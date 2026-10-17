#!/usr/bin/python3
"""One source-bound, supplemental observation; never a native acceptance gate."""
import hashlib
import json
import os
import pathlib
import runpy
import stat
import subprocess
import sys
import time


METHOD = 'test_exec_failure_releases_guard_and_leaves_change_retryable'
RUNNER_HASH = '59bfba402e22913cea69ebc160e7b5be864c5701aa63c0345b29cce38bed1819'
TEST_HASH = '9133467f3c07b5424b60c7b7d47f66e171a448e94b12d87529fac8fcfba8a96d'
SITE_HASH = '1bfdb644d76b69f1c5b8d0bdf5f8bc3eff6226f79f6193521b96dda4877c4572'
EVENT_LIMIT = 128  # Each of the runner and its one original guard; <=64 KiB total.
EVENT_BYTES = 256
TRACE_LIMIT = 2 * EVENT_LIMIT * EVENT_BYTES
FUNCTIONS = {'<module>', 'main', 'heartbeat', 'acquire_lock', 'load_config',
             'github_fingerprint', 'verify_wake_target', 'reserve_heartbeat',
             'run_wake', 'spawn_lock_guard', 'admission_call'}
LINES = {('spawn_lock_guard', 2444): 'guard_fork_call',
         ('spawn_lock_guard', 2445): 'guard_fork_return',
         ('spawn_lock_guard', 2449): 'guard_child_branch',
         ('spawn_lock_guard', 2502): 'guard_handoff_parsed',
         ('spawn_lock_guard', 2547): 'guard_empty_group_branch',
         ('spawn_lock_guard', 2554): 'guard_settlement_call',
         ('spawn_lock_guard', 2556): 'guard_settled_write_attempt',
         ('run_wake', 2693): 'popen_call',
         ('run_wake', 2704): 'popen_failure_branch',
         ('run_wake', 2711): 'parent_settled_ack_received',
         ('run_wake', 2712): 'parent_guard_reaped'}


def source_identity(runner):
    runner = pathlib.Path(runner).resolve(strict=True)
    test = runner.with_name('test_runner.py')
    for path, expected in [(runner, RUNNER_HASH), (test, TEST_HASH)]:
        if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise RuntimeError('timing_original_source_mismatch')
    return runner, test


def original_main(path, arguments):
    # Script execution semantics, including the fixture's already-loaded sitecustomize.
    sys.argv = [str(path), *arguments]
    sys.path[0] = str(path.parent)
    return runpy.run_path(str(path), run_name='__main__')


class SparseTrace:
    def __init__(self, runner, output):
        self.runner = str(runner)
        self.root = self.pid = os.getpid()
        self.role = 'runner'
        self.count = 0
        self.failed = False
        self.fd = os.open(output, os.O_WRONLY | os.O_APPEND | os.O_CLOEXEC | os.O_NOFOLLOW)
        info = os.fstat(self.fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
            os.close(self.fd)
            raise RuntimeError('timing_trace_file_unsafe')

    def emit(self, phase, exception=None):
        if self.failed:
            return
        self.count += 1
        if self.count == EVENT_LIMIT:
            phase, exception = 'trace_limit', None
        value = {'phase': phase, 'pid': os.getpid(), 'ppid': os.getppid(),
                 'role': self.role, 'monotonic_ns': time.monotonic_ns()}
        if exception is not None:
            value['exception'] = exception
        raw = (json.dumps(value, separators=(',', ':')) + '\n').encode()
        try:
            if len(raw) > EVENT_BYTES or self.count > EVENT_LIMIT or os.write(self.fd, raw) != len(raw):
                raise OSError('trace_write_incomplete')
        except OSError:
            self.failed = True
        if self.count >= EVENT_LIMIT:
            self.failed = True

    def trace(self, frame, event, arg):
        pid = os.getpid()
        if pid != self.pid:
            # Only the return from this exact original fork can admit the guard.
            if self.role == 'runner' and os.getppid() == self.root and event == 'line' \
                    and frame.f_code.co_filename == self.runner \
                    and frame.f_code.co_name == 'spawn_lock_guard' and frame.f_lineno == 2445:
                self.pid, self.role, self.count = pid, 'guard', 0
            else:
                sys.settrace(None)
                # Do not touch the child's descriptor table; normal close_fds/CLOEXEC applies.
                return None
        if self.failed:
            sys.settrace(None)
            return None
        if frame.f_code.co_filename != self.runner:
            return None
        name = frame.f_code.co_name
        if name not in FUNCTIONS:
            return None
        if event in ('call', 'return') and name in FUNCTIONS:
            self.emit(name.strip('<>') + '_' + event)
        elif event == 'line' and (name, frame.f_lineno) in LINES:
            self.emit(LINES[(name, frame.f_lineno)])
        elif event == 'exception' and name == 'run_wake' and frame.f_lineno == 2693:
            # Class only; never exception values, arguments, locals or messages.
            kind = arg[0].__name__
            self.emit('popen_exception', kind if kind.isidentifier() and len(kind) <= 64 else 'UNKNOWN')
        return self.trace


def run_runner(runner, output):
    runner, _test = source_identity(runner)
    trace = SparseTrace(runner, output)
    trace.emit('hook_ready')
    sys.settrace(trace.trace)
    try:
        original_main(runner, ['run'])
    finally:
        sys.settrace(None)
        if trace.failed:
            trace.failed = False
            trace.emit('trace_incomplete')
        trace.emit('hook_return')
        os.close(trace.fd)


def run_test(runner, output):
    runner, test = source_identity(runner)
    output = pathlib.Path(output).resolve(strict=True)
    events = output / 'timing-events.jsonl'
    descriptor = os.open(events, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
    os.close(descriptor)
    launcher = pathlib.Path(__file__).resolve(strict=True)
    original_run = subprocess.run
    receipt = {'schema_version': 1, 'supplemental_only': True, 'method': 'HeartbeatTest.' + METHOD,
               'runner': str(runner), 'runner_sha256': RUNNER_HASH, 'test': str(test),
               'test_sha256': TEST_HASH, 'interceptions': 0, 'unittest_exit_code': None,
               'invocation': None}

    def observed_run(args, *pos, **kw):
        caller = sys._getframe(1)
        method = caller.f_back
        target = caller.f_code.co_filename == str(test) and caller.f_code.co_name == 'invoke' \
            and caller.f_lineno == 1564 and method is not None \
            and method.f_code.co_filename == str(test) and method.f_code.co_name == METHOD and method.f_lineno == 3298
        if not target:
            return original_run(args, *pos, **kw)
        started = time.monotonic_ns()
        receipt['interceptions'] += 1
        if receipt['interceptions'] != 1 or pos or args != [sys.executable, str(runner), 'run'] \
                or set(kw) != {'env', 'stdout', 'stderr', 'text', 'check'} \
                or kw['stdout'] != subprocess.PIPE or kw['stderr'] != subprocess.PIPE \
                or kw['text'] is not True or kw['check'] is not False:
            raise RuntimeError('timing_exact_invocation_mismatch')
        site = pathlib.Path(kw['env']['PYTHONPATH']) / 'sitecustomize.py'
        if not site.is_file() or site.is_symlink() or hashlib.sha256(site.read_bytes()).hexdigest() != SITE_HASH:
            raise RuntimeError('timing_original_sitecustomize_mismatch')
        receipt['sitecustomize'] = {'path': str(site), 'sha256': SITE_HASH}
        result = original_run([sys.executable, str(launcher), '--runner', str(runner), str(events)], *pos, **kw)
        receipt['invocation'] = {'elapsed_ns': time.monotonic_ns() - started, 'returncode': result.returncode}
        return result

    subprocess.run = observed_run
    try:
        original_main(test, ['HeartbeatTest.' + METHOD])
    except SystemExit as error:
        receipt['unittest_exit_code'] = error.code
        raise
    finally:
        subprocess.run = original_run
        (output / 'timing-observation.json').write_text(json.dumps(receipt, indent=2) + '\n')


if __name__ == '__main__':
    if len(sys.argv) == 4 and sys.argv[1] == '--runner':
        run_runner(sys.argv[2], sys.argv[3])
    elif len(sys.argv) == 3:
        run_test(sys.argv[1], sys.argv[2])
    else:
        raise SystemExit('Invalid timing observation invocation.')
