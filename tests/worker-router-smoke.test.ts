import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { WorkerRouterAdapter } from '../src/agents/worker-router.js';
import { GitWorktreeBootstrap } from '../src/workspace/git-worktree-bootstrap.js';
import { createBootstrapGitFixture } from './bootstrap-fixture.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const FIXTURE_DIR = path.join(import.meta.dirname, 'fixtures', 'worker-router-container');
const IMAGE_TAG = 'tachiko/worker-router-container-smoke:issue-74';
const ENTRYPOINT = '/usr/local/bin/worker-router-container';
const MARKER = 'CONTAINER_WORKER_MARKER.txt';
const MARKER_CONTENT = 'CONTAINER_WORKER_OK\n';
const TASK_MARKER = 'TACHIKO_ISSUE74_TASK_MARKER';
const OWNER = 'acme';
const REPO = 'widgets';
const ISSUE = 74;
const SHA = /^[0-9a-f]{40}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;

function out(file: string, args: readonly string[], cwd?: string): string {
  return execFileSync(file, args, { encoding: 'utf8', ...(cwd === undefined ? {} : { cwd }) }).trim();
}

function status(file: string, args: readonly string[], cwd?: string): number {
  return spawnSync(file, args, { cwd, stdio: 'ignore' }).status ?? -1;
}

function dockerAvailable(): boolean {
  return status('docker', ['version', '--format', '{{.Server.Version}}']) === 0;
}

/**
 * Builds the disposable worker image and returns its immutable digest. The
 * adapter accepts digest references only, so the tag is used solely as the
 * build handle.
 *
 * The build runs with a private Docker client config directory (plus the
 * current daemon endpoint) so the Buildx plugin has a writable config/activity
 * path even when the test runs inside a restricted file sandbox.
 */
function buildSmokeImage(): string {
  if (status('docker', ['image', 'inspect', '--format', '{{.Id}}', 'alpine:3.21']) !== 0) {
    const pull = spawnSync('docker', ['pull', 'alpine:3.21'], { stdio: 'inherit' });
    if (pull.status !== 0) throw new Error('could not obtain the alpine:3.21 base image');
  }
  const daemon = out('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']);
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'worker-router-docker-config-'));
  try {
    const plugins = path.join(os.homedir(), '.docker', 'cli-plugins');
    if (existsSync(plugins)) symlinkSync(plugins, path.join(configDir, 'cli-plugins'));
    const build = spawnSync('docker', ['build', '--pull=false', '-t', IMAGE_TAG, FIXTURE_DIR], {
      stdio: 'inherit',
      env: { ...process.env, DOCKER_CONFIG: configDir, DOCKER_HOST: daemon },
    });
    if (build.status !== 0) throw new Error('could not build the disposable worker container image');
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
  const digest = out('docker', ['image', 'inspect', '--format', '{{.Id}}', IMAGE_TAG]);
  if (!IMAGE_DIGEST.test(digest)) throw new Error(`unexpected built image digest: ${digest}`);
  return digest;
}

describe('worker-router container smoke', () => {
  it('runs only when explicitly enabled', async (t) => {
    if (process.env.TACHIKO_WORKER_ROUTER_SMOKE !== '1') { t.skip('set TACHIKO_WORKER_ROUTER_SMOKE=1 to run the containerized worker-router acceptance path'); return; }
    if (!dockerAvailable()) { t.skip('docker is not available'); return; }

    const repoBefore = execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' });
    const image = buildSmokeImage();
    const fixture = createBootstrapGitFixture();
    let failure: unknown;
    try {
      const bootstrap = new GitWorktreeBootstrap({
        repositoryRoot: fixture.source,
        workspaceRoot: fixture.workspaceRoot,
        runner: fixture.runner,
      });
      const request = {
        runId: 'issue74container',
        target: { kind: 'issue', owner: OWNER, repo: REPO, issueNumber: ISSUE },
        baseBranch: fixture.branch,
        baseSha: fixture.baseSha,
      } as const;
      const identity = await bootstrap.plan(request);
      // Pack the source refs first so the prepared branch is created loose
      // afterwards. This proves the commit-only mount set needs no
      // `packed-refs` mount: the container commits on a loose ref while the
      // host repository still has a real packed-refs file.
      out('git', ['pack-refs', '--all'], fixture.source);
      if (!existsSync(path.join(fixture.source, '.git', 'packed-refs'))) {
        throw new Error('smoke fixture failed to create a packed-refs file for the mount-necessity proof');
      }
      await bootstrap.prepare({ ...request, existing: identity });
      const guard = bootstrap.guard(identity);
      await guard.assertValid('before-execution');

      // Real end-to-end acceptance: guard(before) -> container-owned worker
      // (commit only) -> exact container terminal -> guard(after) -> exact HEAD
      // -> ancestry -> Tachiko publication -> verifyDurable.
      const result = await new WorkerRouterAdapter({
        image,
        executable: ENTRYPOINT,
        network: 'none',
        containerEnv: [],
        timeoutMs: 120_000,
      }).run({
        target: request.target,
        baseSha: request.baseSha,
        workspacePath: identity.workspacePath,
        branch: identity.branch,
        authority: 'embedded',
        instructions: [
          'This is an isolated local container acceptance fixture with no live GitHub authority.',
          `Delivery token: ${TASK_MARKER}`,
          `Create ${MARKER} containing exactly CONTAINER_WORKER_OK followed by one newline.`,
          'Commit the marker file. Do not push it; Conductor owns publication.',
        ].join('\n'),
        workspaceGuard: guard,
      });
      if (result.exitStatus !== 'success') throw new Error(result.diagnostics?.join('\n') ?? result.summary);
      const head = result.headSha ?? '';
      if (!SHA.test(head)) throw new Error('the container worker did not produce an exact 40-hex HEAD');
      if ((result.diagnostics?.join('\n') ?? '').includes('[worker-router] -> deepseek-worker') === false) {
        throw new Error('the bounded container provenance marker was not preserved');
      }
      if (readFileSync(path.join(identity.workspacePath, MARKER), 'utf8') !== MARKER_CONTENT) throw new Error('container worker marker content is incorrect');
      if (out('git', ['status', '--porcelain', '--untracked-files=all'], identity.workspacePath) !== '') throw new Error('the container worker left a dirty worktree');

      // The worker/container never pushed: the containment probe branch must not exist.
      if (status('git', ['--git-dir', fixture.remote, 'rev-parse', '--verify', '--quiet', 'refs/heads/containment-probe']) === 0) {
        throw new Error('the container worker published a ref; the container boundary did not contain publication');
      }
      // Tachiko published the exact committed HEAD from the host.
      const published = out('git', ['--git-dir', fixture.remote, 'rev-parse', `refs/heads/${identity.branch}`]);
      if (published !== head) throw new Error('Conductor did not publish the exact container HEAD');

      const durable = await bootstrap.verifyDurable({
        identity,
        expectedHeadSha: head,
        progressBaseSha: request.baseSha,
        workspaceGuard: guard,
      });
      if (durable.headSha !== head || durable.branch !== identity.branch) throw new Error('verifyDurable returned a different identity');
    } catch (error) {
      failure = error;
    } finally {
      fixture.cleanup();
    }

    const repoAfter = execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' });
    spawnSync('docker', ['image', 'rm', '--force', IMAGE_TAG], { stdio: 'ignore' });
    if (repoAfter !== repoBefore) throw new Error('the containerized worker-router smoke mutated the current repository');
    if (failure !== undefined) throw failure;
  });
});
