import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { StandaloneGitBootstrap } from '../src/workspace/standalone-git-bootstrap.js';
import type { ProcessRunner } from '../src/github/transport.js';
import { createBootstrapGitFixture, type BootstrapGitFixture } from './bootstrap-fixture.js';

const fixtures: BootstrapGitFixture[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.cleanup(); });

describe('standalone Luna bootstrap', () => {
  it('gives the worker a remote-free standalone checkout and host-publishes only its exact clean descendant', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    const bootstrap = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
    const request = { runId: 'luna-99', target: { kind: 'issue' as const, owner: 'acme', repo: 'widgets', issueNumber: 99 }, baseBranch: fixture.branch, baseSha: fixture.baseSha };
    const identity = await bootstrap.plan(request);
    await bootstrap.prepare({ ...request, existing: identity });
    assert.equal(fixture.git(identity.workspacePath, ['remote']).trim(), '');
    assert.equal(existsSync(`${identity.workspacePath}/.git`), true);
    writeFileSync(`${identity.workspacePath}/luna.txt`, 'host publishes this\n');
    fixture.git(identity.workspacePath, ['add', 'luna.txt']);
    fixture.git(identity.workspacePath, ['-c', 'user.name=Luna', '-c', 'user.email=luna@example.invalid', 'commit', '-m', 'luna commit']);
    const head = fixture.git(identity.workspacePath, ['rev-parse', 'HEAD']).trim();
    const durable = await bootstrap.verifyDurable({ identity, expectedHeadSha: head, progressBaseSha: fixture.baseSha });
    assert.equal(durable.headSha, head);
    assert.equal(fixture.git(fixture.remote, ['rev-parse', `refs/heads/${identity.branch}`]).trim(), head);
  });

  it('rejects an initial no-progress result before host publication', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    const bootstrap = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
    const request = { runId: 'luna-99-empty', target: { kind: 'issue' as const, owner: 'acme', repo: 'widgets', issueNumber: 99 }, baseBranch: fixture.branch, baseSha: fixture.baseSha };
    const identity = await bootstrap.plan(request); await bootstrap.prepare({ ...request, existing: identity });
    await assert.rejects(() => bootstrap.verifyDurable({ identity, expectedHeadSha: fixture.baseSha }), /did not advance/);
  });

  it('rejects every effective origin push URL before host publication', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    const calls: string[][] = [];
    let extraPushUrl = false;
    const runner: ProcessRunner = { run: async (file, args, options) => {
      calls.push([...args] as string[]);
      const command = args.join(' ');
      if (file === 'git' && command.includes('remote get-url --all --push origin')) {
        return { stdout: extraPushUrl
          ? 'git@github.com:acme/widgets.git\nhttps://github.com/evil/widgets.git\n'
          : 'git@github.com:acme/widgets.git\n', stderr: '', exitCode: 0 };
      }
      return fixture.runner.run(file, args, options);
    } };
    const bootstrap = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner });
    const request = { runId: 'luna-99-extra-push', target: { kind: 'issue' as const, owner: 'acme', repo: 'widgets', issueNumber: 99 }, baseBranch: fixture.branch, baseSha: fixture.baseSha };
    const identity = await bootstrap.plan(request);
    await bootstrap.prepare({ ...request, existing: identity });
    writeFileSync(`${identity.workspacePath}/luna.txt`, 'candidate\n');
    fixture.git(identity.workspacePath, ['add', 'luna.txt']);
    fixture.git(identity.workspacePath, ['-c', 'user.name=Luna', '-c', 'user.email=luna@example.invalid', 'commit', '-m', 'candidate']);
    const head = fixture.git(identity.workspacePath, ['rev-parse', 'HEAD']).trim();
    extraPushUrl = true;
    await assert.rejects(() => bootstrap.verifyDurable({ identity, expectedHeadSha: head }), /publication remote/);
    assert.equal(calls.some((args) => args.includes('push')), false);
    assert.equal(fixture.git(fixture.remote, ['for-each-ref', 'refs/heads/tachiko/luna-99-extra-push']).trim(), '');
  });

  it('adopts only the authoritative PR head with distinct base tree progress', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    const adoptedHead = fixture.commit(fixture.source, 'pr.txt', 'authoritative PR change\n');
    fixture.git(fixture.source, ['push', 'origin', `HEAD:refs/heads/tachiko/existing-pr`]);
    const bootstrap = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
    const request = { runId: 'luna-99-adopt', target: { kind: 'issue' as const, owner: 'acme', repo: 'widgets', issueNumber: 99 }, baseBranch: fixture.branch, baseSha: fixture.baseSha, publicationBranch: 'tachiko/existing-pr' };
    const identity = await bootstrap.plan(request);
    await bootstrap.prepare({ ...request, existing: identity, recoveryAuthority: { expectedHeadSha: adoptedHead } });
    assert.equal(fixture.git(identity.workspacePath, ['rev-parse', 'HEAD']).trim(), adoptedHead);
    await assert.doesNotReject(() => bootstrap.verifyDurable({ identity, expectedHeadSha: adoptedHead, progressBaseSha: fixture.baseSha, adoptExistingHead: true }));
    assert.notEqual(identity.branch, identity.publicationBranch);
    fixture.commit(identity.workspacePath, 'repair.txt', 'repair\n');
    const repaired = fixture.git(identity.workspacePath, ['rev-parse', 'HEAD']).trim();
    await bootstrap.verifyDurable({ identity, expectedHeadSha: repaired, progressBaseSha: adoptedHead });
    assert.equal(fixture.git(fixture.remote, ['rev-parse', 'refs/heads/tachiko/existing-pr']).trim(), repaired);
    fixture.git(identity.workspacePath, ['reset', '--hard', fixture.baseSha]);
    await assert.rejects(
      () => bootstrap.verifyDurable({ identity, expectedHeadSha: adoptedHead, progressBaseSha: fixture.baseSha, adoptExistingHead: true }),
      /differs from the reported exact HEAD/,
    );
  });

  it('rejects canonical filters and every attributes location before marker commands can execute', async () => {
    for (const location of ['config', '.gitattributes', 'nested/.gitattributes', '.git/info/attributes'] as const) {
      const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
      const bootstrap = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
      const request = { runId: `luna-99-surface-${location.replaceAll(/[^a-z]/g, '-')}`, target: { kind: 'issue' as const, owner: 'acme', repo: 'widgets', issueNumber: 99 }, baseBranch: fixture.branch, baseSha: fixture.baseSha };
      const identity = await bootstrap.plan(request); await bootstrap.prepare({ ...request, existing: identity });
      const marker = `${fixture.root}/marker-${location.replaceAll(/[^a-z]/g, '-')}`;
      const command = `${fixture.root}/marker-command-${location.replaceAll(/[^a-z]/g, '-')}.sh`;
      writeFileSync(command, `#!/bin/sh\ntouch '${marker}'\n`); chmodSync(command, 0o755);
      fixture.git(identity.workspacePath, ['config', 'filter.marker.clean', command]);
      if (location !== 'config') {
        const file = `${identity.workspacePath}/${location}`;
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, '*.txt filter=marker\n');
      }
      await assert.rejects(async () => { await bootstrap.guard(identity).assertValid(); }, /Git (config|attributes) request/);
      assert.equal(existsSync(marker), false, location);
    }
  });

  it('skips an ordinary repository symlink but rejects a symlinked attribute authority', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    const bootstrap = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
    const request = { runId: 'luna-symlink-authority', target: { kind: 'issue' as const, owner: 'acme', repo: 'widgets', issueNumber: 99 }, baseBranch: fixture.branch, baseSha: fixture.baseSha };
    const identity = await bootstrap.plan(request); await bootstrap.prepare({ ...request, existing: identity });
    symlinkSync('README.md', `${identity.workspacePath}/ordinary-link`);
    fixture.git(identity.workspacePath, ['add', 'ordinary-link']);
    fixture.git(identity.workspacePath, ['-c', 'user.name=Luna', '-c', 'user.email=luna@example.invalid', 'commit', '-m', 'ordinary symlink']);
    await assert.doesNotReject(async () => await bootstrap.guard(identity).assertValid('after-execution'));
    symlinkSync('README.md', `${identity.workspacePath}/.gitattributes`);
    await assert.rejects(async () => await bootstrap.guard(identity).assertValid('after-execution'), /attribute authority/);
  });
});
