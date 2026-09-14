#!/usr/bin/python3
"""Deterministic integration tests; real GitHub, launchctl, and Codex are never used."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import time
import unittest


HERE = Path(__file__).resolve().parent
RUNNER = HERE / "runner.py"


class HeartbeatTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix=".tachiko-conductor-heartbeat-", dir=Path.home())
        self.root = Path(self.temp.name)
        self.state_root = self.root / "state"
        self.payload = self.root / "payload.json"
        self.calls = self.root / "calls.jsonl"
        self.gh = self.root / "gh"
        self.wake = self.root / "wake"
        self.launchctl = self.root / "launchctl"
        self.plist = self.root / "LaunchAgents" / "heartbeat.plist"
        self.gh.write_text(
            "#!/usr/bin/python3\nimport os, pathlib, time\n"
            "time.sleep(float(os.environ.get('MOCK_GH_SLEEP', '0')))\n"
            "print(pathlib.Path(os.environ['MOCK_GH_PAYLOAD']).read_text(), end='')\n",
            encoding="utf-8",
        )
        self.wake.write_text(
            "#!/usr/bin/python3\n"
            "import json, os, pathlib, sys, time\n"
            "with pathlib.Path(os.environ['MOCK_WAKE_CALLS']).open('a') as f: "
            "f.write(json.dumps({'args': sys.argv[1:]}) + '\\n')\n"
            "print('x' * int(os.environ.get('MOCK_WAKE_OUTPUT', '0')))\n"
            "background = float(os.environ.get('MOCK_WAKE_BACKGROUND_SLEEP', '0'))\n"
            "if background:\n"
            "    pid = os.fork()\n"
            "    if pid == 0:\n"
            "        if os.environ.get('MOCK_WAKE_BACKGROUND_IGNORE_TERM') == '1':\n"
            "            import signal; signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
            "        if os.environ.get('MOCK_WAKE_BACKGROUND_KEEP_OUTPUT') != '1':\n"
            "            os.close(1); os.close(2)\n"
            "        time.sleep(background); os._exit(0)\n"
            "    pathlib.Path(os.environ['MOCK_WAKE_BACKGROUND_PID']).write_text(str(pid))\n"
            "time.sleep(float(os.environ.get('MOCK_WAKE_SLEEP', '0')))\n"
            "if os.environ.get('MOCK_WAKE_SETTLED', '1') == '1':\n"
            "    print('TACHIKO_HEARTBEAT_SETTLED_V1')\n"
            "if os.environ.get('MOCK_WAKE_AFTER_SETTLED'):\n"
            "    print(os.environ['MOCK_WAKE_AFTER_SETTLED'])\n"
            "sys.exit(int(os.environ.get('MOCK_WAKE_EXIT', '0')))\n",
            encoding="utf-8",
        )
        self.launchctl.write_text(
            "#!/bin/sh\n"
            "if [ \"${1:-}\" = print ]; then echo 'mock launch agent loaded'; exit 0; fi\n"
            "if [ \"${1:-}\" = bootout ]; then echo 'Could not find specified service' >&2; exit 3; fi\n"
            "exit 0\n",
            encoding="utf-8",
        )
        for executable in (self.gh, self.wake, self.launchctl):
            executable.chmod(0o700)
        self.write_payload("A")
        self.env = os.environ.copy()
        self.env.update({
            "SCD_HEARTBEAT_TESTING": "1",
            "SCD_HEARTBEAT_TEST_ROOT": str(self.state_root),
            "SCD_HEARTBEAT_TEST_PLIST": str(self.plist),
            "SCD_HEARTBEAT_TEST_LAUNCHCTL": str(self.launchctl),
            "SCD_HEARTBEAT_TEST_GH": str(self.gh),
            "SCD_HEARTBEAT_TEST_NOW": "1000",
            "MOCK_GH_PAYLOAD": str(self.payload),
            "MOCK_WAKE_CALLS": str(self.calls),
            "MOCK_WAKE_BACKGROUND_PID": str(self.root / "background.pid"),
        })
        self.write_config()

    def tearDown(self) -> None:
        self.temp.cleanup()

    def write_config(self, *, safety: int = 1800) -> None:
        self.state_root.mkdir(parents=True, exist_ok=True)
        config = {
            "schema": 1,
            "gh": str(self.gh),
            "repo": str(Path.cwd()),
            "runner": str(RUNNER),
            "poll_interval_seconds": 180,
            "poll_timeout_seconds": 60,
            "wake_timeout_seconds": 1500,
            "safety_interval_seconds": safety,
            "wake_executable_relocatable": True,
            "wake_command": [str(self.wake), "dispatchable-target"],
            "wake_env": {},
            "required_files": [{
                "path": str(self.wake), "sha256": hashlib.sha256(self.wake.read_bytes()).hexdigest()
            }],
            "installed_at": 1000,
        }
        (self.state_root / "config.json").write_text(json.dumps(config), encoding="utf-8")

    def write_payload(self, oid: str, *, reverse: bool = False, truncated: bool = False) -> None:
        issues = [
            {
                "number": 36, "state": "OPEN", "title": "Heartbeat", "body": "contract-v1",
                "labels": {"pageInfo": {"hasNextPage": False}, "nodes": []},
                "assignees": {"pageInfo": {"hasNextPage": False}, "nodes": [{"login": "owner"}]},
                "comments": {"pageInfo": {"hasNextPage": truncated}, "nodes": [
                    {"databaseId": 1, "body": "ordinary comment", "updatedAt": "2026-09-14T00:00:00Z"},
                    {"databaseId": 2, "body": "<!-- agent-handoff:v1 -->\nREADY", "updatedAt": "2026-09-14T00:00:00Z"},
                ]},
            },
            {
                "number": 34, "state": "OPEN", "title": "Policy", "body": "standing-policy",
                "labels": {"pageInfo": {"hasNextPage": False}, "nodes": []},
                "assignees": {"pageInfo": {"hasNextPage": False}, "nodes": []},
                "comments": {"pageInfo": {"hasNextPage": False}, "nodes": []},
            },
        ]
        if reverse:
            issues.reverse()
        pr = {
            "number": 31, "state": "OPEN", "title": "Existing lane", "body": "Closes #20",
            "isDraft": False,
            "headRefOid": oid, "headRefName": "feature",
            "headRepository": {"nameWithOwner": "nurockplayer/tachiko-conductor"},
            "baseRefOid": "base", "baseRefName": "main", "mergeable": "MERGEABLE",
            "mergeStateStatus": "CLEAN",
            "reviewDecision": "APPROVED",
            "closingIssuesReferences": {"pageInfo": {"hasNextPage": False}, "nodes": [
                {"number": 36, "repository": {"nameWithOwner": "nurockplayer/tachiko-conductor"}}
            ]},
            "labels": {"pageInfo": {"hasNextPage": False}, "nodes": []},
            "assignees": {"pageInfo": {"hasNextPage": False}, "nodes": []},
            "comments": {"pageInfo": {"hasNextPage": False}, "nodes": []},
            "reviews": {"pageInfo": {"hasPreviousPage": False}, "nodes": [
                {"databaseId": 41, "author": {"login": "reviewer"}, "state": "APPROVED",
                 "body": "top-level review", "submittedAt": "2026-09-14T00:00:00Z",
                 "updatedAt": "2026-09-14T00:00:00Z", "commit": {"oid": oid}}
            ]},
            "reviewThreads": {"pageInfo": {"hasNextPage": False}, "nodes": [{
                "isResolved": False,
                "comments": {"pageInfo": {"hasNextPage": False}, "nodes": [{
                    "databaseId": 51, "body": "review feedback v1", "updatedAt": "2026-09-14T00:00:00Z"
                }, {
                    "databaseId": 52, "body": "later reply", "updatedAt": "2026-09-14T00:00:30Z"
                }]},
            }]},
            "commits": {"nodes": [{"commit": {"oid": oid, "statusCheckRollup": {
                "state": "SUCCESS", "contexts": {
                    "pageInfo": {"hasNextPage": False}, "nodes": []
                }
            }}}]},
        }
        data = {"data": {"rateLimit": {
            "cost": 75, "remaining": 4925, "resetAt": "2026-09-14T01:00:00Z",
        }, "repository": {
            "defaultBranchRef": {"name": "main", "target": {"oid": oid}},
            "issues": {"pageInfo": {"hasNextPage": False}, "nodes": issues},
            "pullRequests": {"pageInfo": {"hasNextPage": False}, "nodes": [pr]},
        }}}
        self.payload.write_text(json.dumps(data), encoding="utf-8")

    def invoke(self, command: str = "run", *args: str, env: dict[str, str] | None = None,
               check: bool = True) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(RUNNER), command, *args], env=env or self.env,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=check,
        )

    def records(self) -> list[dict[str, object]]:
        if not self.calls.exists():
            return []
        return [json.loads(line) for line in self.calls.read_text(encoding="utf-8").splitlines()]

    def state(self) -> dict[str, object]:
        return json.loads((self.state_root / "state.json").read_text(encoding="utf-8"))

    def test_change_safety_retry_and_post_success_quiet(self) -> None:
        self.invoke("run", "--prime")
        self.invoke("run", "--verbose", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="1179"))
        self.assertEqual(self.records(), [], "unchanged cheap poll must not wake")

        self.invoke("run", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="2800"))
        self.assertEqual(len(self.records()), 1, "safety interval must wake exactly once")
        self.assertEqual(self.state()["last_attempt_reason"], "safety reconciliation interval elapsed")
        self.invoke("run", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="2801"))
        self.assertEqual(len(self.records()), 1, "successful safety wake resets the clock")

        self.write_payload("B")
        self.invoke("run", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="2802"))
        self.assertEqual(len(self.records()), 2, "material exact-HEAD change must wake once")
        self.invoke("run", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="2803"))
        self.assertEqual(len(self.records()), 2, "successful changed fingerprint must be consumed")

        self.write_payload("C")
        failed = dict(self.env, SCD_HEARTBEAT_TEST_NOW="2804", MOCK_WAKE_EXIT="7")
        self.assertEqual(self.invoke("run", env=failed, check=False).returncode, 7)
        self.assertNotEqual(self.state()["successful_fingerprint"], self.state()["last_attempt_fingerprint"])
        self.invoke("run", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="2805"))
        self.assertEqual(len(self.records()), 4, "failed wake must retry unconsumed change")
        self.assertEqual(self.records()[0]["args"], ["dispatchable-target"])

    def test_canonicalization_ignores_connection_order(self) -> None:
        self.invoke("run", "--prime")
        self.write_payload("A", reverse=True)
        self.invoke("run", "--verbose", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="1179"))
        self.assertEqual(self.records(), [])

    def test_exit_zero_without_settled_acknowledgement_remains_retryable(self) -> None:
        self.invoke("run", "--prime")
        initial_success_at = self.state()["last_success_at"]
        self.write_payload("B")
        unfinished = dict(
            self.env, SCD_HEARTBEAT_TEST_NOW="1001", MOCK_WAKE_SETTLED="0",
        )
        self.assertEqual(self.invoke("run", env=unfinished).returncode, 0)
        self.assertEqual(len(self.records()), 1)
        self.assertNotEqual(
            self.state()["successful_fingerprint"], self.state()["last_attempt_fingerprint"],
        )
        self.assertEqual(self.state()["last_success_at"], initial_success_at)

        self.invoke("run", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="1002"))
        self.assertEqual(len(self.records()), 2, "unsettled exit 0 must retry the same change")
        self.assertEqual(
            self.state()["successful_fingerprint"], self.state()["last_attempt_fingerprint"],
        )
        self.assertEqual(self.state()["last_success_at"], 1002)

    def test_only_final_nonempty_output_line_acknowledges_settled(self) -> None:
        self.invoke("run", "--prime")
        self.write_payload("B")
        continued = dict(
            self.env, SCD_HEARTBEAT_TEST_NOW="1001",
            MOCK_WAKE_AFTER_SETTLED="continued non-terminal output",
        )
        self.assertEqual(self.invoke("run", env=continued).returncode, 0)
        self.assertNotEqual(
            self.state()["successful_fingerprint"], self.state()["last_attempt_fingerprint"],
            "an earlier marker followed by output must not settle",
        )

        self.assertEqual(
            self.invoke("run", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="1002")).returncode, 0,
        )
        self.assertEqual(
            self.state()["successful_fingerprint"], self.state()["last_attempt_fingerprint"],
            "the exact marker as final non-empty line must settle",
        )

    def test_fast_exit_and_large_output_tail_preserve_final_settled_marker(self) -> None:
        self.invoke("run", "--prime")
        for index, output_size in enumerate((0, 700 * 1024), start=1):
            with self.subTest(output_size=output_size):
                self.write_payload(f"tail-{index}")
                environment = dict(
                    self.env,
                    SCD_HEARTBEAT_TEST_NOW=str(1000 + index),
                    MOCK_WAKE_OUTPUT=str(output_size),
                    SCD_HEARTBEAT_TEST_PRE_DRAIN_SLEEP="0.1",
                )
                self.assertEqual(self.invoke("run", env=environment).returncode, 0)
                self.assertEqual(
                    self.state()["successful_fingerprint"],
                    self.state()["last_attempt_fingerprint"],
                    "the final marker must be drained and committed after direct exit",
                )

    def test_ordinary_execution_comment_edit_is_meaningful(self) -> None:
        self.invoke("run", "--prime")
        data = json.loads(self.payload.read_text(encoding="utf-8"))
        comment = data["data"]["repository"]["issues"]["nodes"][0]["comments"]["nodes"][0]
        comment["body"] = "clarified execution comment"
        comment["updatedAt"] = "2026-09-14T00:01:00Z"
        self.payload.write_text(json.dumps(data), encoding="utf-8")
        self.invoke("run", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="1001"))
        self.assertEqual(len(self.records()), 1, "ordinary execution comments must wake promptly")

    def test_issue_contract_body_edit_is_meaningful(self) -> None:
        self.invoke("run", "--prime")
        data = json.loads(self.payload.read_text(encoding="utf-8"))
        data["data"]["repository"]["issues"]["nodes"][0]["body"] = "contract-v2"
        self.payload.write_text(json.dumps(data), encoding="utf-8")
        self.invoke("run", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="1001"))
        self.assertEqual(len(self.records()), 1, "Issue body edits must wake before the safety interval")

    def test_existing_inline_review_comment_edit_is_meaningful(self) -> None:
        self.invoke("run", "--prime")
        data = json.loads(self.payload.read_text(encoding="utf-8"))
        comment = data["data"]["repository"]["pullRequests"]["nodes"][0]["reviewThreads"]["nodes"][0]["comments"]["nodes"][0]
        comment["body"] = "review feedback v2"
        comment["updatedAt"] = "2026-09-14T00:01:00Z"
        self.payload.write_text(json.dumps(data), encoding="utf-8")
        self.invoke("run", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="1001"))
        self.assertEqual(len(self.records()), 1, "edited earlier inline feedback must wake before safety")

    def test_top_level_review_body_edit_is_meaningful(self) -> None:
        self.invoke("run", "--prime")
        data = json.loads(self.payload.read_text(encoding="utf-8"))
        review = data["data"]["repository"]["pullRequests"]["nodes"][0]["reviews"]["nodes"][0]
        review["body"] = "corrected top-level review"
        review["updatedAt"] = "2026-09-14T00:01:00Z"
        self.payload.write_text(json.dumps(data), encoding="utf-8")
        self.invoke("run", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="1001"))
        self.assertEqual(len(self.records()), 1, "edited top-level review must wake before safety")

    def test_bootstrap_authority_changes_are_meaningful(self) -> None:
        paths_and_values = (
            (("defaultBranchRef", "name"), "release"),
            (("pullRequests", "nodes", 0, "mergeStateStatus"), "BLOCKED"),
            (("pullRequests", "nodes", 0, "closingIssuesReferences", "nodes"), []),
            (("pullRequests", "nodes", 0, "baseRefName"), "release"),
            (("pullRequests", "nodes", 0, "headRefName"), "renamed-feature"),
            (("pullRequests", "nodes", 0, "headRepository", "nameWithOwner"), "fork/other"),
        )
        for path, value in paths_and_values:
            with self.subTest(path=path):
                self.invoke("run", "--prime")
                data = json.loads(self.payload.read_text(encoding="utf-8"))
                target = data["data"]["repository"]
                for part in path[:-1]:
                    target = target[part]
                target[path[-1]] = value
                self.payload.write_text(json.dumps(data), encoding="utf-8")
                self.invoke("run", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="1001"))
                self.assertEqual(len(self.records()), 1, "bootstrap authority change must wake")
                self.calls.unlink()
                self.write_payload("A")

    def test_stalled_github_poll_times_out_and_fails_closed(self) -> None:
        self.invoke("run", "--prime")
        config_path = self.state_root / "config.json"
        config = json.loads(config_path.read_text(encoding="utf-8"))
        config["poll_timeout_seconds"] = 1
        config_path.write_text(json.dumps(config), encoding="utf-8")
        started = time.monotonic()
        self.assertEqual(self.invoke("run", env=dict(self.env, MOCK_GH_SLEEP="2"), check=False).returncode, 1)
        self.assertLess(time.monotonic() - started, 1.8)
        self.assertEqual(self.records(), [], "timed-out poll must never wake")

    def test_expensive_github_query_fails_closed(self) -> None:
        data = json.loads(self.payload.read_text(encoding="utf-8"))
        data["data"]["rateLimit"]["cost"] = 101
        self.payload.write_text(json.dumps(data), encoding="utf-8")
        self.assertEqual(self.invoke("run", "--prime", check=False).returncode, 1)
        self.assertEqual(self.records(), [], "over-budget polling must never wake")

    def test_overlap_and_stale_lock_policy(self) -> None:
        self.invoke("run", "--prime")
        self.write_payload("B")
        sleeping = dict(self.env, SCD_HEARTBEAT_TEST_NOW="1001", MOCK_WAKE_SLEEP="1")
        first = subprocess.Popen([sys.executable, str(RUNNER), "run"], env=sleeping)
        deadline = time.time() + 5
        while not self.calls.exists() and time.time() < deadline:
            time.sleep(0.02)
        self.invoke("run", "--verbose", env=sleeping)
        first.wait(timeout=5)
        self.assertEqual(len(self.records()), 1, "atomic overlap must start only one writer")

        (self.state_root / "runner.lock").write_text("not-json\n", encoding="utf-8")
        self.write_payload("C")
        self.assertEqual(self.invoke("run", check=False).returncode, 1)
        self.assertEqual(len(self.records()), 1, "ambiguous lock metadata must fail closed")

        (self.state_root / "runner.lock").write_text('{"pid":true}\n', encoding="utf-8")
        self.assertEqual(self.invoke("run", check=False).returncode, 1)
        self.assertEqual(len(self.records()), 1, "boolean lock pid must fail closed")

        (self.state_root / "runner.lock").write_text(json.dumps({"pid": os.getpid()}) + "\n", encoding="utf-8")
        self.assertEqual(self.invoke("run", check=False).returncode, 1)
        self.assertEqual(len(self.records()), 1, "unlocked metadata naming live pid is ambiguous")

        (self.state_root / "runner.lock").write_text('{"pid":999999}\n', encoding="utf-8")
        self.invoke("run")
        self.assertEqual(len(self.records()), 2, "provably exited stale owner may recover")

    def test_wake_child_keeps_lock_if_supervisor_is_killed(self) -> None:
        self.invoke("run", "--prime")
        self.write_payload("B")
        sleeping = dict(self.env, SCD_HEARTBEAT_TEST_NOW="1001", MOCK_WAKE_SLEEP="2")
        first = subprocess.Popen([sys.executable, str(RUNNER), "run"], env=sleeping)
        deadline = time.time() + 5
        while len(self.records()) < 1 and time.time() < deadline:
            time.sleep(0.02)
        self.assertEqual(len(self.records()), 1, "first wake target must have started")

        first.kill()
        first.wait(timeout=5)
        self.invoke("run", "--verbose", env=sleeping)
        self.assertEqual(
            len(self.records()), 1,
            "orphaned wake child must retain the lock after supervisor death",
        )

        time.sleep(2.1)
        self.invoke("run", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="1002"))
        self.assertEqual(len(self.records()), 2, "runner may recover only after the child exits")

    def test_lock_guard_enforces_timeout_after_supervisor_is_killed(self) -> None:
        self.invoke("run", "--prime")
        self.write_payload("B")
        config_path = self.state_root / "config.json"
        config = json.loads(config_path.read_text(encoding="utf-8"))
        config["wake_timeout_seconds"] = 1
        config_path.write_text(json.dumps(config), encoding="utf-8")
        sleeping = dict(self.env, SCD_HEARTBEAT_TEST_NOW="1001", MOCK_WAKE_SLEEP="10")
        first = subprocess.Popen([sys.executable, str(RUNNER), "run"], env=sleeping)
        deadline = time.time() + 5
        while len(self.records()) < 1 and time.time() < deadline:
            time.sleep(0.02)
        self.assertEqual(len(self.records()), 1, "first wake target must have started")
        first.kill()
        first.wait(timeout=5)
        self.invoke("run", "--verbose", env=sleeping)
        self.assertEqual(len(self.records()), 1, "guard must retain the lock after supervisor death")

        deadline = time.time() + 7
        while time.time() < deadline:
            self.invoke("run", "--verbose", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="1002"))
            if len(self.records()) == 2:
                break
            time.sleep(0.1)
        self.assertEqual(
            len(self.records()), 2,
            "guard must terminate the timed-out direct target before releasing the lock",
        )

    def test_orphan_timeout_kills_term_resistant_process_group_before_unlock(self) -> None:
        self.invoke("run", "--prime")
        self.write_payload("B")
        config_path = self.state_root / "config.json"
        config = json.loads(config_path.read_text(encoding="utf-8"))
        config["wake_timeout_seconds"] = 1
        config_path.write_text(json.dumps(config), encoding="utf-8")
        sleeping = dict(
            self.env, SCD_HEARTBEAT_TEST_NOW="1001", MOCK_WAKE_SLEEP="10",
            MOCK_WAKE_BACKGROUND_SLEEP="10", MOCK_WAKE_BACKGROUND_IGNORE_TERM="1",
        )
        first = subprocess.Popen([sys.executable, str(RUNNER), "run"], env=sleeping)
        deadline = time.time() + 5
        while len(self.records()) < 1 and time.time() < deadline:
            time.sleep(0.02)
        self.assertEqual(len(self.records()), 1)
        first.kill()
        first.wait(timeout=5)

        deadline = time.time() + 4
        while time.time() < deadline:
            self.invoke("run", "--verbose", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="1002"))
            self.assertEqual(len(self.records()), 1, "TERM-resistant descendant must keep guard locked")
            time.sleep(0.2)

        deadline = time.time() + 5
        while time.time() < deadline:
            self.invoke("run", "--verbose", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="1002"))
            if len(self.records()) == 2:
                break
            time.sleep(0.1)
        self.assertEqual(len(self.records()), 2, "guard must unlock only after process-group cleanup")

    def test_wake_descendant_cannot_retain_lock_after_direct_child_exits(self) -> None:
        self.invoke("run", "--prime")
        self.write_payload("B")
        background_pid_path = self.root / "background.pid"
        background = dict(self.env, SCD_HEARTBEAT_TEST_NOW="1001", MOCK_WAKE_BACKGROUND_SLEEP="5")
        self.invoke("run", env=background)
        background_pid = int(background_pid_path.read_text(encoding="utf-8"))
        try:
            os.kill(background_pid, 0)
            self.write_payload("C")
            self.invoke("run", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="1002"))
            self.assertEqual(
                len(self.records()), 2,
                "a background descendant must not retain the single-writer lock",
            )
        finally:
            try:
                os.kill(background_pid, 9)
            except ProcessLookupError:
                pass

    def test_direct_exit_does_not_wait_for_descendant_output_eof(self) -> None:
        self.invoke("run", "--prime")
        self.write_payload("B")
        config_path = self.state_root / "config.json"
        config = json.loads(config_path.read_text(encoding="utf-8"))
        config["wake_timeout_seconds"] = 2
        config_path.write_text(json.dumps(config), encoding="utf-8")
        background_pid_path = self.root / "background.pid"
        environment = dict(
            self.env,
            SCD_HEARTBEAT_TEST_NOW="1001",
            MOCK_WAKE_BACKGROUND_SLEEP="5",
            MOCK_WAKE_BACKGROUND_KEEP_OUTPUT="1",
        )
        started = time.monotonic()
        result = self.invoke("run", env=environment, check=False)
        background_pid = int(background_pid_path.read_text(encoding="utf-8"))
        try:
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertLess(time.monotonic() - started, 1.5)
            self.assertEqual(self.state()["last_attempt_exit"], 0)
        finally:
            try:
                os.kill(background_pid, 9)
            except ProcessLookupError:
                pass

    def test_stalled_wake_times_out_without_consuming_change(self) -> None:
        self.invoke("run", "--prime")
        self.write_payload("B")
        config_path = self.state_root / "config.json"
        config = json.loads(config_path.read_text(encoding="utf-8"))
        config["wake_timeout_seconds"] = 1
        config_path.write_text(json.dumps(config), encoding="utf-8")
        started = time.monotonic()
        stalled = dict(self.env, SCD_HEARTBEAT_TEST_NOW="1001", MOCK_WAKE_SLEEP="2")
        result = self.invoke("run", env=stalled, check=False)
        heartbeat_log = (self.state_root / "heartbeat.log").read_text(encoding="utf-8")
        self.assertEqual(result.returncode, 124, result.stderr + heartbeat_log)
        self.assertLess(time.monotonic() - started, 1.8)
        self.assertEqual(self.state()["last_attempt_exit"], 124)
        self.assertNotEqual(self.state()["successful_fingerprint"], self.state()["last_attempt_fingerprint"])
        self.invoke("run", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="1002"))
        self.assertEqual(len(self.records()), 2, "timed-out wake must leave the change retryable")

    def test_exec_failure_releases_guard_and_leaves_change_retryable(self) -> None:
        self.invoke("run", "--prime")
        self.write_payload("B")
        unavailable = self.root / "missing-interpreter-target"
        unavailable.write_text("#!/definitely/missing/interpreter\n", encoding="utf-8")
        unavailable.chmod(0o700)
        config_path = self.state_root / "config.json"
        config = json.loads(config_path.read_text(encoding="utf-8"))
        config["wake_timeout_seconds"] = 1
        config["wake_command"] = [str(unavailable)]
        config["required_files"] = [{
            "path": str(unavailable),
            "sha256": hashlib.sha256(unavailable.read_bytes()).hexdigest(),
        }]
        config_path.write_text(json.dumps(config), encoding="utf-8")
        started = time.monotonic()
        self.assertEqual(self.invoke("run", check=False).returncode, 1)
        self.assertLess(time.monotonic() - started, 2)
        self.write_config()
        self.invoke("run", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="1002"))
        self.assertEqual(len(self.records()), 1, "exec failure must release the guard for retry")

    def test_poll_and_config_fail_closed_and_logs_are_bounded(self) -> None:
        self.invoke("run", "--prime")
        self.write_payload("B", truncated=True)
        self.assertEqual(self.invoke("run", check=False).returncode, 1)
        self.assertEqual(self.records(), [])
        self.assertIn("snapshot truncated", (self.state_root / "heartbeat.log").read_text(encoding="utf-8"))

        self.write_payload("A")
        config = json.loads((self.state_root / "config.json").read_text(encoding="utf-8"))
        config["wake_command"] = ["relative-command"]
        (self.state_root / "config.json").write_text(json.dumps(config), encoding="utf-8")
        self.assertEqual(self.invoke("run", check=False).returncode, 1)
        self.assertEqual(self.records(), [])

        self.write_config()
        (self.state_root / "heartbeat.log").write_bytes(b"z" * (80 * 1024))
        self.invoke("run", "--verbose", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="1179"))
        self.assertLessEqual((self.state_root / "heartbeat.log").stat().st_size, 64 * 1024)

        self.write_payload("B")
        self.invoke("run", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="1180", MOCK_WAKE_OUTPUT=str(700 * 1024)))
        self.assertLessEqual((self.state_root / "wake.log").stat().st_size, 512 * 1024)

    def test_boolean_integer_fields_fail_closed(self) -> None:
        self.invoke("run", "--prime")
        self.write_payload("B")
        config_path = self.state_root / "config.json"
        valid_config = json.loads(config_path.read_text(encoding="utf-8"))
        for field in (
            "schema", "poll_interval_seconds", "poll_timeout_seconds",
            "wake_timeout_seconds", "safety_interval_seconds",
        ):
            with self.subTest(config_field=field):
                invalid_config = dict(valid_config, **{field: True})
                config_path.write_text(json.dumps(invalid_config), encoding="utf-8")
                self.assertEqual(self.invoke("run", check=False).returncode, 1)
                self.assertEqual(self.records(), [], "boolean config integer must never wake")
        config_path.write_text(json.dumps(valid_config), encoding="utf-8")

        state_path = self.state_root / "state.json"
        valid_state = self.state()
        for field in (
            "schema", "last_success_at", "last_attempt_at", "last_attempt_exit",
        ):
            with self.subTest(state_field=field):
                invalid_state = dict(valid_state, **{field: True})
                state_path.write_text(json.dumps(invalid_state), encoding="utf-8")
                self.assertEqual(self.invoke("run", check=False).returncode, 1)
                self.assertEqual(self.records(), [], "boolean state integer must never wake")
        state_path.write_text(json.dumps(valid_state), encoding="utf-8")

    def test_install_status_uninstall_and_plist_are_idempotent(self) -> None:
        if (self.state_root / "state.json").exists():
            (self.state_root / "state.json").unlink()
        command = json.dumps([str(self.wake), "future-dispatch-once"])
        args = (
            "--repo", str(Path.cwd()), "--interval", "180", "--safety-interval", "1800",
            "--wake-command-json", command, "--acknowledge-relocatable-wake-target", "--no-load",
        )
        self.invoke("install", *args)
        before = (self.state_root / "state.json").read_bytes()
        self.invoke("install", *args)
        self.assertEqual((self.state_root / "state.json").read_bytes(), before)
        with self.plist.open("rb") as stream:
            plist = plistlib.load(stream)
        self.assertEqual(plist["StartInterval"], 180)
        self.assertEqual(plist["WorkingDirectory"], str(Path.cwd()))
        self.assertEqual(plist["ProgramArguments"], ["/usr/bin/python3", str(RUNNER), "run"])
        config = json.loads((self.state_root / "config.json").read_text(encoding="utf-8"))
        self.assertEqual(config["wake_command"], [str(self.wake), "future-dispatch-once"])
        self.assertEqual(self.invoke("status").returncode, 0)
        self.invoke("uninstall", "--no-load")
        self.invoke("uninstall", "--no-load")
        self.assertFalse(self.plist.exists())
        self.assertTrue((self.state_root / "state.json").exists(), "uninstall preserves evidence/state")

    def test_reinstall_cannot_race_an_active_wake_snapshot(self) -> None:
        self.invoke("run", "--prime")
        self.write_payload("B")
        sleeping = dict(self.env, SCD_HEARTBEAT_TEST_NOW="1001", MOCK_WAKE_SLEEP="2")
        active = subprocess.Popen(
            [sys.executable, str(RUNNER), "run"], env=sleeping,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        deadline = time.time() + 5
        while len(self.records()) < 1 and time.time() < deadline:
            time.sleep(0.02)
        self.assertEqual(len(self.records()), 1)
        config_before = (self.state_root / "config.json").read_bytes()
        snapshot = self.state_root / "verified-wake-executable"
        snapshot_before = hashlib.sha256(snapshot.read_bytes()).hexdigest()
        alternate = self.root / "alternate-wake"
        alternate.write_text("#!/bin/sh\nprintf 'TACHIKO_HEARTBEAT_SETTLED_V1\\n'\n", encoding="utf-8")
        alternate.chmod(0o700)
        command = json.dumps([str(alternate)])
        result = self.invoke(
            "install", "--repo", str(Path.cwd()), "--wake-command-json", command,
            "--acknowledge-relocatable-wake-target", "--no-load", check=False,
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("heartbeat poll or wake is active", result.stderr)
        self.assertEqual((self.state_root / "config.json").read_bytes(), config_before)
        self.assertEqual(hashlib.sha256(snapshot.read_bytes()).hexdigest(), snapshot_before)
        active.communicate(timeout=5)

    def test_required_wake_identity_fails_closed(self) -> None:
        self.invoke("run", "--prime")
        config_path = self.state_root / "config.json"
        config = json.loads(config_path.read_text(encoding="utf-8"))
        config["required_files"] = [{
            "path": str(self.gh), "sha256": hashlib.sha256(self.gh.read_bytes()).hexdigest()
        }, *config["required_files"]]
        config_path.write_text(json.dumps(config), encoding="utf-8")
        self.write_payload("B")
        self.gh.write_text(self.gh.read_text(encoding="utf-8") + "# changed\n", encoding="utf-8")
        self.assertEqual(self.invoke("run", check=False).returncode, 1)
        self.assertEqual(self.records(), [])

    def test_required_wake_file_under_writable_ancestor_fails_closed(self) -> None:
        self.invoke("run", "--prime")
        unsafe_parent = self.root / "writable-parent"
        unsafe_parent.mkdir(mode=0o777)
        unsafe_parent.chmod(0o777)
        required = unsafe_parent / "profile.toml"
        required.write_text("profile = 'trusted-content'\n", encoding="utf-8")
        required.chmod(0o600)
        config_path = self.state_root / "config.json"
        config = json.loads(config_path.read_text(encoding="utf-8"))
        config["required_files"].append({
            "path": str(required), "sha256": hashlib.sha256(required.read_bytes()).hexdigest()
        })
        config_path.write_text(json.dumps(config), encoding="utf-8")
        self.write_payload("B")
        self.assertEqual(self.invoke("run", check=False).returncode, 1)
        self.assertEqual(self.records(), [], "unsafe required-file ancestry must never wake")

    def test_replaceable_wake_executable_identity_is_pinned(self) -> None:
        self.invoke("run", "--prime")
        self.write_payload("B")
        self.wake.write_text(self.wake.read_text(encoding="utf-8") + "# replaced\n", encoding="utf-8")
        self.wake.chmod(0o700)
        self.assertEqual(self.invoke("run", check=False).returncode, 1)
        self.assertEqual(self.records(), [], "replaced wake executable must never run")

    def test_verified_executable_snapshot_survives_path_replacement(self) -> None:
        original_digest = hashlib.sha256(self.wake.read_bytes()).hexdigest()
        self.invoke("run", "--prime")
        self.write_payload("B")
        self.invoke("run")
        verified = self.state_root / "verified-wake-executable"
        self.assertEqual(hashlib.sha256(verified.read_bytes()).hexdigest(), original_digest)

        self.wake.write_text("#!/bin/sh\nexit 99\n", encoding="utf-8")
        self.wake.chmod(0o700)
        completed = subprocess.run(
            [str(self.wake), "verified-snapshot"], executable=str(verified), env=self.env,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(
            self.records()[-1]["args"], ["verified-snapshot"],
            "execution must stay bound to the verified bytes, not the replaced pathname",
        )

    def test_custom_install_pins_wake_executable_identity(self) -> None:
        config_path = self.state_root / "config.json"
        command = json.dumps([str(self.wake), "pinned-target"])
        self.invoke(
            "install", "--repo", str(Path.cwd()), "--wake-command-json", command,
            "--acknowledge-relocatable-wake-target", "--no-load",
        )
        config = json.loads(config_path.read_text(encoding="utf-8"))
        self.assertIn({
            "path": str(self.wake), "sha256": hashlib.sha256(self.wake.read_bytes()).hexdigest()
        }, config["required_files"])

    def test_custom_install_rejects_location_dependent_or_symlink_target(self) -> None:
        command = json.dumps([str(self.wake), "target"])
        result = self.invoke(
            "install", "--repo", str(Path.cwd()), "--wake-command-json", command,
            "--no-load", check=False,
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("requires --acknowledge-relocatable-wake-target", result.stderr)

        link = self.root / "wake-link"
        link.symlink_to(self.wake)
        result = self.invoke(
            "install", "--repo", str(Path.cwd()),
            "--wake-command-json", json.dumps([str(link)]),
            "--acknowledge-relocatable-wake-target", "--no-load", check=False,
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("custom wake executable unavailable", result.stderr)

    def test_location_dependent_target_runs_as_pinned_original_path_argument(self) -> None:
        interpreter = self.root / "relocation-safe-interpreter"
        interpreter.write_text(
            "#!/usr/bin/python3\nimport runpy, sys\nsys.argv = sys.argv[1:]\n"
            "runpy.run_path(sys.argv[0], run_name='__main__')\n",
            encoding="utf-8",
        )
        interpreter.chmod(0o700)
        cli = self.root / "location-dependent-cli.py"
        cli.write_text(
            "import json, os, pathlib, sys\n"
            "with pathlib.Path(os.environ['MOCK_WAKE_CALLS']).open('a') as stream:\n"
            "    stream.write(json.dumps({'args': sys.argv[1:]}) + '\\n')\n",
            encoding="utf-8",
        )
        cli.chmod(0o600)
        command = json.dumps([str(interpreter), str(cli), "dispatch", "once"])
        self.invoke(
            "install", "--repo", str(Path.cwd()), "--wake-command-json", command,
            "--acknowledge-relocatable-wake-target", "--required-file", str(cli),
            "--no-load",
        )
        config = json.loads((self.state_root / "config.json").read_text(encoding="utf-8"))
        self.assertIn({
            "path": str(cli), "sha256": hashlib.sha256(cli.read_bytes()).hexdigest()
        }, config["required_files"])
        self.invoke("run", "--prime")
        self.write_payload("B")
        self.invoke("run")
        self.assertEqual(self.records()[-1]["args"], ["dispatch", "once"])

    def test_root_owned_pinned_wake_executable_is_trusted(self) -> None:
        system_true = Path("/usr/bin/true")
        self.assertEqual(system_true.stat().st_uid, 0)
        config_path = self.state_root / "config.json"
        config = json.loads(config_path.read_text(encoding="utf-8"))
        config["wake_command"] = [str(system_true)]
        config["required_files"] = [{
            "path": str(system_true), "sha256": hashlib.sha256(system_true.read_bytes()).hexdigest(),
        }]
        config_path.write_text(json.dumps(config), encoding="utf-8")
        self.invoke("run", "--prime")
        self.write_payload("B")
        self.assertEqual(self.invoke("run").returncode, 0)
        self.assertNotEqual(
            self.state()["successful_fingerprint"], self.state()["last_attempt_fingerprint"],
            "trusted exit zero without settled acknowledgement remains retryable",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
