#!/usr/bin/python3
"""Model-free GitHub heartbeat that wakes one replaceable SCD target."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import select
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import time
import uuid
from typing import Any


LABEL = "io.tachiko.conductor.scd-heartbeat"
OWNER = "nurockplayer"
REPOSITORY = "tachiko-conductor"
DEFAULT_REPO = Path("/Users/tachikoma/Developer/tachiko-conductor")
DEFAULT_ROOT = Path.home() / "Library/Application Support" / LABEL
DEFAULT_PLIST = Path.home() / "Library/LaunchAgents" / f"{LABEL}.plist"
DEFAULT_CODEX = Path("/Applications/ChatGPT.app/Contents/Resources/codex")
DEFAULT_PROFILE = Path.home() / ".codex/scd_mission_lead.config.toml"
SETTLED_MARKER = "TACHIKO_HEARTBEAT_SETTLED_V1"
DEFAULT_PROMPT = (
    "Continue SCD for nurockplayer/tachiko-conductor under the repository's live "
    "standing SCD policy. Reconcile already-active owned work first, use live GitHub "
    "authority, and stay quiet when no work or meaningful update is executable. Only "
    "when all currently executable in-scope work is settled or no work is executable, "
    f"print {SETTLED_MARKER} on its own final line. Do not print that marker when ending "
    "at a non-terminal re-entry boundary."
)
STATE_SCHEMA = 1
CONFIG_SCHEMA = 2
DEFAULT_POLL_SECONDS = 180
DEFAULT_SAFETY_SECONDS = 1800
DEFAULT_POLL_TIMEOUT_SECONDS = 60
DEFAULT_WAKE_TIMEOUT_SECONDS = 1500
MAX_HEARTBEAT_LOG = 64 * 1024
MAX_WAKE_LOG = 512 * 1024
MAX_POLL_QUERY_COST = 100

QUERY = r"""
query TachikoConductorBootstrapHeartbeat {
  rateLimit { cost remaining resetAt }
  repository(owner: "nurockplayer", name: "tachiko-conductor") {
    defaultBranchRef { name target { oid } }
    issues(first: 25, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage }
      nodes {
        number state title body
        labels(first: 20) { pageInfo { hasNextPage } nodes { name } }
        assignees(first: 10) { pageInfo { hasNextPage } nodes { login } }
        comments(first: 25) {
          pageInfo { hasNextPage }
          nodes { databaseId body updatedAt }
        }
      }
    }
    pullRequests(first: 10, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage }
      nodes {
        number state title body isDraft headRefOid headRefName headRepository { nameWithOwner }
        baseRefOid baseRefName mergeable mergeStateStatus reviewDecision
        closingIssuesReferences(first: 20) {
          pageInfo { hasNextPage }
          nodes { number repository { nameWithOwner } }
        }
        labels(first: 20) { pageInfo { hasNextPage } nodes { name } }
        assignees(first: 10) { pageInfo { hasNextPage } nodes { login } }
        comments(first: 25) {
          pageInfo { hasNextPage }
          nodes { databaseId body updatedAt }
        }
        reviews(last: 100) {
          pageInfo { hasPreviousPage }
          nodes { databaseId author { login } state body submittedAt updatedAt commit { oid } }
        }
        reviewThreads(first: 100) {
          pageInfo { hasNextPage }
          nodes {
            isResolved
            comments(first: 10) {
              pageInfo { hasNextPage }
              nodes { databaseId body updatedAt }
            }
          }
        }
        commits(last: 1) {
          nodes { commit { oid statusCheckRollup {
            state
            contexts(first: 50) { pageInfo { hasNextPage } nodes {
              __typename
              ... on CheckRun { id name status conclusion }
              ... on StatusContext { id context state }
            } }
          } } }
        }
      }
    }
  }
}
"""


def testing() -> bool:
    return os.environ.get("SCD_HEARTBEAT_TESTING") == "1"


ROOT = Path(os.environ["SCD_HEARTBEAT_TEST_ROOT"]) if testing() else DEFAULT_ROOT
CONFIG = ROOT / "config.json"
STATE = ROOT / "state.json"
LOCK = ROOT / "runner.lock"
HEARTBEAT_LOG = ROOT / "heartbeat.log"
WAKE_LOG = ROOT / "wake.log"


def plist_path() -> Path:
    return Path(os.environ["SCD_HEARTBEAT_TEST_PLIST"]) if testing() else DEFAULT_PLIST


def launchctl_path() -> str:
    return os.environ.get("SCD_HEARTBEAT_TEST_LAUNCHCTL", "/bin/launchctl") if testing() else "/bin/launchctl"


def now_epoch() -> int:
    return int(os.environ["SCD_HEARTBEAT_TEST_NOW"]) if testing() and "SCD_HEARTBEAT_TEST_NOW" in os.environ else int(time.time())


def atomic_write(path: Path, data: bytes, mode: int = 0o600) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".tmp")
    with temp.open("wb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    os.chmod(temp, mode)
    os.replace(temp, path)


def trim(path: Path, limit: int) -> None:
    try:
        if path.stat().st_size > limit:
            atomic_write(path, path.read_bytes()[-limit:])
    except FileNotFoundError:
        pass


def log(message: str) -> None:
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    with HEARTBEAT_LOG.open("a", encoding="utf-8") as stream:
        stream.write(time.strftime("%Y-%m-%dT%H:%M:%S%z") + " " + message + "\n")
    os.chmod(HEARTBEAT_LOG, 0o600)
    trim(HEARTBEAT_LOG, MAX_HEARTBEAT_LOG)


def load_object(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (json.JSONDecodeError, OSError) as error:
        raise RuntimeError(f"invalid {path.name}: {error}") from error
    if not isinstance(value, dict):
        raise RuntimeError(f"invalid {path.name}: expected object")
    return value


def reject_truncation(value: Any, path: str = "data") -> None:
    if isinstance(value, dict):
        if value.get("hasNextPage") is True or value.get("hasPreviousPage") is True:
            raise RuntimeError("GitHub snapshot truncated at " + path)
        for key, child in value.items():
            reject_truncation(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            reject_truncation(child, f"{path}[{index}]")


def canonicalize(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: canonicalize(value[key]) for key in sorted(value)}
    if isinstance(value, list):
        items = [canonicalize(item) for item in value]
        return sorted(items, key=lambda item: json.dumps(item, sort_keys=True, separators=(",", ":")))
    return value


def names(connection: dict[str, Any], key: str) -> list[str]:
    return [node[key] for node in connection.get("nodes", []) if isinstance(node.get(key), str)]


def normalized_repository(repository: dict[str, Any]) -> dict[str, Any]:
    issues = []
    for issue in repository["issues"]["nodes"]:
        issues.append({
            "number": issue["number"], "state": issue["state"], "title": issue["title"],
            "body": issue["body"],
            "labels": names(issue["labels"], "name"),
            "assignees": names(issue["assignees"], "login"),
            "comments": issue["comments"]["nodes"],
        })
    prs = []
    for pr in repository["pullRequests"]["nodes"]:
        prs.append({
            "number": pr["number"], "state": pr["state"], "title": pr["title"],
            "body": pr["body"],
            "isDraft": pr["isDraft"], "headRefOid": pr["headRefOid"],
            "headRefName": pr["headRefName"], "headRepository": pr["headRepository"],
            "baseRefOid": pr["baseRefOid"], "baseRefName": pr["baseRefName"],
            "mergeable": pr["mergeable"],
            "mergeStateStatus": pr["mergeStateStatus"],
            "reviewDecision": pr["reviewDecision"],
            "closingIssuesReferences": pr["closingIssuesReferences"]["nodes"],
            "labels": names(pr["labels"], "name"),
            "assignees": names(pr["assignees"], "login"),
            "comments": pr["comments"]["nodes"],
            "reviews": pr["reviews"]["nodes"],
            "reviewThreads": pr["reviewThreads"]["nodes"],
            "commits": pr["commits"]["nodes"],
        })
    return canonicalize({
        "defaultBranch": repository["defaultBranchRef"]["name"],
        "defaultHead": repository["defaultBranchRef"]["target"]["oid"],
        "issues": issues,
        "pullRequests": prs,
    })


def validate_config(config: dict[str, Any]) -> dict[str, Any]:
    if type(config.get("schema")) is not int or config["schema"] != CONFIG_SCHEMA:
        raise RuntimeError("unsupported heartbeat config schema")
    for key in ("gh", "repo", "runner"):
        if not isinstance(config.get(key), str) or not Path(config[key]).is_absolute():
            raise RuntimeError("invalid absolute config path: " + key)
    gh_digest = config.get("gh_sha256")
    if (not isinstance(gh_digest, str) or len(gh_digest) != 64
            or any(character not in "0123456789abcdef" for character in gh_digest)
            or Path(config["gh"]) != ROOT / ("verified-gh-" + gh_digest)):
        raise RuntimeError("invalid pinned GitHub CLI identity")
    runner_digest = config.get("runner_sha256")
    if (not isinstance(runner_digest, str) or len(runner_digest) != 64
            or any(character not in "0123456789abcdef" for character in runner_digest)
            or Path(config["runner"]) != ROOT / ("verified-runner-" + runner_digest)):
        raise RuntimeError("invalid pinned heartbeat runner identity")
    node_digest = config.get("admission_node_sha256")
    if (not isinstance(node_digest, str) or len(node_digest) != 64
            or any(character not in "0123456789abcdef" for character in node_digest)
            or Path(config.get("admission_node", "")) != ROOT / ("verified-node-" + node_digest)):
        raise RuntimeError("invalid pinned admission Node identity")
    helper_files = config.get("admission_helper_files")
    helper_entry = config.get("admission_helper")
    if not isinstance(helper_files, list) or not helper_files or not isinstance(helper_entry, str) or not Path(helper_entry).is_absolute():
        raise RuntimeError("invalid pinned admission helper closure")
    closure_digest = config.get("admission_helper_sha256")
    if (not isinstance(closure_digest, str) or len(closure_digest) != 64
            or any(character not in "0123456789abcdef" for character in closure_digest)):
        raise RuntimeError("invalid pinned admission helper digest")
    for item in helper_files:
        if (not isinstance(item, dict) or set(item) != {"path", "sha256"}
                or not isinstance(item["path"], str) or not Path(item["path"]).is_absolute()
                or not isinstance(item["sha256"], str) or len(item["sha256"]) != 64
                or any(character not in "0123456789abcdef" for character in item["sha256"])):
            raise RuntimeError("invalid pinned admission helper file")
    if not any(item["path"] == helper_entry for item in helper_files):
        raise RuntimeError("admission helper entry is outside its pinned closure")
    helper_root = Path(helper_entry).parents[1]
    closure_manifest = []
    for item in helper_files:
        file_path = Path(item["path"])
        try:
            relative = file_path.relative_to(helper_root).as_posix()
        except ValueError as error:
            raise RuntimeError("admission helper file escapes its pinned closure") from error
        closure_manifest.append((relative, item["sha256"]))
    calculated_closure = hashlib.sha256("\n".join(f"{name} {digest}" for name, digest in sorted(closure_manifest)).encode()).hexdigest()
    if calculated_closure != closure_digest or helper_entry != str(helper_root / "mission-admission/heartbeat-admission-cli.js"):
        raise RuntimeError("admission helper closure digest or entry does not match its pinned layout")
    admission = config.get("admission")
    if (not isinstance(admission, dict) or set(admission) != {"repository", "workspace", "home", "registry", "runs", "receipts", "config"}
            or admission.get("repository") != "nurockplayer/tachiko-conductor"
            or any(not isinstance(admission.get(key), str) or not Path(admission[key]).is_absolute()
                   for key in ("workspace", "home", "registry", "runs", "receipts"))
            or not isinstance(admission.get("config"), dict)):
        raise RuntimeError("invalid fixed heartbeat admission domain")
    admission_config = admission["config"]
    if (set(admission_config) != {"schemaVersion", "revision", "limits"} or admission_config.get("schemaVersion") != 1
            or not isinstance(admission_config.get("revision"), str) or not admission_config["revision"]
            or not isinstance(admission_config.get("limits"), dict)
            or set(admission_config["limits"]) - {"maxCaptains", "maxWriters", "maxHighAutonomy", "maxPerRepository"}
            or any(type(value) is not int or value < 1 for value in admission_config["limits"].values())
            or any(key not in admission_config["limits"] for key in ("maxCaptains", "maxWriters", "maxHighAutonomy"))):
        raise RuntimeError("invalid fixed heartbeat admission configuration")
    if type(config.get("poll_interval_seconds")) is not int or config["poll_interval_seconds"] < 1:
        raise RuntimeError("invalid poll_interval_seconds")
    if type(config.get("poll_timeout_seconds")) is not int or config["poll_timeout_seconds"] < 1:
        raise RuntimeError("invalid poll_timeout_seconds")
    if config["poll_timeout_seconds"] >= config["poll_interval_seconds"]:
        raise RuntimeError("poll timeout must be shorter than poll interval")
    if type(config.get("wake_timeout_seconds")) is not int or config["wake_timeout_seconds"] < 1:
        raise RuntimeError("invalid wake_timeout_seconds")
    if type(config.get("safety_interval_seconds")) is not int or config["safety_interval_seconds"] < 1:
        raise RuntimeError("invalid safety_interval_seconds")
    if config.get("wake_executable_relocatable") is not True:
        raise RuntimeError("wake executable must be explicitly relocation-safe")
    command = config.get("wake_command")
    if not isinstance(command, list) or not command or not all(isinstance(item, str) and item for item in command):
        raise RuntimeError("invalid wake_command")
    if not Path(command[0]).is_absolute():
        raise RuntimeError("wake executable must be absolute")
    wake_kind = config.get("wake_target_kind")
    if wake_kind not in ({"codex", "test"} if testing() else {"codex"}):
        raise RuntimeError("unqualified custom wake targets are not supported by the heartbeat supervisor")
    wake_env = config.get("wake_env", {})
    if not isinstance(wake_env, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in wake_env.items()):
        raise RuntimeError("invalid wake_env")
    forbidden_wake_env = {"TACHIKO_MISSION_ADMISSION_PATH", "TACHIKO_MISSION_ADMISSION_CONFIG", "TACHIKO_DATA_DIR", "TACHIKO_HEARTBEAT_ADMISSION_RECEIPTS_DIR"}
    if forbidden_wake_env.intersection(wake_env):
        raise RuntimeError("wake_env cannot override the pinned mission-admission domain")
    if wake_kind == "codex":
        codex = str(DEFAULT_CODEX)
        profile = str(DEFAULT_PROFILE)
        expected_command = [
            codex, "exec", "--profile", Path(profile).stem.replace(".config", ""),
            "--strict-config", "--model", "gpt-6-sol", "-c", 'model_reasoning_effort="high"',
            "-C", config["repo"], DEFAULT_PROMPT,
        ]
        expected_env = {"CODEX_HOME": str(Path(profile).parent)}
        if command != expected_command or wake_env != expected_env:
            raise RuntimeError("wake target does not match the pinned GPT-6 Sol heartbeat contract")
        profile_path = Path(profile)
        try:
            profile_text = profile_path.read_text(encoding="utf-8")
        except OSError as error:
            raise RuntimeError("pinned GPT-6 Sol heartbeat profile is unavailable") from error
        if not re.search(r'(?m)^model\s*=\s*["\']gpt-6-sol["\']\s*$', profile_text) or not re.search(r'(?m)^model_reasoning_effort\s*=\s*["\']high["\']\s*$', profile_text):
            raise RuntimeError("heartbeat profile must pin GPT-6 Sol at high reasoning effort")
    required = config.get("required_files", [])
    if not isinstance(required, list):
        raise RuntimeError("invalid required_files")
    installed_names: set[str] = set()
    for item in required:
        if not isinstance(item, dict) or not isinstance(item.get("path"), str) or not Path(item["path"]).is_absolute():
            raise RuntimeError("invalid required file")
        if not isinstance(item.get("sha256"), str):
            raise RuntimeError("invalid required file digest")
        installed_name = item.get("installed_name")
        if installed_name is not None:
            if installed_name != "codex-code-mode-host" or installed_name in installed_names:
                raise RuntimeError("invalid required companion name")
            installed_names.add(installed_name)
    return config


def load_config() -> dict[str, Any]:
    return validate_config(load_object(CONFIG))


def github_fingerprint(config: dict[str, Any], verbose: bool = False) -> str:
    try:
        result = subprocess.run(
            [config["gh"], "api", "graphql", "-f", "query=" + QUERY], cwd=config["repo"],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            check=False, text=True, env=os.environ.copy(), timeout=config["poll_timeout_seconds"],
        )
    except subprocess.TimeoutExpired as error:
        raise RuntimeError("GitHub poll timed out; refusing wake") from error
    if result.returncode:
        detail = (result.stderr.strip().splitlines()[-1:] or ["unknown error"])[0][-1000:]
        raise RuntimeError(f"GitHub poll failed ({result.returncode}): {detail}")
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError("GitHub poll returned invalid JSON") from error
    if payload.get("errors"):
        raise RuntimeError("GitHub GraphQL returned errors")
    data = payload.get("data", {})
    rate_limit = data.get("rateLimit")
    if not isinstance(rate_limit, dict) or type(rate_limit.get("cost")) is not int:
        raise RuntimeError("GitHub snapshot missing query cost")
    if rate_limit["cost"] > MAX_POLL_QUERY_COST:
        raise RuntimeError(
            f"GitHub poll query cost {rate_limit['cost']} exceeds {MAX_POLL_QUERY_COST}; refusing wake"
        )
    if verbose:
        log(f"GitHub poll query cost: {rate_limit['cost']} points")
    repository = data.get("repository")
    if not isinstance(repository, dict) or not repository.get("defaultBranchRef"):
        raise RuntimeError("GitHub snapshot missing repository/default branch")
    reject_truncation(repository)
    normalized = json.dumps(normalized_repository(repository), sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(normalized).hexdigest()


def load_state() -> dict[str, Any]:
    state = load_object(STATE)
    if not state:
        return {}
    fields = {
        "schema": int, "successful_fingerprint": str, "last_success_at": int,
        "last_attempt_at": int, "last_attempt_fingerprint": str,
        "last_attempt_exit": int, "last_attempt_reason": str,
    }
    for key, kind in fields.items():
        if type(state.get(key)) is not kind:
            raise RuntimeError("invalid heartbeat state field: " + key)
    if state["schema"] != STATE_SCHEMA:
        raise RuntimeError("unsupported heartbeat state schema")
    return state


def save_state(state: dict[str, Any]) -> None:
    atomic_write(STATE, (json.dumps(state, sort_keys=True) + "\n").encode())


def prime(config: dict[str, Any], reason: str) -> None:
    fingerprint = github_fingerprint(config)
    now = now_epoch()
    save_state({
        "schema": STATE_SCHEMA, "successful_fingerprint": fingerprint,
        "last_success_at": now, "last_attempt_at": now,
        "last_attempt_fingerprint": fingerprint, "last_attempt_exit": 0,
        "last_attempt_reason": "prime",
    })
    log(f"primed normalized GitHub baseline; no wake ({reason})")


def fd_sha256(fd: int) -> str:
    digest = hashlib.sha256()
    os.lseek(fd, 0, os.SEEK_SET)
    while chunk := os.read(fd, 1024 * 1024):
        digest.update(chunk)
    os.lseek(fd, 0, os.SEEK_SET)
    return digest.hexdigest()


def verify_trusted_path(path: Path) -> None:
    absolute = path.absolute()
    for component in (absolute, *absolute.parents):
        metadata = component.lstat()
        if stat.S_ISLNK(metadata.st_mode) or metadata.st_uid not in {0, os.getuid()} or metadata.st_mode & 0o022:
            raise RuntimeError("wake file path ownership or permissions unsafe: " + str(component))


def materialize_verified_executable(source_fd: int, name: str = "verified-wake-executable") -> Path:
    target = ROOT / name
    temporary = target.with_name(target.name + ".tmp")
    try:
        os.lseek(source_fd, 0, os.SEEK_SET)
        with temporary.open("wb") as stream:
            while chunk := os.read(source_fd, 1024 * 1024):
                stream.write(chunk)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o700)
        os.replace(temporary, target)
    finally:
        if temporary.exists():
            temporary.unlink()
    return target


def verify_wake_target(config: dict[str, Any]) -> Path:
    executable = Path(config["wake_command"][0])
    if not executable.is_file() or executable.is_symlink() or not os.access(executable, os.X_OK):
        raise RuntimeError("wake executable unavailable or unsafe: " + str(executable))
    executable_fd = os.open(executable, os.O_RDONLY)
    try:
        metadata = os.fstat(executable_fd)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid not in {0, os.getuid()} or metadata.st_mode & 0o022:
            raise RuntimeError("wake executable ownership or permissions unsafe: " + str(executable))
        executable_digest = fd_sha256(executable_fd)
        executable_pinned = False
        for required in config.get("required_files", []):
            path = Path(required["path"])
            if not path.is_file() or path.is_symlink():
                raise RuntimeError("required wake file unavailable or unsafe: " + str(path))
            if path.resolve(strict=True) == executable.resolve(strict=True):
                executable_pinned = executable_pinned or required["sha256"] == executable_digest
                if required["sha256"] != executable_digest:
                    raise RuntimeError("required wake file identity changed: " + str(path))
                continue
            installed_name = required.get("installed_name")
            if installed_name is None:
                verify_trusted_path(path)
            required_fd = os.open(path, os.O_RDONLY)
            try:
                metadata = os.fstat(required_fd)
                if not stat.S_ISREG(metadata.st_mode):
                    raise RuntimeError("required wake file unavailable or unsafe: " + str(path))
                if installed_name is not None and (
                        metadata.st_uid not in {0, os.getuid()} or metadata.st_mode & 0o022):
                    raise RuntimeError("required wake companion ownership or permissions unsafe: " + str(path))
                if fd_sha256(required_fd) != required["sha256"]:
                    raise RuntimeError("required wake file identity changed: " + str(path))
                if installed_name is not None:
                    if not metadata.st_mode & 0o111:
                        raise RuntimeError("required wake companion is not executable: " + str(path))
                    materialize_verified_executable(required_fd, installed_name)
            finally:
                os.close(required_fd)
        if not executable_pinned:
            raise RuntimeError("wake executable identity is not pinned: " + str(executable))
        return materialize_verified_executable(executable_fd)
    finally:
        os.close(executable_fd)


def pin_github_tool(path: Path) -> tuple[Path, str, bool]:
    if not path.is_file() or path.is_symlink() or not os.access(path, os.X_OK):
        raise RuntimeError("GitHub CLI unavailable or unsafe: " + str(path))
    source_fd = os.open(path, os.O_RDONLY)
    try:
        metadata = os.fstat(source_fd)
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid not in {0, os.getuid()}
                or metadata.st_mode & 0o022):
            raise RuntimeError("GitHub CLI ownership or permissions unsafe: " + str(path))
        digest = fd_sha256(source_fd)
        existed = (ROOT / ("verified-gh-" + digest)).exists()
        target = materialize_verified_executable(source_fd, "verified-gh-" + digest)
        return target, digest, not existed
    finally:
        os.close(source_fd)


def pin_runner_source(path: Path) -> tuple[Path, str, bool]:
    if not path.is_file() or path.is_symlink():
        raise RuntimeError("heartbeat runner unavailable or unsafe: " + str(path))
    source_fd = os.open(path, os.O_RDONLY)
    try:
        metadata = os.fstat(source_fd)
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid not in {0, os.getuid()}
                or metadata.st_mode & 0o022):
            raise RuntimeError("heartbeat runner ownership or permissions unsafe: " + str(path))
        digest = fd_sha256(source_fd)
        existed = (ROOT / ("verified-runner-" + digest)).exists()
        target = materialize_verified_executable(source_fd, "verified-runner-" + digest)
        return target, digest, not existed
    finally:
        os.close(source_fd)


def pin_admission_node(path: Path) -> tuple[Path, str, bool]:
    if not path.is_file() or path.is_symlink() or not os.access(path, os.X_OK):
        raise RuntimeError("Node executable unavailable or unsafe: " + str(path))
    source_fd = os.open(path, os.O_RDONLY)
    try:
        metadata = os.fstat(source_fd)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid not in {0, os.getuid()} or metadata.st_mode & 0o022:
            raise RuntimeError("Node executable ownership or permissions unsafe: " + str(path))
        digest = fd_sha256(source_fd)
        existed = (ROOT / ("verified-node-" + digest)).exists()
        target = materialize_verified_executable(source_fd, "verified-node-" + digest)
        return target, digest, not existed
    finally:
        os.close(source_fd)


def pin_admission_helper(repo: Path) -> tuple[Path, str, list[dict[str, str]], bool]:
    source_root = repo / "dist"
    entry_relative = Path("mission-admission/heartbeat-admission-cli.js")
    pending = [entry_relative]
    sources: dict[Path, bytes] = {}
    while pending:
        relative = pending.pop()
        if relative in sources:
            continue
        source = source_root / relative
        if not source.is_file() or source.is_symlink():
            raise RuntimeError("compiled heartbeat admission helper is missing or unsafe; run the pinned project build first")
        data = source.read_bytes()
        sources[relative] = data
        for specifier in re.findall(r"(?:from\s*|import\s*)[\"']([^\"']+)[\"']", data.decode("utf-8")):
            if specifier.startswith("node:"):
                continue
            if not specifier.startswith("."):
                raise RuntimeError("heartbeat admission helper has an external import that cannot be pinned")
            child = (relative.parent / specifier)
            if child.suffix != ".js":
                raise RuntimeError("heartbeat admission helper has a non-JS local import")
            normalized = Path(os.path.normpath(str(child)))
            if normalized.is_absolute() or ".." in normalized.parts:
                raise RuntimeError("heartbeat admission helper import escapes compiled source root")
            pending.append(normalized)
    sources[Path("package.json")] = b'{"type":"module"}\n'
    digests = {relative: hashlib.sha256(data).hexdigest() for relative, data in sources.items()}
    manifest = "\n".join(f"{relative.as_posix()} {digests[relative]}" for relative in sorted(sources))
    closure_digest = hashlib.sha256(manifest.encode("utf-8")).hexdigest()
    bundle = ROOT / ("verified-admission-" + closure_digest)
    existed = bundle.is_dir()
    bundle.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(bundle, 0o700)
    for relative, data in sources.items():
        target = bundle / relative
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(target.parent, 0o700)
        atomic_write(target, data, 0o600)
    files = [{"path": str(bundle / relative), "sha256": digests[relative]} for relative in sorted(sources)]
    return bundle / entry_relative, closure_digest, files, not existed


def prune_stale_digest_snapshots(prefix: str, current: Path) -> None:
    try:
        candidates = list(ROOT.iterdir())
    except OSError as error:
        log("could not inspect stale digest snapshots: " + str(error))
        return
    for candidate in candidates:
        try:
            suffix = candidate.name.removeprefix(prefix)
            if (candidate == current or not candidate.name.startswith(prefix) or len(suffix) != 64
                    or any(character not in "0123456789abcdef" for character in suffix)):
                continue
            metadata = candidate.lstat()
            if stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
                candidate.unlink()
        except OSError as error:
            log("could not prune stale digest snapshot " + str(candidate) + ": " + str(error))


def restore_optional_file(path: Path, previous: bytes | None) -> None:
    if previous is None:
        if path.exists():
            path.unlink()
    else:
        atomic_write(path, previous)


def linux_process_identity(pid: int) -> tuple[str, str] | None:
    try:
        raw = (Path("/proc") / str(pid) / "stat").read_text(encoding="utf-8")
    except (FileNotFoundError, NotADirectoryError):
        return None
    except OSError as error:
        raise RuntimeError("could not inspect guarded process identity") from error
    closing = raw.rfind(")")
    fields = raw[closing + 2:].split() if closing >= 0 else []
    if len(fields) < 20:
        return None
    return fields[0], fields[19]


def process_group_has_live_members(process_group: int) -> bool | None:
    scanned_empty = False
    proc = Path("/proc")
    if proc.is_dir():
        try:
            entries = list(proc.iterdir())
        except OSError:
            return None
        for entry in entries:
            if not entry.name.isdigit():
                continue
            try:
                raw = (entry / "stat").read_text(encoding="utf-8")
            except FileNotFoundError:
                continue
            except OSError:
                return None
            closing = raw.rfind(")")
            fields = raw[closing + 2:].split() if closing >= 0 else []
            if len(fields) < 3:
                return None
            if fields[0] != "Z" and fields[2] == str(process_group):
                return True
        scanned_empty = True
    else:
        try:
            result = subprocess.run(
                ["/bin/ps", "-axo", "pgid=,state="], stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
                check=False, timeout=2,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return None
        if result.returncode:
            return None
        for line in result.stdout.splitlines():
            fields = line.split()
            try:
                pgid = int(fields[0])
            except (IndexError, ValueError):
                return None
            if pgid == process_group and len(fields) > 1 and not fields[1].startswith("Z"):
                return True
        scanned_empty = True
    if scanned_empty:
        # The process may have forked into this group after the /proc or ps
        # snapshot. Only ESRCH from a second kernel query proves the group is
        # gone; an existing or inaccessible group remains unknown.
        try:
            os.killpg(process_group, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return None
        except OSError:
            return None
        return None
    return None


def process_identity(pid: int) -> str | None:
    if Path("/proc").is_dir():
        identity = linux_process_identity(pid)
        if identity is None or identity[0] == "Z":
            return None
        return "linux-start:" + identity[1]
    try:
        result = subprocess.run(
            ["/bin/ps", "-p", str(pid), "-o", "uid=,lstart=,state=,command="],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, timeout=2, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise RuntimeError("could not inspect lock owner process identity") from error
    fields = result.stdout.split(None, 7)
    if result.returncode != 0:
        if not fields:
            return None
        raise RuntimeError("could not inspect lock owner process identity")
    if not fields:
        return None
    if len(fields) < 8:
        raise RuntimeError("could not inspect lock owner process identity")
    if fields[6].startswith("Z"):
        return None
    return "ps:" + " ".join([fields[0], *fields[1:6], *fields[7:]])


def verify_admission_helper(config: dict[str, Any]) -> None:
    node = Path(config["admission_node"])
    metadata = node.lstat()
    if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid not in {0, os.getuid()}
            or metadata.st_mode & 0o022 or not metadata.st_mode & 0o111
            or hashlib.sha256(node.read_bytes()).hexdigest() != config["admission_node_sha256"]):
        raise RuntimeError("pinned admission Node bytes failed verification")
    for item in config["admission_helper_files"]:
        candidate = Path(item["path"])
        metadata = candidate.lstat()
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid not in {0, os.getuid()}
                or metadata.st_mode & 0o022 or hashlib.sha256(candidate.read_bytes()).hexdigest() != item["sha256"]):
            raise RuntimeError("pinned admission helper closure failed verification")


def admission_domain_environment(config: dict[str, Any]) -> dict[str, str]:
    admission = config["admission"]
    return {
        "TACHIKO_MISSION_ADMISSION_PATH": admission["registry"],
        "TACHIKO_MISSION_ADMISSION_CONFIG": json.dumps(admission["config"], sort_keys=True, separators=(",", ":")),
        "TACHIKO_DATA_DIR": admission["runs"],
        "TACHIKO_HEARTBEAT_ADMISSION_RECEIPTS_DIR": admission["receipts"],
        "TACHIKO_DISPATCH_WAKE_PATH": str(Path(admission["home"]) / ".tachiko-conductor/dispatch/wake"),
    }


def admission_helper_environment(config: dict[str, Any]) -> dict[str, str]:
    return {"HOME": config["admission"]["home"], "PATH": "/usr/bin:/bin", **admission_domain_environment(config)}


def admission_call(config: dict[str, Any], request: dict[str, Any]) -> dict[str, Any]:
    verify_admission_helper(config)
    try:
        result = subprocess.run(
            [config["admission_node"], config["admission_helper"]], cwd=config["repo"],
            input=json.dumps(request, separators=(",", ":")) + "\n", text=True,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False,
            timeout=15, env=admission_helper_environment(config),
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise RuntimeError("pinned admission helper could not establish ownership") from error
    if result.returncode != 0:
        raise RuntimeError("pinned admission helper rejected the ownership transaction")
    try:
        value = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError("pinned admission helper returned invalid bounded JSON") from error
    if not isinstance(value, dict) or value.get("schemaVersion") != 1 or not isinstance(value.get("outcome"), str):
        raise RuntimeError("pinned admission helper returned an ambiguous result")
    return value


def reserve_heartbeat(config: dict[str, Any], supervisor_id: str) -> dict[str, Any]:
    admission = config["admission"]
    return admission_call(config, {
        "schemaVersion": 1, "action": "reserve", "repository": admission["repository"],
        "workspace": admission["workspace"], "supervisorId": supervisor_id,
    })


def write_all(fd: int, data: bytes) -> None:
    view = memoryview(data)
    offset = 0
    while offset < len(view):
        written = os.write(fd, view[offset:])
        if written <= 0:
            raise OSError("short write while publishing guarded handoff")
        offset += written


def spawn_lock_guard(lock_fd: int, timeout_seconds: int) -> tuple[int, int, int]:
    read_fd, write_fd = os.pipe()
    result_read_fd, result_write_fd = os.pipe()
    guard_pid = os.fork()
    if guard_pid:
        os.close(read_fd)
        os.close(result_write_fd)
        return guard_pid, write_fd, result_read_fd
    try:
        # The guard is a background custody process. Holding these descriptors
        # would keep its caller's captured stdout/stderr open for the whole
        # descendant lifetime, even after the supervisor returned.
        for descriptor in (0, 1, 2):
            try:
                os.close(descriptor)
            except OSError:
                pass
        os.close(write_fd)
        os.close(result_read_fd)
        header = b""
        while len(header) < 4:
            chunk = os.read(read_fd, 4 - len(header))
            if not chunk:
                raise RuntimeError("guard handoff ended before its frame header")
            header += chunk
        frame_size = int.from_bytes(header, "big")
        if frame_size < 2 or frame_size > 64 * 1024:
            raise RuntimeError("guard handoff frame size is invalid")
        message = bytearray()
        while len(message) < frame_size:
            chunk = os.read(read_fd, frame_size - len(message))
            if not chunk:
                raise RuntimeError("guard handoff frame was truncated")
            message.extend(chunk)
        if os.read(read_fd, 1):
            raise RuntimeError("guard handoff contains trailing bytes")
        os.close(read_fd)
        metadata = json.loads(message)
        if metadata.get("cancelled_before_spawn") is True:
            settlement = metadata["settlement"]
            request = dict(settlement["request"])
            request["stopProof"] = {
                "childrenStopped": True, "supervisorStopped": True,
                "observedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
            while True:
                try:
                    result = admission_call(settlement["config"], request)
                    if result.get("outcome") == "settled":
                        try: os.write(result_write_fd, b"settled\n")
                        except OSError: pass
                        try: os.close(result_write_fd)
                        except OSError: pass
                        os.lseek(lock_fd, 0, os.SEEK_SET)
                        os.ftruncate(lock_fd, 0)
                        os.fsync(lock_fd)
                        os.close(lock_fd)
                        os._exit(0)
                except BaseException:
                    pass
                time.sleep(5)
        target_pid = metadata["target_pid"]
        settlement = metadata["settlement"]
        if type(target_pid) is not int or target_pid < 1:
            raise RuntimeError("invalid guarded child identity")
        initial_linux_identity = linux_process_identity(target_pid) if Path("/proc").is_dir() else None
        initial_process_identity = None if initial_linux_identity is not None else process_identity(target_pid)
        deadline = time.monotonic() + timeout_seconds
        terminate_deadline: float | None = None
        killed = False
        while True:
            direct_exited = False
            if initial_linux_identity is not None:
                current_identity = linux_process_identity(target_pid)
                if (current_identity is None or current_identity[0] == "Z"
                        or current_identity[1] != initial_linux_identity[1]):
                    direct_exited = True
            else:
                current_identity = process_identity(target_pid)
                if current_identity is None or current_identity != initial_process_identity:
                    direct_exited = True
            try:
                os.kill(target_pid, 0)
            except ProcessLookupError:
                direct_exited = True
            except PermissionError:
                pass
            now = time.monotonic()
            if terminate_deadline is None:
                if now >= deadline:
                    try:
                        os.killpg(target_pid, signal.SIGTERM)
                    except (ProcessLookupError, PermissionError):
                        pass
                    terminate_deadline = now + 5
            elif terminate_deadline is not None and not killed and now >= terminate_deadline:
                try:
                    os.killpg(target_pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
                killed = True
            if direct_exited:
                group_live = process_group_has_live_members(target_pid)
                if group_live is False:
                    # This time is evidence from the guard's observed empty group,
                    # after the direct target has stopped. It is never pre-start data.
                    request = dict(settlement["request"])
                    request["stopProof"] = {
                        "childrenStopped": True, "supervisorStopped": True,
                        "observedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    }
                    while True:
                        try:
                            result = admission_call(settlement["config"], request)
                            if result.get("outcome") == "settled":
                                try: os.write(result_write_fd, b"settled\n" if terminate_deadline is None else b"terminated\n")
                                except OSError: pass
                                try: os.close(result_write_fd)
                                except OSError: pass
                                try:
                                    os.lseek(lock_fd, 0, os.SEEK_SET)
                                    os.ftruncate(lock_fd, 0)
                                    os.fsync(lock_fd)
                                except OSError:
                                    pass
                                os.close(lock_fd)
                                os._exit(0)
                        except BaseException:
                            pass
                        time.sleep(5)
                # Unknown inspection is not evidence that descendants stopped.
                # Continue holding both registry ownership and the flock.
            time.sleep(0.05)
    except BaseException:
        # Any ambiguous guard state retains the inherited lock indefinitely.
        while True:
            time.sleep(60)


def run_wake(config: dict[str, Any], lock_fd: int, reservation: dict[str, Any], supervisor_id: str) -> tuple[int, bool]:
    verified_executable = verify_wake_target(config)
    child = None
    settlement = {
        "config": config,
        "request": {
            "schemaVersion": 1, "action": "settle", "repository": config["admission"]["repository"],
            "workspace": config["admission"]["workspace"], "supervisorId": supervisor_id,
            "expectedGeneration": reservation["generation"], "receiptId": reservation["receiptId"],
            "stopProof": {"childrenStopped": True, "supervisorStopped": True, "observedAt": "pending"},
        },
    }
    guard_pid, guard_write_fd, guard_result_fd = spawn_lock_guard(lock_fd, config["wake_timeout_seconds"])
    guard_started = False
    wake_deadline = time.monotonic() + config["wake_timeout_seconds"]
    guard_result_deadline = wake_deadline + 7
    output = bytearray()
    selector = selectors.DefaultSelector()

    def signal_group(signum: int) -> None:
        if child is not None:
            try:
                os.killpg(child.pid, signum)
            except ProcessLookupError:
                pass
            except PermissionError:
                if child.poll() is None:
                    child.send_signal(signum)

    def group_alive() -> bool:
        if child is None:
            return False
        try:
            os.killpg(child.pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return child.poll() is None
        return True

    def forward(signum: int, _frame: Any) -> None:
        signal_group(signum)

    old_term = signal.signal(signal.SIGTERM, forward)
    old_int = signal.signal(signal.SIGINT, forward)
    try:
        environment = os.environ.copy()
        environment.update(config.get("wake_env", {}))
        # The model-capable child must observe the same admission authority
        # that just granted this generation, even if launchd inherited stale
        # domain variables or the owner supplied an explicit host path.
        environment["HOME"] = config["admission"]["home"]
        environment.update(admission_domain_environment(config))

        def publish_guard_pid() -> None:
            frame = json.dumps({"target_pid": os.getpid(), "settlement": settlement}, separators=(",", ":")).encode()
            if len(frame) > 64 * 1024:
                raise RuntimeError("guard handoff exceeds bounded frame size")
            write_all(guard_write_fd, len(frame).to_bytes(4, "big") + frame)
            os.close(guard_write_fd)

        try:
            child = subprocess.Popen(
                config["wake_command"], cwd=config["repo"], stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=environment,
                executable=str(verified_executable), start_new_session=True,
                pass_fds=(guard_write_fd,), preexec_fn=publish_guard_pid,
            )
        except BaseException:
            # If preexec published the bound PID, the guard can prove the
            # failed exec process has exited. Appending a second frame would
            # make the initial handoff ambiguous, so EOF is the only parent
            # action here; a missing first frame remains fail-closed.
            os.close(guard_write_fd)
            guard_started = True
            os.set_blocking(guard_result_fd, False)
            cancel_deadline = time.monotonic() + 15
            while time.monotonic() < cancel_deadline:
                readable, _, _ = select.select([guard_result_fd], [], [], min(0.1, cancel_deadline - time.monotonic()))
                if readable and os.read(guard_result_fd, 64).strip() == b"settled":
                    os.waitpid(guard_pid, 0)
                    break
            raise
        os.close(guard_write_fd)
        guard_started = True
        assert child.stdout is not None
        os.set_blocking(child.stdout.fileno(), False)
        selector.register(child.stdout, selectors.EVENT_READ)
        deadline = wake_deadline
        timed_out = False

        def remember(chunk: bytes) -> None:
            output.extend(chunk)
            if len(output) > MAX_WAKE_LOG:
                del output[:-MAX_WAKE_LOG]

        def drain_buffered_tail() -> None:
            # Direct-child exit guarantees its own writes reached the pipe, but
            # descendants may keep the descriptor open. Drain only bytes already
            # available, with a strict volume bound, and never wait for EOF.
            if testing() and os.environ.get("SCD_HEARTBEAT_TEST_PRE_DRAIN_SLEEP"):
                time.sleep(float(os.environ["SCD_HEARTBEAT_TEST_PRE_DRAIN_SLEEP"]))
            drained = 0
            while drained < MAX_WAKE_LOG * 2:
                try:
                    chunk = os.read(child.stdout.fileno(), 64 * 1024)
                except BlockingIOError:
                    break
                if not chunk:
                    break
                drained += len(chunk)
                remember(chunk)

        while True:
            if child.poll() is not None:
                drain_buffered_tail()
                break
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                timed_out = True
                break
            if not selector.get_map():
                try:
                    child.wait(timeout=remaining)
                except subprocess.TimeoutExpired:
                    timed_out = True
                break
            for key, _mask in selector.select(min(remaining, 0.1)):
                chunk = os.read(key.fileobj.fileno(), 64 * 1024)
                if chunk:
                    remember(chunk)
                else:
                    selector.unregister(key.fileobj)
            # The direct target defines completion. A detached descendant may
            # legitimately keep inherited output descriptors open; waiting for
            # pipe EOF would turn a successful direct exit into a false timeout.
            if child.poll() is not None:
                drain_buffered_tail()
                break
        if timed_out:
            signal_group(signal.SIGTERM)
            terminate_deadline = time.monotonic() + 5
            while group_alive() and time.monotonic() < terminate_deadline:
                child.poll()
                time.sleep(0.05)
            if group_alive():
                signal_group(signal.SIGKILL)
            child.wait()
            # The guard performs the authoritative generation settlement after
            # it independently observes the group empty. Do not make the next
            # poll race that cleanup.
            os.set_blocking(guard_result_fd, False)
            while time.monotonic() < guard_result_deadline:
                readable, _, _ = select.select([guard_result_fd], [], [], min(0.1, guard_result_deadline - time.monotonic()))
                if readable:
                    chunk = os.read(guard_result_fd, 64)
                    if not chunk or b"\n" in chunk:
                        break
            atomic_write(WAKE_LOG, bytes(output[-MAX_WAKE_LOG:]))
            return 124, False
        code = child.wait()
        atomic_write(WAKE_LOG, bytes(output[-MAX_WAKE_LOG:]))
        nonempty_lines = [line for line in output.splitlines() if line.strip()]
        marker_settled = code == 0 and bool(nonempty_lines) and nonempty_lines[-1] == SETTLED_MARKER.encode()
        acknowledgement = bytearray()
        os.set_blocking(guard_result_fd, False)
        # Do not let an already-successful direct wake be retried while its
        # descendants remain in the guarded group. The guard also enforces the
        # hard timeout and settles only after observing an empty group. If the
        # guard cannot prove settlement, return after its kill grace while its
        # inherited flock/registry fence remain held.
        ack_deadline = wake_deadline + 7
        while True:
            remaining = ack_deadline - time.monotonic()
            if remaining <= 0:
                break
            readable, _, _ = select.select([guard_result_fd], [], [], remaining)
            if readable:
                chunk = os.read(guard_result_fd, 64)
                if not chunk:
                    break
                acknowledgement.extend(chunk)
                if b"\n" in acknowledgement:
                    break
        clean_guard = bytes(acknowledgement).strip() == b"settled"
        if not clean_guard:
            return code, False
        return code, marker_settled
    finally:
        if not guard_started:
            try:
                os.write(guard_write_fd, b"0\n")
            except OSError:
                pass
            os.close(guard_write_fd)
        if child is None or child.poll() is not None:
            if not guard_started:
                os.waitpid(guard_pid, 0)
        os.close(guard_result_fd)
        selector.close()
        signal.signal(signal.SIGTERM, old_term)
        signal.signal(signal.SIGINT, old_int)


def acquire_lock(verbose: bool):
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(ROOT, 0o700)
    stream = LOCK.open("a+b")
    os.chmod(LOCK, 0o600)
    try:
        fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        stream.close()
        if verbose:
            log("no-op: another heartbeat invocation owns the atomic lock")
        return None
    stream.seek(0)
    prior = stream.read().strip()
    if prior:
        try:
            metadata = json.loads(prior)
            pid = metadata["pid"]
            prior_identity = metadata["process_identity"]
            if type(pid) is not int or pid < 1 or not isinstance(prior_identity, str) or not prior_identity:
                raise ValueError("invalid lock owner identity")
        except (json.JSONDecodeError, KeyError, TypeError, ValueError) as error:
            stream.close()
            raise RuntimeError("ambiguous stale lock metadata; refusing wake") from error
        current_identity = process_identity(pid)
        if current_identity is None:
            log(f"recovered provably stale lock from exited pid {pid}")
        elif current_identity != prior_identity:
            log(f"recovered provably stale lock from reused pid {pid}")
        else:
            stream.close()
            raise RuntimeError("ambiguous unlocked metadata names the same live process; refusing wake")
    current_identity = process_identity(os.getpid())
    if current_identity is None:
        stream.close()
        raise RuntimeError("could not establish current lock owner process identity")
    stream.seek(0)
    stream.truncate()
    stream.write((json.dumps({
        "pid": os.getpid(), "process_identity": current_identity, "acquired_at": now_epoch(),
    }) + "\n").encode())
    stream.flush()
    os.fsync(stream.fileno())
    return stream


def release_lock(stream: Any) -> None:
    stream.seek(0)
    stream.truncate()
    stream.flush()
    os.fsync(stream.fileno())
    stream.close()


def acquire_operator_lock(action: str):
    try:
        stream = acquire_lock(False)
    except Exception as error:
        raise RuntimeError(f"cannot {action}; heartbeat lock is not safely available: {error}") from error
    if stream is None:
        raise RuntimeError(f"cannot {action}; heartbeat poll or wake is active")
    return stream


def heartbeat(verbose: bool = False, do_prime: bool = False) -> int:
    os.umask(0o077)
    try:
        lock_stream = acquire_lock(verbose)
    except Exception as error:
        log("lock error; no wake: " + str(error))
        return 1
    if lock_stream is None:
        return 0
    try:
        config = load_config()
        if do_prime:
            prime(config, "explicit")
            return 0
        state = load_state()
        if not state:
            prime(config, "initial")
            return 0
        try:
            fingerprint = github_fingerprint(config, verbose)
        except Exception as error:
            log("poll error; no wake: " + str(error))
            return 1
        now = now_epoch()
        changed = fingerprint != state["successful_fingerprint"]
        safety_due = now - state["last_success_at"] >= config["safety_interval_seconds"]
        if not changed and not safety_due:
            if verbose:
                log("no-op: normalized GitHub state unchanged and safety interval not due")
            return 0
        reason = "normalized GitHub state changed" if changed else "safety reconciliation interval elapsed"
        try:
            verify_wake_target(config)
            supervisor_id = str(uuid.uuid4())
            reservation = reserve_heartbeat(config, supervisor_id)
        except Exception as error:
            log("admission error; no wake: " + str(error))
            return 1
        # Only a newly committed generation authorizes a new model process.
        # Existing receipts are reconciliation evidence, never a spawn permit.
        if reservation.get("outcome") != "reserved":
            log("no-op: mission admission did not grant a fresh generation")
            return 0
        attempt = dict(state)
        attempt.update(last_attempt_at=now, last_attempt_fingerprint=fingerprint,
                       last_attempt_exit=-1, last_attempt_reason=reason)
        save_state(attempt)
        log("waking target: " + reason)
        # The dedicated guard retains the flock if this supervisor is killed. A
        # replacement runner cannot overlap an orphaned wake target on this host.
        code, settled = run_wake(config, lock_stream.fileno(), reservation, supervisor_id)
        attempt["last_attempt_exit"] = code
        if code:
            save_state(attempt)
            log(f"wake target failed with exit {code}; successful state not consumed")
            return code
        if not settled:
            save_state(attempt)
            log("wake target exited 0 without settled acknowledgement; successful state not consumed")
            return 0
        attempt.update(successful_fingerprint=fingerprint, last_success_at=now_epoch())
        save_state(attempt)
        log("wake target acknowledged settled state; fingerprint and safety clock committed")
        return 0
    except Exception as error:
        log("heartbeat error; no wake: " + str(error))
        return 1
    finally:
        release_lock(lock_stream)


def launchctl(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run([launchctl_path(), *args], stdin=subprocess.DEVNULL,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=check)


def bootout_if_loaded(domain: str) -> bool:
    result = launchctl("bootout", f"{domain}/{LABEL}", check=False)
    if result.returncode == 0:
        return True
    detail = (result.stdout + "\n" + result.stderr).strip()
    if "No such process" in detail or "Could not find specified service" in detail:
        return False
    raise RuntimeError("launchctl bootout failed: " + (detail or f"exit {result.returncode}"))


def resolved_tool(name: str) -> str:
    override = os.environ.get("SCD_HEARTBEAT_TEST_" + name.upper()) if testing() else None
    path = override or shutil.which(name)
    if not path:
        raise RuntimeError("could not resolve executable absolute path for " + name)
    resolved = Path(os.path.realpath(path))
    if not resolved.is_absolute() or not resolved.is_file() or not os.access(resolved, os.X_OK):
        raise RuntimeError("could not resolve executable absolute path for " + name)
    return str(resolved)


def launch_path() -> str:
    entries = []
    for name in ("node", "pnpm", "cargo", "git", "gh", "codex"):
        path = shutil.which(name)
        if path:
            entries.append(str(Path(os.path.realpath(path)).parent))
    entries.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"])
    return os.pathsep.join(dict.fromkeys(entries))


def default_wake(repo: Path, codex: Path, profile: Path) -> tuple[list[str], dict[str, str], list[dict[str, str]]]:
    if not codex.is_file() or not os.access(codex, os.X_OK):
        raise RuntimeError("audited Codex executable unavailable: " + str(codex))
    companion = codex.with_name("codex-code-mode-host")
    if not companion.is_file() or companion.is_symlink() or not os.access(companion, os.X_OK):
        raise RuntimeError("audited Codex code-mode companion unavailable: " + str(companion))
    if not profile.is_file() or profile.is_symlink():
        raise RuntimeError("SCD profile unavailable or unsafe: " + str(profile))
    metadata = profile.stat()
    if metadata.st_uid != os.getuid() or metadata.st_mode & 0o022:
        raise RuntimeError("SCD profile ownership or permissions unsafe: " + str(profile))
    digest = hashlib.sha256(profile.read_bytes()).hexdigest()
    command = [
        str(codex), "exec", "--profile", profile.stem.replace(".config", ""),
        "--strict-config", "--model", "gpt-6-sol",
        "-c", 'model_reasoning_effort="high"', "-C", str(repo), DEFAULT_PROMPT,
    ]
    required_files = [
        {"path": str(codex), "sha256": hashlib.sha256(codex.read_bytes()).hexdigest()},
        {
            "path": str(companion), "sha256": hashlib.sha256(companion.read_bytes()).hexdigest(),
            "installed_name": "codex-code-mode-host",
        },
        {"path": str(profile), "sha256": digest},
    ]
    return command, {"CODEX_HOME": str(profile.parent)}, required_files


def admission_domain(repo: Path, registry_override: str | None, config_raw: str | None) -> dict[str, Any]:
    home = Path.home().resolve()
    repository = "nurockplayer/tachiko-conductor"
    runs = Path(os.environ.get("TACHIKO_DATA_DIR", str(home / ".tachiko-conductor/runs"))).expanduser().resolve()
    canonical_registry = (home / ".tachiko-conductor/mission-admission/registry.json").resolve()
    inherited_registry = os.environ.get("TACHIKO_MISSION_ADMISSION_PATH")
    registry = Path(registry_override or inherited_registry or canonical_registry).expanduser()
    receipts = Path(os.environ.get("TACHIKO_HEARTBEAT_ADMISSION_RECEIPTS_DIR", str(home / ".tachiko-conductor/mission-admission/heartbeat-receipts"))).expanduser()
    if not registry.is_absolute() or not receipts.is_absolute():
        raise RuntimeError("mission-admission registry and receipt paths must be absolute")
    registry = registry.resolve()
    if registry != canonical_registry or (inherited_registry and Path(inherited_registry).expanduser().resolve() != canonical_registry):
        raise RuntimeError("heartbeat admission registry must resolve to the canonical per-user host path")
    receipts = receipts.resolve()
    if registry == runs or runs in registry.parents or repo == registry or repo in registry.parents:
        raise RuntimeError("mission-admission registry must be host-global and outside Run/repository storage")
    default_config = {"schemaVersion": 1, "revision": "mission-admission-v1", "limits": {"maxCaptains": 1, "maxWriters": 1, "maxHighAutonomy": 1}}
    raw = config_raw or os.environ.get("TACHIKO_MISSION_ADMISSION_CONFIG")
    try:
        config = json.loads(raw) if raw else default_config
    except json.JSONDecodeError as error:
        raise RuntimeError("admission config must be strict revisioned JSON") from error
    if (not isinstance(config, dict) or set(config) != {"schemaVersion", "revision", "limits"}
            or config.get("schemaVersion") != 1 or not isinstance(config.get("revision"), str) or not config["revision"]
            or not isinstance(config.get("limits"), dict) or set(config["limits"]) - {"maxCaptains", "maxWriters", "maxHighAutonomy", "maxPerRepository"}
            or any(type(value) is not int or value < 1 for value in config["limits"].values())
            or any(key not in config["limits"] for key in ("maxCaptains", "maxWriters", "maxHighAutonomy"))):
        raise RuntimeError("admission config must use the supported positive-integer limits schema")
    return {"repository": repository, "workspace": str(repo), "home": str(home), "registry": str(registry),
            "runs": str(runs), "receipts": str(receipts), "config": config}


def install(args: argparse.Namespace) -> int:
    os.umask(0o077)
    repo = Path(args.repo).resolve()
    runner = Path(__file__).resolve()
    if not repo.is_dir() or not (repo / ".git").exists():
        raise RuntimeError("repository directory is not a Git checkout: " + str(repo))
    if args.interval < 1 or args.safety_interval < 1:
        raise RuntimeError("intervals must be positive")
    if Path(args.codex).resolve() != DEFAULT_CODEX or Path(args.profile).resolve() != DEFAULT_PROFILE:
        raise RuntimeError("only the qualified default GPT-6 Sol executable and profile are supported")
    if args.wake_command_json:
        if not testing():
            raise RuntimeError("custom wake targets are disabled until a verified admission and child-containment adapter exists")
        if not args.acknowledge_relocatable_wake_target:
            raise RuntimeError("custom target requires --acknowledge-relocatable-wake-target")
        try:
            wake_command = json.loads(args.wake_command_json)
        except json.JSONDecodeError as error:
            raise RuntimeError("custom wake command must be a JSON string array") from error
        if not isinstance(wake_command, list) or not wake_command or not all(isinstance(item, str) and item for item in wake_command):
            raise RuntimeError("custom wake command must be a non-empty JSON string array")
        custom_executable = Path(wake_command[0])
        if custom_executable.is_symlink() or not custom_executable.is_file() or not os.access(custom_executable, os.X_OK):
            raise RuntimeError("custom wake executable unavailable or unsafe")
        wake_command[0] = str(custom_executable.resolve())
        wake_env = {}
        required_files = [{"path": wake_command[0], "sha256": hashlib.sha256(Path(wake_command[0]).read_bytes()).hexdigest()}]
        for required_path in args.required_file:
            path = Path(required_path).resolve()
            required_files.append({"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
        wake_kind = "test"
    else:
        wake_command, wake_env, required_files = default_wake(repo, Path(args.codex), Path(args.profile))
        wake_kind = "codex"
    domain_config = admission_domain(repo, args.admission_registry_path, args.admission_config_json)
    node_source = Path(resolved_tool("node"))
    gh_source = Path(resolved_tool("gh"))
    config_values = {
        "schema": CONFIG_SCHEMA, "gh": str(gh_source), "gh_sha256": "", "repo": str(repo),
        "runner": str(runner), "runner_sha256": "", "poll_interval_seconds": args.interval,
        "poll_timeout_seconds": DEFAULT_POLL_TIMEOUT_SECONDS,
        "wake_timeout_seconds": DEFAULT_WAKE_TIMEOUT_SECONDS,
        "safety_interval_seconds": args.safety_interval,
        "wake_executable_relocatable": True, "wake_command": wake_command,
        "wake_target_kind": wake_kind, "wake_env": wake_env, "required_files": required_files,
        "admission": domain_config, "admission_node": str(node_source), "admission_node_sha256": "",
        "admission_helper": "", "admission_helper_sha256": "", "admission_helper_files": [],
        "installed_at": now_epoch(),
    }
    plist: dict[str, Any] = {
        "Label": LABEL,
        "ProgramArguments": [],
        "WorkingDirectory": str(repo),
        "StandardInPath": "/dev/null", "StandardOutPath": "/dev/null", "StandardErrorPath": "/dev/null",
        "EnvironmentVariables": {"PATH": launch_path(), "PYTHONDONTWRITEBYTECODE": "1"},
        "RunAtLoad": True, "StartInterval": args.interval, "ProcessType": "Background",
        "LowPriorityIO": True, "Nice": 10, "ThrottleInterval": 30,
    }
    target = plist_path()
    lock_stream = acquire_operator_lock("install")
    previous_config = CONFIG.read_bytes() if CONFIG.exists() else None
    previous_state = STATE.read_bytes() if STATE.exists() else None
    previous_plist = target.read_bytes() if target.exists() else None
    gh_snapshot: Path | None = None
    gh_snapshot_created = False
    runner_snapshot: Path | None = None
    runner_snapshot_created = False
    node_snapshot: Path | None = None
    node_snapshot_created = False
    helper_entry: Path | None = None
    helper_created = False
    service_transitioned = False
    previous_service_loaded = False
    domain = f"gui/{os.getuid()}"
    try:
        gh_snapshot, gh_digest, gh_snapshot_created = pin_github_tool(gh_source)
        runner_snapshot, runner_digest, runner_snapshot_created = pin_runner_source(runner)
        node_snapshot, node_digest, node_snapshot_created = pin_admission_node(node_source)
        helper_entry, helper_digest, helper_files, helper_created = pin_admission_helper(repo)
        config_values.update(
            gh=str(gh_snapshot), gh_sha256=gh_digest,
            runner=str(runner_snapshot), runner_sha256=runner_digest,
            admission_node=str(node_snapshot), admission_node_sha256=node_digest,
            admission_helper=str(helper_entry), admission_helper_sha256=helper_digest,
            admission_helper_files=helper_files,
        )
        plist["ProgramArguments"] = ["/usr/bin/python3", str(runner_snapshot), "run"]
        config = validate_config(config_values)
        verify_wake_target(config)
        prior = load_state() if STATE.exists() else {}
        atomic_write(CONFIG, (json.dumps(config, sort_keys=True) + "\n").encode())
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        atomic_write(target, plistlib.dumps(plist, fmt=plistlib.FMT_XML))
        if not args.no_load:
            previous_service_loaded = bootout_if_loaded(domain)
            service_transitioned = True
            launchctl("bootstrap", domain, str(target))
        if not prior:
            prime(config, "first install")
        else:
            log("preserved valid successful state across reinstall")
        prune_stale_digest_snapshots("verified-gh-", gh_snapshot)
        prune_stale_digest_snapshots("verified-runner-", runner_snapshot)
    except Exception as error:
        rollback_errors: list[str] = []
        for path, previous in ((CONFIG, previous_config), (STATE, previous_state), (target, previous_plist)):
            try:
                restore_optional_file(path, previous)
            except OSError as rollback_error:
                rollback_errors.append(f"restore {path}: {rollback_error}")
        if gh_snapshot_created and gh_snapshot is not None and gh_snapshot.exists():
            try:
                gh_snapshot.unlink()
            except OSError as rollback_error:
                rollback_errors.append(f"remove {gh_snapshot}: {rollback_error}")
        if runner_snapshot_created and runner_snapshot is not None and runner_snapshot.exists():
            try:
                runner_snapshot.unlink()
            except OSError as rollback_error:
                rollback_errors.append(f"remove {runner_snapshot}: {rollback_error}")
        if service_transitioned:
            try:
                bootout_if_loaded(domain)
                if previous_service_loaded and previous_plist is not None:
                    launchctl("bootstrap", domain, str(target))
            except (OSError, subprocess.SubprocessError, RuntimeError) as rollback_error:
                rollback_errors.append("restore launch service: " + str(rollback_error))
        if rollback_errors:
            raise RuntimeError(str(error) + "; rollback failed: " + "; ".join(rollback_errors)) from error
        raise
    finally:
        release_lock(lock_stream)
    print(f"installed {LABEL}; interval={args.interval}s safety={args.safety_interval}s")
    print("runner=" + str(runner_snapshot))
    print("state=" + str(ROOT))
    return 0


def uninstall(args: argparse.Namespace) -> int:
    lock_stream = acquire_operator_lock("uninstall")
    try:
        if not args.no_load:
            bootout_if_loaded(f"gui/{os.getuid()}")
        target = plist_path()
        if target.exists():
            target.unlink()
    finally:
        release_lock(lock_stream)
    print("unloaded and removed plist; state and logs preserved in " + str(ROOT))
    return 0


def status() -> int:
    result = launchctl("print", f"gui/{os.getuid()}/{LABEL}", check=False)
    stream = sys.stdout if result.returncode == 0 else sys.stderr
    print(result.stdout if result.returncode == 0 else result.stderr, end="", file=stream)
    return result.returncode


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser()
    subs = root.add_subparsers(dest="command", required=True)
    run = subs.add_parser("run")
    run.add_argument("--verbose", action="store_true")
    run.add_argument("--prime", action="store_true")
    install_parser = subs.add_parser("install")
    install_parser.add_argument("--repo", default=str(DEFAULT_REPO))
    install_parser.add_argument("--interval", type=int, default=DEFAULT_POLL_SECONDS)
    install_parser.add_argument("--safety-interval", type=int, default=DEFAULT_SAFETY_SECONDS)
    install_parser.add_argument("--codex", default=str(DEFAULT_CODEX))
    install_parser.add_argument("--profile", default=str(DEFAULT_PROFILE))
    install_parser.add_argument("--wake-command-json")
    install_parser.add_argument("--acknowledge-relocatable-wake-target", action="store_true")
    install_parser.add_argument("--required-file", action="append", default=[])
    install_parser.add_argument("--admission-registry-path")
    install_parser.add_argument("--admission-config-json")
    install_parser.add_argument("--no-load", action="store_true", help=argparse.SUPPRESS)
    uninstall_parser = subs.add_parser("uninstall")
    uninstall_parser.add_argument("--no-load", action="store_true", help=argparse.SUPPRESS)
    subs.add_parser("status")
    return root


def main() -> int:
    args = parser().parse_args()
    try:
        if args.command == "run":
            return heartbeat(args.verbose, args.prime)
        if args.command == "install":
            return install(args)
        if args.command == "uninstall":
            return uninstall(args)
        return status()
    except Exception as error:
        print("error: " + str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
