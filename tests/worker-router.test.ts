import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { WorkspaceGuardFailure } from '../src/adapters/agent.js';
import {
  WORKER_ROUTER_ERROR_CODE,
  WORKER_ROUTER_EXECUTABLE_ENV,
  WorkerRouterAdapter,
} from '../src/agents/worker-router.js';
import {
  WORKER_ROUTER_CONTAINER_ERROR_CODE,
  WORKER_ROUTER_IMAGE_ENV,
  WorkerRouterContainerError,
  type ContainerWorkerExecution,
  type ContainerWorkerResult,
  type WorkerContainerSpec,
} from '../src/agents/worker-router-container.js';
import type { ProcessResult, ProcessRunner, ProcessRunOptions } from '../src/github/transport.js';
import { InMemoryToolOutputStore, boundToolOutput } from '../src/evidence/tool-output.js';
import { TARGET } from './helpers.js';

class FakeRunner implements ProcessRunner {
  readonly calls: Array<{ file: string; args: readonly string[]; options: ProcessRunOptions }> = [];
  constructor(private readonly outcomes: Array<ProcessResult | Error>, private readonly events: string[] = []) {}
  async run(file: string, args: readonly string[], options: ProcessRunOptions): Promise<ProcessResult> {
    this.calls.push({ file, args, options });
    this.events.push(`git:${args[0] ?? ''}`);
    const outcome = this.outcomes.shift();
    if (outcome === undefined) throw new Error('No fake outcome queued');
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }
}

class FakeContainer implements ContainerWorkerExecution {
  readonly specs: WorkerContainerSpec[] = [];
  constructor(private readonly outcomes: Array<ContainerWorkerResult | Error>, private readonly events: string[] = []) {}
  async run(spec: WorkerContainerSpec): Promise<ContainerWorkerResult> {
    this.specs.push(spec);
    this.events.push('container:run');
    const outcome = this.outcomes.shift();
    if (outcome === undefined) throw new Error('No fake container outcome queued');
    if (outcome instanceof Error) {
      this.events.push('container:failed');
      throw outcome;
    }
    this.events.push('container:terminal');
    return outcome;
  }
}

const HEAD = '9d9cc7d210960f3c81d7d7498a36f65c67b9f4a9';
const BASE = '1d9cc7d210960f3c81d7d7498a36f65c67b9f4a9';
const IMAGE = `tachiko/worker-router@sha256:${'a'.repeat(64)}`;
const result = (stdout = '', stderr = '', exitCode = 0): ProcessResult => ({ stdout, stderr, exitCode });
const containerResult = (overrides: Partial<ContainerWorkerResult> = {}): ContainerWorkerResult => ({
  containerId: 'f'.repeat(64),
  exitCode: 0,
  terminalState: 'exited',
  restartPolicy: 'no',
  stdout: '',
  stderr: '[worker-router] -> luna-worker\n',
  ...overrides,
});

/** Minimal on-disk linked-worktree indirection; no Git process is needed. */
function preparedWorkspace(): { root: string; workspacePath: string; gitdir: string; commonDir: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'worker-router-ws-'));
  const workspacePath = path.join(root, 'worktree');
  const commonDir = path.join(root, 'source', '.git');
  const gitdir = path.join(commonDir, 'worktrees', 'worker-router-test');
  mkdirSync(workspacePath, { recursive: true });
  mkdirSync(gitdir, { recursive: true });
  writeFileSync(path.join(gitdir, 'commondir'), '../..\n');
  mkdirSync(path.join(commonDir, 'objects'), { recursive: true });
  mkdirSync(path.join(commonDir, 'refs'), { recursive: true });
  writeFileSync(path.join(commonDir, 'config'), '[core]\n\trepositoryformatversion = 0\n');
  writeFileSync(path.join(workspacePath, '.git'), `gitdir: ${gitdir}\n`);
  return { root, workspacePath, gitdir, commonDir };
}

const cleanupPaths: string[] = [];
function workspace(): { workspacePath: string; gitdir: string; commonDir: string } {
  const created = preparedWorkspace();
  cleanupPaths.push(created.root);
  return created;
}
process.on('exit', () => { for (const root of cleanupPaths) rmSync(root, { recursive: true, force: true }); });

function requestFor(workspacePath: string): {
  readonly target: typeof TARGET;
  readonly baseSha: string;
  readonly workspacePath: string;
  readonly branch: string;
} {
  return { target: TARGET, baseSha: BASE, workspacePath, branch: 'worker-router-test' };
}

describe('WorkerRouterAdapter container boundary', () => {
  it('runs the containerized worker, then proves HEAD and publishes it only after container terminal', async () => {
    const events: string[] = [];
    const ws = workspace();
    const runner = new FakeRunner([result(HEAD), result(), result('To origin\n')], events);
    const container = new FakeContainer([containerResult()], events);
    let before = 0; let after = 0;
    const response = await new WorkerRouterAdapter({ runner, container, image: IMAGE, executable: '/router', timeoutMs: 9000, env: { DEEPSEEK_API_KEY: 'sk-secret' } }).run({
      ...requestFor(ws.workspacePath),
      authority: 'live-target',
      supplementalInstructions: 'Focus on the acceptance tests.',
      workspaceGuard: { assertValid: (phase) => { events.push(`guard:${phase ?? 'before-execution'}`); if (phase === 'after-execution') after++; else before++; } },
    });

    assert.equal(response.exitStatus, 'success');
    assert.equal(response.headSha, HEAD);
    assert.equal(before, 1);
    assert.equal(after, 1);

    // Terminal before guard(after) and before any Tachiko-owned Git authority work.
    const terminal = events.indexOf('container:terminal');
    assert.ok(terminal >= 0, 'container terminal must be observed');
    assert.ok(events.indexOf('guard:before-execution') < events.indexOf('container:run'));
    assert.ok(terminal < events.indexOf('guard:after-execution'), 'guard(after) must follow container terminal');
    assert.ok(terminal < events.indexOf('git:rev-parse'));
    assert.ok(terminal < events.indexOf('git:merge-base'));
    assert.ok(terminal < events.indexOf('git:push'));

    // The exact container terminal is awaited exactly once; no replay/fallback.
    assert.equal(container.specs.length, 1);
    assert.ok(runner.calls.every((call) => call.file !== '/router'));

    // Commit-only mounts: no bare remote, no hooks, no $HOME, no Docker socket.
    const spec = container.specs[0]!;
    assert.equal(spec.entrypoint, '/router');
    assert.equal(spec.network, 'none');
    assert.equal(spec.workdir, ws.workspacePath);
    assert.match(spec.stdin, /live GitHub target and repository-local instructions/);
    assert.match(spec.stdin, /Focus on the acceptance tests\./);
    assert.match(spec.stdin, /Do not push; Conductor publishes the exact committed HEAD/i);
    assert.deepEqual(
      spec.mounts.map((mount) => [mount.container, mount.mode]),
      [
        [ws.workspacePath, 'rw'],
        [ws.gitdir, 'rw'],
        [path.join(ws.commonDir, 'objects'), 'rw'],
        [path.join(ws.commonDir, 'refs'), 'rw'],
        [path.join(ws.commonDir, 'config'), 'ro'],
      ],
    );
    for (const mount of spec.mounts) {
      assert.equal(mount.host, mount.container);
      assert.equal(mount.container.includes('remote.git'), false);
      assert.equal(mount.container.includes(`${path.sep}hooks`), false);
      assert.equal(mount.container.includes('docker.sock'), false);
      assert.equal(mount.container.startsWith(os.homedir()), false);
    }
    assert.equal(spec.env['HOME'], '/root');
    assert.equal(spec.env['DEEPSEEK_API_KEY'], 'sk-secret');

    assert.deepEqual(runner.calls.map((call) => call.args), [
      ['rev-parse', 'HEAD'],
      ['merge-base', '--is-ancestor', BASE, HEAD],
      ['push', '--porcelain', 'origin', `${HEAD}:refs/heads/worker-router-test`],
    ]);
    assert.equal(runner.calls[0]?.options.cwd, ws.workspacePath);
    assert.match(response.diagnostics?.join('\n') ?? '', /luna-worker/);
  });

  it('requires an explicit prepared workspace and branch instead of using ambient cwd', async () => {
    const runner = new FakeRunner([]);
    const container = new FakeContainer([]);
    const missingWorkspace = await new WorkerRouterAdapter({ runner, container, image: IMAGE, cwd: '/ambient' }).run({ target: TARGET, baseSha: 'base', branch: 'branch' });
    const missingBranch = await new WorkerRouterAdapter({ runner, container, image: IMAGE, cwd: '/ambient' }).run({ target: TARGET, baseSha: 'base', workspacePath: '/prepared' });
    assert.match(missingWorkspace.diagnostics?.[0] ?? '', new RegExp(WORKER_ROUTER_ERROR_CODE.WORKSPACE_REQUIRED));
    assert.match(missingBranch.diagnostics?.[0] ?? '', new RegExp(WORKER_ROUTER_ERROR_CODE.WORKSPACE_REQUIRED));
    assert.equal(runner.calls.length, 0);
    assert.equal(container.specs.length, 0);
  });

  it('fails closed before spawn when per-run MCP capabilities are requested', async () => {
    const container = new FakeContainer([]);
    const response = await new WorkerRouterAdapter({ runner: new FakeRunner([]), container, image: IMAGE }).run({
      ...requestFor('/prepared'),
      capabilities: [{ kind: 'mcp-http', name: 'browser', endpoint: 'http://127.0.0.1:3000/' }],
    });
    assert.equal(response.exitStatus, 'failure');
    assert.match(response.diagnostics?.[0] ?? '', new RegExp(WORKER_ROUTER_ERROR_CODE.CAPABILITIES_UNSUPPORTED));
    assert.equal(container.specs.length, 0);
  });

  it('uses the configured in-container entrypoint and rejects a relative one', async () => {
    const ws = workspace();
    const runner = new FakeRunner([result(HEAD), result(), result()]);
    const container = new FakeContainer([containerResult()]);
    const response = await new WorkerRouterAdapter({
      runner,
      container,
      image: IMAGE,
      env: { [WORKER_ROUTER_EXECUTABLE_ENV]: '/custom/worker-router' },
    }).run(requestFor(ws.workspacePath));
    assert.equal(response.exitStatus, 'success');
    assert.equal(container.specs[0]?.entrypoint, '/custom/worker-router');
    assert.throws(
      () => new WorkerRouterAdapter({ runner: new FakeRunner([]), env: { [WORKER_ROUTER_EXECUTABLE_ENV]: 'relative/router' } }),
      /absolute non-empty path/,
    );
  });

  it('fails closed without a digest-pinned image and never falls back to host execution', async () => {
    const ws = workspace();
    const runner = new FakeRunner([]);
    const container = new FakeContainer([]);
    const response = await new WorkerRouterAdapter({ runner, container, env: {} }).run(requestFor(ws.workspacePath));
    assert.equal(response.exitStatus, 'failure');
    assert.match(response.diagnostics?.[0] ?? '', new RegExp(WORKER_ROUTER_ERROR_CODE.IMAGE_REQUIRED));
    assert.equal(container.specs.length, 0);
    assert.equal(runner.calls.length, 0);
  });

  it('rejects a tag-only container image reference', () => {
    assert.throws(() => new WorkerRouterAdapter({ image: 'tachiko/worker-router:latest' }), /pinned by digest/);
    assert.throws(() => new WorkerRouterAdapter({ env: { [WORKER_ROUTER_IMAGE_ENV]: 'alpine:3.21' } }), /pinned by digest/);
  });

  it('fails closed when the prepared workspace cannot be mounted', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'worker-router-nogit-'));
    cleanupPaths.push(root);
    const runner = new FakeRunner([]);
    const container = new FakeContainer([]);
    const response = await new WorkerRouterAdapter({ runner, container, image: IMAGE }).run(requestFor(root));
    assert.equal(response.exitStatus, 'failure');
    assert.match(response.diagnostics?.[0] ?? '', new RegExp(WORKER_ROUTER_ERROR_CODE.MOUNTS_INVALID));
    assert.equal(container.specs.length, 0);
    assert.equal(runner.calls.length, 0);
  });

  it('refuses a plain Git repository workspace instead of exposing its whole .git tree', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'worker-router-plain-'));
    cleanupPaths.push(root);
    mkdirSync(path.join(root, '.git', 'objects'), { recursive: true });
    mkdirSync(path.join(root, '.git', 'refs'), { recursive: true });
    mkdirSync(path.join(root, '.git', 'hooks'), { recursive: true });
    writeFileSync(path.join(root, '.git', 'config'), '[core]\n');
    const runner = new FakeRunner([]);
    const container = new FakeContainer([]);
    const response = await new WorkerRouterAdapter({ runner, container, image: IMAGE }).run(requestFor(root));
    assert.equal(response.exitStatus, 'failure');
    assert.match(response.diagnostics?.[0] ?? '', new RegExp(WORKER_ROUTER_ERROR_CODE.MOUNTS_INVALID));
    assert.equal(container.specs.length, 0);
    assert.equal(runner.calls.length, 0);
  });

  it('keeps only recognized provenance and never persists worker output', async () => {
    const ws = workspace();
    const container = new FakeContainer([containerResult({ exitCode: 7, stderr: `[worker-router] -> deepseek-worker\n${'x'.repeat(5000)}` })]);
    const response = await new WorkerRouterAdapter({ runner: new FakeRunner([]), container, image: IMAGE }).run(requestFor(ws.workspacePath));
    assert.equal(response.exitStatus, 'failure');
    assert.match(response.diagnostics?.join('\n') ?? '', /deepseek-worker/);
    assert.equal(response.diagnostics?.join('\n').includes('xxxxx'), false);
  });

  it('returns cancellation when the request is already aborted', async () => {
    const ws = workspace();
    const controller = new AbortController();
    controller.abort();
    const container = new FakeContainer([]);
    const response = await new WorkerRouterAdapter({ runner: new FakeRunner([]), container, image: IMAGE }).run({ ...requestFor(ws.workspacePath), signal: controller.signal });
    assert.equal(response.exitStatus, 'failure');
    assert.match(response.diagnostics?.[0] ?? '', new RegExp(WORKER_ROUTER_ERROR_CODE.CANCELLED));
    assert.equal(container.specs.length, 0);
  });

  it('maps container cancellation to a typed cancellation', async () => {
    const ws = workspace();
    const runner = new FakeRunner([]);
    const container = new FakeContainer([new WorkerRouterContainerError(WORKER_ROUTER_CONTAINER_ERROR_CODE.CANCELLED, 'cancelled')]);
    const response = await new WorkerRouterAdapter({ runner, container, image: IMAGE }).run(requestFor(ws.workspacePath));
    assert.equal(response.exitStatus, 'failure');
    assert.match(response.diagnostics?.[0] ?? '', new RegExp(WORKER_ROUTER_ERROR_CODE.CANCELLED));
    assert.equal(runner.calls.length, 0);
  });

  it('maps a container timeout to a typed timeout without touching HEAD or publication', async () => {
    const ws = workspace();
    const runner = new FakeRunner([]);
    const container = new FakeContainer([new WorkerRouterContainerError(WORKER_ROUTER_CONTAINER_ERROR_CODE.TIMEOUT, 'timed out')]);
    let after = 0;
    const response = await new WorkerRouterAdapter({ runner, container, image: IMAGE }).run({
      ...requestFor(ws.workspacePath),
      workspaceGuard: { assertValid: (phase) => { if (phase === 'after-execution') after++; } },
    });
    assert.equal(response.exitStatus, 'failure');
    assert.match(response.diagnostics?.[0] ?? '', new RegExp(WORKER_ROUTER_ERROR_CODE.TIMEOUT));
    assert.equal(after, 0);
    assert.equal(runner.calls.length, 0);
  });

  it('retains container timeout evidence on the provider-neutral failure result', async () => {
    const ws = preparedWorkspace();
    const output = boundToolOutput({
      outcome: 'timed_out', exitCode: null, stdout: '', stderr: 'ERROR: worker timeout\n',
      store: new InMemoryToolOutputStore(),
    });
    const container = new FakeContainer([new WorkerRouterContainerError(
      WORKER_ROUTER_CONTAINER_ERROR_CODE.TIMEOUT, 'timed out', undefined, output,
    )]);
    const response = await new WorkerRouterAdapter({ runner: new FakeRunner([]), container, image: IMAGE }).run(requestFor(ws.workspacePath));

    assert.equal(response.exitStatus, 'failure');
    assert.equal(response.output?.outcome, 'timed_out');
    assert.equal(response.output?.artifact.totalBytes, output.artifact.totalBytes);
  });

  it('never reads HEAD, proves ancestry, or publishes after a container failure', async () => {
    const ws = workspace();
    const runner = new FakeRunner([]);
    const container = new FakeContainer([containerResult({ exitCode: 3, stderr: 'boom' })]);
    let after = 0;
    const response = await new WorkerRouterAdapter({ runner, container, image: IMAGE }).run({
      ...requestFor(ws.workspacePath),
      workspaceGuard: { assertValid: (phase) => { if (phase === 'after-execution') after++; } },
    });
    assert.equal(response.exitStatus, 'failure');
    assert.match(response.diagnostics?.[0] ?? '', new RegExp(WORKER_ROUTER_ERROR_CODE.EXIT_FAILURE));
    assert.equal(after, 0);
    assert.equal(runner.calls.length, 0);
  });

  it('surfaces a distinct containment failure and never publishes when container quiescence is unproven', async () => {
    const ws = workspace();
    const runner = new FakeRunner([]);
    const container = new FakeContainer([new WorkerRouterContainerError(
      WORKER_ROUTER_CONTAINER_ERROR_CODE.TERMINAL_UNPROVEN,
      'Container abc cleanup could not prove quiescence; refusing to report the worker failure as contained.',
    )]);
    let after = 0;
    const response = await new WorkerRouterAdapter({ runner, container, image: IMAGE }).run({
      ...requestFor(ws.workspacePath),
      workspaceGuard: { assertValid: (phase) => { if (phase === 'after-execution') after++; } },
    });
    assert.equal(response.exitStatus, 'failure');
    assert.match(response.diagnostics?.[0] ?? '', new RegExp(WORKER_ROUTER_ERROR_CODE.CONTAINMENT_UNPROVEN));
    assert.equal(after, 0);
    assert.equal(runner.calls.length, 0);
  });

  it('redacts forwarded worker credentials from bounded container diagnostics', async () => {
    const ws = workspace();
    const container = new FakeContainer([new WorkerRouterContainerError(
      WORKER_ROUTER_CONTAINER_ERROR_CODE.CREATE_FAILED,
      'docker create failed: --env DEEPSEEK_API_KEY=sk-live-secret',
    )]);
    const response = await new WorkerRouterAdapter({
      runner: new FakeRunner([]),
      container,
      image: IMAGE,
      env: { DEEPSEEK_API_KEY: 'sk-live-secret' },
    }).run(requestFor(ws.workspacePath));
    const text = response.diagnostics?.join('\n') ?? '';
    assert.match(text, new RegExp(WORKER_ROUTER_ERROR_CODE.CONTAINER_FAILURE));
    assert.equal(text.includes('sk-live-secret'), false);
    assert.match(text, /\[redacted\]/);
  });

  it('forwards only the allow-listed container environment', async () => {
    const ws = workspace();
    const container = new FakeContainer([containerResult()]);
    await new WorkerRouterAdapter({
      runner: new FakeRunner([result(HEAD), result(), result()]),
      container,
      image: IMAGE,
      env: { DEEPSEEK_API_KEY: 'sk-1', WORKER_FORCE: 'deepseek', AWS_SECRET_ACCESS_KEY: 'nope', HOME: '/Users/someone' },
    }).run(requestFor(ws.workspacePath));
    const env = container.specs[0]?.env ?? {};
    assert.equal(env['HOME'], '/root');
    assert.equal(env['DEEPSEEK_API_KEY'], 'sk-1');
    assert.equal(env['WORKER_FORCE'], 'deepseek');
    assert.equal(env['AWS_SECRET_ACCESS_KEY'], undefined);
  });

  it('does not resume a model session on stateless re-entry', async () => {
    const ws = workspace();
    const container = new FakeContainer([containerResult()]);
    const response = await new WorkerRouterAdapter({ runner: new FakeRunner([result(HEAD), result(), result()]), container, image: IMAGE }).run({
      ...requestFor(ws.workspacePath),
      executor: { provider: 'worker-router', sessionId: 'ignored' },
    });
    assert.equal(response.exitStatus, 'success');
    assert.equal(container.specs.length, 1);
    assert.equal(container.specs[0]?.stdin.includes('ignored'), false);
  });

  it('fails closed before publication when the worker HEAD diverges from the authorized base', async () => {
    const ws = workspace();
    const runner = new FakeRunner([result(HEAD), result('', 'not an ancestor', 1)]);
    const container = new FakeContainer([containerResult()]);
    const response = await new WorkerRouterAdapter({ runner, container, image: IMAGE }).run(requestFor(ws.workspacePath));
    assert.equal(response.exitStatus, 'failure');
    assert.match(response.diagnostics?.[0] ?? '', new RegExp(WORKER_ROUTER_ERROR_CODE.BASE_ANCESTRY_FAILED));
    assert.deepEqual(runner.calls.map((call) => call.args), [
      ['rev-parse', 'HEAD'],
      ['merge-base', '--is-ancestor', BASE, HEAD],
    ]);
    assert.equal(runner.calls.some((call) => call.args[0] === 'push'), false);
  });

  it('fails before spawn when the workspace guard rejects', async () => {
    const ws = workspace();
    const container = new FakeContainer([]);
    await assert.rejects(() => new WorkerRouterAdapter({ runner: new FakeRunner([]), container, image: IMAGE }).run({
      ...requestFor(ws.workspacePath),
      workspaceGuard: { assertValid: () => { throw new Error('changed'); } },
    }), WorkspaceGuardFailure);
    assert.equal(container.specs.length, 0);
  });

  it('fails closed when the worker HEAD cannot be read', async () => {
    const ws = workspace();
    const container = new FakeContainer([containerResult()]);
    const runner = new FakeRunner([result('not-a-sha\n', 'fatal: not a git repository', 128)]);
    const response = await new WorkerRouterAdapter({ runner, container, image: IMAGE }).run(requestFor(ws.workspacePath));
    assert.equal(response.exitStatus, 'failure');
    assert.match(response.diagnostics?.[0] ?? '', new RegExp(WORKER_ROUTER_ERROR_CODE.HEAD_READ_FAILED));
  });

  it('fails closed when deterministic publication fails', async () => {
    const ws = workspace();
    const container = new FakeContainer([containerResult()]);
    const runner = new FakeRunner([result(HEAD), result(), result('', 'rejected', 1)]);
    const response = await new WorkerRouterAdapter({ runner, container, image: IMAGE }).run(requestFor(ws.workspacePath));
    assert.equal(response.exitStatus, 'failure');
    assert.match(response.diagnostics?.[0] ?? '', new RegExp(WORKER_ROUTER_ERROR_CODE.PUBLISH_FAILED));
    assert.equal(response.diagnostics?.join('\n').includes('rejected'), false);
  });

  it('returns cancellation when HEAD verification is aborted after the container is terminal', async () => {
    const ws = workspace();
    const controller = new AbortController();
    const container = new FakeContainer([containerResult()]);
    const runner = new FakeRunner([result(HEAD)]);
    const originalRun = runner.run.bind(runner);
    runner.run = async (file, args, options) => {
      const value = await originalRun(file, args, options);
      if (args.join(' ') === 'rev-parse HEAD') controller.abort();
      return value;
    };
    const response = await new WorkerRouterAdapter({ runner, container, image: IMAGE }).run({ ...requestFor(ws.workspacePath), signal: controller.signal });
    assert.equal(response.exitStatus, 'failure');
    assert.match(response.diagnostics?.[0] ?? '', new RegExp(WORKER_ROUTER_ERROR_CODE.CANCELLED));
    assert.equal(runner.calls.length, 1);
  });
});
