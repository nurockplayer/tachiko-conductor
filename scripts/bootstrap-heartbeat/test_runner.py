#!/usr/bin/python3
"""Deterministic integration tests; real GitHub, launchctl, and Codex are never used."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import pwd
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock


HERE = Path(__file__).resolve().parent
RUNNER = HERE / "runner.py"


class HeartbeatTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="tachiko-conductor-heartbeat-", dir=Path(tempfile.gettempdir()).resolve())
        self.root = Path(self.temp.name)
        self.account_home = self.root / "account-home"
        self.account_home.mkdir()
        self.python_test_support = self.root / "python-test-support"
        self.python_test_support.mkdir()
        (self.python_test_support / "sitecustomize.py").write_text(
            "import os, pwd, subprocess\n"
            "_getpwuid = pwd.getpwuid\n"
            "def _test_getpwuid(uid):\n"
            "    record = _getpwuid(uid)\n"
            "    home = os.environ.get('SCD_HEARTBEAT_TEST_ACCOUNT_HOME')\n"
            "    return pwd.struct_passwd(record[:5] + (home,) + record[6:]) if home else record\n"
            "pwd.getpwuid = _test_getpwuid\n"
            "_subprocess_run = subprocess.run\n"
            "def _test_run(args, *pos, **kw):\n"
            "    command = args[0] if isinstance(args, (list, tuple)) and args else ''\n"
            "    preload = os.environ.get('SCD_HEARTBEAT_TEST_NODE_PRELOAD')\n"
            "    if preload and os.path.basename(command).startswith('verified-node-'):\n"
            "        child_env = dict(kw.get('env') or os.environ)\n"
            "        child_env['NODE_OPTIONS'] = '--import ' + preload\n"
            "        kw['env'] = child_env\n"
            "    return _subprocess_run(args, *pos, **kw)\n"
            "subprocess.run = _test_run\n",
            encoding="utf-8",
        )
        real_getpwuid = pwd.getpwuid
        self.account_lookup = mock.patch(
            "pwd.getpwuid",
            side_effect=lambda uid: pwd.struct_passwd(real_getpwuid(uid)[:5] + (str(self.account_home),) + real_getpwuid(uid)[6:]),
        )
        self.account_lookup.start()
        self.state_root = self.root / "state"
        self.payload = self.root / "payload.json"
        self.calls = self.root / "calls.jsonl"
        self.gh = self.root / "gh"
        self.wake = self.root / "wake"
        self.launchctl = self.root / "launchctl"
        self.admission_state = self.root / "admission-state.json"
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
            "if os.environ.get('MOCK_WAKE_REQUIRE_COMPANION') == '1':\n"
            "    companion = pathlib.Path(os.environ['SCD_HEARTBEAT_TEST_ROOT']) / 'codex-code-mode-host'\n"
            "    if companion.read_text() != 'trusted companion\\n': sys.exit(86)\n"
            "with pathlib.Path(os.environ['MOCK_WAKE_CALLS']).open('a') as f: "
            "f.write(json.dumps({'args': sys.argv[1:], 'admission_path': os.environ.get('TACHIKO_MISSION_ADMISSION_PATH')}) + '\\n')\n"
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
            "if [ \"${1:-}\" = bootout ]; then\n"
            "  if [ \"${MOCK_LAUNCHCTL_LOADED:-}\" = 1 ]; then exit 0; fi\n"
            "  echo 'Could not find specified service' >&2; exit 3\n"
            "fi\n"
            "if [ \"${1:-}\" = bootstrap ] && [ \"${MOCK_LAUNCHCTL_FAIL_ONCE:-}\" = 1 ] && "
            "[ ! -e \"${MOCK_LAUNCHCTL_FAIL_MARKER}\" ]; then\n"
            "  : > \"${MOCK_LAUNCHCTL_FAIL_MARKER}\"; exit 9\n"
            "fi\n"
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
            "MOCK_LAUNCHCTL_FAIL_MARKER": str(self.root / "launchctl-failed-once"),
            "MOCK_ADMISSION_STATE": str(self.admission_state),
            "SCD_HEARTBEAT_TEST_ACCOUNT_HOME": str(self.account_home),
            "SCD_HEARTBEAT_TEST_NODE_PRELOAD": str(HERE.parent.parent / "tests/fixtures/account-home-preload.mjs"),
            "PYTHONPATH": str(self.python_test_support),
        })
        self.env.pop("TACHIKO_MISSION_ADMISSION_PATH", None)
        self.write_config()

    def tearDown(self) -> None:
        self.account_lookup.stop()
        self.temp.cleanup()

    def test_query_budget_covers_long_lived_review_threads(self) -> None:
        source = RUNNER.read_text(encoding="utf-8")
        self.assertIn("reviewThreads(first: 100)", source)
        self.assertIn("MAX_POLL_QUERY_COST = 100", source)

    def test_loaded_config_rejects_pinned_admission_from_another_home(self) -> None:
        config_path = self.state_root / "config.json"
        config = json.loads(config_path.read_text(encoding="utf-8"))
        config["admission"]["home"] = str(self.root / "stale-home")
        config_path.write_text(json.dumps(config), encoding="utf-8")
        result = self.invoke("run", check=False)
        self.assertEqual(result.returncode, 1)
        self.assertIn("pinned heartbeat admission home does not match", (self.state_root / "heartbeat.log").read_text(encoding="utf-8"))
        self.assertEqual(self.records(), [], "stale pinned account root must be rejected before wake")
        config["admission"]["home"] = str(self.account_home)
        config["admission"]["registry"] = str(self.root / "stale-registry.json")
        config_path.write_text(json.dumps(config), encoding="utf-8")
        result = self.invoke("run", check=False)
        self.assertEqual(result.returncode, 1)
        self.assertIn("pinned heartbeat admission registry does not match", (self.state_root / "heartbeat.log").read_text(encoding="utf-8"))
        self.assertEqual(self.records(), [])
        config["admission"]["registry"] = str(self.account_home / ".tachiko-conductor/mission-admission/registry.json")
        config["admission"]["runs"] = str(self.root / "stale-runs")
        config_path.write_text(json.dumps(config), encoding="utf-8")
        result = self.invoke("run", check=False)
        self.assertEqual(result.returncode, 1)
        self.assertIn("pinned heartbeat Run directory does not match", (self.state_root / "heartbeat.log").read_text(encoding="utf-8"))
        self.assertEqual(self.records(), [])
        config["admission"]["runs"] = str(self.account_home / ".tachiko-conductor/runs")
        config["admission"]["receipts"] = str(self.root / "stale-receipts")
        config_path.write_text(json.dumps(config), encoding="utf-8")
        result = self.invoke("run", check=False)
        self.assertEqual(result.returncode, 1)
        self.assertIn("pinned heartbeat receipt directory does not match", (self.state_root / "heartbeat.log").read_text(encoding="utf-8"))
        self.assertEqual(self.records(), [])

    def test_loaded_config_rejects_symlink_retargeted_account_admission_roots(self) -> None:
        conductor = self.account_home / ".tachiko-conductor"
        alternate = self.root / "alternate-account-root"
        alternate.mkdir()
        conductor.symlink_to(alternate, target_is_directory=True)
        try:
            result = self.invoke("run", check=False)
            self.assertEqual(result.returncode, 1)
            self.assertIn("symlink or wrong filesystem type", (self.state_root / "heartbeat.log").read_text(encoding="utf-8"))
            self.assertEqual(self.records(), [], "retargeted account root is rejected before wake")
            self.assertFalse((alternate / "mission-admission").exists())
        finally:
            conductor.unlink()

        conductor.mkdir()
        mission = conductor / "mission-admission"
        alternate_mission = self.root / "alternate-mission-admission"
        alternate_mission.mkdir()
        mission.symlink_to(alternate_mission, target_is_directory=True)
        try:
            result = self.invoke("run", check=False)
            self.assertEqual(result.returncode, 1)
            self.assertIn("symlink or wrong filesystem type", (self.state_root / "heartbeat.log").read_text(encoding="utf-8"))
            self.assertEqual(self.records(), [])
            self.assertFalse((alternate_mission / "registry.json").exists())
        finally:
            mission.unlink()

        mission.mkdir()
        canonical_receipts = mission / "heartbeat-receipts"
        alternate_receipts = self.root / "alternate-heartbeat-receipts"
        alternate_receipts.mkdir()
        canonical_receipts.symlink_to(alternate_receipts, target_is_directory=True)
        try:
            result = self.invoke("run", check=False)
            self.assertEqual(result.returncode, 1)
            self.assertIn("symlink or wrong filesystem type", (self.state_root / "heartbeat.log").read_text(encoding="utf-8"))
            self.assertEqual(self.records(), [])
            self.assertEqual(list(alternate_receipts.iterdir()), [])
        finally:
            canonical_receipts.unlink()

    def test_admission_domain_accepts_physical_canonical_aliases_and_rejects_divergent_roots(self) -> None:
        spec = importlib.util.spec_from_file_location("heartbeat_admission_domain_under_test", RUNNER)
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        canonical_runs = self.account_home / ".tachiko-conductor/runs"
        canonical_receipts = self.account_home / ".tachiko-conductor/mission-admission/heartbeat-receipts"
        canonical_registry = self.account_home / ".tachiko-conductor/mission-admission/registry.json"
        canonical_runs.mkdir(parents=True)
        canonical_receipts.mkdir(parents=True)
        canonical_registry.parent.mkdir(parents=True, exist_ok=True)
        canonical_registry.write_text("{}", encoding="utf-8")
        runs_alias = self.root / "runs-alias"
        receipts_alias = self.root / "receipts-alias"
        registry_alias = self.root / "registry-alias.json"
        runs_alias.symlink_to(canonical_runs, target_is_directory=True)
        receipts_alias.symlink_to(canonical_receipts, target_is_directory=True)
        registry_alias.symlink_to(canonical_registry)
        repo = Path.cwd().resolve()

        with mock.patch.dict(os.environ, {
            "TACHIKO_DATA_DIR": str(runs_alias),
            "TACHIKO_HEARTBEAT_ADMISSION_RECEIPTS_DIR": str(receipts_alias),
            "TACHIKO_MISSION_ADMISSION_PATH": str(registry_alias),
        }):
            domain = module.admission_domain(repo, None, None)
        self.assertEqual(Path(domain["runs"]), canonical_runs.resolve())
        self.assertEqual(Path(domain["receipts"]), canonical_receipts.resolve())
        self.assertEqual(Path(domain["registry"]), canonical_registry.resolve())

        for variable, divergent, message in (
            ("TACHIKO_DATA_DIR", self.root / "other-runs", "Run directory must resolve"),
            ("TACHIKO_HEARTBEAT_ADMISSION_RECEIPTS_DIR", self.root / "other-receipts", "receipt directory must resolve"),
        ):
            with mock.patch.dict(os.environ, {variable: str(divergent)}):
                with self.assertRaisesRegex(RuntimeError, message):
                    module.admission_domain(repo, None, None)

    def test_account_home_lookup_ignores_divergent_ambient_home_values(self) -> None:
        saved_home = self.env.get("HOME")
        first = self.root / "ambient-home-a"
        second = self.root / "ambient-home-b"
        first.mkdir()
        second.mkdir()
        try:
            with mock.patch.dict(os.environ, {"HOME": str(first)}):
                module_a = importlib.util.spec_from_file_location("heartbeat_home_a", RUNNER)
                assert module_a and module_a.loader
                runner_a = importlib.util.module_from_spec(module_a)
                module_a.loader.exec_module(runner_a)
            with mock.patch.dict(os.environ, {"HOME": str(second)}):
                module_b = importlib.util.spec_from_file_location("heartbeat_home_b", RUNNER)
                assert module_b and module_b.loader
                runner_b = importlib.util.module_from_spec(module_b)
                module_b.loader.exec_module(runner_b)
            self.assertEqual(runner_a.account_home_directory(), self.account_home.resolve())
            self.assertEqual(runner_b.account_home_directory(), self.account_home.resolve())
            self.assertFalse((first / ".tachiko-conductor").exists())
            self.assertFalse((second / ".tachiko-conductor").exists())
        finally:
            if saved_home is None:
                self.env.pop("HOME", None)
            else:
                self.env["HOME"] = saved_home

    def test_runtime_import_closure_rejects_dynamic_loaders_and_traversal(self) -> None:
        saved_testing = os.environ.get("SCD_HEARTBEAT_TESTING")
        saved_root = os.environ.get("SCD_HEARTBEAT_TEST_ROOT")
        os.environ["SCD_HEARTBEAT_TESTING"] = "1"
        os.environ["SCD_HEARTBEAT_TEST_ROOT"] = str(self.state_root)
        try:
            spec = importlib.util.spec_from_file_location("heartbeat_closure_under_test", RUNNER)
            assert spec and spec.loader
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
        finally:
            if saved_testing is None: os.environ.pop("SCD_HEARTBEAT_TESTING", None)
            else: os.environ["SCD_HEARTBEAT_TESTING"] = saved_testing
            if saved_root is None: os.environ.pop("SCD_HEARTBEAT_TEST_ROOT", None)
            else: os.environ["SCD_HEARTBEAT_TEST_ROOT"] = saved_root

        node = Path(shutil.which("node") or "")
        compiler_root = Path.cwd() / "node_modules/typescript"
        self.assertTrue(compiler_root.is_dir(), "closure test needs the repository-pinned TypeScript parser")
        with tempfile.TemporaryDirectory(dir=self.root) as temporary:
            output = Path(temporary)
            entry = Path("mission-admission/heartbeat-admission-cli.js")
            (output / entry).parent.mkdir(parents=True)
            cases = [
                ("await import('./other.js');", "dynamic import"),
                ("import { createRequire } from 'node:module'; createRequire(import.meta.url);", "createRequire"),
                ("import { createRequire } from 'node:module'; const x = module.createRequire(import.meta.url);", "module.createRequire"),
                ("import '../outside.js';", "path traversal"),
            ]
            for source, label in cases:
                with self.subTest(loader=label):
                    (output / entry).write_text(source, encoding="utf-8")
                    with self.assertRaises(RuntimeError):
                        module.validate_runtime_import_closure(node, compiler_root, output, {entry}, entry)

    def test_existing_staged_bundle_requires_exact_manifest_and_output_bytes(self) -> None:
        saved_testing = os.environ.get("SCD_HEARTBEAT_TESTING")
        saved_root = os.environ.get("SCD_HEARTBEAT_TEST_ROOT")
        os.environ["SCD_HEARTBEAT_TESTING"] = "1"
        os.environ["SCD_HEARTBEAT_TEST_ROOT"] = str(self.state_root)
        try:
            spec = importlib.util.spec_from_file_location("heartbeat_bundle_under_test", RUNNER)
            assert spec and spec.loader
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
        finally:
            if saved_testing is None: os.environ.pop("SCD_HEARTBEAT_TESTING", None)
            else: os.environ["SCD_HEARTBEAT_TESTING"] = saved_testing
            if saved_root is None: os.environ.pop("SCD_HEARTBEAT_TEST_ROOT", None)
            else: os.environ["SCD_HEARTBEAT_TEST_ROOT"] = saved_root

        bundle = self.root / "pinned-bundle"
        bundle.mkdir(mode=0o700)
        bundle.chmod(0o700)
        nested = bundle / "mission-admission" / "entry.js"
        nested.parent.mkdir(parents=True)
        content = b"export {}\n"
        nested.write_bytes(content)
        manifest = b'{"entry":"mission-admission/entry.js"}\n'
        (bundle / "build-manifest.json").write_bytes(manifest)
        expected = {Path("mission-admission/entry.js"): hashlib.sha256(content).hexdigest()}
        module.verify_existing_admission_bundle(bundle, manifest, expected)

        nested.write_bytes(content + b"// tampered\n")
        with self.assertRaisesRegex(RuntimeError, "byte verification"):
            module.verify_existing_admission_bundle(bundle, manifest, expected)
        nested.write_bytes(content)
        (bundle / "unlisted.js").write_text("// unmanifested", encoding="utf-8")
        with self.assertRaisesRegex(RuntimeError, "file set"):
            module.verify_existing_admission_bundle(bundle, manifest, expected)
        (bundle / "unlisted.js").unlink()
        (bundle / "build-manifest.json").write_bytes(b'{"entry":"changed"}\n')
        with self.assertRaisesRegex(RuntimeError, "mismatched build manifest"):
            module.verify_existing_admission_bundle(bundle, manifest, expected)

    def test_dangling_digest_bundle_symlink_is_existing_and_refused(self) -> None:
        saved_testing = os.environ.get("SCD_HEARTBEAT_TESTING")
        saved_root = os.environ.get("SCD_HEARTBEAT_TEST_ROOT")
        os.environ["SCD_HEARTBEAT_TESTING"] = "1"
        os.environ["SCD_HEARTBEAT_TEST_ROOT"] = str(self.state_root)
        try:
            spec = importlib.util.spec_from_file_location("heartbeat_symlink_bundle_under_test", RUNNER)
            assert spec and spec.loader
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
        finally:
            if saved_testing is None: os.environ.pop("SCD_HEARTBEAT_TESTING", None)
            else: os.environ["SCD_HEARTBEAT_TESTING"] = saved_testing
            if saved_root is None: os.environ.pop("SCD_HEARTBEAT_TEST_ROOT", None)
            else: os.environ["SCD_HEARTBEAT_TEST_ROOT"] = saved_root

        dangling = self.root / "verified-admission-deadbeef"
        self.assertFalse(module.existing_admission_bundle(dangling))
        dangling.symlink_to(self.root / "missing-target")
        with self.assertRaisesRegex(RuntimeError, "directory is unsafe"):
            module.existing_admission_bundle(dangling)
        self.assertTrue(dangling.is_symlink(), "refusal must not replace or follow the dangling alias")

    def write_config(self, *, safety: int = 1800) -> None:
        self.state_root.mkdir(parents=True, exist_ok=True)
        gh_digest = hashlib.sha256(self.gh.read_bytes()).hexdigest()
        gh_snapshot = self.state_root / ("verified-gh-" + gh_digest)
        gh_snapshot.write_bytes(self.gh.read_bytes())
        gh_snapshot.chmod(0o700)
        runner_digest = hashlib.sha256(RUNNER.read_bytes()).hexdigest()
        runner_snapshot = self.state_root / ("verified-runner-" + runner_digest)
        runner_snapshot.write_bytes(RUNNER.read_bytes())
        runner_snapshot.chmod(0o700)
        node = Path(shutil.which("node") or "")
        self.assertTrue(node.is_file(), "Node is required for the pinned admission helper tests")
        node_digest = hashlib.sha256(node.read_bytes()).hexdigest()
        node_snapshot = self.state_root / ("verified-node-" + node_digest)
        node_snapshot.write_bytes(node.read_bytes())
        node_snapshot.chmod(0o700)
        helper_root = self.state_root / "verified-admission-test"
        helper_entry = helper_root / "mission-admission" / "heartbeat-admission-cli.js"
        helper_entry.parent.mkdir(parents=True, exist_ok=True)
        helper_source = (
            "import fs from 'node:fs';\n"
            "const statePath = " + json.dumps(str(self.admission_state)) + ";\n"
            "let s = {}; try { s = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch {}\n"
            "const q = JSON.parse(fs.readFileSync(0, 'utf8'));\n"
            "if (q.action === 'inspect') { console.log(JSON.stringify({schemaVersion:1,outcome:'inspected',lane:s.active?{status:'active',generation:s.generation}:{status:'released',generation:s.releasedGeneration||((s.generation||0)+1)}}));\n"
            "} else if (q.action === 'recover') {\n"
            " if (s.uncommittedReceipt && q.expectedGeneration === null && q.supervisorId === s.supervisorId) { console.log(JSON.stringify({schemaVersion:1,outcome:'uncommitted_receipt',generation:s.generation,receiptId:s.receiptId,supervisorId:s.supervisorId})); process.exit(0); }\n"
            " if (s.discardedPredecessor && q.expectedGeneration === null) { console.log(JSON.stringify({schemaVersion:1,outcome:'discarded_predecessor',laneId:s.laneId,generation:s.generation,receiptId:s.receiptId,supervisorId:s.markerSupervisorId})); process.exit(0); }\n"
            " if ((s.capacityWait || s.capacityWaitHistoricalReceipt) && !s.active && q.expectedGeneration === null) { console.log(JSON.stringify({schemaVersion:1,outcome:'capacity_wait'})); process.exit(0); }\n"
            " if (s.releasedPredecessor && !s.active && q.expectedGeneration === null) { console.log(JSON.stringify({schemaVersion:1,outcome:'released_predecessor',laneId:s.laneId,generation:s.generation,releasedGeneration:s.releasedGeneration,receiptId:s.receiptId,supervisorId:s.supervisorId})); process.exit(0); }\n"
            " if (s.active && s.settlementPending && s.supervisorId === q.supervisorId && (q.expectedGeneration === null || q.expectedGeneration === s.generation)) console.log(JSON.stringify({schemaVersion:1,outcome:'settlement_pending',generation:s.generation,receiptId:s.receiptId}));\n"
            " else if (s.active && s.supervisorId === q.supervisorId && (q.expectedGeneration === null || q.expectedGeneration === s.generation)) console.log(JSON.stringify({schemaVersion:1,outcome:'recoverable',generation:s.generation,receiptId:s.receiptId}));\n"
            " else if (!s.active && q.expectedGeneration !== null && s.releasedGeneration === q.expectedGeneration + 1) console.log(JSON.stringify({schemaVersion:1,outcome:'already_settled',generation:q.expectedGeneration,receiptId:s.receiptId}));\n"
            " else if (!s.active && q.expectedGeneration === null && (!s.generation || s.discardedUncommitted)) console.log(JSON.stringify({schemaVersion:1,outcome:'absent'}));\n"
            " else console.log(JSON.stringify({schemaVersion:1,outcome:'not_owned'}));\n"
            "} else if (q.action === 'discard_uncommitted') {\n"
            " if (s.uncommittedReceipt && q.supervisorId === s.supervisorId && q.expectedGeneration === s.generation && q.receiptId === s.receiptId) { s.uncommittedReceipt = false; s.discardedUncommitted = true; s.discardedPredecessor = true; s.markerSupervisorId = q.supervisorId; fs.writeFileSync(statePath, JSON.stringify(s)); console.log(JSON.stringify({schemaVersion:1,outcome:'discarded_uncommitted',generation:q.expectedGeneration,receiptId:q.receiptId,supervisorId:q.supervisorId})); } else console.log(JSON.stringify({schemaVersion:1,outcome:'not_owned'}));\n"
            "} else if (q.action === 'reserve') {\n"
            " if (s.mode === 'waiting') { console.log(JSON.stringify({schemaVersion:1,outcome:'waiting'})); process.exit(0); }\n"
            " if (s.mode === 'owned_elsewhere') { console.log(JSON.stringify({schemaVersion:1,outcome:'owned_elsewhere'})); process.exit(0); }\n"
            " if (s.mode === 'corrupt') { process.exit(2); }\n"
            " if (s.active) { console.log(JSON.stringify({schemaVersion:1,outcome:'already_reserved',generation:s.generation,receiptId:s.receiptId,revision:s.generation})); process.exit(0); }\n"
            " s.generation = (s.generation || 0) + 1; s.receiptId = '00000000-0000-4000-8000-' + String(s.generation).padStart(12,'0');\n"
            " s.supervisorId = q.supervisorId; s.active = true; fs.writeFileSync(statePath, JSON.stringify(s));\n"
            " console.log(JSON.stringify({schemaVersion:1,outcome:'reserved',generation:s.generation,receiptId:s.receiptId,revision:s.generation}));\n"
            "} else if (q.action === 'settle') {\n"
            " if (s.mode === 'stale') process.exit(2);\n"
            " if (!s.active || q.expectedGeneration !== s.generation || q.receiptId !== s.receiptId || q.supervisorId !== s.supervisorId || !q.stopProof?.childrenStopped || !q.stopProof?.supervisorStopped || q.stopProof.observedAt === 'pending') process.exit(2);\n"
            " if (s.failSettlement) { s.failSettlement = false; fs.writeFileSync(statePath, JSON.stringify(s)); process.exit(2); }\n"
            " s.active = false; s.settlementPending = false; s.releasedGeneration = s.generation + 1; fs.writeFileSync(statePath, JSON.stringify(s)); console.log(JSON.stringify({schemaVersion:1,outcome:'settled'}));\n"
            "}\n"
        )
        helper_entry.write_text(helper_source, encoding="utf-8")
        package_json = helper_root / "package.json"
        package_json.write_text('{"type":"module"}\n', encoding="utf-8")
        helper_files = []
        for path in (package_json, helper_entry):
            path_digest = hashlib.sha256(path.read_bytes()).hexdigest()
            helper_files.append({"path": str(path), "sha256": path_digest})
        helper_build = {
            "source_commit": "a" * 40, "source_tree": "b" * 40, "git_archive_sha256": "c" * 64,
            "package_json_sha256": "d" * 64, "lockfile_sha256": "e" * 64,
            "node_path": str(node), "node_sha256": node_digest, "node_version": "v22.0.0",
            "corepack_path": "/usr/bin/corepack", "corepack_sha256": "f" * 64,
            "corepack_version": "0.34.0", "pnpm_version": "10.34.5",
            "typescript_version": "5.9.3", "typescript_package_sha256": "1" * 64,
            "typescript_tree_sha256": "2" * 64,
            "install_command": ["corepack", "pnpm@10.34.5", "install", "--frozen-lockfile", "--ignore-scripts"],
            "build_command": ["corepack", "pnpm@10.34.5", "build"],
            "entry": "mission-admission/heartbeat-admission-cli.js",
            "files": [{"path": Path(item["path"]).relative_to(helper_root).as_posix(), "sha256": item["sha256"]}
                      for item in sorted(helper_files, key=lambda i: i["path"])],
        }
        manifest_bytes = (json.dumps(helper_build, sort_keys=True, separators=(",", ":")) + "\n").encode()
        manifest_path = helper_root / "build-manifest.json"
        manifest_path.write_bytes(manifest_bytes)
        helper_files.append({"path": str(manifest_path), "sha256": hashlib.sha256(manifest_bytes).hexdigest()})
        closure_digest = hashlib.sha256(manifest_bytes).hexdigest()
        canonical_helper_root = self.state_root / ("verified-admission-" + closure_digest)
        if canonical_helper_root.exists():
            shutil.rmtree(canonical_helper_root)
        os.rename(helper_root, canonical_helper_root)
        helper_root = canonical_helper_root
        helper_root.chmod(0o700)
        helper_entry = helper_root / "mission-admission" / "heartbeat-admission-cli.js"
        for item in helper_files:
            relative = Path(item["path"]).relative_to(self.state_root / "verified-admission-test")
            item["path"] = str(helper_root / relative)
        admission = {
            "repository": "nurockplayer/tachiko-conductor", "workspace": str(Path.cwd().resolve()),
            "home": str(self.account_home),
            "registry": str(self.account_home / ".tachiko-conductor/mission-admission/registry.json"),
            "runs": str(self.account_home / ".tachiko-conductor/runs"),
            "receipts": str(self.account_home / ".tachiko-conductor/mission-admission/heartbeat-receipts"),
            "config": {"schemaVersion": 1, "revision": "test-config-v2", "limits": {"maxCaptains": 2, "maxWriters": 2, "maxHighAutonomy": 1}},
        }
        config = {
            "schema": 2,
            "gh": str(gh_snapshot),
            "gh_sha256": gh_digest,
            "repo": str(Path.cwd()),
            "runner": str(runner_snapshot),
            "runner_sha256": runner_digest,
            "poll_interval_seconds": 180,
            "poll_timeout_seconds": 60,
            "wake_timeout_seconds": 1500,
            "safety_interval_seconds": safety,
            "wake_executable_relocatable": True,
            "wake_target_kind": "test",
            "wake_command": [str(self.wake), "dispatchable-target"],
            "wake_env": {},
            "required_files": [{
                "path": str(self.wake), "sha256": hashlib.sha256(self.wake.read_bytes()).hexdigest()
            }],
            "admission": admission,
            "admission_node": str(node_snapshot), "admission_node_sha256": node_digest,
            "admission_helper": str(helper_entry), "admission_helper_sha256": closure_digest,
            "admission_helper_files": helper_files, "admission_build": helper_build,
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

    def test_admission_capacity_denial_and_existing_receipt_never_spawn(self) -> None:
        self.invoke("run", "--prime")
        self.write_payload("B")
        self.admission_state.write_text(json.dumps({"mode": "waiting"}), encoding="utf-8")
        denied = self.invoke("run", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="1001"), check=False)
        self.assertEqual(denied.returncode, 0, denied.stderr)
        self.assertEqual(self.records(), [], "capacity denial remains a quiet model-free result")
        self.admission_state.write_text(json.dumps({"active": True, "generation": 1, "receiptId": "old"}), encoding="utf-8")
        retry = self.invoke("run", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="1002"), check=False)
        self.assertEqual(retry.returncode, 0, retry.stderr)
        self.assertEqual(self.records(), [], "already-reserved reconciliation never authorizes another model")

    def _set_pending_admission(self, phase: str, *, boot_id: str = "test-boot", pid: int = 999999) -> None:
        state = self.state()
        state["pending_admission"] = {
            "supervisor_id": "old-supervisor", "host_id": "test-host", "boot_id": boot_id,
            "pid": pid, "process_identity": "dead-owner-identity", "phase": phase,
            "generation": 1, "receipt_id": "00000000-0000-4000-8000-000000000001", "started_at": 1000,
        }
        (self.state_root / "state.json").write_text(json.dumps(state), encoding="utf-8")
        self.admission_state.write_text(json.dumps({
            "active": True, "generation": 1,
            "receiptId": "00000000-0000-4000-8000-000000000001", "supervisorId": "old-supervisor",
        }), encoding="utf-8")

    def test_reentry_reconciles_verified_prior_boot_before_unchanged_fingerprint(self) -> None:
        self.invoke("run", "--prime")
        self._set_pending_admission("spawn_uncertain", boot_id="prior-boot")
        result = self.invoke("run", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="1001"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(json.loads(self.admission_state.read_text(encoding="utf-8"))["active"])
        self.assertIsNone(self.state()["pending_admission"])
        self.assertEqual(self.records(), [], "recovery precedes the unchanged-state return and never spawns")

    def test_same_boot_uncertain_execution_remains_fenced(self) -> None:
        self.invoke("run", "--prime")
        self._set_pending_admission("spawn_uncertain")
        result = self.invoke("run", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="1001"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(self.admission_state.read_text(encoding="utf-8"))["active"])
        self.assertEqual(self.state()["pending_admission"]["phase"], "spawn_uncertain")
        self.assertEqual(self.records(), [])

    def test_durable_settlement_receipt_retries_same_boot_uncertain_execution_without_spawn(self) -> None:
        self.invoke("run", "--prime")
        self._set_pending_admission("spawn_uncertain")
        admission = json.loads(self.admission_state.read_text(encoding="utf-8"))
        admission.update(settlementPending=True, failSettlement=True)
        self.admission_state.write_text(json.dumps(admission), encoding="utf-8")

        failed = self.invoke("run", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="1001"), check=False)
        self.assertEqual(failed.returncode, 1)
        self.assertIsNotNone(self.state()["pending_admission"], "failed exact settlement keeps durable pending state")
        self.assertTrue(json.loads(self.admission_state.read_text(encoding="utf-8"))["active"])
        self.assertEqual(self.records(), [], "settlement retry never spawns a wake")

        retried = self.invoke("run", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="1002"))
        self.assertEqual(retried.returncode, 0, retried.stderr)
        self.assertIsNone(self.state()["pending_admission"])
        settled = json.loads(self.admission_state.read_text(encoding="utf-8"))
        self.assertFalse(settled["active"])
        self.assertEqual(settled["releasedGeneration"], 2)
        self.assertEqual(self.records(), [], "recovery precedes polling and never spawns a wake")

    def test_recoverable_active_rejects_partial_wrong_phase_and_mismatched_bindings(self) -> None:
        saved_testing = os.environ.get("SCD_HEARTBEAT_TESTING")
        saved_root = os.environ.get("SCD_HEARTBEAT_TEST_ROOT")
        os.environ["SCD_HEARTBEAT_TESTING"] = "1"
        os.environ["SCD_HEARTBEAT_TEST_ROOT"] = str(self.state_root)
        try:
            spec = importlib.util.spec_from_file_location("heartbeat_binding_runner_under_test", RUNNER)
            assert spec and spec.loader
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
        finally:
            if saved_testing is None:
                os.environ.pop("SCD_HEARTBEAT_TESTING", None)
            else:
                os.environ["SCD_HEARTBEAT_TESTING"] = saved_testing
            if saved_root is None:
                os.environ.pop("SCD_HEARTBEAT_TEST_ROOT", None)
            else:
                os.environ["SCD_HEARTBEAT_TEST_ROOT"] = saved_root

        exact_receipt_id = "00000000-0000-4000-8000-000000000001"
        config = {"admission": {"repository": "nurockplayer/tachiko-conductor", "workspace": str(Path.cwd())}}
        cases = (
            ("partial null generation", {"generation": None, "receipt_id": exact_receipt_id}, "reserved_pre_execution", "test-host", "test-boot"),
            ("partial null receipt", {"generation": 1, "receipt_id": None}, "reserved_pre_execution", "test-host", "test-boot"),
            ("mismatched generation", {"generation": 2, "receipt_id": exact_receipt_id}, "reserved_pre_execution", "test-host", "test-boot"),
            ("mismatched receipt", {"generation": 1, "receipt_id": "00000000-0000-4000-8000-000000000002"}, "reserved_pre_execution", "test-host", "test-boot"),
            ("uncertain phase after reboot", {"generation": None, "receipt_id": None}, "spawn_uncertain", "test-host", "prior-boot"),
            ("wrong host", {"generation": None, "receipt_id": None}, "reserved_pre_execution", "other-host", "prior-boot"),
        )
        for label, identity, phase, host_id, boot_id in cases:
            with self.subTest(case=label):
                pending = {
                    "supervisor_id": "old-supervisor", "host_id": host_id, "boot_id": boot_id,
                    "pid": 999999, "process_identity": "dead-owner-identity", "phase": phase,
                    **identity, "started_at": 1000,
                }
                state = {"pending_admission": pending}
                calls: list[str] = []

                def admission_call(_config: dict[str, object], request: dict[str, object]) -> dict[str, object]:
                    calls.append(str(request["action"]))
                    if request["action"] == "recover":
                        return {"schemaVersion": 1, "outcome": "recoverable", "generation": 1,
                                "receiptId": exact_receipt_id}
                    return {"schemaVersion": 1, "outcome": "settled"}

                with mock.patch.object(module, "admission_call", side_effect=admission_call), \
                        mock.patch.object(module, "durable_host_boot_identity", return_value=("test-host", "test-boot")), \
                        mock.patch.object(module, "process_identity", return_value=None), \
                        mock.patch.object(module, "save_state") as save:
                    with self.assertRaises(RuntimeError):
                        module.reconcile_pending_admission(config, state)
                self.assertEqual(calls, [] if label == "wrong host" else ["recover"],
                                 "fenced recovery must not settle")
                save.assert_not_called()
                self.assertEqual(state["pending_admission"], pending)

        live_pending = {
            "supervisor_id": "old-supervisor", "host_id": "test-host", "boot_id": "test-boot",
            "pid": 123, "process_identity": "live-owner-identity", "phase": "reserved_pre_execution",
            "generation": None, "receipt_id": None, "started_at": 1000,
        }
        live_state = {"pending_admission": dict(live_pending)}
        live_calls: list[str] = []

        def live_admission_call(_config: dict[str, object], request: dict[str, object]) -> dict[str, object]:
            live_calls.append(str(request["action"]))
            return {"schemaVersion": 1, "outcome": "recoverable", "generation": 1, "receiptId": exact_receipt_id}

        with mock.patch.object(module, "admission_call", side_effect=live_admission_call), \
                mock.patch.object(module, "durable_host_boot_identity", return_value=("test-host", "test-boot")), \
                mock.patch.object(module, "process_identity", return_value="live-owner-identity"), \
                mock.patch.object(module, "save_state") as save:
            self.assertFalse(module.reconcile_pending_admission(config, live_state))
        self.assertEqual(live_calls, ["recover"])
        save.assert_not_called()
        self.assertEqual(live_state["pending_admission"], live_pending)

    def test_prior_boot_spawn_uncertain_with_exact_bound_receipt_still_settles(self) -> None:
        saved_testing = os.environ.get("SCD_HEARTBEAT_TESTING")
        saved_root = os.environ.get("SCD_HEARTBEAT_TEST_ROOT")
        os.environ["SCD_HEARTBEAT_TESTING"] = "1"
        os.environ["SCD_HEARTBEAT_TEST_ROOT"] = str(self.state_root)
        try:
            spec = importlib.util.spec_from_file_location("heartbeat_bound_uncertain_runner_under_test", RUNNER)
            assert spec and spec.loader
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
        finally:
            if saved_testing is None:
                os.environ.pop("SCD_HEARTBEAT_TESTING", None)
            else:
                os.environ["SCD_HEARTBEAT_TESTING"] = saved_testing
            if saved_root is None:
                os.environ.pop("SCD_HEARTBEAT_TEST_ROOT", None)
            else:
                os.environ["SCD_HEARTBEAT_TEST_ROOT"] = saved_root

        receipt_id = "00000000-0000-4000-8000-000000000001"
        pending = {
            "supervisor_id": "old-supervisor", "host_id": "test-host", "boot_id": "prior-boot",
            "pid": 999999, "process_identity": "old-owner-identity", "phase": "spawn_uncertain",
            "generation": 1, "receipt_id": receipt_id, "started_at": 1000,
        }
        state = {"pending_admission": dict(pending)}
        calls: list[str] = []

        def admission_call(_config: dict[str, object], request: dict[str, object]) -> dict[str, object]:
            calls.append(str(request["action"]))
            if request["action"] == "recover":
                return {"schemaVersion": 1, "outcome": "recoverable", "generation": 1, "receiptId": receipt_id}
            return {"schemaVersion": 1, "outcome": "settled"}

        config = {"admission": {"repository": "nurockplayer/tachiko-conductor", "workspace": str(Path.cwd())}}
        with mock.patch.object(module, "admission_call", side_effect=admission_call), \
                mock.patch.object(module, "durable_host_boot_identity", return_value=("test-host", "test-boot")), \
                mock.patch.object(module, "process_identity") as process_identity, \
                mock.patch.object(module, "save_state") as save:
            self.assertTrue(module.reconcile_pending_admission(config, state))
        self.assertEqual(calls, ["recover", "settle"])
        process_identity.assert_not_called()
        save.assert_called_once_with(state)
        self.assertIsNone(state["pending_admission"])

    def test_same_boot_dead_preexecution_owner_can_settle_exact_generation(self) -> None:
        self.invoke("run", "--prime")
        self._set_pending_admission("reserved_pre_execution")
        result = self.invoke("run", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="1001"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(json.loads(self.admission_state.read_text(encoding="utf-8"))["active"])
        self.assertIsNone(self.state()["pending_admission"])
        self.assertEqual(self.records(), [])

    def _set_capacity_wait_pending(self, *, phase: str = "reserved_pre_execution", host_id: str = "test-host", historical_receipt: bool = False) -> None:
        state = self.state()
        state["pending_admission"] = {
            "supervisor_id": "old-supervisor", "host_id": host_id, "boot_id": "test-boot",
            "pid": 999999, "process_identity": "dead-owner-identity", "phase": phase,
            "generation": None, "receipt_id": None, "started_at": 1000,
        }
        (self.state_root / "state.json").write_text(json.dumps(state), encoding="utf-8")
        self.admission_state.write_text(json.dumps({"capacityWait": not historical_receipt, "capacityWaitHistoricalReceipt": historical_receipt, "mode": "waiting"}), encoding="utf-8")

    def _set_uncommitted_receipt_pending(self, *, phase: str = "reserved_pre_execution", host_id: str = "test-host", owner: str = "old-supervisor", receipt_owner: str | None = None, boot_id: str = "test-boot") -> None:
        state = self.state()
        state["pending_admission"] = {
            "supervisor_id": owner, "host_id": host_id, "boot_id": boot_id,
            "pid": 999999, "process_identity": "dead-owner-identity", "phase": phase,
            "generation": None, "receipt_id": None, "started_at": 1000,
        }
        (self.state_root / "state.json").write_text(json.dumps(state), encoding="utf-8")
        workspace = str(Path.cwd().resolve())
        lane_id = "heartbeat:" + hashlib.sha256(
            ("nurockplayer/tachiko-conductor" + "\0" + workspace).encode()
        ).hexdigest()[:32]
        self.admission_state.write_text(json.dumps({
            "uncommittedReceipt": True, "generation": 7,
            "receiptId": "00000000-0000-4000-8000-000000000007", "supervisorId": receipt_owner or owner,
            "laneId": lane_id,
        }), encoding="utf-8")

    def _set_released_predecessor_pending(self, *, phase: str = "reserved_pre_execution", host_id: str = "test-host",
                                         boot_id: str = "test-boot", receipt_id: str = "00000000-0000-4000-8000-000000000006") -> None:
        state = self.state()
        state["pending_admission"] = {
            "supervisor_id": "new-supervisor", "host_id": host_id, "boot_id": boot_id,
            "pid": 999999, "process_identity": "dead-owner-identity", "phase": phase,
            "generation": None, "receipt_id": None, "started_at": 1000,
        }
        (self.state_root / "state.json").write_text(json.dumps(state), encoding="utf-8")
        repository = "nurockplayer/tachiko-conductor"
        workspace = str(Path.cwd().resolve())
        lane_id = "heartbeat:" + hashlib.sha256((repository + "\0" + workspace).encode()).hexdigest()[:32]
        self.admission_state.write_text(json.dumps({
            "mode": "waiting", "releasedPredecessor": True, "active": False,
            "generation": 6, "releasedGeneration": 7,
            "receiptId": receipt_id, "supervisorId": "previous-supervisor",
            "status": "settled", "laneId": lane_id,
        }), encoding="utf-8")

    def _set_discarded_predecessor_pending(self, *, owner: str = "new-supervisor", marker_owner: str = "old-supervisor",
                                           receipt_id: str = "00000000-0000-4000-8000-000000000006",
                                           phase: str = "reserved_pre_execution", host_id: str = "test-host",
                                           lane_id: str | None = None) -> None:
        state = self.state()
        state["pending_admission"] = {
            "supervisor_id": owner, "host_id": host_id, "boot_id": "test-boot",
            "pid": 999999, "process_identity": "dead-owner-identity", "phase": phase,
            "generation": None, "receipt_id": None, "started_at": 1000,
        }
        (self.state_root / "state.json").write_text(json.dumps(state), encoding="utf-8")
        workspace = str(Path.cwd().resolve())
        exact_lane_id = "heartbeat:" + hashlib.sha256(
            ("nurockplayer/tachiko-conductor" + "\0" + workspace).encode()
        ).hexdigest()[:32]
        self.admission_state.write_text(json.dumps({
            "mode": "waiting", "discardedPredecessor": True, "generation": 6,
            "receiptId": receipt_id, "markerSupervisorId": marker_owner,
            "laneId": lane_id or exact_lane_id,
        }), encoding="utf-8")

    def test_capacity_wait_crash_clears_only_dead_generation_free_preexecution_intent(self) -> None:
        self.invoke("run", "--prime")
        self._set_capacity_wait_pending()
        result = self.invoke("run", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="1001"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIsNone(self.state()["pending_admission"])
        self.assertTrue(json.loads(self.admission_state.read_text(encoding="utf-8"))["capacityWait"],
                        "capacity reconciliation preserves the parked lane and never releases it")
        self.assertEqual(self.records(), [], "capacity recovery never spawns")

    def test_later_cycle_capacity_wait_crash_accepts_prior_settled_tombstone_without_spawning(self) -> None:
        self.invoke("run", "--prime")
        self._set_capacity_wait_pending(historical_receipt=True)
        result = self.invoke("run", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="1001"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIsNone(self.state()["pending_admission"])
        receipt_evidence = json.loads(self.admission_state.read_text(encoding="utf-8"))
        self.assertTrue(receipt_evidence["capacityWaitHistoricalReceipt"], "the historical receipt remains evidence only; the parked lane is not retired")
        self.assertEqual(self.records(), [])

    def test_capacity_wait_refuses_wrong_host_or_execution_possible_intent(self) -> None:
        for phase, host_id in (("reserved_pre_execution", "other-host"), ("spawn_uncertain", "test-host")):
            with self.subTest(phase=phase, host_id=host_id):
                self.invoke("run", "--prime")
                self._set_capacity_wait_pending(phase=phase, host_id=host_id)
                result = self.invoke("run", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="1001"), check=False)
                self.assertEqual(result.returncode, 1)
                self.assertIsNotNone(self.state()["pending_admission"])
                self.assertEqual(self.records(), [])

    def test_uncommitted_candidate_is_discarded_only_for_dead_generation_free_preexecution_owner(self) -> None:
        for phase, host_id, owner, receipt_owner in (
            ("reserved_pre_execution", "test-host", "old-supervisor", "other-supervisor"),
            ("spawn_uncertain", "test-host", "old-supervisor", "old-supervisor"),
            ("reserved_pre_execution", "other-host", "old-supervisor", "old-supervisor"),
        ):
            with self.subTest(phase=phase, host_id=host_id, owner=owner, receipt_owner=receipt_owner):
                self.invoke("run", "--prime")
                self._set_uncommitted_receipt_pending(phase=phase, host_id=host_id, owner=owner, receipt_owner=receipt_owner)
                result = self.invoke("run", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="1001"), check=False)
                self.assertEqual(result.returncode, 1)
                self.assertIsNotNone(self.state()["pending_admission"])
                self.assertTrue(json.loads(self.admission_state.read_text(encoding="utf-8"))["uncommittedReceipt"])
                self.assertEqual(self.records(), [])

        self.invoke("run", "--prime")
        self._set_uncommitted_receipt_pending(phase="spawn_uncertain", boot_id="prior-boot")
        rebooted_uncertain = self.invoke("run", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="1001"), check=False)
        self.assertEqual(rebooted_uncertain.returncode, 1, "a reboot alone cannot clear an absent spawn-uncertain intent")
        self.assertIsNotNone(self.state()["pending_admission"])
        self.assertEqual(self.records(), [])

        self.invoke("run", "--prime")
        self._set_uncommitted_receipt_pending()
        result = self.invoke("run", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="1001"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIsNone(self.state()["pending_admission"])
        admission = json.loads(self.admission_state.read_text(encoding="utf-8"))
        self.assertTrue(admission["discardedUncommitted"])
        self.assertEqual(admission["generation"], 7, "discard does not consume or release a registry generation")
        self.assertEqual(self.records(), [], "clearing a prepublication candidate is never itself spawn authority")

    def test_crash_after_uncommitted_receipt_discard_retries_absent_without_spawning(self) -> None:
        self.invoke("run", "--prime")
        self._set_uncommitted_receipt_pending()
        failed = self.invoke("run", env=dict(
            self.env, SCD_HEARTBEAT_TEST_NOW="1001", SCD_HEARTBEAT_TEST_FAIL_CLEAR_PENDING="1",
        ), check=False)
        self.assertEqual(failed.returncode, 1)
        self.assertIsNotNone(self.state()["pending_admission"], "failed pending-state save must preserve intent")
        self.assertTrue(json.loads(self.admission_state.read_text(encoding="utf-8"))["discardedUncommitted"],
                        "the exact private orphan was durably removed before the failed state save")

        retried = self.invoke("run", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="1002"))
        self.assertEqual(retried.returncode, 0, retried.stderr)
        self.assertIsNone(self.state()["pending_admission"])
        self.assertEqual(self.records(), [], "absent retry after discard cannot reuse stale execution intent")

    def test_crash_after_marker_publication_reconciles_later_supervisor_without_spawning(self) -> None:
        self.invoke("run", "--prime")
        self._set_discarded_predecessor_pending()
        failed_save = self.invoke("run", env=dict(
            self.env, SCD_HEARTBEAT_TEST_NOW="1001", SCD_HEARTBEAT_TEST_FAIL_CLEAR_PENDING="1",
        ), check=False)
        self.assertEqual(failed_save.returncode, 1)
        self.assertIsNotNone(self.state()["pending_admission"], "the failed save retains the null-generation intent")
        marker = json.loads(self.admission_state.read_text(encoding="utf-8"))
        self.assertTrue(marker["discardedPredecessor"], "the durable tokenless marker survives the failed state save")

        retry = self.invoke("run", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="1002"))
        self.assertEqual(retry.returncode, 0, retry.stderr)
        self.assertIsNone(self.state()["pending_admission"])
        self.assertEqual(self.records(), [], "a later supervisor may clear only after dead-owner proof and marker recovery")

    def test_discarded_marker_rejects_bad_owner_phase_host_and_uuid_without_traceback(self) -> None:
        cases = (
            {"phase": "spawn_uncertain"},
            {"host_id": "other-host"},
            {"receipt_id": "not-a-uuid"},
            {"receipt_id": "x" * 36},
            {"lane_id": "heartbeat:foreign"},
        )
        for overrides in cases:
            with self.subTest(overrides=overrides):
                self.invoke("run", "--prime")
                self._set_discarded_predecessor_pending(**overrides)
                before = json.loads(self.admission_state.read_text(encoding="utf-8"))
                result = self.invoke("run", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="1001"), check=False)
                self.assertEqual(result.returncode, 1)
                self.assertNotIn("Traceback", result.stderr, "malformed marker UUID is handled as a fenced recovery result")
                self.assertIsNotNone(self.state()["pending_admission"])
                self.assertEqual(json.loads(self.admission_state.read_text(encoding="utf-8")), before)
                self.assertEqual(self.records(), [])

    def test_real_typescript_discard_marker_survives_python_restart(self) -> None:
        saved_testing = os.environ.get("SCD_HEARTBEAT_TESTING")
        saved_root = os.environ.get("SCD_HEARTBEAT_TEST_ROOT")
        os.environ["SCD_HEARTBEAT_TESTING"] = "1"
        os.environ["SCD_HEARTBEAT_TEST_ROOT"] = str(self.state_root)
        try:
            spec = importlib.util.spec_from_file_location("heartbeat_marker_runner_under_test", RUNNER)
            assert spec and spec.loader
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
        finally:
            if saved_testing is None: os.environ.pop("SCD_HEARTBEAT_TESTING", None)
            else: os.environ["SCD_HEARTBEAT_TESTING"] = saved_testing
            if saved_root is None: os.environ.pop("SCD_HEARTBEAT_TEST_ROOT", None)
            else: os.environ["SCD_HEARTBEAT_TEST_ROOT"] = saved_root

        workspace = self.root / "real-helper-workspace"
        workspace.mkdir()
        helper_registry = self.root / "real-helper-host" / "registry.json"
        helper_receipt = self.root / "real-helper-receipts" / "heartbeat.json"
        admission_config = {
            "schemaVersion": 1, "revision": "discard-marker-cross-language-v1",
            "limits": {"maxCaptains": 1, "maxWriters": 1, "maxHighAutonomy": 1},
        }
        registry_module = (Path.cwd() / "src/mission-admission/registry.ts").resolve().as_uri()
        admission_module = (Path.cwd() / "src/mission-admission/heartbeat-admission.ts").resolve().as_uri()
        bridge = self.state_root / "real-heartbeat-admission-bridge.mjs"
        bridge.write_text(
            "import fs from 'node:fs';\n"
            "import { MissionAdmissionRegistry } from " + json.dumps(registry_module) + ";\n"
            "import { handleHeartbeatAdmission } from " + json.dumps(admission_module) + ";\n"
            "const q = JSON.parse(fs.readFileSync(0, 'utf8'));\n"
            "const config = JSON.parse(process.env.TEST_ADMISSION_CONFIG);\n"
            "const options = { filePath: process.env.TEST_ADMISSION_REGISTRY, config, "
            "...(q.injectPublicationFailure ? { beforePublish: () => { throw new Error('injected publication failure'); } } : {}) };\n"
            "const registry = new MissionAdmissionRegistry(options);\n"
            "if (q.bridgeAction === 'occupy') {\n"
            " const result = registry.admit({laneId:'test-capacity-holder',role:'production_captain',highAutonomy:true,evidence:{repository:'acme/holder',issue:117}});\n"
            " console.log(JSON.stringify(result));\n"
            "} else if (q.bridgeAction === 'readLane') {\n"
            " console.log(JSON.stringify(registry.readLane(q.laneId)));\n"
            "} else {\n"
            " delete q.injectPublicationFailure; delete q.bridgeAction; delete q.laneId;\n"
            " console.log(JSON.stringify(handleHeartbeatAdmission(q,{registry,receiptPath:()=>process.env.TEST_ADMISSION_RECEIPT})));\n"
            "}\n",
            encoding="utf-8",
        )
        node = shutil.which("node")
        self.assertIsNotNone(node)
        node_env = dict(os.environ, TEST_ADMISSION_REGISTRY=str(helper_registry),
                        TEST_ADMISSION_RECEIPT=str(helper_receipt),
                        TEST_ADMISSION_CONFIG=json.dumps(admission_config))

        def real_helper(request: dict[str, object], *, allow_failure: bool = False) -> tuple[subprocess.CompletedProcess[str], dict[str, object] | None]:
            result = subprocess.run([str(node), "--import", "tsx", str(bridge)], cwd=Path.cwd(), env=node_env,
                                    input=json.dumps(request), text=True, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, check=False)
            if result.returncode != 0:
                if allow_failure:
                    return result, None
                self.fail("real TypeScript helper failed: " + result.stderr)
            if allow_failure:
                self.fail("real TypeScript helper unexpectedly published the injected candidate")
            return result, json.loads(result.stdout)

        repository = "nurockplayer/tachiko-conductor"
        workspace_text = str(workspace.resolve())
        self.invoke("run", "--prime")
        runtime_config = {"admission": {"repository": repository, "workspace": workspace_text}}

        def python_recovery(_config: dict[str, object], request: dict[str, object]) -> dict[str, object]:
            outcome = real_helper(request)[1]
            assert outcome is not None
            return outcome

        def reconcile_state(state: dict[str, object], *, fail_save: bool = False) -> bool:
            with mock.patch.object(module, "admission_call", side_effect=python_recovery), \
                    mock.patch.object(module, "durable_host_boot_identity", return_value=("test-host", "test-boot")), \
                    mock.patch.object(module, "process_identity", return_value=None):
                if fail_save:
                    with mock.patch.object(module, "save_state", side_effect=OSError("simulated pending save failure")):
                        return module.reconcile_pending_admission(runtime_config, state)
                return module.reconcile_pending_admission(runtime_config, state)

        prior_supervisor = "prior-supervisor"
        reserved = real_helper({"schemaVersion": 1, "action": "reserve", "repository": repository,
                                "workspace": workspace_text, "supervisorId": prior_supervisor})[1]
        assert reserved is not None
        self.assertEqual(reserved["outcome"], "reserved")
        generation = reserved["generation"]
        receipt_id = reserved["receiptId"]
        settled = real_helper({
            "schemaVersion": 1, "action": "settle", "repository": repository, "workspace": workspace_text,
            "supervisorId": prior_supervisor, "expectedGeneration": generation, "receiptId": receipt_id,
            "stopProof": {"childrenStopped": True, "supervisorStopped": True, "observedAt": "2026-09-24T00:00:00Z"},
        })[1]
        assert settled is not None
        self.assertEqual(settled["outcome"], "settled")
        lane_id = reserved["laneId"]
        legacy_receipt_id = "-" * 36
        settled_receipt = json.loads(helper_receipt.read_text(encoding="utf-8"))
        settled_receipt["receiptId"] = legacy_receipt_id
        helper_receipt.write_text(json.dumps(settled_receipt), encoding="utf-8")
        released_lane = real_helper({"bridgeAction": "readLane", "laneId": lane_id})[1]
        assert released_lane is not None
        self.assertEqual((released_lane["status"], released_lane["generation"]), ("released", generation + 1))
        released_recovery = real_helper({"schemaVersion": 1, "action": "recover", "repository": repository,
                                         "workspace": workspace_text, "supervisorId": "released-reader",
                                         "expectedGeneration": None})[1]
        assert released_recovery is not None
        self.assertEqual(released_recovery["outcome"], "released_predecessor")
        self.assertEqual(released_recovery["receiptId"], legacy_receipt_id)
        released_state = self.state()
        released_state["pending_admission"] = {
            "supervisor_id": "released-reader", "host_id": "test-host", "boot_id": "test-boot",
            "pid": 999999, "process_identity": "dead-owner-identity", "phase": "reserved_pre_execution",
            "generation": None, "receipt_id": None, "started_at": 999,
        }
        module.STATE.write_text(json.dumps(released_state), encoding="utf-8")
        self.assertTrue(reconcile_state(released_state), "Python must accept the prior receipt grammar for released recovery")
        self.assertIsNone(released_state["pending_admission"])

        failed, _ = real_helper({"schemaVersion": 1, "action": "reserve", "repository": repository,
                                 "workspace": workspace_text, "supervisorId": prior_supervisor,
                                 "injectPublicationFailure": True}, allow_failure=True)
        self.assertNotEqual(failed.returncode, 0)
        orphan = json.loads(helper_receipt.read_text(encoding="utf-8"))
        orphan["receiptId"] = legacy_receipt_id
        helper_receipt.write_text(json.dumps(orphan), encoding="utf-8")
        self.assertEqual((orphan["status"], orphan["token"]["generation"]), ("active", generation + 2))
        unchanged_lane = real_helper({"bridgeAction": "readLane", "laneId": lane_id})[1]
        assert unchanged_lane is not None
        self.assertEqual((unchanged_lane["status"], unchanged_lane["generation"]), ("released", generation + 1))
        orphan_recovery = real_helper({"schemaVersion": 1, "action": "recover", "repository": repository,
                                       "workspace": workspace_text, "supervisorId": prior_supervisor,
                                       "expectedGeneration": None})[1]
        assert orphan_recovery is not None
        self.assertEqual(orphan_recovery["outcome"], "uncommitted_receipt")
        marker_result = real_helper({"schemaVersion": 1, "action": "discard_uncommitted", "repository": repository,
                                     "workspace": workspace_text, "supervisorId": prior_supervisor,
                                     "expectedGeneration": orphan_recovery["generation"],
                                     "receiptId": orphan_recovery["receiptId"]})[1]
        assert marker_result is not None
        self.assertEqual(marker_result["outcome"], "discarded_uncommitted")
        marker = json.loads(helper_receipt.read_text(encoding="utf-8"))
        self.assertEqual(marker["kind"], "discarded_uncommitted")
        self.assertEqual(marker["receiptId"], legacy_receipt_id, "marker retains exact accepted legacy identity")
        self.assertNotIn("token", marker)

        state = self.state()
        state["pending_admission"] = {
            "supervisor_id": "marker-reader", "host_id": "test-host", "boot_id": "test-boot",
            "pid": 999999, "process_identity": "dead-owner-identity", "phase": "reserved_pre_execution",
            "generation": None, "receipt_id": None, "started_at": 1000,
        }
        module.STATE.write_text(json.dumps(state), encoding="utf-8")
        with self.assertRaisesRegex(OSError, "simulated pending save failure"):
            reconcile_state(state, fail_save=True)
        self.assertIsNone(state["pending_admission"], "the failed save occurs after marker recovery, in memory only")
        self.assertIsNotNone(self.state()["pending_admission"], "disk still retains the pending intent across simulated crash")

        restarted_state = self.state()
        self.assertTrue(reconcile_state(restarted_state))
        self.assertIsNone(restarted_state["pending_admission"])
        self.assertIsNone(self.state()["pending_admission"], "Python restart persists marker-backed pending clear")

        # A later supervisor may recover the marker before reserve, then a
        # subsequent crash may leave the same null-generation intent after
        # capacity has parked generation G+2.
        holder = real_helper({"bridgeAction": "occupy"})[1]
        assert holder is not None
        self.assertEqual(holder["outcome"], "admitted")
        later_state = self.state()
        later_state["pending_admission"] = {
            "supervisor_id": "later-supervisor", "host_id": "test-host", "boot_id": "test-boot",
            "pid": 999999, "process_identity": "dead-owner-identity", "phase": "reserved_pre_execution",
            "generation": None, "receipt_id": None, "started_at": 1001,
        }
        module.STATE.write_text(json.dumps(later_state), encoding="utf-8")
        self.assertTrue(reconcile_state(later_state))
        self.assertIsNone(later_state["pending_admission"])
        capacity_wait = real_helper({"schemaVersion": 1, "action": "reserve", "repository": repository,
                                     "workspace": workspace_text, "supervisorId": "later-supervisor"})[1]
        assert capacity_wait is not None
        self.assertEqual(capacity_wait["outcome"], "waiting")
        parked_lane = real_helper({"bridgeAction": "readLane", "laneId": lane_id})[1]
        assert parked_lane is not None
        self.assertEqual((parked_lane["status"], parked_lane["generation"]), ("parked", generation + 2))
        after_capacity = self.state()
        after_capacity["pending_admission"] = {
            "supervisor_id": "another-later-supervisor", "host_id": "test-host", "boot_id": "test-boot",
            "pid": 999999, "process_identity": "dead-owner-identity", "phase": "reserved_pre_execution",
            "generation": None, "receipt_id": None, "started_at": 1002,
        }
        module.STATE.write_text(json.dumps(after_capacity), encoding="utf-8")
        self.assertTrue(reconcile_state(after_capacity))
        self.assertIsNone(after_capacity["pending_admission"])
        self.assertIsNone(self.state()["pending_admission"], "later capacity marker recovery also persists its clear")
        self.assertEqual(self.records(), [], "real helper marker recovery and capacity denial never spawn")

    def test_real_helper_recovery_binds_null_pending_before_settlement_and_retries_both_crashes(self) -> None:
        saved_testing = os.environ.get("SCD_HEARTBEAT_TESTING")
        saved_root = os.environ.get("SCD_HEARTBEAT_TEST_ROOT")
        os.environ["SCD_HEARTBEAT_TESTING"] = "1"
        os.environ["SCD_HEARTBEAT_TEST_ROOT"] = str(self.state_root)
        try:
            spec = importlib.util.spec_from_file_location("heartbeat_recoverable_runner_under_test", RUNNER)
            assert spec and spec.loader
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
        finally:
            if saved_testing is None:
                os.environ.pop("SCD_HEARTBEAT_TESTING", None)
            else:
                os.environ["SCD_HEARTBEAT_TESTING"] = saved_testing
            if saved_root is None:
                os.environ.pop("SCD_HEARTBEAT_TEST_ROOT", None)
            else:
                os.environ["SCD_HEARTBEAT_TEST_ROOT"] = saved_root

        workspace = self.root / "real-recovery-workspace"
        workspace.mkdir()
        helper_registry = self.root / "real-recovery-host" / "registry.json"
        helper_receipt = self.root / "real-recovery-receipts" / "heartbeat.json"
        admission_config = {
            "schemaVersion": 1, "revision": "recoverable-restart-v1",
            "limits": {"maxCaptains": 1, "maxWriters": 1, "maxHighAutonomy": 1},
        }
        registry_module = (Path.cwd() / "src/mission-admission/registry.ts").resolve().as_uri()
        admission_module = (Path.cwd() / "src/mission-admission/heartbeat-admission.ts").resolve().as_uri()
        bridge = self.state_root / "real-recoverable-admission-bridge.mjs"
        bridge.write_text(
            "import fs from 'node:fs';\n"
            "import { MissionAdmissionRegistry } from " + json.dumps(registry_module) + ";\n"
            "import { handleHeartbeatAdmission } from " + json.dumps(admission_module) + ";\n"
            "const q=JSON.parse(fs.readFileSync(0,'utf8'));\n"
            "const config=JSON.parse(process.env.TEST_ADMISSION_CONFIG);\n"
            "const options={filePath:process.env.TEST_ADMISSION_REGISTRY,config,"
            "...(q.injectPublicationFailure?{beforePublish:()=>{throw new Error('injected registry publication failure')}}:{})};\n"
            "const registry=new MissionAdmissionRegistry(options);\n"
            "if(q.bridgeAction==='readLane') console.log(JSON.stringify(registry.readLane(q.laneId)));\n"
            "else {delete q.injectPublicationFailure;delete q.bridgeAction;delete q.laneId;"
            "console.log(JSON.stringify(handleHeartbeatAdmission(q,{registry,receiptPath:()=>process.env.TEST_ADMISSION_RECEIPT})));}\n",
            encoding="utf-8",
        )
        node = shutil.which("node")
        self.assertIsNotNone(node)
        node_env = dict(os.environ, TEST_ADMISSION_REGISTRY=str(helper_registry),
                        TEST_ADMISSION_RECEIPT=str(helper_receipt),
                        TEST_ADMISSION_CONFIG=json.dumps(admission_config))

        def real_helper(request: dict[str, object]) -> dict[str, object]:
            result = subprocess.run([str(node), "--import", "tsx", str(bridge)], cwd=Path.cwd(), env=node_env,
                                    input=json.dumps(request), text=True, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, check=False)
            if result.returncode != 0:
                raise RuntimeError("pinned admission helper rejected the ownership transaction")
            return json.loads(result.stdout)

        repository = "nurockplayer/tachiko-conductor"
        workspace_text = str(workspace.resolve())
        reserved = real_helper({"schemaVersion": 1, "action": "reserve", "repository": repository,
                                "workspace": workspace_text, "supervisorId": "restarting-supervisor"})
        self.assertEqual(reserved["outcome"], "reserved")
        generation = reserved["generation"]
        receipt_id = reserved["receiptId"]
        lane_id = reserved["laneId"]
        runtime_config = {"admission": {"repository": repository, "workspace": workspace_text}}

        self.invoke("run", "--prime")
        state = self.state()
        state["pending_admission"] = {
            "supervisor_id": "restarting-supervisor", "host_id": "test-host", "boot_id": "test-boot",
            "pid": 999999, "process_identity": "dead-owner-identity", "phase": "reserved_pre_execution",
            "generation": None, "receipt_id": None, "started_at": 1000,
        }
        module.STATE.write_text(json.dumps(state), encoding="utf-8")
        calls: list[str] = []
        inject_settle_failure = False

        def python_admission_call(_config: dict[str, object], request: dict[str, object]) -> dict[str, object]:
            nonlocal inject_settle_failure
            action = str(request["action"])
            calls.append(action)
            call = dict(request)
            if action == "settle" and inject_settle_failure:
                call["injectPublicationFailure"] = True
                inject_settle_failure = False
            return real_helper(call)

        def patch_reconcile():
            return (
                mock.patch.object(module, "admission_call", side_effect=python_admission_call),
                mock.patch.object(module, "durable_host_boot_identity", return_value=("test-host", "test-boot")),
                mock.patch.object(module, "process_identity", return_value=None),
            )

        patches = patch_reconcile()
        with patches[0], patches[1], patches[2], \
                mock.patch.object(module, "save_state", side_effect=OSError("simulated pre-bind save failure")):
            with self.assertRaisesRegex(OSError, "simulated pre-bind save failure"):
                module.reconcile_pending_admission(runtime_config, state)
        self.assertEqual(calls, ["recover"], "failed exact-generation binding must not issue settle")
        self.assertEqual((state["pending_admission"]["generation"], state["pending_admission"]["receipt_id"]), (None, None))
        durable = self.state()["pending_admission"]
        self.assertEqual((durable["generation"], durable["receipt_id"]), (None, None))
        active_receipt = json.loads(helper_receipt.read_text(encoding="utf-8"))
        self.assertEqual((active_receipt["status"], active_receipt["token"]["generation"]), ("active", generation))
        active_lane = real_helper({"bridgeAction": "readLane", "laneId": lane_id})
        self.assertEqual((active_lane["status"], active_lane["generation"]), ("active", generation))

        inject_settle_failure = True
        patches = patch_reconcile()
        with patches[0], patches[1], patches[2]:
            with self.assertRaisesRegex(RuntimeError, "pinned admission helper rejected"):
                module.reconcile_pending_admission(runtime_config, state)
        durable = self.state()["pending_admission"]
        self.assertEqual((durable["generation"], durable["receipt_id"]), (generation, receipt_id),
                         "exact registry identity is durably bound before the settlement request")
        self.assertEqual((state["pending_admission"]["generation"], state["pending_admission"]["receipt_id"]),
                         (generation, receipt_id))
        settled_receipt = json.loads(helper_receipt.read_text(encoding="utf-8"))
        self.assertEqual((settled_receipt["status"], settled_receipt["token"]["generation"]), ("settled", generation))
        active_lane = real_helper({"bridgeAction": "readLane", "laneId": lane_id})
        self.assertEqual((active_lane["status"], active_lane["generation"]), ("active", generation),
                         "second interruption is after settled receipt publication but before registry release")

        restarted = self.state()
        patches = patch_reconcile()
        with patches[0], patches[1], patches[2]:
            self.assertTrue(module.reconcile_pending_admission(runtime_config, restarted))
        self.assertIsNone(restarted["pending_admission"])
        self.assertIsNone(self.state()["pending_admission"])
        released_lane = real_helper({"bridgeAction": "readLane", "laneId": lane_id})
        self.assertEqual((released_lane["status"], released_lane["generation"]), ("released", generation + 1))
        self.assertEqual(self.records(), [], "both restart recoveries settle exact ownership without spawning")

    def test_uncommitted_discard_retry_can_be_denied_by_capacity_again(self) -> None:
        self.invoke("run", "--prime")
        self.write_payload("B")
        self._set_uncommitted_receipt_pending()
        admission = json.loads(self.admission_state.read_text(encoding="utf-8"))
        admission["mode"] = "waiting"
        self.admission_state.write_text(json.dumps(admission), encoding="utf-8")

        first = self.invoke("run", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="1001"))
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertIsNone(self.state()["pending_admission"])
        self.assertEqual(self.state()["last_attempt_reason"], "normalized GitHub state changed")
        self.assertEqual(self.records(), [])

        self.write_payload("C")
        restarted = self.invoke("run", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="1002"))
        self.assertEqual(restarted.returncode, 0, restarted.stderr)
        self.assertIsNone(self.state()["pending_admission"])
        self.assertEqual(self.records(), [], "a second capacity denial across restart remains no-spawn")

    def test_released_predecessor_clears_crashed_owned_elsewhere_intent_then_retries_without_spawn(self) -> None:
        self.invoke("run", "--prime")
        self.write_payload("B")
        self.admission_state.write_text(json.dumps({"mode": "owned_elsewhere"}), encoding="utf-8")
        failed_clear = self.invoke("run", env=dict(
            self.env, SCD_HEARTBEAT_TEST_NOW="1001", SCD_HEARTBEAT_TEST_FAIL_CLEAR_PENDING="1",
        ), check=False)
        self.assertEqual(failed_clear.returncode, 1)
        pending = self.state()["pending_admission"]
        self.assertIsNotNone(pending, "crash/failure after owned_elsewhere must preserve the null-generation intent")
        self.assertEqual(pending["phase"], "reserved_pre_execution")
        self.assertIsNone(pending["generation"])
        self.assertIsNone(pending["receipt_id"])

        predecessor = {
            "mode": "waiting", "releasedPredecessor": True, "active": False,
            "generation": 6, "releasedGeneration": 7,
            "receiptId": "00000000-0000-4000-8000-000000000006", "supervisorId": "previous-supervisor",
            "status": "settled", "laneId": "heartbeat:" + hashlib.sha256(("nurockplayer/tachiko-conductor\0" + str(Path.cwd().resolve())).encode()).hexdigest()[:32],
        }
        self.admission_state.write_text(json.dumps(predecessor), encoding="utf-8")
        retried = self.invoke("run", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="1002"))
        self.assertEqual(retried.returncode, 0, retried.stderr)
        self.assertIsNone(self.state()["pending_admission"])
        after = json.loads(self.admission_state.read_text(encoding="utf-8"))
        self.assertEqual(after, predecessor, "read-only classification and repeated capacity denial preserve the tombstone/lane")
        self.assertEqual(self.records(), [], "only a fresh reserved result may spawn")

    def test_released_predecessor_accepts_legacy_receipt_id_grammar(self) -> None:
        self.invoke("run", "--prime")
        legacy_receipt_id = "-" * 36
        self._set_released_predecessor_pending(receipt_id=legacy_receipt_id)
        result = self.invoke("run", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="1001"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIsNone(self.state()["pending_admission"])
        self.assertEqual(self.records(), [], "legacy released predecessor recovery cannot spawn")

    def test_released_predecessor_refuses_wrong_phase_or_host_after_reboot(self) -> None:
        for phase, host_id, boot_id, bad_tombstone in (
            ("spawn_uncertain", "test-host", "prior-boot", None),
            ("reserved_pre_execution", "other-host", "prior-boot", None),
            ("reserved_pre_execution", "test-host", "test-boot", {"releasedGeneration": 8}),
            ("reserved_pre_execution", "test-host", "test-boot", {"laneId": "heartbeat:foreign"}),
            ("reserved_pre_execution", "test-host", "test-boot", {"receiptId": "not-a-uuid"}),
            ("reserved_pre_execution", "test-host", "test-boot", {"receiptId": "x" * 36}),
        ):
            with self.subTest(phase=phase, host_id=host_id, bad_tombstone=bad_tombstone):
                self.invoke("run", "--prime")
                self._set_released_predecessor_pending(phase=phase, host_id=host_id, boot_id=boot_id)
                before = json.loads(self.admission_state.read_text(encoding="utf-8"))
                if bad_tombstone is not None:
                    before.update(bad_tombstone)
                    self.admission_state.write_text(json.dumps(before), encoding="utf-8")
                result = self.invoke("run", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="1001"), check=False)
                self.assertEqual(result.returncode, 1)
                self.assertIsNotNone(self.state()["pending_admission"])
                self.assertEqual(json.loads(self.admission_state.read_text(encoding="utf-8")), before)
                self.assertEqual(self.records(), [])

    def test_same_boot_uncertain_intent_clears_only_after_registry_proves_exact_release(self) -> None:
        self.invoke("run", "--prime")
        self._set_pending_admission("spawn_uncertain")
        receipt = json.loads(self.admission_state.read_text(encoding="utf-8"))
        receipt.update(active=False, releasedGeneration=2)
        self.admission_state.write_text(json.dumps(receipt), encoding="utf-8")
        result = self.invoke("run", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="1001"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIsNone(self.state()["pending_admission"])
        final_admission = json.loads(self.admission_state.read_text(encoding="utf-8"))
        self.assertEqual(final_admission["generation"], 1, "orphan reconciliation never reserves a successor generation")
        self.assertEqual(self.records(), [])

    def test_caught_spawn_uncertain_state_write_failure_settles_before_any_child(self) -> None:
        self.invoke("run", "--prime")
        self.write_payload("B")
        result = self.invoke("run", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="1001",
                                                SCD_HEARTBEAT_TEST_FAIL_PHASE_SAVE="spawn_uncertain"), check=False)
        self.assertEqual(result.returncode, 1)
        self.assertFalse(json.loads(self.admission_state.read_text(encoding="utf-8"))["active"])
        self.assertEqual(self.records(), [], "known pre-spawn failure settles the exact generation")

    def test_guard_setup_failure_settles_exact_generation_and_releases_runner_lock(self) -> None:
        self.invoke("run", "--prime")
        self.write_payload("B")
        failed = self.invoke("run", env=dict(
            self.env, SCD_HEARTBEAT_TEST_NOW="1001", SCD_HEARTBEAT_TEST_FAIL_GUARD_SETUP="1",
        ), check=False)
        self.assertEqual(failed.returncode, 1)
        failed_admission = json.loads(self.admission_state.read_text(encoding="utf-8"))
        self.assertFalse(failed_admission["active"])
        self.assertEqual(failed_admission["releasedGeneration"], failed_admission["generation"] + 1)
        self.assertEqual(self.records(), [], "guard setup failure precedes Popen")

        retry = self.invoke("run", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="1002"))
        self.assertEqual(retry.returncode, 0, retry.stderr)
        self.assertEqual(len(self.records()), 1, "the runner lock and exact admission were released for retry")

    def test_corrupt_or_tampered_admission_helper_fails_closed(self) -> None:
        self.invoke("run", "--prime")
        self.write_payload("B")
        self.admission_state.write_text(json.dumps({"mode": "corrupt"}), encoding="utf-8")
        result = self.invoke("run", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="1001"), check=False)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.records(), [])
        self.admission_state.write_text("{}", encoding="utf-8")
        config = json.loads((self.state_root / "config.json").read_text(encoding="utf-8"))
        Path(config["admission_helper"]).write_text("// replaced\n", encoding="utf-8")
        result = self.invoke("run", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="1002"), check=False)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.records(), [], "helper byte tampering must deny ownership and model launch")

    def test_config_rejects_noncanonical_helper_root_and_duplicate_paths(self) -> None:
        self.invoke("run", "--prime")
        config_path = self.state_root / "config.json"
        pristine = json.loads(config_path.read_text(encoding="utf-8"))

        wrong_root = json.loads(json.dumps(pristine))
        wrong_root["admission_helper"] = str(self.root / "other-bundle" / "mission-admission" / "heartbeat-admission-cli.js")
        config_path.write_text(json.dumps(wrong_root), encoding="utf-8")
        self.assertEqual(self.invoke("run", check=False).returncode, 1)

        duplicate = json.loads(json.dumps(pristine))
        duplicate["admission_helper_files"].append(dict(duplicate["admission_helper_files"][0]))
        config_path.write_text(json.dumps(duplicate), encoding="utf-8")
        self.assertEqual(self.invoke("run", check=False).returncode, 1)
        self.assertEqual(self.records(), [], "malformed closure identities fail before any model-capable wake")

    def test_wake_environment_cannot_override_admission_domain(self) -> None:
        config_path = self.state_root / "config.json"
        config = json.loads(config_path.read_text(encoding="utf-8"))
        config["wake_env"] = {"TACHIKO_MISSION_ADMISSION_PATH": str(self.root / "attacker-registry.json")}
        config_path.write_text(json.dumps(config), encoding="utf-8")
        self.assertEqual(self.invoke("run", "--prime", check=False).returncode, 1)
        self.assertFalse((self.root / "attacker-registry.json").exists())
        self.assertEqual(self.records(), [])

    def test_wake_child_uses_pinned_admission_domain_over_conflicting_ambient_environment(self) -> None:
        self.invoke("run", "--prime")
        config = json.loads((self.state_root / "config.json").read_text(encoding="utf-8"))
        self.write_payload("ambient-domain")
        alternate = self.root / "ambient-registry.json"
        result = self.invoke(
            "run", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="1179",
                            TACHIKO_MISSION_ADMISSION_PATH=str(alternate),
                            TACHIKO_MISSION_ADMISSION_CONFIG="{}",
                            TACHIKO_DATA_DIR=str(self.root / "wrong-runs")),
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.records()), 1)
        self.assertEqual(self.records()[0]["admission_path"], config["admission"]["registry"])
        self.assertNotEqual(self.records()[0]["admission_path"], str(alternate))
        self.assertFalse(alternate.exists())

    def test_guard_settlement_failure_times_out_without_consuming_or_unlocking(self) -> None:
        self.invoke("run", "--prime")
        self.write_payload("B")
        config_path = self.state_root / "config.json"
        config = json.loads(config_path.read_text(encoding="utf-8"))
        config["wake_timeout_seconds"] = 1
        config_path.write_text(json.dumps(config), encoding="utf-8")
        self.admission_state.write_text(json.dumps({"mode": "stale"}), encoding="utf-8")
        result = self.invoke("run", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="1001"), check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.records()), 1)
        self.assertNotEqual(self.state()["successful_fingerprint"], self.state()["last_attempt_fingerprint"])
        receipt = json.loads(self.admission_state.read_text(encoding="utf-8"))
        self.assertTrue(receipt["active"], "ambiguous settlement must retain the registry generation")
        self.invoke("run", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="1002"))
        self.assertEqual(len(self.records()), 1, "ambiguous guard settlement must not permit overlap")
        receipt.pop("mode", None)
        self.admission_state.write_text(json.dumps(receipt), encoding="utf-8")
        deadline = time.time() + 7
        while (self.state_root / "runner.lock").read_bytes() and time.time() < deadline:
            time.sleep(0.1)
        self.assertEqual((self.state_root / "runner.lock").read_bytes(), b"", "guard may settle after state repair")

    def test_real_pinned_helper_competes_with_native_lane_then_guard_settles(self) -> None:
        saved_testing = os.environ.get("SCD_HEARTBEAT_TESTING")
        saved_root = os.environ.get("SCD_HEARTBEAT_TEST_ROOT")
        os.environ["SCD_HEARTBEAT_TESTING"] = "1"
        os.environ["SCD_HEARTBEAT_TEST_ROOT"] = str(self.state_root)
        try:
            spec = importlib.util.spec_from_file_location("heartbeat_runner_under_test", RUNNER)
            self.assertIsNotNone(spec and spec.loader)
            module = importlib.util.module_from_spec(spec)
            assert spec and spec.loader
            spec.loader.exec_module(module)
        finally:
            if saved_testing is None: os.environ.pop("SCD_HEARTBEAT_TESTING", None)
            else: os.environ["SCD_HEARTBEAT_TESTING"] = saved_testing
            if saved_root is None: os.environ.pop("SCD_HEARTBEAT_TEST_ROOT", None)
            else: os.environ["SCD_HEARTBEAT_TEST_ROOT"] = saved_root

        node_source = Path(shutil.which("node") or "")
        node, node_digest, _ = module.pin_admission_node(node_source)
        ambient_entry = Path.cwd() / "dist/mission-admission/heartbeat-admission-cli.js"
        ambient_entry.parent.mkdir(parents=True, exist_ok=True)
        had_ambient = ambient_entry.exists()
        ambient_bytes = ambient_entry.read_bytes() if had_ambient else None
        poison = b"// stale untracked dist must never be pinned\n"
        ambient_entry.write_bytes(poison)
        saved_testing = os.environ.get("SCD_HEARTBEAT_TESTING")
        saved_root = os.environ.get("SCD_HEARTBEAT_TEST_ROOT")
        os.environ["SCD_HEARTBEAT_TESTING"] = "1"
        os.environ["SCD_HEARTBEAT_TEST_ROOT"] = str(self.state_root)
        try:
            helper, helper_digest, helper_files, helper_build, _ = module.pin_admission_helper(Path.cwd().resolve(), node_source)
        finally:
            if saved_testing is None: os.environ.pop("SCD_HEARTBEAT_TESTING", None)
            else: os.environ["SCD_HEARTBEAT_TESTING"] = saved_testing
            if saved_root is None: os.environ.pop("SCD_HEARTBEAT_TEST_ROOT", None)
            else: os.environ["SCD_HEARTBEAT_TEST_ROOT"] = saved_root
            if had_ambient:
                assert ambient_bytes is not None
                ambient_entry.write_bytes(ambient_bytes)
            else:
                ambient_entry.unlink(missing_ok=True)
        self.assertNotEqual(Path(helper).read_bytes(), poison)
        expected_head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=Path.cwd(), check=True,
                                       text=True, stdout=subprocess.PIPE).stdout.strip()
        self.assertEqual(helper_build["source_commit"], expected_head)
        self.assertEqual(helper_build["pnpm_version"], "10.34.5")
        self.assertEqual(helper_build["typescript_version"], "5.9.3")
        admission = {
            "repository": "nurockplayer/tachiko-conductor", "workspace": str((self.root / "workspace").resolve()),
            "home": str(self.account_home.resolve()),
            "registry": str((self.account_home / ".tachiko-conductor" / "mission-admission" / "registry.json").resolve()),
            "runs": str(self.account_home / ".tachiko-conductor" / "runs"),
            "receipts": str(self.account_home / ".tachiko-conductor" / "mission-admission" / "heartbeat-receipts"),
            "config": {"schemaVersion": 1, "revision": "cross-language-smoke-v1", "limits": {"maxCaptains": 2, "maxWriters": 2, "maxHighAutonomy": 1}},
        }
        Path(admission["workspace"]).mkdir()
        config_path = self.state_root / "config.json"
        config = json.loads(config_path.read_text(encoding="utf-8"))
        config.update({"admission": admission, "admission_node": str(node), "admission_node_sha256": node_digest,
                       "admission_helper": str(helper), "admission_helper_sha256": helper_digest,
                       "admission_helper_files": helper_files, "admission_build": helper_build})
        config_path.write_text(json.dumps(config), encoding="utf-8")
        runtime_config = dict(config)
        runtime_config["wake_env"] = {}
        module.verify_admission_helper(config)
        helper_root = Path(helper).parents[1]
        extra_bundle_file = helper_root / "unlisted.js"
        extra_bundle_file.write_text("// not in manifest", encoding="utf-8")
        try:
            with self.assertRaisesRegex(RuntimeError, "unlisted or missing"):
                module.verify_admission_helper(config)
        finally:
            extra_bundle_file.unlink()
        symlink_bundle_file = helper_root / "symlink.js"
        symlink_bundle_file.symlink_to(Path(helper))
        try:
            with self.assertRaisesRegex(RuntimeError, "symlink"):
                module.verify_admission_helper(config)
        finally:
            symlink_bundle_file.unlink()
        mismatched_source = json.loads(json.dumps(config))
        mismatched_source["admission_build"]["source_commit"] = "0" * len(helper_build["source_commit"])
        with self.assertRaisesRegex(RuntimeError, "closure digest or entry"):
            module.validate_config(mismatched_source)
        transitive = Path(helper).parents[1] / "mission-admission/registry.js"
        transitive_bytes = transitive.read_bytes()
        transitive.unlink()
        try:
            with self.assertRaisesRegex(OSError, "No such file"):
                module.verify_admission_helper(config)
        finally:
            transitive.write_bytes(transitive_bytes)
        transitive.write_bytes(transitive_bytes + b"// tampered\n")
        try:
            with self.assertRaisesRegex(RuntimeError, "closure failed verification"):
                module.verify_admission_helper(config)
        finally:
            transitive.write_bytes(transitive_bytes)
        helper_env = module.admission_helper_environment(runtime_config)
        node_preload = HERE.parent.parent / "tests/fixtures/account-home-preload.mjs"
        registry_js = Path(helper).parents[1] / "mission-admission/registry.js"
        host_registry_js = Path(helper).parents[1] / "mission-admission/host-registry.js"
        direct_source = (
            "import { createHostAdmissionRegistry } from " + json.dumps(host_registry_js.as_uri()) + ";\n"
            "const registry = createHostAdmissionRegistry();\n"
            "const result = registry.admit({laneId:'native-direct-smoke',role:'production_captain',highAutonomy:true,evidence:{repository:'nurockplayer/tachiko-conductor',issue:117,workspace:" + json.dumps(admission["workspace"]) + "}});\n"
            "console.log(JSON.stringify(result));\n"
        )
        direct = subprocess.run([str(node), "--import", str(node_preload), "--input-type=module", "-e", direct_source], env=helper_env,
                                text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
        direct_result = json.loads(direct.stdout)
        self.assertEqual(direct_result["outcome"], "admitted")

        self.invoke("run", "--prime")
        self.write_payload("B")
        denied = self.invoke("run", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="1001"), check=False)
        self.assertEqual(denied.returncode, 0, denied.stderr + (self.state_root / "heartbeat.log").read_text())
        self.assertEqual(self.records(), [], "a native/direct production lane must deny the heartbeat wake")

        release_source = (
            "import { MissionAdmissionRegistry } from " + json.dumps(registry_js.as_uri()) + ";\n"
            "const registry = new MissionAdmissionRegistry({filePath: process.env.TACHIKO_MISSION_ADMISSION_PATH, config: JSON.parse(process.env.TACHIKO_MISSION_ADMISSION_CONFIG)});\n"
            "const lane = registry.readLane('native-direct-smoke');\n"
            "registry.release({laneId:lane.laneId,generation:lane.generation,token:" + json.dumps(direct_result["token"]["token"]) + "},true);\n"
        )
        subprocess.run([str(node), "--import", str(node_preload), "--input-type=module", "-e", release_source], env=helper_env,
                       text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
        resumed = self.invoke("run", env=dict(
            self.env, SCD_HEARTBEAT_TEST_NOW="1002",
            TACHIKO_MISSION_ADMISSION_PATH=str(self.root / "attacker-registry.json"),
        ), check=False)
        self.assertEqual(resumed.returncode, 0, resumed.stderr)
        self.assertEqual(len(self.records()), 1)
        self.assertEqual(self.records()[0]["admission_path"], admission["registry"],
                         "native CLI in the wake must use the helper's fixed registry domain")
        original_helper_environment = module.admission_helper_environment
        with mock.patch.object(
            module, "admission_helper_environment",
            side_effect=lambda selected: {**original_helper_environment(selected), "NODE_OPTIONS": "--import " + str(node_preload)},
        ):
            inspect = module.admission_call(runtime_config, {
                "schemaVersion": 1, "action": "inspect", "repository": admission["repository"],
                "workspace": admission["workspace"],
            })
        self.assertEqual(inspect["outcome"], "inspected")
        heartbeat_lane = inspect["lane"]
        self.assertIsNotNone(heartbeat_lane)
        self.assertEqual(heartbeat_lane["status"], "released", "guard must settle the exact registry generation")

    def test_empty_process_snapshot_requires_kernel_group_absence(self) -> None:
        saved_testing = os.environ.get("SCD_HEARTBEAT_TESTING")
        saved_root = os.environ.get("SCD_HEARTBEAT_TEST_ROOT")
        os.environ["SCD_HEARTBEAT_TESTING"] = "1"
        os.environ["SCD_HEARTBEAT_TEST_ROOT"] = str(self.state_root)
        try:
            spec = importlib.util.spec_from_file_location("heartbeat_group_scan_under_test", RUNNER)
            assert spec and spec.loader
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
        finally:
            if saved_testing is None: os.environ.pop("SCD_HEARTBEAT_TESTING", None)
            else: os.environ["SCD_HEARTBEAT_TESTING"] = saved_testing
            if saved_root is None: os.environ.pop("SCD_HEARTBEAT_TEST_ROOT", None)
            else: os.environ["SCD_HEARTBEAT_TEST_ROOT"] = saved_root
        empty_ps = subprocess.CompletedProcess(["ps"], 0, stdout="", stderr="")
        with mock.patch.object(module.Path, "is_dir", return_value=False), \
             mock.patch.object(module.subprocess, "run", return_value=empty_ps), \
             mock.patch.object(module.os, "killpg", return_value=None):
            self.assertIsNone(module.process_group_has_live_members(12345),
                              "a fork after the process snapshot must not be mistaken for an empty group")
        with mock.patch.object(module.Path, "is_dir", return_value=False), \
             mock.patch.object(module.subprocess, "run", return_value=empty_ps), \
             mock.patch.object(module.os, "killpg", side_effect=ProcessLookupError()):
            self.assertFalse(module.process_group_has_live_members(12345),
                             "only kernel-confirmed process-group absence proves stop")

    @unittest.skipUnless(sys.platform.startswith("linux"), "the synchronized /proc race regression requires Linux")
    def test_process_group_scan_miss_after_fork_remains_unknown(self) -> None:
        saved_testing = os.environ.get("SCD_HEARTBEAT_TESTING")
        saved_root = os.environ.get("SCD_HEARTBEAT_TEST_ROOT")
        os.environ["SCD_HEARTBEAT_TESTING"] = "1"
        os.environ["SCD_HEARTBEAT_TEST_ROOT"] = str(self.state_root)
        try:
            spec = importlib.util.spec_from_file_location("heartbeat_fork_scan_under_test", RUNNER)
            assert spec and spec.loader
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
        finally:
            if saved_testing is None: os.environ.pop("SCD_HEARTBEAT_TESTING", None)
            else: os.environ["SCD_HEARTBEAT_TESTING"] = saved_testing
            if saved_root is None: os.environ.pop("SCD_HEARTBEAT_TEST_ROOT", None)
            else: os.environ["SCD_HEARTBEAT_TEST_ROOT"] = saved_root

        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(5)"], start_new_session=True)
        original_iterdir = module.Path.iterdir
        try:
            def snapshot_without_target(directory: Path):
                entries = list(original_iterdir(directory))
                if str(directory) == "/proc":
                    # Model a process forked into the guarded PGID just after
                    # the directory snapshot was taken.
                    entries = [entry for entry in entries if entry.name != str(child.pid)]
                return iter(entries)

            with mock.patch.object(module.Path, "iterdir", snapshot_without_target):
                self.assertIsNone(module.process_group_has_live_members(child.pid),
                                  "a child omitted from the process snapshot must remain guarded by kernel PGID evidence")
        finally:
            child.terminate()
            child.wait(timeout=5)

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

        (self.state_root / "runner.lock").write_text(
            '{"pid":999999,"process_identity":"expired"}\n', encoding="utf-8"
        )
        self.invoke("run")
        self.assertEqual(len(self.records()), 2, "provably exited stale owner may recover")

    def test_poll_crash_recovers_from_reused_pid_identity(self) -> None:
        self.invoke("run", "--prime")
        self.write_payload("B")
        sleeping = dict(self.env, SCD_HEARTBEAT_TEST_NOW="1001", MOCK_GH_SLEEP="2")
        first = subprocess.Popen([sys.executable, str(RUNNER), "run"], env=sleeping)
        lock_path = self.state_root / "runner.lock"
        deadline = time.time() + 5
        metadata: dict[str, object] = {}
        while time.time() < deadline:
            raw = lock_path.read_text(encoding="utf-8")
            if raw.strip():
                metadata = json.loads(raw)
                break
            time.sleep(0.02)
        self.assertIn("process_identity", metadata)
        first.kill()
        first.wait(timeout=5)
        metadata["pid"] = os.getpid()
        lock_path.write_text(json.dumps(metadata) + "\n", encoding="utf-8")
        self.invoke("run", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="1002"))
        self.assertEqual(len(self.records()), 1, "a reused PID with different identity must recover")

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

        deadline = time.time() + 5
        while (self.state_root / "runner.lock").read_bytes() and time.time() < deadline:
            time.sleep(0.02)
        self.assertEqual(
            (self.state_root / "runner.lock").read_bytes(), b"",
            "the guard must clear dead-supervisor metadata before releasing the flock",
        )
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
            "guard must terminate the timed-out direct target before releasing the lock; log=" +
            (self.state_root / "heartbeat.log").read_text() + " registry=" +
            self.admission_state.read_text() + " lock=" + (self.state_root / "runner.lock").read_text(),
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

    def test_wake_descendant_retains_lock_until_process_group_is_empty(self) -> None:
        self.invoke("run", "--prime")
        self.write_payload("B")
        background_pid_path = self.root / "background.pid"
        background = dict(self.env, SCD_HEARTBEAT_TEST_NOW="1001", MOCK_WAKE_BACKGROUND_SLEEP="5")
        first = subprocess.Popen([sys.executable, str(RUNNER), "run"], env=background)
        deadline = time.time() + 5
        while not background_pid_path.exists() and time.time() < deadline:
            time.sleep(0.02)
        self.assertTrue(background_pid_path.exists(), "wake target must create the test descendant")
        background_pid = int(background_pid_path.read_text(encoding="utf-8"))
        try:
            os.kill(background_pid, 0)
            self.write_payload("C")
            self.invoke("run", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="1002"))
            self.assertEqual(
                len(self.records()), 1,
                "a live descendant must retain the single-writer admission and lock",
            )
            first.wait(timeout=10)
            self.invoke("run", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="1003"))
            self.assertEqual(len(self.records()), 2, "fresh admission may resume after guard settles the prior generation")
        finally:
            if first.poll() is None:
                first.kill()
                first.wait(timeout=5)
            try:
                os.kill(background_pid, 9)
            except ProcessLookupError:
                pass

    def test_long_guard_handoff_frame_is_delivered_completely(self) -> None:
        self.invoke("run", "--prime")
        self.write_payload("B")
        config_path = self.state_root / "config.json"
        config = json.loads(config_path.read_text(encoding="utf-8"))
        config["wake_env"] = {"MOCK_LONG_HANDOFF": "x" * 20_000}
        config_path.write_text(json.dumps(config), encoding="utf-8")
        result = self.invoke("run", env=dict(self.env, SCD_HEARTBEAT_TEST_NOW="1001"), check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(self.admission_state.exists())
        self.assertFalse(json.loads(self.admission_state.read_text()) ["active"])

    def test_direct_exit_does_not_wait_for_descendant_output_eof(self) -> None:
        self.invoke("run", "--prime")
        self.write_payload("B")
        config_path = self.state_root / "config.json"
        config = json.loads(config_path.read_text(encoding="utf-8"))
        config["wake_timeout_seconds"] = 10
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
            self.assertGreaterEqual(time.monotonic() - started, 4.0, "successful state waits for the descendant group to stop")
            self.assertLess(time.monotonic() - started, 8.0)
            self.assertEqual(self.state()["last_attempt_exit"], 0)
            self.assertEqual(self.state()["successful_fingerprint"], self.state()["last_attempt_fingerprint"])
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
        self.assertLess(time.monotonic() - started, 3.0)
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
        home = self.account_home.resolve()
        canonical_registry = home / ".tachiko-conductor" / "mission-admission" / "registry.json"
        canonical_registry.parent.mkdir(parents=True)
        canonical_registry.write_text("{}", encoding="utf-8")
        registry_alias = self.root / "registry-alias.json"
        registry_alias.symlink_to(canonical_registry)
        args = (
            "--repo", str(Path.cwd()), "--interval", "180", "--safety-interval", "1800",
            "--wake-command-json", command, "--acknowledge-relocatable-wake-target", "--no-load",
            "--admission-registry-path", str(registry_alias),
        )
        install_env = dict(self.env, HOME=str(home))
        self.invoke("install", *args, env=install_env)
        before = (self.state_root / "state.json").read_bytes()
        self.invoke("install", *args, env=install_env)
        self.assertEqual((self.state_root / "state.json").read_bytes(), before)
        with self.plist.open("rb") as stream:
            plist = plistlib.load(stream)
        config = json.loads((self.state_root / "config.json").read_text(encoding="utf-8"))
        self.assertEqual(config["admission"]["registry"], str(canonical_registry))
        self.assertEqual(plist["StartInterval"], 180)
        self.assertEqual(plist["WorkingDirectory"], str(Path.cwd()))
        self.assertEqual(plist["ProgramArguments"], ["/usr/bin/python3", config["runner"], "run"])
        self.assertEqual(Path(config["runner"]).parent, self.state_root)
        self.assertEqual(Path(config["runner"]).name, "verified-runner-" + config["runner_sha256"])
        self.assertEqual(
            hashlib.sha256(Path(config["runner"]).read_bytes()).hexdigest(), config["runner_sha256"]
        )
        self.assertEqual(config["wake_command"], [str(self.wake), "future-dispatch-once"])
        self.assertEqual(self.invoke("status").returncode, 0)
        self.invoke("uninstall", "--no-load")
        self.invoke("uninstall", "--no-load")
        self.assertFalse(self.plist.exists())
        self.assertTrue((self.state_root / "state.json").exists(), "uninstall preserves evidence/state")

    def test_install_rejects_noncanonical_admission_registry_paths(self) -> None:
        command = json.dumps([str(self.wake), "future-dispatch-once"])
        args = (
            "install", "--repo", str(Path.cwd()), "--wake-command-json", command,
            "--acknowledge-relocatable-wake-target", "--no-load",
        )
        home = self.root.resolve()
        install_env = dict(self.env, HOME=str(home))
        explicit = self.invoke(
            *args, "--admission-registry-path", str(self.root / "alternate" / "registry.json"),
            env=install_env, check=False,
        )
        self.assertNotEqual(explicit.returncode, 0)
        self.assertIn("canonical per-user host path", explicit.stderr)
        inherited = self.invoke(
            *args, env=dict(install_env, TACHIKO_MISSION_ADMISSION_PATH=str(self.root / "alternate" / "registry.json")),
            check=False,
        )
        self.assertNotEqual(inherited.returncode, 0)
        self.assertIn("canonical per-user host path", inherited.stderr)

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

    def test_install_pins_github_cli_bytes_across_source_replacement(self) -> None:
        replaceable_parent = self.root / "replaceable-gh-parent"
        replaceable_parent.mkdir(mode=0o777)
        replaceable_parent.chmod(0o777)
        replaceable_gh = replaceable_parent / "gh"
        replaceable_gh.write_bytes(self.gh.read_bytes())
        replaceable_gh.chmod(0o700)
        command = json.dumps([str(self.wake), "future-dispatch-once"])
        environment = dict(self.env, SCD_HEARTBEAT_TEST_GH=str(replaceable_gh))
        result = self.invoke(
            "install", "--repo", str(Path.cwd()), "--wake-command-json", command,
            "--acknowledge-relocatable-wake-target", "--no-load",
            env=environment, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        config = json.loads((self.state_root / "config.json").read_text(encoding="utf-8"))
        self.assertEqual(Path(config["gh"]).parent, self.state_root)
        self.assertEqual(Path(config["gh"]).name, "verified-gh-" + config["gh_sha256"])
        replaceable_gh.write_text("#!/bin/sh\nexit 99\n", encoding="utf-8")
        replaceable_gh.chmod(0o700)
        self.assertEqual(self.invoke("run", "--prime", env=environment).returncode, 0)
        replaceable_gh.write_bytes(self.gh.read_bytes() + b"# upgraded\n")
        replaceable_gh.chmod(0o700)
        result = self.invoke(
            "install", "--repo", str(Path.cwd()), "--wake-command-json", command,
            "--acknowledge-relocatable-wake-target", "--no-load",
            env=environment, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        config = json.loads((self.state_root / "config.json").read_text(encoding="utf-8"))
        snapshots = list(self.state_root.glob("verified-gh-*"))
        self.assertEqual(snapshots, [Path(config["gh"])])

    def test_failed_install_rolls_back_new_github_snapshot(self) -> None:
        snapshots_before = list(self.state_root.glob("verified-gh-*"))
        unsafe_wake = self.root / "unsafe-wake"
        unsafe_wake.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        unsafe_wake.chmod(0o777)
        command = json.dumps([str(unsafe_wake)])
        result = self.invoke(
            "install", "--repo", str(Path.cwd()), "--wake-command-json", command,
            "--acknowledge-relocatable-wake-target", "--no-load", check=False,
        )
        self.assertEqual(result.returncode, 1)
        self.assertEqual(list(self.state_root.glob("verified-gh-*")), snapshots_before)

    def test_failed_activation_restores_previous_install_transaction(self) -> None:
        original_command = json.dumps([str(self.wake), "original"])
        self.invoke(
            "install", "--repo", str(Path.cwd()), "--wake-command-json", original_command,
            "--acknowledge-relocatable-wake-target", "--no-load",
        )
        before = {
            "config": (self.state_root / "config.json").read_bytes(),
            "state": (self.state_root / "state.json").read_bytes(),
            "plist": self.plist.read_bytes(),
            "snapshots": sorted(path.name for path in self.state_root.glob("verified-gh-*")),
        }
        upgraded_gh = self.root / "upgraded-gh"
        upgraded_gh.write_bytes(self.gh.read_bytes() + b"# upgraded\n")
        upgraded_gh.chmod(0o700)
        alternate = self.root / "alternate-transaction-wake"
        alternate.write_text("#!/bin/sh\nprintf 'TACHIKO_HEARTBEAT_SETTLED_V1\\n'\n", encoding="utf-8")
        alternate.chmod(0o700)
        environment = dict(
            self.env, SCD_HEARTBEAT_TEST_GH=str(upgraded_gh),
            MOCK_LAUNCHCTL_LOADED="1", MOCK_LAUNCHCTL_FAIL_ONCE="1",
        )
        result = self.invoke(
            "install", "--repo", str(Path.cwd()),
            "--wake-command-json", json.dumps([str(alternate)]),
            "--acknowledge-relocatable-wake-target", env=environment, check=False,
        )
        self.assertEqual(result.returncode, 1)
        self.assertEqual((self.state_root / "config.json").read_bytes(), before["config"])
        self.assertEqual((self.state_root / "state.json").read_bytes(), before["state"])
        self.assertEqual(self.plist.read_bytes(), before["plist"])
        self.assertEqual(
            sorted(path.name for path in self.state_root.glob("verified-gh-*")), before["snapshots"]
        )

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

    def test_verified_wake_materializes_pinned_adjacent_companion_from_writable_ancestor(self) -> None:
        companion_parent = self.root / "application-directory"
        companion_parent.mkdir(mode=0o777)
        companion_parent.chmod(0o777)
        companion = companion_parent / "source-code-mode-host"
        companion.write_text("trusted companion\n", encoding="utf-8")
        companion.chmod(0o700)
        config_path = self.state_root / "config.json"
        config = json.loads(config_path.read_text(encoding="utf-8"))
        config["wake_env"] = {"MOCK_WAKE_REQUIRE_COMPANION": "1"}
        config["required_files"].append({
            "path": str(companion), "sha256": hashlib.sha256(companion.read_bytes()).hexdigest(),
            "installed_name": "codex-code-mode-host",
        })
        config_path.write_text(json.dumps(config), encoding="utf-8")

        self.invoke("run", "--prime")
        self.write_payload("B")
        self.invoke("run")

        installed = self.state_root / "codex-code-mode-host"
        self.assertEqual(installed.read_text(encoding="utf-8"), "trusted companion\n")
        self.assertEqual(self.records()[-1]["args"], ["dispatchable-target"])

    def test_replaced_adjacent_companion_fails_closed(self) -> None:
        companion = self.root / "source-code-mode-host"
        companion.write_text("trusted companion\n", encoding="utf-8")
        companion.chmod(0o700)
        config_path = self.state_root / "config.json"
        config = json.loads(config_path.read_text(encoding="utf-8"))
        config["required_files"].append({
            "path": str(companion), "sha256": hashlib.sha256(companion.read_bytes()).hexdigest(),
            "installed_name": "codex-code-mode-host",
        })
        config_path.write_text(json.dumps(config), encoding="utf-8")

        self.invoke("run", "--prime")
        self.write_payload("B")
        companion.write_text("replaced companion\n", encoding="utf-8")
        self.assertEqual(self.invoke("run", check=False).returncode, 1)
        self.assertEqual(self.records(), [])

    def test_adjacent_companion_name_is_fixed_and_cannot_escape_state_root(self) -> None:
        config_path = self.state_root / "config.json"
        config = json.loads(config_path.read_text(encoding="utf-8"))
        config["required_files"][0]["installed_name"] = "../untrusted-host"
        config_path.write_text(json.dumps(config), encoding="utf-8")
        self.write_payload("B")
        self.assertEqual(self.invoke("run", check=False).returncode, 1)
        self.assertEqual(self.records(), [])

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
            "--no-load", env=dict(self.env, HOME=str(self.root.resolve())),
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
