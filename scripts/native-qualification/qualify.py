#!/usr/bin/python3
"""Qualification infrastructure; never part of the immutable tested checkout.

Raw subprocess output, process identities and filesystem identities are private.
Only the fixed-schema summary and recipient-encrypted archive are publishable.
An infrastructure success is not production/runtime qualification.
"""

import ast
import datetime
import hashlib
import json
import os
import pathlib
import platform
import pwd
import re
import selectors
import shutil
import signal
import stat
import struct
import subprocess
import sys
import tarfile
import tempfile
import time
import traceback


CANDIDATE = 'c9e8a06e660d285746e4da4db252971939073e2d'
TREE = '00490a7f39b99632fdb31819e753b5b1185cfd41'
BASE = 'c8c7f0c094f0f51319b1b2890e96bcdf93a0ded8'
PREVIOUS_CANDIDATE = 'e3cfc972f10cfbe4dca44a1f74d0d28d7943df76'
PYTHON_SKIP = 'test_process_group_scan_miss_after_fork_remains_unknown'
PYTHON_SKIP_REASON = 'the synchronized /proc race regression requires Linux'
SEATBELT = 'runs configured absolute Node and repository-pinned absolute pnpm under the macOS seatbelt'
NODE_TESTS = 65
RAW_LIMIT = 32 * 1024 * 1024
PUBLIC_LIMIT = 8 * 1024 * 1024
SUMMARY_LIMIT = 16 * 1024
CLT_ROOT = pathlib.Path('/Library/Developer/CommandLineTools')
CLT_GIT = CLT_ROOT / 'usr/bin/git'
DYLD_LIMIT = 4 * 1024 * 1024
DYLD_CRASH_UUID = '7331d12c-0f65-3aae-808e-12f9ff0eca3a'


def dyld_x86_uuid(data):
    """Read only bounded Mach-O headers/load commands; never load or execute an image."""
    if not 32 <= len(data) <= DYLD_LIMIT:
        raise RuntimeError('dyld_image_size_unsupported')
    start, size = 0, len(data)
    fat = {b'\xca\xfe\xba\xbe': ('>', False), b'\xbe\xba\xfe\xca': ('<', False),
           b'\xca\xfe\xba\xbf': ('>', True), b'\xbf\xba\xfe\xca': ('<', True)}
    if data[:4] in fat:
        endian, wide = fat[data[:4]]
        count = struct.unpack_from(endian + 'I', data, 4)[0]
        width = 32 if wide else 20
        table_end = 8 + count * width
        if not 1 <= count <= 16 or table_end > len(data):
            raise RuntimeError('dyld_fat_table_unsupported')
        slices, selected = [], []
        for index in range(count):
            fields = struct.unpack_from(endian + ('IIQQII' if wide else 'IIIII'), data, 8 + index * width)
            cpu, _subtype, offset, length, align = fields[:5]
            if (wide and fields[5] != 0) or align > 31 or offset < table_end or length < 32 \
                    or offset + length > len(data) or offset % (1 << align):
                raise RuntimeError('dyld_fat_slice_unsupported')
            if any(offset < other + span and other < offset + length for other, span in slices):
                raise RuntimeError('dyld_fat_slices_overlap')
            slices.append((offset, length))
            if cpu == 0x01000007:
                selected.append((offset, length))
        if len(selected) != 1:
            raise RuntimeError('dyld_x86_slice_not_unique')
        start, size = selected[0]
    magics = {b'\xcf\xfa\xed\xfe': '<', b'\xfe\xed\xfa\xcf': '>'}
    endian = magics.get(data[start:start + 4])
    if endian is None:
        raise RuntimeError('dyld_macho64_unsupported')
    header = struct.unpack_from(endian + '8I', data, start)
    cpu, commands, command_bytes = header[1], header[4], header[5]
    if cpu != 0x01000007 or not 1 <= commands <= 256 or command_bytes > 1024 * 1024 \
            or 32 + command_bytes > size:
        raise RuntimeError('dyld_x86_commands_unsupported')
    cursor, end = start + 32, start + 32 + command_bytes
    uuids = []
    for _index in range(commands):
        if cursor + 8 > end:
            raise RuntimeError('dyld_command_truncated')
        command, length = struct.unpack_from(endian + 'II', data, cursor)
        if length < 8 or length % 8 or cursor + length > end:
            raise RuntimeError('dyld_command_size_unsupported')
        if command == 0x1b:
            if length != 24:
                raise RuntimeError('dyld_uuid_command_unsupported')
            value = data[cursor + 8:cursor + 24].hex()
            uuids.append('-'.join([value[:8], value[8:12], value[12:16], value[16:20], value[20:]]))
        cursor += length
    if cursor != end or len(uuids) != 1:
        raise RuntimeError('dyld_uuid_not_unique_or_command_size_mismatch')
    return {'uuid': uuids[0], 'slice_offset': start, 'slice_bytes': size, 'cpu_type': cpu, 'ncmds': commands}


def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def digest(path):
    h = hashlib.sha256()
    with pathlib.Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def write_json(path, value):
    pathlib.Path(path).write_text(json.dumps(value, sort_keys=True, indent=2) + '\n')


def write_summary(path, value):
    encoded = (json.dumps(value, sort_keys=True, indent=2) + '\n').encode()
    if len(encoded) > SUMMARY_LIMIT:
        mode = value.get('mode', 'native_qualification')
        value = {'schema_version': 1, 'candidate': CANDIDATE, 'tree': TREE, 'base': BASE,
                 'mode': mode, 'native_gates': 'UNKNOWN' if mode == 'native_qualification' else 'NOT_RUN',
                 'selection': 'dyld_image_only' if mode == 'diagnostics_only' else None,
                 'status': {'provider_preflight_only': 'PREFLIGHT_FAIL',
                            'diagnostics_only': 'DIAGNOSTIC_FAIL'}.get(mode, 'FAIL'),
                 'reason': 'summary_oversize', 'evidence_encrypted': False,
                 'production_qualification': False}
        encoded = (json.dumps(value, sort_keys=True, indent=2) + '\n').encode()
    pathlib.Path(path).write_bytes(encoded)
    return value


def parse_python(text):
    totals = re.findall(r'^Ran (\d+) tests? in [0-9.]+s$', text, re.M)
    outcomes = re.findall(r'^(test_\w+) \([^\n]+\) \.\.\. (ok|skipped \'[^\n]*\'|FAIL|ERROR)$', text, re.M)
    skips = [{'name': name, 'reason': result[9:-1]} for name, result in outcomes if result.startswith("skipped '")]
    passed = sum(result == 'ok' for _, result in outcomes)
    failed = sum(result in ('FAIL', 'ERROR') for _, result in outcomes)
    complete = len(totals) == 1 and int(totals[0]) == len(outcomes)
    return {'tests': int(totals[0]) if len(totals) == 1 else None, 'pass': passed,
            'fail': failed, 'skip': len(skips), 'skips': skips, 'counts_complete': complete,
            'accepted': complete and int(totals[0]) == 108 and passed == 107 and failed == 0
            and skips == [{'name': PYTHON_SKIP, 'reason': PYTHON_SKIP_REASON}]
            and re.search(r'^OK \(skipped=1\)$', text, re.M) is not None}


def parse_node(text):
    numbers = {}
    complete = True
    for name in ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']:
        values = re.findall(r'^# ' + name + r' (\d+)$', text, re.M)
        if len(values) != 1:
            complete = False
            numbers[name] = None
        else:
            numbers[name] = int(values[0])
    seatbelt = re.findall(r'^\s*ok \d+ - ' + re.escape(SEATBELT) + r'\s*$', text, re.M)
    skip_names = re.findall(r'^\s*(?:ok|not ok) \d+ - (.*?)(?:\s+# SKIP(?:\s+.*)?)$', text, re.M)
    numbers.update({'counts_complete': complete, 'seatbelt_executed': len(seatbelt) == 1,
                    'skips': skip_names})
    numbers['accepted'] = complete and numbers['tests'] == NODE_TESTS and numbers['pass'] == NODE_TESTS \
        and all(numbers[name] == 0 for name in ['fail', 'cancelled', 'skipped', 'todo']) \
        and len(seatbelt) == 1 and not skip_names
    return numbers


class Qualification:
    def __init__(self, preflight_only=False, diagnostics_only=False):
        os.umask(0o077)
        self.preflight_only = preflight_only
        self.diagnostics_only = diagnostics_only
        self.mode = 'diagnostics_only' if diagnostics_only else 'provider_preflight_only' if preflight_only else 'native_qualification'
        self.failure_status = 'DIAGNOSTIC_FAIL' if diagnostics_only else 'PREFLIGHT_FAIL' if preflight_only else 'FAIL'
        self.success_status = 'DIAGNOSTIC_COMPLETE' if diagnostics_only else 'PREFLIGHT_PASS' if preflight_only else 'PASS'
        self.git_capability = None
        self.diagnostics = {'selection': 'dyld_image_only', 'image': None, 'complete': False} if diagnostics_only else None
        self.diagnostic_files = []
        self.started = time.monotonic()
        self.runner_temp = pathlib.Path(os.environ['RUNNER_TEMP']).resolve(strict=True)
        self.workspace = pathlib.Path(os.environ['GITHUB_WORKSPACE']).resolve(strict=True)
        self.candidate = (self.workspace / 'candidate').resolve(strict=True)
        self.infra = pathlib.Path(__file__).resolve().parent
        self.private = pathlib.Path(tempfile.mkdtemp(prefix='pr93-native-private-', dir=self.runner_temp)).resolve(strict=True)
        self.public = self.runner_temp / 'pr93-native-public'
        self.public.mkdir(mode=0o700, exist_ok=False)
        write_summary(self.public / 'summary.json', {'schema_version': 1, 'candidate': CANDIDATE, 'tree': TREE,
                      'base': BASE, 'mode': self.mode, 'native_gates': 'NOT_RUN',
                      'selection': 'dyld_image_only' if diagnostics_only else None,
                      'status': self.failure_status, 'reason': 'collector_initializing',
                      'evidence_encrypted': False, 'production_qualification': False})
        self.logs = self.private / 'logs'
        self.logs.mkdir(mode=0o700)
        self.fixture = self.private / 'fixtures'
        self.fixture.mkdir(mode=0o700)
        self.child_home = self.private / 'home'
        self.child_home.mkdir(mode=0o700)
        node = shutil.which('node')
        if node is None:
            raise RuntimeError('pinned_node_missing')
        self.node = pathlib.Path(node).resolve(strict=True)
        self.env = {'PATH': str(self.node.parent) + ':/usr/bin:/bin:/usr/sbin:/sbin',
                    'HOME': str(self.child_home), 'TMPDIR': str(self.fixture) + '/',
                    'XDG_CACHE_HOME': str(self.private / 'cache'),
                    'XDG_CONFIG_HOME': str(self.private / 'config'),
                    'COREPACK_HOME': str(self.private / 'corepack-cache'),
                    'COREPACK_ENABLE_DOWNLOAD_PROMPT': '0', 'CI': 'true',
                    'PYTHONDONTWRITEBYTECODE': '1', 'LANG': 'C', 'LC_ALL': 'C', 'TZ': 'UTC0',
                    'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_OPTIONAL_LOCKS': '0',
                    'GIT_TERMINAL_PROMPT': '0', 'GIT_AUTHOR_NAME': 'Native qualification fixture',
                    'GIT_AUTHOR_EMAIL': 'native-qualification@example.invalid',
                    'GIT_COMMITTER_NAME': 'Native qualification fixture',
                    'GIT_COMMITTER_EMAIL': 'native-qualification@example.invalid'}
        self.records = []
        self.versions = {}
        self.before = None
        self.after = None
        self.python = None
        self.node_result = None
        self.git = pathlib.Path('/usr/bin/git')
        self.sequence = 0
        self.failure = None
        self.provider_proofs = {}
        self.openssl = pathlib.Path('/usr/bin/openssl')
        self.finalizing = False
        self.provenance = {}
        self.developer_selection_prepared = False
        self.validate_private_root()

    def validate_private_root(self):
        for root in [self.private, self.fixture, self.child_home, self.logs]:
            info = root.lstat()
            if root.resolve(strict=True) != root or not stat.S_ISDIR(info.st_mode) \
                    or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
                raise RuntimeError('private_root_unsafe')
            for parent in root.parents:
                info = parent.lstat()
                sticky = info.st_uid == 0 and bool(info.st_mode & stat.S_ISVTX)
                if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) \
                        or info.st_uid not in (0, os.getuid()) or (info.st_mode & 0o022 and not sticky):
                    raise RuntimeError('private_ancestry_unsafe')

    def process_table(self):
        result = subprocess.run(['/bin/ps', '-axo', 'pid=,ppid=,pgid=,lstart=,stat=,comm='],
                                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                env=self.env, timeout=5, check=True)
        table = {}
        for line in result.stdout.decode('utf-8', errors='strict').splitlines():
            fields = line.split(None, 9)
            if len(fields) != 10:
                raise RuntimeError('process_snapshot_unparseable')
            pid, ppid, pgid = map(int, fields[:3])
            table[pid] = {'pid': pid, 'ppid': ppid, 'pgid': pgid, 'start': ' '.join(fields[3:8]),
                          'state': fields[8], 'command': fields[9]}
        return table

    def run(self, label, argv, timeout=30, cwd=None, required=True):
        """One attempt, bounded byte capture; observe/kill only this launched process family.

        A snapshot cannot prove that no unobserved detached descendant ever existed.
        The receipt reports only observed-family completion and original-group absence.
        """
        self.sequence += 1
        stem = '%03d-%s' % (self.sequence, label)
        outputs = [self.logs / (stem + '.stdout'), self.logs / (stem + '.stderr')]
        streams = [path.open('wb') for path in outputs]
        started = time.monotonic()
        record = {'label': label, 'argv': [str(arg) for arg in argv], 'cwd': str(cwd or self.candidate),
                  'started_at': utc(), 'timeout_seconds': timeout, 'exit_code': None,
                  'timed_out': False, 'raw_capture_complete': True, 'discarded_bytes': 0,
                  'observed_root': False, 'observed_family_complete': False, 'original_group_absent': False}
        seen = {}
        proc = None
        selector = selectors.DefaultSelector()
        total = 0
        root_exited = None
        termination = None
        snapshots = self.logs / (stem + '.processes.jsonl')
        try:
            budget = timeout if self.finalizing else max(1, min(timeout, 2300 - int(time.monotonic() - self.started)))
            proc = subprocess.Popen([str(arg) for arg in argv], cwd=cwd or self.candidate, env=self.env,
                                    stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    start_new_session=True, umask=0o022)
            record['child_umask'] = '022'
            record['root_pid'] = proc.pid
            for index, pipe in enumerate([proc.stdout, proc.stderr]):
                os.set_blocking(pipe.fileno(), False)
                selector.register(pipe, selectors.EVENT_READ, index)
            with snapshots.open('w') as observed:
                while True:
                    table = self.process_table()
                    owned = {pid for pid, info in table.items() if info['pgid'] == proc.pid}
                    owned.update(pid for pid, start in seen.items() if pid in table and table[pid]['start'] == start)
                    changed = True
                    while changed:
                        extra = {pid for pid, info in table.items() if info['ppid'] in owned}
                        changed = not extra.issubset(owned)
                        owned.update(extra)
                    if proc.pid in table and table[proc.pid]['pgid'] == proc.pid:
                        record['observed_root'] = True
                    for pid in owned:
                        seen[pid] = table[pid]['start']
                    observed.write(json.dumps({'at': utc(), 'family': [table[pid] for pid in sorted(owned)]}) + '\n')
                    observed.flush()
                    if snapshots.stat().st_size > RAW_LIMIT:
                        record['raw_capture_complete'] = False
                    elapsed = time.monotonic() - started
                    code = proc.poll()
                    if code is not None and root_exited is None:
                        root_exited = time.monotonic()
                    if elapsed > budget:
                        record['timed_out'] = True
                    must_stop = record['timed_out'] or not record['raw_capture_complete'] \
                        or (root_exited is not None and time.monotonic() - root_exited > 10 and owned)
                    if must_stop and termination is None:
                        termination = time.monotonic()
                    if termination is not None:
                        kill_signal = signal.SIGTERM if time.monotonic() - termination < 2 else signal.SIGKILL
                        # Recheck exact observed start identity immediately before each PID signal.
                        fresh = self.process_table()
                        for pid in owned:
                            if pid in fresh and fresh[pid]['start'] == seen.get(pid):
                                try:
                                    os.kill(pid, kill_signal)
                                except ProcessLookupError:
                                    pass
                    for key, _events in selector.select(timeout=0.1):
                        data = os.read(key.fileobj.fileno(), 64 * 1024)
                        if not data:
                            selector.unregister(key.fileobj)
                            key.fileobj.close()
                        else:
                            accepted = data[:max(0, RAW_LIMIT - total)]
                            streams[key.data].write(accepted)
                            total += len(accepted)
                            if len(accepted) != len(data):
                                record['raw_capture_complete'] = False
                                record['discarded_bytes'] += len(data) - len(accepted)
                    if code is not None and not owned and not selector.get_map():
                        record['observed_family_complete'] = True
                        record['original_group_absent'] = True
                        break
                    if termination is not None and time.monotonic() - termination > 10:
                        break
            record['exit_code'] = proc.wait(timeout=5)
        finally:
            if proc is not None and proc.poll() is None:
                # Only this unreaped direct child; never an unrelated PID or global group.
                proc.kill()
                proc.wait(timeout=5)
            selector.close()
            for stream in streams:
                stream.close()
            record['ended_at'] = utc()
            record['elapsed_seconds'] = round(time.monotonic() - started, 3)
            record['output'] = [{'name': path.name, 'bytes': path.stat().st_size, 'sha256': digest(path)} for path in outputs]
            record['observed_process_count'] = len(seen)
            self.records.append(record)
            write_json(self.logs / (stem + '.receipt.json'), record)
        success = record['exit_code'] == 0 and not record['timed_out'] and record['raw_capture_complete'] \
            and record['observed_family_complete'] and record['original_group_absent']
        if required and not success:
            raise RuntimeError('command_failed_' + label)
        return record, outputs

    def text(self, label, argv, timeout=30, cwd=None):
        _record, output = self.run(label, argv, timeout=timeout, cwd=cwd)
        if output[0].stat().st_size > 64 * 1024:
            raise RuntimeError('probe_output_oversize')
        return output[0].read_text().strip()

    def safe_system_file(self, path):
        physical = pathlib.Path(path).resolve(strict=True)
        info = physical.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise RuntimeError('system_provider_unsafe')
        for parent in physical.parents:
            info = parent.lstat()
            if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) \
                    or info.st_uid != 0 or info.st_mode & 0o022:
                raise RuntimeError('system_provider_ancestry_unsafe')
        return physical

    def apple_tool(self, path, expected_identifier=None):
        physical = self.safe_system_file(path)
        info = physical.stat()
        self.run('apple-signature', ['/usr/bin/codesign', '--verify', '--strict', '-R=anchor apple', physical])
        _record, output = self.run('apple-identity', ['/usr/bin/codesign', '-dv', '--verbose=4', physical])
        details = output[0].read_text() + '\n' + output[1].read_text()
        identifiers = re.findall(r'^Identifier=(.+)$', details, re.M)
        if len(identifiers) != 1 or (expected_identifier is not None and identifiers[0] != expected_identifier):
            raise RuntimeError('apple_identifier_mismatch')
        _record, output = self.run('apple-requirement', ['/usr/bin/codesign', '-d', '-r-', physical])
        requirement = output[0].read_text() + '\n' + output[1].read_text()
        if 'identifier "' + identifiers[0] + '"' not in requirement:
            raise RuntimeError('apple_requirement_missing')
        proof = {'physical_path': str(physical), 'identifier': identifiers[0], 'sha256': digest(physical),
                 'mode': stat.S_IMODE(info.st_mode), 'uid': info.st_uid, 'gid': info.st_gid,
                 'inode': info.st_ino, 'device': info.st_dev, 'anchor_apple_verified': True}
        self.provider_proofs[str(path)] = proof
        return physical

    def system_file_identity(self, path):
        physical = self.safe_system_file(path)
        info = physical.stat()
        return {'physical_path': str(physical), 'sha256': digest(physical), 'uid': info.st_uid,
                'gid': info.st_gid, 'mode': stat.S_IMODE(info.st_mode),
                'inode': info.st_ino, 'device': info.st_dev}

    def developer_path_inventory(self, path):
        """Metadata only: never execute an inventoried Git or repair its permissions."""
        path = pathlib.Path(path)
        result = {'requested_path': str(path), 'entries': []}
        try:
            if not path.is_absolute() or len(str(path)) > 4096 or len(path.parts) > 64:
                raise RuntimeError('inventory_path_invalid')
            physical = path.resolve(strict=True)
            result['physical_path'] = str(physical)
            paths = list(dict.fromkeys([path, *path.parents, physical, *physical.parents]))
        except (OSError, RuntimeError) as error:
            result['resolution_error'] = {'type': type(error).__name__, 'message': str(error)}
            paths = [path, *path.parents][:65]
        for entry in paths:
            item = {'path': str(entry)}
            try:
                info = entry.lstat()
                item.update({'uid': info.st_uid, 'gid': info.st_gid, 'mode': stat.S_IMODE(info.st_mode),
                             'type_and_permissions': stat.filemode(info.st_mode),
                             'inode': info.st_ino, 'device': info.st_dev})
                if stat.S_ISLNK(info.st_mode):
                    item['symlink_target'] = os.readlink(entry)
            except OSError as error:
                item['error'] = {'type': type(error).__name__, 'message': str(error)}
            result['entries'].append(item)
        return result

    def prepare_existing_clt_selection(self):
        """Only an existing, fully qualified CLT can replace an unsafe selected Git.

        The caller has already qualified codesign and xcrun. A successful switch
        restarts the ordinary provider preflight; no provider predicate changes.
        """
        inventory = {'original_selection': None, 'selected_git': None,
                     'clt_git': self.developer_path_inventory(CLT_GIT), 'existing_xcode_roots': [],
                     'switched': False}
        try:
            # A bounded, single-level inventory of existing developer roots only.
            try:
                with os.scandir('/Applications') as entries:
                    for index, entry in enumerate(entries):
                        if index >= 128 or len(inventory['existing_xcode_roots']) >= 8:
                            inventory['xcode_inventory_limit_reached'] = True
                            break
                        if re.fullmatch(r'Xcode(?:_[0-9.]+)?\.app', entry.name):
                            root = pathlib.Path(entry.path) / 'Contents/Developer'
                            inventory['existing_xcode_roots'].append(self.developer_path_inventory(root))
            except OSError as error:
                inventory['xcode_inventory_error'] = {'type': type(error).__name__, 'message': str(error)}
            self.safe_system_file('/usr/bin/xcode-select')
            original = self.text('developer-selection-before', ['/usr/bin/xcode-select', '-p'])
            inventory['original_selection'] = original
            selected = self.text('developer-selected-git', ['/usr/bin/xcrun', '--find', 'git'])
            inventory['selected_git'] = self.developer_path_inventory(selected)
            if not pathlib.Path(original).is_absolute() or not pathlib.Path(selected).is_absolute():
                raise RuntimeError('developer_selection_unresolved')
            try:
                self.safe_system_file(selected)
            except (OSError, RuntimeError) as error:
                inventory['selected_git_filesystem_failure'] = {'type': type(error).__name__, 'message': str(error)}
            else:
                return False
            before = self.system_file_identity(CLT_GIT)
            self.apple_tool(CLT_GIT, 'com.apple.git')
            if self.system_file_identity(CLT_GIT) != before:
                raise RuntimeError('clt_git_changed_during_qualification')
            inventory['qualified_clt_git'] = before
            self.safe_system_file('/usr/bin/sudo')
            switch = ['/usr/bin/sudo', '-n', '/usr/bin/xcode-select', '--switch', str(CLT_ROOT)]
            inventory['switch_command'] = switch
            self.run('select-existing-qualified-clt', switch, timeout=30)
            selection = self.text('developer-selection-after', ['/usr/bin/xcode-select', '-p'])
            resolved = self.text('developer-git-after', ['/usr/bin/xcrun', '--find', 'git'])
            inventory['selection_after'] = selection
            inventory['git_after'] = resolved
            if pathlib.Path(selection).resolve(strict=True) != CLT_ROOT.resolve(strict=True) \
                    or str(pathlib.Path(resolved).resolve(strict=True)) != before['physical_path'] \
                    or self.system_file_identity(CLT_GIT) != before:
                raise RuntimeError('clt_selection_postflight_mismatch')
            inventory['switched'] = True
            return True
        except BaseException as error:
            inventory['failure'] = {'type': type(error).__name__, 'message': str(error)}
            raise
        finally:
            write_json(self.private / 'developer-tools-inventory.json', inventory)

    def git_text(self, label, *args):
        return self.text(label, [self.git, '-C', self.candidate, *args])

    def source_manifest(self, label):
        head = self.git_text(label + '-head', 'rev-parse', 'HEAD')
        tree = self.git_text(label + '-tree', 'rev-parse', 'HEAD^{tree}')
        if (head, tree) != (CANDIDATE, TREE):
            raise RuntimeError('candidate_identity_mismatch')
        parents = self.git_text(label + '-parents', 'show', '-s', '--format=%P', 'HEAD').split()
        if parents != [PREVIOUS_CANDIDATE, BASE]:
            raise RuntimeError('candidate_parents_mismatch')
        self.run(label + '-base-ancestry', [self.git, '-C', self.candidate, 'merge-base', '--is-ancestor', BASE, CANDIDATE])
        _receipt, output = self.run(label + '-tracked', [self.git, '-C', self.candidate, 'ls-files', '--stage', '-z'])
        listing = output[0].read_bytes()
        files = []
        indexed = {}
        for item in listing.split(b'\0'):
            if not item:
                continue
            metadata, name = item.split(b'\t', 1)
            mode, blob, stage = metadata.decode().split()
            filename = os.fsdecode(name)
            relative = pathlib.PurePosixPath(filename)
            if relative.is_absolute() or '..' in relative.parts or stage != '0' or mode not in ('100644', '100755', '120000'):
                raise RuntimeError('tracked_manifest_invalid')
            path = self.candidate / filename
            info = path.lstat()
            content = os.fsencode(os.readlink(path)) if stat.S_ISLNK(info.st_mode) else path.read_bytes()
            literal_blob = hashlib.sha1(b'blob ' + str(len(content)).encode() + b'\0' + content).hexdigest()
            if literal_blob != blob or ((mode == '120000') != stat.S_ISLNK(info.st_mode)) \
                    or (mode == '100755' and not info.st_mode & 0o111) \
                    or (mode == '100644' and info.st_mode & 0o111):
                raise RuntimeError('tracked_literal_blob_or_mode_mismatch')
            indexed[filename] = (mode, blob)
            files.append({'path': filename, 'index_mode': mode, 'index_blob': blob,
                          'mode': stat.S_IMODE(info.st_mode), 'sha256': hashlib.sha256(content).hexdigest()})
        _receipt, output = self.run(label + '-head-tree', [self.git, '-C', self.candidate, 'ls-tree', '-r', '-z', '--full-tree', 'HEAD'])
        committed = {}
        for item in output[0].read_bytes().split(b'\0'):
            if item:
                metadata, name = item.split(b'\t', 1)
                mode, kind, blob = metadata.decode().split()
                if kind != 'blob':
                    raise RuntimeError('committed_nonblob_source')
                committed[os.fsdecode(name)] = (mode, blob)
        if indexed != committed:
            raise RuntimeError('index_differs_from_candidate_tree')
        status = self.git_text(label + '-status', 'status', '--porcelain=v1', '--untracked-files=all')
        flags = self.git_text(label + '-flags', 'ls-files', '-v')
        if status or any(line and not line.startswith('H ') for line in flags.splitlines()):
            raise RuntimeError('candidate_not_clean_or_index_flags')
        index_path = pathlib.Path(self.git_text(label + '-index', 'rev-parse', '--git-path', 'index'))
        if not index_path.is_absolute():
            index_path = self.candidate / index_path
        protected = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json',
                     'scripts/bootstrap-heartbeat/test_runner.py', 'scripts/bootstrap-heartbeat/runner.py',
                     'scripts/bootstrap-heartbeat/providers/corepack-0.34.6.json',
                     'scripts/bootstrap-heartbeat/providers/corepack-0.34.6.tgz',
                     'tests/local-command-validation.test.ts', 'tests/dispatch-scheduler.test.ts']
        value = {'head': head, 'tree': tree, 'base': BASE, 'parents': parents, 'files': files, 'index_sha256': digest(index_path),
                 'index_listing_sha256': hashlib.sha256(listing).hexdigest(),
                 'protected': {name: digest(self.candidate / name) for name in protected}, 'worktree_status': status}
        write_json(self.private / (label + '-source.json'), value)
        return value

    def providers(self):
        if platform.system() != 'Darwin' or platform.machine() != 'x86_64':
            raise RuntimeError('supported_native_platform_required')
        if sys.version_info < (3, 9):
            raise RuntimeError('python39_required_for_child_umask')
        patterns = {'GITHUB_SHA': r'[0-9a-f]{40}', 'GITHUB_RUN_ID': r'[0-9]{1,24}',
                    'GITHUB_RUN_ATTEMPT': r'[0-9]{1,6}', 'ImageOS': r'macos[0-9]{1,3}',
                    'ImageVersion': r'[0-9A-Za-z._-]{1,80}'}
        for key, pattern in patterns.items():
            value = os.environ.get(key, '')
            if re.fullmatch(pattern, value) is None:
                raise RuntimeError('workflow_provenance_missing_or_invalid')
            self.provenance[key] = value
        self.safe_system_file('/usr/bin/codesign')
        self.apple_tool('/usr/bin/codesign', 'com.apple.security.codesign')
        self.apple_tool('/usr/bin/python3')
        self.apple_tool('/usr/bin/xcrun', 'com.apple.xcrun')
        self.openssl = self.apple_tool('/usr/bin/openssl', 'com.apple.openssl')
        if not self.developer_selection_prepared:
            self.developer_selection_prepared = True
            if self.prepare_existing_clt_selection():
                return self.providers()
        git_path = self.text('xcrun-find-git', ['/usr/bin/xcrun', '--find', 'git'])
        if not pathlib.Path(git_path).is_absolute():
            raise RuntimeError('apple_git_unresolved')
        self.git = self.apple_tool(git_path, 'com.apple.git')
        infra_head = self.text('infrastructure-head', [self.git, '-C', self.infra, 'rev-parse', 'HEAD'])
        if infra_head != self.provenance['GITHUB_SHA']:
            raise RuntimeError('infrastructure_commit_mismatch')
        self.provenance['harness_sha256'] = digest(self.infra / 'qualify.py')
        self.provenance['recipient_sha256'] = digest(self.infra / 'recipient.pem')
        if self.diagnostics_only:
            self.provenance['diagnostic_module_sha256'] = digest(self.infra / 'adapter-diagnostic.mjs')
        write_json(self.private / 'workflow-provenance.json', self.provenance)
        version_commands = {'python': ['/usr/bin/python3', '--version'], 'node': [self.node, '--version'],
                            'corepack': [self.node.parent / 'corepack', '--version'],
                            'git': [self.git, '--version'], 'openssl': [self.openssl, 'version'],
                            'macos': ['/usr/bin/sw_vers', '-productVersion']}
        for name, command in version_commands.items():
            value = self.text(name + '-version', command)
            if not re.fullmatch(r'[A-Za-z0-9 ._()+:-]{1,120}', value):
                raise RuntimeError('provider_version_unparseable')
            self.versions[name] = value
        # Outer bootstrap uses Node24.19.0's bundled Corepack0.35.0. The unchanged
        # Python fixture independently verifies its committed Corepack0.34.6 provider.
        if self.versions['node'] != 'v24.19.0' or self.versions['corepack'] != '0.35.0':
            raise RuntimeError('pinned_toolchain_mismatch')
        resources = {'disk': dict(zip(['total', 'used', 'free'], shutil.disk_usage(self.private))),
                     'memory_bytes': self.text('memory', ['/usr/sbin/sysctl', '-n', 'hw.memsize']),
                     'cpu_count': self.text('cpus', ['/usr/sbin/sysctl', '-n', 'hw.ncpu']),
                     'platform': platform.platform(), 'architecture': platform.machine(),
                     'node': {'path': str(self.node), 'sha256': digest(self.node)}}
        write_json(self.private / 'providers.json', self.provider_proofs)
        write_json(self.private / 'resources.json', resources)
        if resources['disk']['free'] < 4 * 1024 ** 3:
            raise RuntimeError('insufficient_disk')

    def crypto_probe(self):
        certificate = self.infra / 'recipient.pem'
        if 'PRIVATE KEY' in certificate.read_text():
            raise RuntimeError('recipient_must_be_public')
        self.run('recipient-certificate', [self.openssl, 'x509', '-in', certificate, '-noout', '-fingerprint', '-sha256'])
        probe = self.private / 'cms-probe.txt'
        probe.write_bytes(b'PR93 native evidence CMS capability probe\n')
        encrypted = self.private / 'cms-probe.der'
        self.run('cms-probe', [self.openssl, 'cms', '-encrypt', '-binary', '-aes256', '-outform', 'DER',
                               '-in', probe, '-out', encrypted, certificate])
        self.run('cms-probe-parse', [self.openssl, 'cms', '-cmsout', '-inform', 'DER', '-in', encrypted, '-print'])
        if not encrypted.is_file() or encrypted.stat().st_size == 0:
            raise RuntimeError('cms_probe_missing')

    def hydrate(self):
        corepack = self.node.parent / 'corepack'
        self.run('candidate-frozen-dependencies', [corepack, 'pnpm@10.34.5', 'install', '--frozen-lockfile',
                                                  '--store-dir', self.private / 'dependency-store'], timeout=300)
        tool_root = self.private / 'pnpm-tool'
        tool_root.mkdir(mode=0o700)
        write_json(tool_root / 'package.json', {'private': True, 'packageManager': 'pnpm@10.34.5'})
        self.run('real-pnpm-hydration', [corepack, 'pnpm@10.34.5', 'add', 'pnpm@10.34.5', '--ignore-scripts',
                                        '--store-dir', self.private / 'tool-store'], cwd=tool_root, timeout=180)
        package = (tool_root / 'node_modules/pnpm').resolve(strict=True)
        metadata = json.loads((package / 'package.json').read_text())
        if metadata.get('name') != 'pnpm' or metadata.get('version') != '10.34.5':
            raise RuntimeError('real_pnpm_package_mismatch')
        executable = package / 'bin/pnpm.cjs'
        if not executable.is_file() or not os.access(executable, os.X_OK):
            raise RuntimeError('real_pnpm_executable_missing')
        launcher = self.candidate / 'node_modules/.bin/pnpm'
        if launcher.exists() or launcher.is_symlink():
            raise RuntimeError('unexpected_pnpm_launcher')
        launcher.symlink_to(executable)
        value = self.text('real-pnpm-version', [launcher, '--version'])
        if value != '10.34.5' or launcher.resolve(strict=True) != executable:
            raise RuntimeError('real_pnpm_version_mismatch')
        self.versions['pnpm'] = value
        files = {str(path.relative_to(package)): digest(path) for path in sorted(package.rglob('*')) if path.is_file()}
        write_json(self.private / 'pnpm-tool.json', {'package': str(package), 'files': files,
                   'lock_sha256': digest(tool_root / 'pnpm-lock.yaml'), 'launcher': str(launcher),
                   'launcher_target': str(executable), 'corepack_shim': False})

    def git_capability_probe(self):
        argv = [self.git, '--no-replace-objects', '--no-lazy-fetch', '-c', 'core.fsmonitor=false',
                '-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=',
                '-C', self.candidate, 'cat-file', '-e', 'HEAD^{commit}']
        record, _output = self.run('git-required-syntax-local-object', argv, required=False)
        accepted = record['exit_code'] == 0 and not record['timed_out'] and record['raw_capture_complete'] \
            and record['observed_family_complete'] and record['original_group_absent']
        self.git_capability = {'argv': [str(arg) for arg in argv], 'exit_code': record['exit_code'],
                               'version': self.versions['git'], 'sha256': digest(self.git), 'accepted': accepted}
        write_json(self.private / 'git-capability.json', self.git_capability)
        if not accepted:
            raise RuntimeError('git_required_syntax_local_object_failed')

    def capture_dyld_image(self):
        """Evidence copy only; the image never becomes a provider or executable."""
        def snapshot():
            physical = self.safe_system_file('/usr/lib/dyld')
            initial = physical.stat()
            def identity(info):
                return {'physical_path': str(physical), 'uid': info.st_uid, 'gid': info.st_gid,
                        'mode': stat.S_IMODE(info.st_mode), 'device': info.st_dev, 'inode': info.st_ino,
                        'size': info.st_size, 'mtime_ns': info.st_mtime_ns, 'ctime_ns': info.st_ctime_ns}
            before = identity(initial)
            if not 32 <= initial.st_size <= DYLD_LIMIT:
                raise RuntimeError('dyld_image_read_cap_or_size_unsupported')
            descriptor = os.open(physical, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(descriptor, 'rb') as stream:
                opened = os.fstat(stream.fileno())
                if not stat.S_ISREG(opened.st_mode) or identity(opened) != before:
                    raise RuntimeError('dyld_image_open_identity_changed')
                raw = stream.read(initial.st_size)
                if len(raw) != initial.st_size or identity(os.fstat(stream.fileno())) != before:
                    raise RuntimeError('dyld_image_read_identity_changed')
            if self.safe_system_file('/usr/lib/dyld') != physical or identity(physical.stat()) != before:
                raise RuntimeError('dyld_image_path_identity_changed')
            before['sha256'] = hashlib.sha256(raw).hexdigest()
            return raw, before

        raw, before = snapshot()
        macho = dyld_x86_uuid(raw)
        matched = macho['uuid'] == DYLD_CRASH_UUID
        self.diagnostics['image'] = {'bytes': len(raw), 'sha256': before['sha256'], 'uuid_match': matched}
        if not matched:
            raise RuntimeError('dyld_crash_uuid_mismatch_not_qualified')
        physical = before['physical_path']
        self.run('dyld-evidence-signature', ['/usr/bin/codesign', '--verify', '--strict', '-R=anchor apple', physical])
        _record, output = self.run('dyld-evidence-identity', ['/usr/bin/codesign', '-dv', '--verbose=4', physical])
        if sum(path.stat().st_size for path in output) > 64 * 1024:
            raise RuntimeError('dyld_signature_metadata_oversize')
        identifiers = re.findall(r'^Identifier=(.+)$', output[0].read_text() + '\n' + output[1].read_text(), re.M)
        if len(identifiers) != 1 or re.fullmatch(r'[A-Za-z0-9._-]{1,256}', identifiers[0]) is None:
            raise RuntimeError('dyld_signature_identifier_unknown')
        after_raw, after = snapshot()
        if before != after or raw != after_raw:
            raise RuntimeError('dyld_image_changed_during_signature_binding')
        proof = {'evidence_only': True, 'executable_provider': False, 'before': before, 'after': after,
                 'macho': macho, 'expected_crash_uuid': DYLD_CRASH_UUID, 'uuid_match': True,
                 'signature': {'anchor_apple_strict_verified': True, 'observed_identifier': identifiers[0],
                               'verification_receipt': 'dyld-evidence-signature',
                               'identity_receipt': 'dyld-evidence-identity'}}
        # Nothing is retained as an image/proof until UUID/signature/stable bytes bind.
        (self.private / 'dyld-image.bin').write_bytes(raw)
        write_json(self.private / 'dyld-image.json', proof)
        self.diagnostics['complete'] = True
        write_json(self.private / 'diagnostics.json', self.diagnostics)

    def diagnose(self):
        # One captured adapter call, with no control, Python selection or retry.
        write_json(self.private / 'diagnostics.json', self.diagnostics)
        deadline = time.monotonic() + 180
        limitations = []
        directories = [pathlib.Path('/Library/Logs/DiagnosticReports')]
        try:
            home = pathlib.Path(pwd.getpwuid(os.geteuid()).pw_dir).resolve(strict=True)
            directories.insert(0, home / 'Library/Logs/DiagnosticReports')
        except (OSError, KeyError):
            limitations.append('account_report_directory_unknown')
        baseline = {directory: self.crash_entries(directory, limitations) for directory in directories}
        started = datetime.datetime.now(datetime.timezone.utc).timestamp()
        record, _output = self.run('node-adapter-diagnostic-captured',
            [self.node, '--import', 'tsx', self.infra / 'adapter-diagnostic.mjs', self.candidate,
             self.private / 'node-diagnostic', self.fixture, self.git],
            timeout=max(1, deadline - time.monotonic()), required=False)
        if record['exit_code'] != 0 or not record['observed_root'] or not record['observed_family_complete'] \
                or not record['original_group_absent'] or not record['raw_capture_complete'] \
                or record['timed_out'] or time.monotonic() > deadline:
            raise RuntimeError('node_diagnostic_infrastructure_incomplete')
        self.diagnostics['node'] = json.loads((self.private / 'node-diagnostic/collection.json').read_text())
        if self.diagnostics['node'].get('complete') is not True:
            raise RuntimeError('node_diagnostic_collection_incomplete')
        manifest = self.collect_crash_reports(baseline, limitations, started, deadline)
        self.diagnostics['crash'] = {'status': manifest['status'], 'matched_reports': len(manifest['reports']),
                                     'limitations': manifest['limitations'], 'cause': 'UNKNOWN',
                                     'log_fallback': manifest['log_fallback']}
        if time.monotonic() > deadline:
            raise RuntimeError('node_diagnostic_total_bound')
        self.diagnostics['complete'] = True
        write_json(self.private / 'diagnostics.json', self.diagnostics)

    def crash_entries(self, directory, limitations):
        entries = {}
        try:
            if any(path.is_symlink() for path in [directory, *directory.parents]):
                raise OSError('nonphysical_report_directory')
            if directory.resolve(strict=True) != directory or not directory.is_dir():
                raise OSError('nonphysical_report_directory')
            with os.scandir(directory) as listing:
                for index, entry in enumerate(listing):
                    if index >= 128:
                        limitations.append('directory_entry_cap')
                        break
                    if entry.name.endswith(('.ips', '.crash')):
                        info = entry.stat(follow_symlinks=False)
                        if stat.S_ISREG(info.st_mode):
                            entries[entry.name] = (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)
        except FileNotFoundError:
            return entries
        except (OSError, RuntimeError):
            limitations.append('report_directory_unavailable_or_nonphysical')
            return None
        return entries

    def crash_time(self, value):
        if not isinstance(value, str) or len(value) > 80:
            raise ValueError('unfamiliar_crash_time')
        try:
            parsed = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
        except ValueError:
            try:
                parsed = datetime.datetime.strptime(value, '%Y-%m-%d %H:%M:%S.%f %z')
            except ValueError:
                parsed = datetime.datetime.strptime(value, '%Y-%m-%d %H:%M:%S %z')
        if parsed.utcoffset() is None:
            raise ValueError('crash_timezone_missing')
        return parsed.timestamp()

    def crash_identity(self, raw, suffix):
        text = raw.decode('utf-8', errors='strict')
        if suffix == '.ips':
            decoder = json.JSONDecoder()
            first, end = decoder.raw_decode(text.lstrip())
            rest = text.lstrip()[end:].strip()
            body, tail = decoder.raw_decode(rest) if rest else (first, len(text.lstrip()))
            if not isinstance(first, dict) or not isinstance(body, dict) or (rest and rest[tail:].strip()):
                raise ValueError('unfamiliar_ips_tail')
            return {'pid': body['pid'], 'parent_pid': body['parentPid'], 'image': body['procPath'],
                    'time': self.crash_time(body.get('captureTime', first.get('timestamp')))}
        def field(pattern):
            values = re.findall(pattern, text, re.M)
            if len(values) != 1:
                raise ValueError('ambiguous_crash_field')
            return values[0]
        return {'pid': int(field(r'^Process:\s+[^\n]+\[(\d+)\]\s*$')),
                'parent_pid': int(field(r'^Parent Process:\s+[^\n]+\[(\d+)\]\s*$')),
                'image': field(r'^Path:\s+([^\n]+?)\s*$'),
                'time': self.crash_time(field(r'^Date/Time:\s+([^\n]+?)\s*$'))}

    def collect_crash_reports(self, baseline, limitations, started, deadline):
        root = self.private / 'node-diagnostic'
        manifest = {'status': 'UNKNOWN', 'reports': [], 'limitations': limitations,
                    'log_fallback': {'status': 'NOT_RUN', 'collector_tool_identity': 'NOT_QUALIFIED'}}
        observed = json.loads((root / 'captured-process.json').read_text())
        fixture = json.loads((root / 'fixture.json').read_text())['fixture']
        try:
            pid, parent = observed['targetPid'], observed['parentPid']
            if observed['status'] != 'OBSERVED' or type(pid) is not int or pid < 1 or type(parent) is not int or parent < 1:
                raise ValueError('owned_identity_unknown')
            spawn = self.crash_time(observed['events'][0]['utc'])
            close = self.crash_time(observed['events'][-1]['utc'])
            if close < spawn:
                raise ValueError('owned_time_unknown')
        except (KeyError, ValueError, TypeError):
            limitations.append('owned_pid_or_time_unknown')
            write_json(root / 'crash-collection.json', manifest)
            return manifest
        images = {'/usr/bin/sandbox-exec', '/usr/bin/env', '/bin/sh',
                  fixture['node']['physicalPath'], fixture['pnpm']['physicalPath']}
        until = min(time.monotonic() + 30, deadline)
        examined = set()
        read_bytes = 0
        stop = False
        while time.monotonic() < until and not stop:
            for directory, before in baseline.items():
                if before is None:
                    continue
                current = self.crash_entries(directory, limitations)
                for name, identity in (current or {}).items():
                    if time.monotonic() >= until:
                        limitations.append('report_collection_window_expired')
                        stop = True
                        break
                    key = (directory, name, identity)
                    if before.get(name) == identity or key in examined or identity[3] / 1e9 < started - 1 \
                            or not re.match(r'^(sandbox-exec|node|env|sh|pnpm)[_-]', name, re.I):
                        continue
                    if len(examined) >= 8 or identity[2] > 4 * 1024 ** 2 - read_bytes:
                        limitations.append('candidate_read_count_or_byte_cap')
                        stop = True
                        break
                    examined.add(key)
                    try:
                        descriptor = os.open(directory / name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                        with os.fdopen(descriptor, 'rb') as stream:
                            info = os.fstat(stream.fileno())
                            if not stat.S_ISREG(info.st_mode) or (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns) != identity:
                                raise ValueError('candidate_changed')
                            raw = stream.read(info.st_size)
                            after = os.fstat(stream.fileno())
                        read_bytes += len(raw)
                        if len(raw) != info.st_size or (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) != identity:
                            raise ValueError('candidate_changed')
                        proof = self.crash_identity(raw, pathlib.Path(name).suffix)
                        if type(proof['pid']) is not int or type(proof['parent_pid']) is not int or proof['pid'] != pid:
                            continue
                        if not spawn - 1 <= proof['time'] <= close + 10:
                            limitations.append('pid_matched_outside_invocation_window')
                            continue
                        if proof['parent_pid'] != parent or proof['image'] not in images:
                            limitations.append('pid_time_matched_parent_or_image_incompatible')
                            continue
                        target = root / ('crash-report-' + str(len(manifest['reports']) + 1) + pathlib.Path(name).suffix)
                        target.write_bytes(raw)
                        manifest['reports'].append({'source': str(directory / name), 'file': target.name,
                                                    'bytes': len(raw), 'sha256': digest(target), 'identity': proof})
                        if len(manifest['reports']) >= 2:
                            stop = True
                            break
                    except (OSError, ValueError, KeyError, TypeError, UnicodeError, RecursionError):
                        limitations.append('candidate_unavailable_changed_or_unfamiliar')
                if stop:
                    break
            if manifest['reports']:
                break
            remaining = until - time.monotonic()
            if remaining > 0 and not stop:
                time.sleep(min(1, remaining))
        if not manifest['reports']:
            limitations.append('no_owned_report_observed_in_bounded_window')
            # Observe identity only; this does not qualify or execute /usr/bin/log.
            try:
                if deadline - time.monotonic() < 10:
                    raise RuntimeError('identity_observation_budget_unavailable')
                proof = self.system_file_identity('/usr/bin/log')
                record, _output = self.run('log-collector-identity-observation',
                    ['/usr/bin/codesign', '-dv', '--verbose=4', '/usr/bin/log'], timeout=10, required=False)
                manifest['log_identity_observation'] = {'filesystem': proof,
                    'status': 'OBSERVED' if record['exit_code'] == 0 else 'UNKNOWN',
                    'receipt_label': 'log-collector-identity-observation'}
                if record['exit_code'] != 0:
                    limitations.append('collector_identity_observation_failed')
            except (OSError, RuntimeError):
                limitations.append('collector_identity_observation_unavailable')
        manifest['limitations'] = sorted(set(limitations))
        manifest['candidate_reads'] = len(examined)
        manifest['candidate_bytes_read'] = read_bytes
        manifest['status'] = 'MATCHED' if manifest['reports'] and not limitations else 'UNKNOWN'
        write_json(root / 'crash-collection.json', manifest)
        return manifest

    def diagnostic_archive_files(self):
        # Evidence only: never traverse fixtures, dependencies, child homes or caches.
        root = self.private / 'node-diagnostic'
        patterns = [r'(?:fixture|captured|collection|error|store-manifest|captured-process|crash-collection)\.json',
                    r'actual-profile\.sb', r'crash-report-[12]\.(?:ips|crash)',
                    r'store/[0-9a-f-]{36}\.(?:stdout|stderr)',
                    r'store/operations/(?:[0-9a-f-]{36}\.json|slot-[0-9]{4}\.json|index\.json)']
        files = []
        self.diagnostic_files = files
        total = 0
        invalid = False
        if not root.exists():
            return files
        for directory in [root, root / 'store', root / 'store/operations']:
            if not directory.exists():
                continue
            if directory.is_symlink() or not directory.is_dir():
                raise RuntimeError('diagnostic_evidence_directory_unsafe')
            with os.scandir(directory) as entries:
                for index, entry in enumerate(entries):
                    if index >= 32:
                        raise RuntimeError('diagnostic_evidence_file_count_bound')
                    path = pathlib.Path(entry.path)
                    if path.is_dir() and not path.is_symlink():
                        if path not in [root / 'store', root / 'store/operations']:
                            invalid = True
                        continue
                    relative = str(path.relative_to(root))
                    if not any(re.fullmatch(pattern, relative) for pattern in patterns) \
                            or not stat.S_ISREG(path.lstat().st_mode) or path.is_symlink():
                        invalid = True
                        continue
                    total += path.stat().st_size
                    if total > RAW_LIMIT or len(files) >= 32:
                        raise RuntimeError('diagnostic_evidence_byte_or_count_bound')
                    files.append(path)
        if invalid:
            raise RuntimeError('diagnostic_evidence_unexpected_entries')
        return sorted(files)

    def qualify(self):
        self.providers()
        self.crypto_probe()
        self.before = self.source_manifest('before')
        if self.preflight_only or self.diagnostics_only:
            self.git_capability_probe()
        if self.preflight_only:
            return
        if self.diagnostics_only:
            self.capture_dyld_image()
            return
        self.hydrate()
        # Expected discovery count is source-derived; no test selection or source rewriting.
        python_source = ast.parse((self.candidate / 'scripts/bootstrap-heartbeat/test_runner.py').read_text())
        methods = [node.name for node in ast.walk(python_source) if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                   and node.name.startswith('test_')]
        if len(methods) != 108 or len(set(methods)) != 108:
            raise RuntimeError('python_discovery_count_changed')
        record, output = self.run('python108', ['/usr/bin/python3', 'scripts/bootstrap-heartbeat/test_runner.py'],
                                  timeout=1500, required=False)
        self.python = parse_python(output[0].read_text() + '\n' + output[1].read_text())
        self.python['exit_code'] = record['exit_code']
        self.python['owned_completion'] = record['observed_family_complete'] and record['original_group_absent']
        if not self.python['owned_completion'] or not record['raw_capture_complete'] or not record['observed_root']:
            raise RuntimeError('python_family_or_capture_incomplete_no_next_heavy_gate')
        # Run this second gate once even when the first test gate fails; never overlap.
        record, output = self.run('node-seatbelt-and-locks', [self.node, '--import', 'tsx', '--test', '--test-reporter=tap',
                                  'tests/local-command-validation.test.ts', 'tests/dispatch-scheduler.test.ts'],
                                  timeout=360, required=False)
        self.node_result = parse_node(output[0].read_text() + '\n' + output[1].read_text())
        self.node_result['exit_code'] = record['exit_code']
        self.node_result['owned_completion'] = record['observed_family_complete'] and record['original_group_absent']
        if not all(item['accepted'] and item['exit_code'] == 0 and item['owned_completion'] for item in [self.python, self.node_result]):
            raise RuntimeError('native_test_gate_failed')

    def finish(self):
        self.finalizing = True
        if self.diagnostics_only:
            try:
                self.diagnostic_files = self.diagnostic_archive_files()
            except BaseException:
                self.failure = self.failure or traceback.format_exc()
                (self.private / 'diagnostic-archive-error.txt').write_text(traceback.format_exc())
        source_error = None
        if self.before is not None:
            try:
                for name, proof in self.provider_proofs.items():
                    physical = self.safe_system_file(name)
                    info = physical.stat()
                    if str(physical) != proof['physical_path'] or digest(physical) != proof['sha256'] \
                            or (info.st_ino, info.st_dev) != (proof['inode'], proof['device']):
                        raise RuntimeError('provider_postflight_identity_changed')
                self.after = self.source_manifest('after')
            except BaseException:
                source_error = traceback.format_exc()
        unchanged = self.before is not None and self.before == self.after
        if source_error is not None:
            (self.private / 'source-postflight-error.txt').write_text(source_error)
        complete = bool(self.records) and all(record['observed_family_complete'] and record['original_group_absent']
                       and record['raw_capture_complete'] and not record['timed_out'] for record in self.records)
        native_passed = self.python is not None \
            and self.node_result is not None and self.python['accepted'] and self.node_result['accepted']
        capability_passed = self.git_capability is not None and self.git_capability['accepted'] \
            and self.python is None and self.node_result is None
        diagnostic_complete = capability_passed and self.diagnostics is not None and self.diagnostics['complete']
        passed = self.failure is None and unchanged and complete \
            and (diagnostic_complete if self.diagnostics_only else capability_passed if self.preflight_only else native_passed)
        native_gates = 'NOT_RUN' if self.diagnostics_only or (self.python is None and self.node_result is None) else 'PASS' if native_passed else 'FAIL'
        private_result = {'candidate': CANDIDATE, 'tree': TREE, 'base': BASE, 'provenance': self.provenance,
                          'mode': self.mode, 'native_gates': native_gates, 'git_capability': self.git_capability,
                          'diagnostics': self.diagnostics,
                          'failure': self.failure, 'source_unchanged': unchanged,
                          'python': self.python, 'node': self.node_result, 'commands': self.records,
                          'environment_keys': sorted(self.env), 'versions': self.versions, 'passed': passed}
        write_json(self.private / 'result.json', private_result)
        public_python = None if self.python is None else dict(self.python)
        if public_python is not None:
            allowed = {'name': PYTHON_SKIP, 'reason': PYTHON_SKIP_REASON}
            public_python['skips'] = [allowed] if allowed in self.python['skips'] else []
            public_python['unexpected_skip_count'] = sum(item != allowed for item in self.python['skips'])
        public_node = None if self.node_result is None else dict(self.node_result)
        if public_node is not None:
            allowed = {SEATBELT, 'keeps a live native macOS owner fenced when only the caller timezone changes'}
            public_node['skips'] = sorted(allowed.intersection(self.node_result['skips']))
            public_node['unexpected_skip_count'] = sum(name not in allowed for name in self.node_result['skips'])
        summary = {'schema_version': 1, 'candidate': CANDIDATE, 'tree': TREE, 'base': BASE,
                   'provenance': self.provenance,
                   'mode': self.mode, 'native_gates': native_gates,
                   'selection': 'dyld_image_only' if self.diagnostics_only else None,
                   'diagnostics': self.diagnostics,
                   'status': self.success_status if passed else self.failure_status, 'source_unchanged': unchanged,
                   'python': public_python, 'node': public_node, 'versions': self.versions,
                   'observed_owned_completion': complete, 'global_quiescence_claimed': False,
                   'raw_capture_complete': all(record['raw_capture_complete'] for record in self.records),
                   'production_qualification': False, 'evidence_encrypted': False,
                   'plaintext_sha256': None, 'ciphertext_sha256': None}
        summary = write_summary(self.public / 'summary.json', summary)
        archive = self.runner_temp / ('pr93-private-' + self.private.name + '.tar.gz')
        with tarfile.open(archive, 'w:gz') as tar:
            # Never archive caches, executable hydration, child homes or fixture trees.
            allowed = ['logs', 'before-source.json', 'after-source.json', 'providers.json', 'resources.json',
                       'pnpm-tool.json', 'workflow-provenance.json', 'developer-tools-inventory.json', 'git-capability.json',
                       'result.json', 'cms-probe.txt', 'cms-probe.der', 'diagnostics.json', 'diagnostic-archive-error.txt',
                       'qualification-error.txt', 'source-postflight-error.txt', 'collector-error.txt',
                       'dyld-image.bin', 'dyld-image.json']
            for name in allowed:
                path = self.private / name
                if path.exists():
                    tar.add(path, arcname='evidence/' + name, recursive=True)
            for path in self.diagnostic_files:
                tar.add(path, arcname='evidence/' + str(path.relative_to(self.private)), recursive=False)
        summary['plaintext_sha256'] = digest(archive)
        ciphertext = self.public / 'evidence.cms'
        # Final encryption logs stay private and are not streamed to Actions.
        # They necessarily postdate the immutable plaintext archive.
        try:
            self.run('encrypt-evidence', [self.openssl, 'cms', '-encrypt', '-binary', '-aes256', '-outform', 'DER',
                     '-in', archive, '-out', ciphertext, self.infra / 'recipient.pem'], timeout=120)
            summary['evidence_encrypted'] = ciphertext.is_file() and ciphertext.stat().st_size > 0
            summary['ciphertext_sha256'] = digest(ciphertext)
            if ciphertext.stat().st_size + len(json.dumps(summary).encode()) + 1024 > PUBLIC_LIMIT:
                ciphertext.unlink()
                summary['evidence_encrypted'] = False
                summary['ciphertext_sha256'] = None
        except BaseException:
            (self.private / 'encryption-error.txt').write_text(traceback.format_exc())
            if ciphertext.exists():
                ciphertext.unlink()
        if not summary['evidence_encrypted']:
            summary['status'] = self.failure_status
        summary = write_summary(self.public / 'summary.json', summary)
        # This is the complete public output surface. No exception text, paths or process IDs.
        print(json.dumps(summary, sort_keys=True))
        return 0 if summary['status'] == self.success_status else 1


def main():
    if sys.argv[1:] not in ([], ['--preflight-only'], ['--diagnostics-only']):
        print('Qualification requires no arguments, --preflight-only or --diagnostics-only.')
        return 1
    preflight_only = sys.argv[1:] == ['--preflight-only']
    diagnostics_only = sys.argv[1:] == ['--diagnostics-only']
    qualification = Qualification.__new__(Qualification)
    try:
        qualification.__init__(preflight_only=preflight_only, diagnostics_only=diagnostics_only)
        try:
            qualification.qualify()
        except BaseException:
            qualification.failure = traceback.format_exc()
            (qualification.private / 'qualification-error.txt').write_text(qualification.failure)
        return qualification.finish()
    except BaseException:
        # Even an early infrastructure failure must not reveal filesystem identities.
        if hasattr(qualification, 'private') and hasattr(qualification, 'public') and qualification.public.is_dir():
            (qualification.private / 'collector-error.txt').write_text(traceback.format_exc())
            write_summary(qualification.public / 'summary.json', {'schema_version': 1, 'candidate': CANDIDATE,
                       'tree': TREE, 'base': BASE,
                       'mode': 'diagnostics_only' if diagnostics_only else 'provider_preflight_only' if preflight_only else 'native_qualification',
                       'native_gates': 'NOT_RUN' if preflight_only or diagnostics_only else 'UNKNOWN',
                       'selection': 'dyld_image_only' if diagnostics_only else None,
                       'status': 'DIAGNOSTIC_FAIL' if diagnostics_only else 'PREFLIGHT_FAIL' if preflight_only else 'FAIL', 'reason': 'collector_failed',
                       'evidence_encrypted': False, 'production_qualification': False})
        print('Diagnostic collector failed; native gates NOT_RUN.' if diagnostics_only else
              'Provider preflight collector failed; native gates NOT_RUN.' if preflight_only
              else 'Native qualification collector failed; gate remains FAIL.')
        return 1


if __name__ == '__main__':
    sys.exit(main())
