import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  ContainerWorkerBoundary,
  DockerWorkerContainerRuntime,
  WORKER_ROUTER_CONTAINER_ERROR_CODE,
  WorkerRouterContainerError,
  assertDigestPinnedImage,
  planCommitOnlyMounts,
  resolveWorkerNetworkMode,
  type WorkerContainerInspection,
  type WorkerContainerLogs,
  type WorkerContainerRuntime,
  type WorkerContainerSpec,
} from '../src/agents/worker-router-container.js';
import type { ProcessResult, ProcessRunner, ProcessRunOptions } from '../src/github/transport.js';

const ID = 'ab'.repeat(32);
const IMAGE = `tachiko/worker-router@sha256:${'c'.repeat(64)}`;

class FakeRuntime implements WorkerContainerRuntime {
  readonly calls: string[] = [];
  createResult: string | Error = ID;
  startError: Error | undefined;
  waitResult: number | Error = 0;
  inspectResult: WorkerContainerInspection | Error = { id: ID, status: 'exited', running: false, exitCode: 0, restartPolicy: 'no' };
  /** Per-call overrides consumed before `inspectResult`. */
  readonly inspectQueue: Array<WorkerContainerInspection | Error> = [];
  logsResult: WorkerContainerLogs | Error = { stdout: 'out', stderr: 'err' };
  stopError: Error | undefined;
  killError: Error | undefined;
  removeError: Error | undefined;

  async create(_spec: WorkerContainerSpec): Promise<string> {
    this.calls.push('create');
    if (this.createResult instanceof Error) throw this.createResult;
    return this.createResult;
  }
  async start(id: string, _spec: WorkerContainerSpec): Promise<void> {
    this.calls.push(`start:${id}`);
    if (this.startError !== undefined) throw this.startError;
  }
  async wait(id: string): Promise<number> {
    this.calls.push(`wait:${id}`);
    if (this.waitResult instanceof Error) throw this.waitResult;
    return this.waitResult;
  }
  async inspect(id: string): Promise<WorkerContainerInspection> {
    this.calls.push(`inspect:${id}`);
    const queued = this.inspectQueue.shift() ?? this.inspectResult;
    if (queued instanceof Error) throw queued;
    return queued;
  }
  async logs(id: string): Promise<WorkerContainerLogs> {
    this.calls.push(`logs:${id}`);
    if (this.logsResult instanceof Error) throw this.logsResult;
    return this.logsResult;
  }
  async stop(id: string, graceSeconds: number): Promise<void> {
    this.calls.push(`stop:${id}:${graceSeconds}`);
    if (this.stopError !== undefined) throw this.stopError;
  }
  async kill(id: string): Promise<void> {
    this.calls.push(`kill:${id}`);
    if (this.killError !== undefined) throw this.killError;
  }
  async remove(id: string): Promise<void> {
    this.calls.push(`remove:${id}`);
    if (this.removeError !== undefined) throw this.removeError;
  }
}

function spec(overrides: Partial<WorkerContainerSpec> = {}): WorkerContainerSpec {
  return {
    image: IMAGE,
    entrypoint: '/root/.local/bin/worker-router',
    args: [],
    mounts: [{ host: '/ws', container: '/ws', mode: 'rw' }],
    env: { HOME: '/root' },
    network: 'none',
    workdir: '/ws',
    stdin: 'task\n',
    timeoutMs: 1000,
    ...overrides,
  };
}

const containerError = (code: (typeof WORKER_ROUTER_CONTAINER_ERROR_CODE)[keyof typeof WORKER_ROUTER_CONTAINER_ERROR_CODE], message: string): WorkerRouterContainerError =>
  new WorkerRouterContainerError(code, message);

describe('ContainerWorkerBoundary', () => {
  it('awaits the exact container terminal, then removes it by the exact ID', async () => {
    const runtime = new FakeRuntime();
    const result = await new ContainerWorkerBoundary({ runtime }).run(spec());
    assert.equal(result.containerId, ID);
    assert.equal(result.exitCode, 0);
    assert.equal(result.terminalState, 'exited');
    assert.equal(result.restartPolicy, 'no');
    assert.equal(result.stdout, 'out');
    assert.equal(result.stderr, 'err');
    assert.equal(result.output?.outcome, 'passed');
    assert.equal(result.output?.exitCode, 0);
    assert.deepEqual(runtime.calls, [
      'create',
      `start:${ID}`,
      `wait:${ID}`,
      `inspect:${ID}`,
      `logs:${ID}`,
      `remove:${ID}`,
    ]);
  });

  it('treats a non-zero worker exit as a real terminal result, not a containment failure', async () => {
    const runtime = new FakeRuntime();
    runtime.waitResult = 17;
    runtime.inspectResult = { id: ID, status: 'exited', running: false, exitCode: 17, restartPolicy: 'no' };
    const result = await new ContainerWorkerBoundary({ runtime }).run(spec());
    assert.equal(result.exitCode, 17);
    assert.equal(runtime.calls.includes(`stop:${ID}:5`), false);
    assert.equal(runtime.calls.includes(`kill:${ID}`), false);
    assert.equal(runtime.calls.filter((call) => call === `remove:${ID}`).length, 1);
  });

  it('stops, awaits terminal, kills, and removes by exact ID after a timeout, then rethrows the timeout', async () => {
    const runtime = new FakeRuntime();
    runtime.startError = containerError(WORKER_ROUTER_CONTAINER_ERROR_CODE.TIMEOUT, 'timed out');
    await assert.rejects(
      () => new ContainerWorkerBoundary({ runtime }).run(spec()),
      (error: unknown) => error instanceof WorkerRouterContainerError && error.code === WORKER_ROUTER_CONTAINER_ERROR_CODE.TIMEOUT,
    );
    assert.deepEqual(runtime.calls, [
      'create',
      `start:${ID}`,
      `stop:${ID}:5`,
      `wait:${ID}`,
      `kill:${ID}`,
      `wait:${ID}`,
      `remove:${ID}`,
    ]);
    assert.equal(runtime.calls.filter((call) => call === 'create').length, 1);
  });

  it('cleans up by exact ID on cancellation and reports a single bounded cleanup', async () => {
    const controller = new AbortController();
    const runtime = new FakeRuntime();
    runtime.startError = containerError(WORKER_ROUTER_CONTAINER_ERROR_CODE.CANCELLED, 'cancelled');
    controller.abort();
    await assert.rejects(
      () => new ContainerWorkerBoundary({ runtime }).run(spec({ signal: controller.signal })),
      (error: unknown) => error instanceof WorkerRouterContainerError && error.code === WORKER_ROUTER_CONTAINER_ERROR_CODE.CANCELLED,
    );
    assert.deepEqual(runtime.calls, [
      'create',
      `start:${ID}`,
      `stop:${ID}:5`,
      `wait:${ID}`,
      `kill:${ID}`,
      `wait:${ID}`,
      `remove:${ID}`,
    ]);
    assert.equal(runtime.calls.filter((call) => call === `remove:${ID}`).length, 1);
  });

  it('prefers cancellation when the signal aborts during terminal observation', async () => {
    const controller = new AbortController();
    const runtime = new FakeRuntime();
    runtime.waitResult = new Error('connection reset');
    const originalStart = runtime.start.bind(runtime);
    runtime.start = async (id, containerSpec) => {
      const value = await originalStart(id, containerSpec);
      controller.abort();
      return value;
    };
    await assert.rejects(
      () => new ContainerWorkerBoundary({ runtime }).run(spec({ signal: controller.signal })),
      (error: unknown) => error instanceof WorkerRouterContainerError && error.code === WORKER_ROUTER_CONTAINER_ERROR_CODE.CANCELLED,
    );
    assert.ok(runtime.calls.includes(`kill:${ID}`));
    assert.ok(runtime.calls.includes(`remove:${ID}`));
  });

  it('refuses to return when terminal state cannot be proven, and terminates the container', async () => {
    const runtime = new FakeRuntime();
    runtime.inspectResult = { id: ID, status: 'running', running: true, exitCode: -1, restartPolicy: 'no' };
    await assert.rejects(
      () => new ContainerWorkerBoundary({ runtime }).run(spec()),
      (error: unknown) => error instanceof WorkerRouterContainerError && error.code === WORKER_ROUTER_CONTAINER_ERROR_CODE.TERMINAL_UNPROVEN,
    );
    assert.equal(runtime.calls.includes(`logs:${ID}`), false);
    assert.deepEqual(runtime.calls.slice(0, 4), ['create', `start:${ID}`, `wait:${ID}`, `inspect:${ID}`]);
    assert.ok(runtime.calls.includes(`stop:${ID}:5`));
    assert.ok(runtime.calls.includes(`kill:${ID}`));
    assert.ok(runtime.calls.includes(`remove:${ID}`));
  });

  it('surfaces a containment failure instead of preserving the worker failure when stop/kill/remove cannot prove quiescence', async () => {
    const original = containerError(WORKER_ROUTER_CONTAINER_ERROR_CODE.TIMEOUT, 'worker timed out');
    const runtime = new FakeRuntime();
    runtime.startError = original;
    runtime.inspectResult = new Error('docker inspect failed: cannot connect to the Docker daemon');
    runtime.stopError = new Error('stop failed');
    runtime.killError = new Error('kill failed');
    runtime.removeError = new Error('remove failed');
    let thrown: unknown;
    try {
      await new ContainerWorkerBoundary({ runtime }).run(spec());
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof WorkerRouterContainerError, 'cleanup must surface a typed containment failure');
    assert.equal(thrown.code, WORKER_ROUTER_CONTAINER_ERROR_CODE.TERMINAL_UNPROVEN);
    assert.match(thrown.message, /could not prove quiescence/);
    assert.match(thrown.message, /refusing to report the worker failure as contained/);
    assert.equal(thrown.cause, original, 'the original worker failure is preserved only as cause');
    assert.deepEqual(runtime.calls, [
      'create',
      `start:${ID}`,
      `stop:${ID}:5`,
      `wait:${ID}`,
      `kill:${ID}`,
      `wait:${ID}`,
      `remove:${ID}`,
      `inspect:${ID}`,
    ]);
  });

  it('preserves the worker failure when removal fails but a final inspect still proves a terminal container', async () => {
    const original = containerError(WORKER_ROUTER_CONTAINER_ERROR_CODE.TIMEOUT, 'worker timed out');
    const runtime = new FakeRuntime();
    runtime.startError = original;
    runtime.removeError = new Error('remove failed');
    await assert.rejects(
      () => new ContainerWorkerBoundary({ runtime }).run(spec()),
      (error: unknown) => error === original,
    );
    assert.equal(runtime.calls.includes(`inspect:${ID}`), true);
    assert.equal(runtime.calls.filter((call) => call === `inspect:${ID}`).length, 1);
  });

  it('treats an unreadable first inspect as quiescent only after a final terminal proof', async () => {
    const runtime = new FakeRuntime();
    runtime.inspectQueue.push(new Error('transient inspect failure'));
    await assert.rejects(
      () => new ContainerWorkerBoundary({ runtime }).run(spec()),
      (error: unknown) => error instanceof Error && error.message === 'transient inspect failure',
    );
    assert.deepEqual(runtime.calls, [
      'create',
      `start:${ID}`,
      `wait:${ID}`,
      `inspect:${ID}`,
      `stop:${ID}:5`,
      `wait:${ID}`,
      `kill:${ID}`,
      `wait:${ID}`,
      `remove:${ID}`,
    ]);
  });

  it('refuses to claim cleanup success when a running container survives stop/kill/remove', async () => {
    const runtime = new FakeRuntime();
    runtime.inspectResult = { id: ID, status: 'running', running: true, exitCode: -1, restartPolicy: 'no' };
    runtime.removeError = new Error('remove failed');
    let thrown: unknown;
    try {
      await new ContainerWorkerBoundary({ runtime }).run(spec());
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof WorkerRouterContainerError);
    assert.equal(thrown.code, WORKER_ROUTER_CONTAINER_ERROR_CODE.TERMINAL_UNPROVEN);
    assert.match(thrown.message, /still running/);
    assert.equal(runtime.calls.filter((call) => call === `remove:${ID}`).length, 1);
    assert.equal(runtime.calls.filter((call) => call === `inspect:${ID}`).length, 2);
  });

  it('does not attempt any lifecycle call when create fails', async () => {
    const runtime = new FakeRuntime();
    runtime.createResult = containerError(WORKER_ROUTER_CONTAINER_ERROR_CODE.CREATE_FAILED, 'docker create failed');
    await assert.rejects(
      () => new ContainerWorkerBoundary({ runtime }).run(spec()),
      (error: unknown) => error instanceof WorkerRouterContainerError && error.code === WORKER_ROUTER_CONTAINER_ERROR_CODE.CREATE_FAILED,
    );
    assert.deepEqual(runtime.calls, ['create']);
  });

  it('rejects an unpinned image before any container is created', async () => {
    const runtime = new FakeRuntime();
    await assert.rejects(
      () => new ContainerWorkerBoundary({ runtime }).run(spec({ image: 'alpine:3.21' })),
      (error: unknown) => error instanceof WorkerRouterContainerError && error.code === WORKER_ROUTER_CONTAINER_ERROR_CODE.IMAGE_UNPINNED,
    );
    assert.deepEqual(runtime.calls, []);
  });
});

class QueueRunner implements ProcessRunner {
  readonly calls: Array<{ file: string; args: readonly string[]; options: ProcessRunOptions }> = [];
  constructor(private readonly outcomes: Array<ProcessResult | Error>) {}
  async run(file: string, args: readonly string[], options: ProcessRunOptions): Promise<ProcessResult> {
    this.calls.push({ file, args, options });
    const outcome = this.outcomes.shift();
    if (outcome === undefined) throw new Error('No fake outcome queued');
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }
}

const ok = (stdout = '', stderr = '', exitCode = 0): ProcessResult => ({ stdout, stderr, exitCode });

describe('DockerWorkerContainerRuntime', () => {
  it('builds an unprivileged, restart-free, digest-pinned create invocation', async () => {
    const runner = new QueueRunner([ok(`${ID}\n`)]);
    const runtime = new DockerWorkerContainerRuntime({ runner });
    const id = await runtime.create(spec({
      mounts: [
        { host: '/ws', container: '/ws', mode: 'rw' },
        { host: '/source/.git/config', container: '/source/.git/config', mode: 'ro' },
      ],
      env: { WORKER_FORCE: 'deepseek', HOME: '/root' },
      network: 'none',
    }));
    assert.equal(id, ID);
    const args = runner.calls[0]?.args ?? [];
    assert.deepEqual(args, [
      'create',
      '--pull=never',
      '--restart=no',
      '--network', 'none',
      '--interactive',
      '--workdir', '/ws',
      '--env', 'HOME=/root',
      '--env', 'WORKER_FORCE=deepseek',
      '--volume', '/ws:/ws',
      '--volume', '/source/.git/config:/source/.git/config:ro',
      IMAGE,
      '/root/.local/bin/worker-router',
    ]);
    assert.equal(args.includes('--privileged'), false);
    assert.equal(args.some((arg) => arg.includes('docker.sock')), false);
    assert.equal(args.includes('ps'), false);
  });

  it('addresses every lifecycle call by the exact ID and reads terminal state', async () => {
    const runner = new QueueRunner([
      ok(), // start --attach --interactive
      ok('23\n'), // wait
      ok(JSON.stringify({ Id: ID, State: { Status: 'exited', Running: false, ExitCode: 23 }, HostConfig: { RestartPolicy: { Name: 'no' } } })),
      ok('container stdout', 'container stderr'),
      ok(), // stop
      ok(), // kill
      ok(), // rm
    ]);
    const runtime = new DockerWorkerContainerRuntime({ runner });
    await runtime.start(ID, spec());
    assert.equal(await runtime.wait(ID), 23);
    const state = await runtime.inspect(ID);
    assert.deepEqual(state, { id: ID, status: 'exited', running: false, exitCode: 23, restartPolicy: 'no' });
    assert.deepEqual(await runtime.logs(ID), { stdout: 'container stdout', stderr: 'container stderr' });
    await runtime.stop(ID, 5);
    await runtime.kill(ID);
    await runtime.remove(ID);
    assert.deepEqual(runner.calls.map((call) => call.args), [
      ['start', '--attach', '--interactive', ID],
      ['wait', ID],
      ['inspect', '--format', '{{json .}}', ID],
      ['logs', ID],
      ['stop', '--time', '5', ID],
      ['kill', ID],
      ['rm', '--force', ID],
    ]);
    assert.equal(runner.calls[0]?.options.stdin, 'task\n');
  });

  it('refuses lifecycle calls without an exact 64-hex container id', async () => {
    const runtime = new DockerWorkerContainerRuntime({ runner: new QueueRunner([]) });
    await assert.rejects(() => runtime.wait('abc123'), /exact 64-hex container id/);
    await assert.rejects(() => runtime.remove(''), /exact 64-hex container id/);
  });

  it('maps runtime spawn failures to typed container errors', async () => {
    const missing = new DockerWorkerContainerRuntime({ runner: new QueueRunner([Object.assign(new Error('missing'), { code: 'ENOENT' })]) });
    await assert.rejects(
      () => missing.create(spec()),
      (error: unknown) => error instanceof WorkerRouterContainerError && error.code === WORKER_ROUTER_CONTAINER_ERROR_CODE.RUNTIME_NOT_FOUND,
    );
    const timedOut = new DockerWorkerContainerRuntime({ runner: new QueueRunner([Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })]) });
    await assert.rejects(
      () => timedOut.create(spec()),
      (error: unknown) => error instanceof WorkerRouterContainerError && error.code === WORKER_ROUTER_CONTAINER_ERROR_CODE.TIMEOUT,
    );
    const aborted = new AbortController();
    aborted.abort();
    const cancelled = new DockerWorkerContainerRuntime({ runner: new QueueRunner([Object.assign(new Error('aborted'), { code: 'ABORT_ERR' })]) });
    await assert.rejects(
      () => cancelled.create(spec({ signal: aborted.signal })),
      (error: unknown) => error instanceof WorkerRouterContainerError && error.code === WORKER_ROUTER_CONTAINER_ERROR_CODE.CANCELLED,
    );
  });

  it('rejects a create that does not return an exact container id', async () => {
    const runtime = new DockerWorkerContainerRuntime({ runner: new QueueRunner([ok('not-an-id\n')]) });
    await assert.rejects(
      () => runtime.create(spec()),
      (error: unknown) => error instanceof WorkerRouterContainerError && error.code === WORKER_ROUTER_CONTAINER_ERROR_CODE.ID_INVALID,
    );
  });
});

describe('commit-only mount plan', () => {
  const roots: string[] = [];
  function fixture(): { workspacePath: string; gitdir: string; commonDir: string } {
    const root = mkdtempSync(path.join(os.tmpdir(), 'worker-router-mounts-'));
    roots.push(root);
    const workspacePath = path.join(root, 'worktree');
    const commonDir = path.join(root, 'source', '.git');
    const gitdir = path.join(commonDir, 'worktrees', 'run');
    mkdirSync(workspacePath, { recursive: true });
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(path.join(gitdir, 'commondir'), '../..\n');
    mkdirSync(path.join(commonDir, 'objects'), { recursive: true });
    mkdirSync(path.join(commonDir, 'refs'), { recursive: true });
    writeFileSync(path.join(commonDir, 'config'), '[core]\n');
    writeFileSync(path.join(commonDir, 'packed-refs'), '');
    writeFileSync(path.join(workspacePath, '.git'), `gitdir: ${gitdir}\n`);
    return { workspacePath, gitdir, commonDir };
  }
  process.on('exit', () => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

  it('mounts only the linked worktree, gitdir, objects, refs, and a read-only config', () => {
    const f = fixture();
    assert.deepEqual(
      planCommitOnlyMounts(f.workspacePath).map((mount) => `${mount.container}:${mount.mode}`),
      [
        `${f.workspacePath}:rw`,
        `${f.gitdir}:rw`,
        `${path.join(f.commonDir, 'objects')}:rw`,
        `${path.join(f.commonDir, 'refs')}:rw`,
        `${path.join(f.commonDir, 'config')}:ro`,
      ],
    );
    const destinations = planCommitOnlyMounts(f.workspacePath).map((mount) => mount.container);
    assert.equal(destinations.some((value) => value.includes('remote.git')), false);
    assert.equal(destinations.some((value) => value.includes('packed-refs')), false);
    assert.equal(destinations.some((value) => value.includes(`${path.sep}hooks`)), false);
    assert.equal(destinations.some((value) => value.includes('docker.sock')), false);
    assert.equal(destinations.some((value) => value.startsWith(os.homedir())), false);
  });

  it('refuses a relative, unindirected, or incomplete workspace', () => {
    assert.throws(() => planCommitOnlyMounts('relative/path'), /must be absolute/);
    const empty = mkdtempSync(path.join(os.tmpdir(), 'worker-router-empty-'));
    roots.push(empty);
    assert.throws(() => planCommitOnlyMounts(empty), /no readable \.git indirection/);
    const f = fixture();
    rmSync(path.join(f.commonDir, 'objects'), { recursive: true, force: true });
    assert.throws(() => planCommitOnlyMounts(f.workspacePath), /missing its common Git objects directory/);
  });

  it('rejects a plain .git/ repository instead of exposing its whole common Git tree', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'worker-router-plain-'));
    roots.push(root);
    mkdirSync(path.join(root, '.git', 'objects'), { recursive: true });
    mkdirSync(path.join(root, '.git', 'refs'), { recursive: true });
    mkdirSync(path.join(root, '.git', 'hooks'), { recursive: true });
    writeFileSync(path.join(root, '.git', 'config'), '[core]\n');
    assert.throws(() => planCommitOnlyMounts(root), /plain Git repositories are never containerized/);
  });

  it('rejects a .git file that is not a registered linked-worktree gitdir', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'worker-router-orphan-'));
    roots.push(root);
    const workspacePath = path.join(root, 'worktree');
    const commonDir = path.join(root, 'common', '.git');
    const gitdir = path.join(root, 'gitdirs', 'run');
    mkdirSync(workspacePath, { recursive: true });
    mkdirSync(gitdir, { recursive: true });
    mkdirSync(path.join(commonDir, 'objects'), { recursive: true });
    mkdirSync(path.join(commonDir, 'refs'), { recursive: true });
    writeFileSync(path.join(workspacePath, '.git'), `gitdir: ${gitdir}\n`);
    assert.throws(() => planCommitOnlyMounts(workspacePath), /no commondir pointer/);

    writeFileSync(path.join(gitdir, 'commondir'), '../../common/.git\n');
    assert.throws(() => planCommitOnlyMounts(workspacePath), /not registered under the common Git worktrees/);
  });
});

describe('container image and network policy', () => {
  it('accepts only digest-pinned image references', () => {
    assert.doesNotThrow(() => assertDigestPinnedImage(`tachiko/worker-router@sha256:${'a'.repeat(64)}`));
    assert.doesNotThrow(() => assertDigestPinnedImage(`sha256:${'a'.repeat(64)}`));
    for (const value of ['tachiko/worker-router:latest', 'tachiko/worker-router@sha256:short', 'alpine']) {
      assert.throws(() => assertDigestPinnedImage(value), /pinned by digest/);
    }
    assert.throws(() => assertDigestPinnedImage('  '), /must name a container image/);
  });

  it('defaults to no network and only allows an explicit bridge opt-in', () => {
    assert.equal(resolveWorkerNetworkMode(undefined), 'none');
    assert.equal(resolveWorkerNetworkMode(''), 'none');
    assert.equal(resolveWorkerNetworkMode('bridge'), 'bridge');
    assert.equal(resolveWorkerNetworkMode('none'), 'none');
    assert.throws(() => resolveWorkerNetworkMode('host'), /must be "none" or "bridge"/);
  });
});
