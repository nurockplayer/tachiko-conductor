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
        self.temp = tempfile.TemporaryDirectory(prefix="tachiko-conductor-heartbeat-")
        self.root = Path(self.temp.name)
        self.state_root = self.root / "state"
        self.payload = self.root / "payload.json"
        self.calls = self.root / "calls.jsonl"
        self.gh = self.root / "gh"
        self.wake = self.root / "wake"
        self.launchctl = self.root / "launchctl"
        self.plist = self.root / "LaunchAgents" / "heartbeat.plist"
        self.gh.write_text(
            "#!/usr/bin/python3\nimport os, pathlib\n"
            "print(pathlib.Path(os.environ['MOCK_GH_PAYLOAD']).read_text(), end='')\n",
            encoding="utf-8",
        )
        self.wake.write_text(
            "#!/usr/bin/python3\n"
            "import json, os, pathlib, sys, time\n"
            "with pathlib.Path(os.environ['MOCK_WAKE_CALLS']).open('a') as f: "
            "f.write(json.dumps({'args': sys.argv[1:]}) + '\\n')\n"
            "print('x' * int(os.environ.get('MOCK_WAKE_OUTPUT', '0')))\n"
            "time.sleep(float(os.environ.get('MOCK_WAKE_SLEEP', '0')))\n"
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
            "safety_interval_seconds": safety,
            "wake_command": [str(self.wake), "dispatchable-target"],
            "wake_env": {},
            "required_files": [],
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
            "headRefOid": oid, "baseRefOid": "base", "mergeable": "MERGEABLE",
            "reviewDecision": "APPROVED",
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
        data = {"data": {"repository": {
            "defaultBranchRef": {"target": {"oid": oid}},
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

    def test_install_status_uninstall_and_plist_are_idempotent(self) -> None:
        if (self.state_root / "state.json").exists():
            (self.state_root / "state.json").unlink()
        command = json.dumps([str(self.wake), "future-dispatch-once"])
        args = (
            "--repo", str(Path.cwd()), "--interval", "180", "--safety-interval", "1800",
            "--wake-command-json", command, "--no-load",
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

    def test_required_wake_identity_fails_closed(self) -> None:
        self.invoke("run", "--prime")
        config_path = self.state_root / "config.json"
        config = json.loads(config_path.read_text(encoding="utf-8"))
        config["required_files"] = [{
            "path": str(self.gh), "sha256": hashlib.sha256(self.gh.read_bytes()).hexdigest()
        }]
        config_path.write_text(json.dumps(config), encoding="utf-8")
        self.write_payload("B")
        self.gh.write_text(self.gh.read_text(encoding="utf-8") + "# changed\n", encoding="utf-8")
        self.assertEqual(self.invoke("run", check=False).returncode, 1)
        self.assertEqual(self.records(), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
