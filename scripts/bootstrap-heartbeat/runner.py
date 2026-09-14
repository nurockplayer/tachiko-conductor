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
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import time
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
CONFIG_SCHEMA = 1
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
        reviewThreads(first: 25) {
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
    wake_env = config.get("wake_env", {})
    if not isinstance(wake_env, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in wake_env.items()):
        raise RuntimeError("invalid wake_env")
    required = config.get("required_files", [])
    if not isinstance(required, list):
        raise RuntimeError("invalid required_files")
    for item in required:
        if not isinstance(item, dict) or not isinstance(item.get("path"), str) or not Path(item["path"]).is_absolute():
            raise RuntimeError("invalid required file")
        if not isinstance(item.get("sha256"), str):
            raise RuntimeError("invalid required file digest")
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


def materialize_verified_executable(source_fd: int) -> Path:
    target = ROOT / "verified-wake-executable"
    temporary = target.with_name(target.name + ".tmp")
    os.lseek(source_fd, 0, os.SEEK_SET)
    with temporary.open("wb") as stream:
        while chunk := os.read(source_fd, 1024 * 1024):
            stream.write(chunk)
        stream.flush()
        os.fsync(stream.fileno())
    os.chmod(temporary, 0o700)
    os.replace(temporary, target)
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
            verify_trusted_path(path)
            required_fd = os.open(path, os.O_RDONLY)
            try:
                metadata = os.fstat(required_fd)
                if not stat.S_ISREG(metadata.st_mode):
                    raise RuntimeError("required wake file unavailable or unsafe: " + str(path))
                if fd_sha256(required_fd) != required["sha256"]:
                    raise RuntimeError("required wake file identity changed: " + str(path))
            finally:
                os.close(required_fd)
        if not executable_pinned:
            raise RuntimeError("wake executable identity is not pinned: " + str(executable))
        return materialize_verified_executable(executable_fd)
    finally:
        os.close(executable_fd)


def linux_process_identity(pid: int) -> tuple[str, str] | None:
    try:
        raw = (Path("/proc") / str(pid) / "stat").read_text(encoding="utf-8")
    except (FileNotFoundError, NotADirectoryError, PermissionError, OSError):
        return None
    closing = raw.rfind(")")
    fields = raw[closing + 2:].split() if closing >= 0 else []
    if len(fields) < 20:
        return None
    return fields[0], fields[19]


def process_group_has_live_members(process_group: int) -> bool | None:
    proc = Path("/proc")
    if proc.is_dir():
        for entry in proc.iterdir():
            if not entry.name.isdigit():
                continue
            try:
                raw = (entry / "stat").read_text(encoding="utf-8")
            except (FileNotFoundError, PermissionError, OSError):
                continue
            closing = raw.rfind(")")
            fields = raw[closing + 2:].split() if closing >= 0 else []
            if len(fields) >= 3 and fields[0] != "Z" and fields[2] == str(process_group):
                return True
        return False
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
            continue
        if pgid == process_group and len(fields) > 1 and not fields[1].startswith("Z"):
            return True
    return False


def spawn_lock_guard(lock_fd: int, timeout_seconds: int) -> tuple[int, int]:
    read_fd, write_fd = os.pipe()
    guard_pid = os.fork()
    if guard_pid:
        os.close(read_fd)
        return guard_pid, write_fd
    try:
        os.close(write_fd)
        message = os.read(read_fd, 64)
        os.close(read_fd)
        if not message:
            os._exit(0)
        target_pid = int(message.splitlines()[0])
        if target_pid < 1:
            os._exit(0)
        initial_linux_identity = linux_process_identity(target_pid) if Path("/proc").is_dir() else None
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
            try:
                os.kill(target_pid, 0)
            except ProcessLookupError:
                direct_exited = True
            except PermissionError:
                pass
            now = time.monotonic()
            if terminate_deadline is None:
                if now < deadline and direct_exited:
                    break
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
            if terminate_deadline is not None and direct_exited:
                group_live = process_group_has_live_members(target_pid)
                if group_live is False:
                    break
                if group_live is None:
                    try:
                        os.killpg(target_pid, 0)
                    except ProcessLookupError:
                        break
            time.sleep(0.05)
    except BaseException:
        time.sleep(timeout_seconds + 10)
    finally:
        os.close(lock_fd)
    os._exit(0)


def run_wake(config: dict[str, Any], lock_fd: int) -> tuple[int, bool]:
    verified_executable = verify_wake_target(config)
    child = None
    guard_pid, guard_write_fd = spawn_lock_guard(lock_fd, config["wake_timeout_seconds"])
    guard_started = False
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

        def publish_guard_pid() -> None:
            os.write(guard_write_fd, (str(os.getpid()) + "\n").encode())
            os.close(guard_write_fd)

        child = subprocess.Popen(
            config["wake_command"], cwd=config["repo"], stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=environment,
            executable=str(verified_executable), start_new_session=True,
            pass_fds=(guard_write_fd,), preexec_fn=publish_guard_pid,
        )
        os.close(guard_write_fd)
        guard_started = True
        assert child.stdout is not None
        os.set_blocking(child.stdout.fileno(), False)
        selector.register(child.stdout, selectors.EVENT_READ)
        deadline = time.monotonic() + config["wake_timeout_seconds"]
        timed_out = False

        def remember(chunk: bytes) -> None:
            output.extend(chunk)
            if len(output) > MAX_WAKE_LOG:
                del output[:-MAX_WAKE_LOG]

        def drain_buffered_tail() -> None:
            # Direct-child exit guarantees its own writes reached the pipe, but
            # descendants may keep the descriptor open. Drain only bytes already
            # available, with explicit time/volume bounds, and never wait for EOF.
            drain_deadline = time.monotonic() + 0.05
            drained = 0
            while drained < MAX_WAKE_LOG * 2 and time.monotonic() < drain_deadline:
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
            atomic_write(WAKE_LOG, bytes(output[-MAX_WAKE_LOG:]))
            return 124, False
        code = child.wait()
        atomic_write(WAKE_LOG, bytes(output[-MAX_WAKE_LOG:]))
        nonempty_lines = [line for line in output.splitlines() if line.strip()]
        settled = code == 0 and bool(nonempty_lines) and nonempty_lines[-1] == SETTLED_MARKER.encode()
        return code, settled
    finally:
        if not guard_started:
            try:
                os.write(guard_write_fd, b"0\n")
            except OSError:
                pass
            os.close(guard_write_fd)
        if child is None or child.poll() is not None:
            os.waitpid(guard_pid, 0)
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
            if type(pid) is not int or pid < 1:
                raise ValueError("invalid pid")
        except (json.JSONDecodeError, KeyError, TypeError, ValueError) as error:
            stream.close()
            raise RuntimeError("ambiguous stale lock metadata; refusing wake") from error
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            log(f"recovered provably stale lock from exited pid {pid}")
        except PermissionError as error:
            stream.close()
            raise RuntimeError("ambiguous stale lock owner; refusing wake") from error
        else:
            stream.close()
            raise RuntimeError("ambiguous unlocked metadata names a live pid; refusing wake")
    stream.seek(0)
    stream.truncate()
    stream.write((json.dumps({"pid": os.getpid(), "acquired_at": now_epoch()}) + "\n").encode())
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
        attempt = dict(state)
        attempt.update(last_attempt_at=now, last_attempt_fingerprint=fingerprint,
                       last_attempt_exit=-1, last_attempt_reason=reason)
        save_state(attempt)
        log("waking target: " + reason)
        # The dedicated guard retains the flock if this supervisor is killed. A
        # replacement runner cannot overlap an orphaned wake target on this host.
        code, settled = run_wake(config, lock_stream.fileno())
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
    if not path or not Path(path).is_absolute() or not os.access(path, os.X_OK):
        raise RuntimeError("could not resolve executable absolute path for " + name)
    return path


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
    if not profile.is_file() or profile.is_symlink():
        raise RuntimeError("SCD profile unavailable or unsafe: " + str(profile))
    metadata = profile.stat()
    if metadata.st_uid != os.getuid() or metadata.st_mode & 0o022:
        raise RuntimeError("SCD profile ownership or permissions unsafe: " + str(profile))
    digest = hashlib.sha256(profile.read_bytes()).hexdigest()
    command = [
        str(codex), "exec", "--profile", profile.stem.replace(".config", ""),
        "--strict-config", "--model", "gpt-5.6-terra",
        "-c", 'model_reasoning_effort="high"', "-C", str(repo), DEFAULT_PROMPT,
    ]
    required_files = [
        {"path": str(codex), "sha256": hashlib.sha256(codex.read_bytes()).hexdigest()},
        {"path": str(profile), "sha256": digest},
    ]
    return command, {"CODEX_HOME": str(profile.parent)}, required_files


def install(args: argparse.Namespace) -> int:
    os.umask(0o077)
    repo = Path(args.repo).resolve()
    runner = Path(__file__).resolve()
    if not repo.is_dir() or not (repo / ".git").exists():
        raise RuntimeError("repository directory is not a Git checkout: " + str(repo))
    if args.interval < 1 or args.safety_interval < 1:
        raise RuntimeError("intervals must be positive")
    if args.wake_command_json:
        if not args.acknowledge_relocatable_wake_target:
            raise RuntimeError(
                "custom wake target requires --acknowledge-relocatable-wake-target; "
                "scripts and binaries that depend on their executable location are unsupported"
            )
        try:
            wake_command = json.loads(args.wake_command_json)
        except json.JSONDecodeError as error:
            raise RuntimeError("invalid --wake-command-json") from error
        wake_env: dict[str, str] = {}
        if not isinstance(wake_command, list) or not wake_command or not isinstance(wake_command[0], str):
            raise RuntimeError("invalid --wake-command-json")
        wake_executable = Path(wake_command[0])
        if not wake_executable.is_absolute() or not wake_executable.is_file() or wake_executable.is_symlink():
            raise RuntimeError("custom wake executable unavailable")
        required_files = [{
            "path": str(wake_executable),
            "sha256": hashlib.sha256(wake_executable.read_bytes()).hexdigest(),
        }]
        for required_name in args.required_file:
            required_path = Path(required_name)
            if not required_path.is_absolute() or not required_path.is_file() or required_path.is_symlink():
                raise RuntimeError("custom required wake file unavailable: " + str(required_path))
            if required_path.resolve() != wake_executable.resolve():
                required_files.append({
                    "path": str(required_path),
                    "sha256": hashlib.sha256(required_path.read_bytes()).hexdigest(),
                })
    else:
        wake_command, wake_env, required_files = default_wake(repo, Path(args.codex), Path(args.profile))
    config = validate_config({
        "schema": CONFIG_SCHEMA, "gh": resolved_tool("gh"), "repo": str(repo),
        "runner": str(runner), "poll_interval_seconds": args.interval,
        "poll_timeout_seconds": DEFAULT_POLL_TIMEOUT_SECONDS,
        "wake_timeout_seconds": DEFAULT_WAKE_TIMEOUT_SECONDS,
        "safety_interval_seconds": args.safety_interval,
        "wake_executable_relocatable": True, "wake_command": wake_command,
        "wake_env": wake_env, "required_files": required_files, "installed_at": now_epoch(),
    })
    plist = {
        "Label": LABEL,
        "ProgramArguments": ["/usr/bin/python3", str(runner), "run"],
        "WorkingDirectory": str(repo),
        "StandardInPath": "/dev/null", "StandardOutPath": "/dev/null", "StandardErrorPath": "/dev/null",
        "EnvironmentVariables": {"PATH": launch_path(), "PYTHONDONTWRITEBYTECODE": "1"},
        "RunAtLoad": True, "StartInterval": args.interval, "ProcessType": "Background",
        "LowPriorityIO": True, "Nice": 10, "ThrottleInterval": 30,
    }
    target = plist_path()
    lock_stream = acquire_operator_lock("install")
    try:
        verify_wake_target(config)
        prior = load_state() if STATE.exists() else {}
        atomic_write(CONFIG, (json.dumps(config, sort_keys=True) + "\n").encode())
        if not prior:
            prime(config, "first install")
        else:
            log("preserved valid successful state across reinstall")
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        atomic_write(target, plistlib.dumps(plist, fmt=plistlib.FMT_XML))
        if not args.no_load:
            domain = f"gui/{os.getuid()}"
            bootout_if_loaded(domain)
            launchctl("bootstrap", domain, str(target))
    finally:
        release_lock(lock_stream)
    print(f"installed {LABEL}; interval={args.interval}s safety={args.safety_interval}s")
    print("runner=" + str(runner))
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
