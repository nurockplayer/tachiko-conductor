import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { WorkspaceGuardFailure } from '../src/adapters/agent.js';
import {
  WORKER_ROUTER_ERROR_CODE,
  WORKER_ROUTER_EXECUTABLE_ENV,
  WorkerRouterAdapter,
} from '../src/agents/worker-router.js';
import type { ProcessResult, ProcessRunner, ProcessRunOptions } from '../src/github/transport.js';
import { TARGET } from './helpers.js';

class FakeRunner implements ProcessRunner {
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

const HEAD = '9d9cc7d210960f3c81d7d7498a36f65c67b9f4a9';
const BASE = '1d9cc7d210960f3c81d7d7498a36f65c67b9f4a9';
const result = (stdout = '', stderr = '', exitCode = 0): ProcessResult => ({ stdout, stderr, exitCode });
const REQUEST = { target: TARGET, baseSha: BASE, workspacePath: '/prepared', branch: 'worker-router-test' } as const;

describe('WorkerRouterAdapter', () => {
  it('runs in the prepared worktree, verifies HEAD, and publishes that exact commit', async () => {
    const runner = new FakeRunner([
      result('', '[worker-router] -> luna-worker\nimplementation details'),
      result(HEAD),
      result(),
      result('To origin\n'),
    ]);
    let before = 0; let after = 0;
    const response = await new WorkerRouterAdapter({ runner, executable: '/router', timeoutMs: 9000 }).run({
      ...REQUEST,
      authority: 'live-target',
      supplementalInstructions: 'Focus on the acceptance tests.',
      workspaceGuard: { assertValid: (phase) => { if (phase === 'after-execution') after++; else before++; } },
    });
    assert.equal(response.exitStatus, 'success');
    assert.equal(response.headSha, HEAD);
    assert.match(runner.calls[0]?.options.stdin ?? '', /live GitHub target and repository-local instructions/);
    assert.match(runner.calls[0]?.options.stdin ?? '', /Focus on the acceptance tests/);
    assert.match(runner.calls[0]?.options.stdin ?? '', /commit all in-scope changes before reporting success/i);
    assert.match(runner.calls[0]?.options.stdin ?? '', /Do not push; Conductor publishes the exact committed HEAD/i);
    assert.equal(runner.calls[0]?.file, '/router');
    assert.equal(runner.calls[0]?.options.cwd, '/prepared');
    assert.deepEqual(runner.calls[3]?.args, ['push', '--porcelain', 'origin', `${HEAD}:refs/heads/worker-router-test`]);
    assert.match(response.diagnostics?.join('\n') ?? '', /luna-worker/);
    assert.equal(before, 1); assert.equal(after, 1);
  });

  it('requires an explicit prepared workspace and branch instead of using ambient cwd', async () => {
    const runner = new FakeRunner([]);
    const missingWorkspace = await new WorkerRouterAdapter({ runner, cwd: '/ambient' }).run({ target: TARGET, baseSha: 'base', branch: 'branch' });
    const missingBranch = await new WorkerRouterAdapter({ runner, cwd: '/ambient' }).run({ target: TARGET, baseSha: 'base', workspacePath: '/prepared' });
    assert.match(missingWorkspace.diagnostics?.[0] ?? '', new RegExp(WORKER_ROUTER_ERROR_CODE.WORKSPACE_REQUIRED));
    assert.match(missingBranch.diagnostics?.[0] ?? '', new RegExp(WORKER_ROUTER_ERROR_CODE.WORKSPACE_REQUIRED));
    assert.equal(runner.calls.length, 0);
  });

  it('fails closed before spawn when per-run MCP capabilities are requested', async () => {
    const runner = new FakeRunner([]);
    const response = await new WorkerRouterAdapter({ runner }).run({
      ...REQUEST,
      capabilities: [{ kind: 'mcp-http', name: 'browser', endpoint: 'http://127.0.0.1:3000/' }],
    });
    assert.equal(response.exitStatus, 'failure');
    assert.match(response.diagnostics?.[0] ?? '', new RegExp(WORKER_ROUTER_ERROR_CODE.CAPABILITIES_UNSUPPORTED));
    assert.equal(runner.calls.length, 0);
  });

  it('uses the configured worker-router executable without making it workflow authority', async () => {
    const runner = new FakeRunner([result('', '[worker-router] -> luna-worker'), result(HEAD), result(), result()]);
    const response = await new WorkerRouterAdapter({
      runner,
      env: { [WORKER_ROUTER_EXECUTABLE_ENV]: '/custom/worker-router' },
    }).run(REQUEST);
    assert.equal(response.exitStatus, 'success');
    assert.equal(runner.calls[0]?.file, '/custom/worker-router');
    assert.throws(
      () => new WorkerRouterAdapter({ runner: new FakeRunner([]), env: { [WORKER_ROUTER_EXECUTABLE_ENV]: 'relative/router' } }),
      /absolute non-empty path/,
    );
  });

  it('keeps only recognized provenance and never persists worker output', async () => {
    const runner = new FakeRunner([result('', `[worker-router] -> deepseek-worker\n${'x'.repeat(5000)}`, 7)]);
    const response = await new WorkerRouterAdapter({ runner }).run(REQUEST);
    assert.equal(response.exitStatus, 'failure');
    assert.match(response.diagnostics?.join('\n') ?? '', /deepseek-worker/);
    assert.equal(response.diagnostics?.join('\n').includes('xxxxx'), false);
  });

  it('returns cancellation when the request is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const response = await new WorkerRouterAdapter({ runner: new FakeRunner([]) }).run({ ...REQUEST, signal: controller.signal });
    assert.equal(response.exitStatus, 'failure');
    assert.match(response.diagnostics?.[0] ?? '', new RegExp(WORKER_ROUTER_ERROR_CODE.CANCELLED));
  });

  it('maps an abort thrown by the worker process to cancellation', async () => {
    const response = await new WorkerRouterAdapter({ runner: new FakeRunner([Object.assign(new Error('aborted'), { code: 'ABORT_ERR' })]) }).run(REQUEST);
    assert.equal(response.exitStatus, 'failure');
    assert.match(response.diagnostics?.[0] ?? '', new RegExp(WORKER_ROUTER_ERROR_CODE.CANCELLED));
  });

  it('fails when the completed worker HEAD cannot be read', async () => {
    const runner = new FakeRunner([result('', '[worker-router] -> luna-worker'), result('not-a-sha\n', 'fatal: not a git repository', 128)]);
    const response = await new WorkerRouterAdapter({ runner }).run(REQUEST);
    assert.equal(response.exitStatus, 'failure');
    assert.match(response.diagnostics?.[0] ?? '', new RegExp(WORKER_ROUTER_ERROR_CODE.HEAD_READ_FAILED));
  });

  it('returns cancellation when HEAD verification is aborted', async () => {
    const controller = new AbortController();
    const runner = new FakeRunner([result('', '[worker-router] -> luna-worker'), result(HEAD)]);
    const originalRun = runner.run.bind(runner);
    runner.run = async (file, args, options) => {
      const value = await originalRun(file, args, options);
      if (args.join(' ') === 'rev-parse HEAD') controller.abort();
      return value;
    };
    const response = await new WorkerRouterAdapter({ runner }).run({ ...REQUEST, signal: controller.signal });
    assert.equal(response.exitStatus, 'failure');
    assert.match(response.diagnostics?.[0] ?? '', new RegExp(WORKER_ROUTER_ERROR_CODE.CANCELLED));
    assert.equal(runner.calls.length, 2);
  });

  it('fails closed when deterministic publication fails', async () => {
    const runner = new FakeRunner([result('', '[worker-router] -> luna-worker'), result(HEAD), result(), result('', 'rejected', 1)]);
    const response = await new WorkerRouterAdapter({ runner }).run(REQUEST);
    assert.equal(response.exitStatus, 'failure');
    assert.match(response.diagnostics?.[0] ?? '', new RegExp(WORKER_ROUTER_ERROR_CODE.PUBLISH_FAILED));
    assert.equal(response.diagnostics?.join('\n').includes('rejected'), false);
  });

  for (const [name, error, code] of [
    ['missing router', Object.assign(new Error('missing'), { code: 'ENOENT' }), WORKER_ROUTER_ERROR_CODE.NOT_FOUND],
    ['timeout', Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }), WORKER_ROUTER_ERROR_CODE.TIMEOUT],
  ] as const) {
    it(`returns typed failure for ${name}`, async () => {
      const response = await new WorkerRouterAdapter({ runner: new FakeRunner([error]) }).run(REQUEST);
      assert.match(response.diagnostics?.[0] ?? '', new RegExp(code));
    });
  }

  it('does not resume a model session on stateless re-entry', async () => {
    const runner = new FakeRunner([result('', '[worker-router] -> luna-worker'), result(HEAD), result(), result()]);
    const response = await new WorkerRouterAdapter({ runner }).run({
      ...REQUEST,
      executor: { provider: 'worker-router', sessionId: 'ignored' },
    });
    assert.equal(response.exitStatus, 'success');
    assert.equal(runner.calls.length, 4);
    assert.equal(runner.calls[0]?.options.stdin?.includes('ignored'), false);
  });

  it('fails closed before publication when the worker HEAD diverges from the authorized base', async () => {
    const runner = new FakeRunner([result('', '[worker-router] -> luna-worker'), result(HEAD), result('', 'not an ancestor', 1)]);
    const response = await new WorkerRouterAdapter({ runner }).run(REQUEST);
    assert.equal(response.exitStatus, 'failure');
    assert.match(response.diagnostics?.[0] ?? '', new RegExp(WORKER_ROUTER_ERROR_CODE.BASE_ANCESTRY_FAILED));
    assert.deepEqual(runner.calls.map((call) => call.args), [
      [],
      ['rev-parse', 'HEAD'],
      ['merge-base', '--is-ancestor', BASE, HEAD],
    ]);
  });

  it('fails closed before publication when the authorized base cannot be resolved', async () => {
    const runner = new FakeRunner([result('', '[worker-router] -> luna-worker'), result(HEAD), result('', 'bad object', 128)]);
    const response = await new WorkerRouterAdapter({ runner }).run(REQUEST);
    assert.equal(response.exitStatus, 'failure');
    assert.match(response.diagnostics?.[0] ?? '', new RegExp(WORKER_ROUTER_ERROR_CODE.BASE_ANCESTRY_FAILED));
    assert.equal(runner.calls.some((call) => call.args[0] === 'push'), false);
  });

  it('fails before spawn when the workspace guard rejects', async () => {
    const runner = new FakeRunner([]);
    await assert.rejects(() => new WorkerRouterAdapter({ runner }).run({
      ...REQUEST,
      workspaceGuard: { assertValid: () => { throw new Error('changed'); } },
    }), WorkspaceGuardFailure);
    assert.equal(runner.calls.length, 0);
  });
});
