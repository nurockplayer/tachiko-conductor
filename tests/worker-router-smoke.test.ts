import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { WorkerRouterAdapter } from '../src/agents/worker-router.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SMOKE_FILE = 'WORKER_ROUTER_SMOKE.txt';
const SMOKE_CONTENT = 'WORKER_ROUTER_SMOKE_OK\n';
const SMOKE_TARGET = { kind: 'repository', owner: 'local', repo: 'worker-router-smoke', branch: 'worker-router-smoke' } as const;

function disposableGitWorkspace(): { root: string; source: string; worker: string; remote: string; baseSha: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-worker-router-smoke-'));
  const source = path.join(root, 'source');
  const worker = path.join(root, 'worker');
  const remote = path.join(root, 'remote.git');
  const workspace = source;
  execFileSync('git', ['init', '--bare', '-q', remote]);
  execFileSync('git', ['init', '-q', '-b', 'main', workspace]);
  // Build the fixture from HEAD, never from arbitrary checkout contents.
  const archive = execFileSync('git', ['archive', 'HEAD'], { cwd: REPO_ROOT });
  execFileSync('tar', ['-x', '-f', '-', '-C', workspace], { input: archive });
  execFileSync('git', ['config', 'user.email', 'worker-router-smoke@example.invalid'], { cwd: workspace });
  execFileSync('git', ['config', 'user.name', 'worker-router-smoke'], { cwd: workspace });
  execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: workspace });
  execFileSync('git', ['add', '-A'], { cwd: workspace });
  execFileSync('git', ['commit', '-qm', 'smoke fixture'], { cwd: workspace });
  execFileSync('git', ['push', '-qu', 'origin', 'main'], { cwd: workspace });
  const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim();
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'worker-router-smoke', worker, 'main'], { cwd: workspace });
  return { root, source, worker, remote, baseSha };
}

function canonicalGitPath(cwd: string, args: readonly string[]): string {
  const raw = execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim();
  return realpathSync(path.resolve(cwd, raw));
}

describe('worker-router smoke', () => {
  it('runs only when explicitly enabled', async (t) => {
    if (process.env.TACHIKO_WORKER_ROUTER_SMOKE !== '1') { t.skip('set TACHIKO_WORKER_ROUTER_SMOKE=1 to use the real local router'); return; }
    const before = execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' });
    const workspace = disposableGitWorkspace();
    let failure: unknown;
    try {
      const sourceBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace.source, encoding: 'utf8' }).trim();
      const sourceCommon = canonicalGitPath(workspace.source, ['rev-parse', '--git-common-dir']);
      const workerCommon = canonicalGitPath(workspace.worker, ['rev-parse', '--git-common-dir']);
      const workerGitDir = canonicalGitPath(workspace.worker, ['rev-parse', '--git-dir']);
      if (
        sourceCommon !== workerCommon ||
        workerGitDir === workerCommon ||
        !workerGitDir.startsWith(`${workerCommon}${path.sep}worktrees${path.sep}`)
      ) {
        throw new Error('worker workspace is not a linked worktree');
      }
      const result = await new WorkerRouterAdapter().run({
        target: SMOKE_TARGET,
        baseSha: workspace.baseSha,
        workspacePath: workspace.worker,
        branch: 'worker-router-smoke',
        authority: 'embedded',
        instructions: [
          'This is an isolated local smoke fixture with no live GitHub authority.',
          `Create ${SMOKE_FILE} containing exactly WORKER_ROUTER_SMOKE_OK followed by one newline.`,
          'Do not modify any other tracked file.',
          'Do not install dependencies or run project tests; validate only the marker file and git status.',
          'Commit the marker file. Do not push it; Conductor owns publication.',
        ].join('\n'),
      });
      if (result.exitStatus !== 'success') throw new Error(result.diagnostics?.join('\n') ?? result.summary);
      const workerStatus = execFileSync('git', ['status', '--porcelain'], { cwd: workspace.worker, encoding: 'utf8' });
      const workerHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace.worker, encoding: 'utf8' }).trim();
      const pushedHead = execFileSync('git', ['--git-dir', workspace.remote, 'rev-parse', 'refs/heads/worker-router-smoke'], { encoding: 'utf8' }).trim();
      if (readFileSync(path.join(workspace.worker, SMOKE_FILE), 'utf8') !== SMOKE_CONTENT) throw new Error('worker smoke marker content is incorrect');
      if (workerStatus !== '') throw new Error(`worker worktree is dirty: ${workerStatus}`);
      if (workerHead === workspace.baseSha || workerHead !== pushedHead || workerHead !== result.headSha) throw new Error('worker did not create a clean commit and Conductor did not publish the exact advanced HEAD');
      if (execFileSync('git', ['status', '--porcelain'], { cwd: workspace.source, encoding: 'utf8' }) !== '') throw new Error('source worktree is dirty');
      if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace.source, encoding: 'utf8' }).trim() !== sourceBefore) throw new Error('source worktree HEAD changed');
    } catch (error) {
      failure = error;
    } finally {
      rmSync(workspace.root, { recursive: true, force: true });
    }
    const after = execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' });
    if (after !== before) throw new Error('worker-router smoke mutated the current repository');
    if (failure !== undefined) throw failure;
  });
});
