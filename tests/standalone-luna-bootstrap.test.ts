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
  it('accepts canonical HTTPS and SCP GitHub remote identity casing at the real bootstrap boundary', async () => {
    for (const githubUrl of ['https://github.com/AcMe/WiDgEtS.git', 'git@github.com:ACME/WIDGETS.git']) {
      const fixture = createBootstrapGitFixture({ githubUrl }); fixtures.push(fixture);
      const bootstrap = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
      const request = { runId: `luna-case-${githubUrl.startsWith('https') ? 'https' : 'scp'}`, target: { kind: 'issue' as const, owner: 'acme', repo: 'widgets', issueNumber: 99 }, baseBranch: fixture.branch, baseSha: fixture.baseSha };
      const identity = await bootstrap.plan(request);
      await assert.doesNotReject(() => bootstrap.prepare({ ...request, existing: identity }));
    }
  });

  it('fetches and proves the live base when the trusted host checkout is stale', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    const publisher = path.join(fixture.root, 'publisher');
    fixture.git(fixture.root, ['clone', fixture.remote, publisher]);
    fixture.git(publisher, ['checkout', fixture.branch]);
    const liveBase = fixture.commit(publisher, 'live-base.txt', 'published after host checkout\n');
    fixture.git(publisher, ['push', 'origin', fixture.branch]);
    const bootstrap = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
    const request = { runId: 'luna-stale-source', target: { kind: 'issue' as const, owner: 'acme', repo: 'widgets', issueNumber: 99 }, baseBranch: fixture.branch, baseSha: liveBase };
    await assert.doesNotReject(() => bootstrap.plan(request));
    assert.equal(fixture.git(fixture.source, ['rev-parse', liveBase]), liveBase);
  });

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

  it('retains a distinct existing PR publication branch through implementation, validation, and repair preparation', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    const adoptedHead = fixture.commit(fixture.source, 'pr.txt', 'authoritative PR change\n');
    fixture.git(fixture.source, ['push', 'origin', `HEAD:refs/heads/tachiko/existing-pr`]);
    const bootstrap = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
    const request = { runId: 'luna-99-reprepare', target: { kind: 'issue' as const, owner: 'acme', repo: 'widgets', issueNumber: 99 }, baseBranch: fixture.branch, baseSha: fixture.baseSha, publicationBranch: 'tachiko/existing-pr' };
    const identity = await bootstrap.plan(request);

    // Initial existing-PR adoption (implementation), then the exact-head
    // validation reconstruction must retain the host publication target.
    await bootstrap.prepare({ ...request, existing: identity, recoveryAuthority: { expectedHeadSha: adoptedHead } });
    const validationIdentity = await bootstrap.prepare({ ...request, existing: identity, recoveryAuthority: { expectedHeadSha: adoptedHead } });
    assert.equal(validationIdentity.publicationBranch, 'tachiko/existing-pr');
    assert.notEqual(validationIdentity.branch, validationIdentity.publicationBranch);

    // A review repair reconstructs from H and publication still targets the
    // existing PR branch rather than this standalone workspace branch.
    const repaired = fixture.commit(identity.workspacePath, 'repair.txt', 'repair\n');
    const repairIdentity = await bootstrap.prepare({ ...request, existing: validationIdentity, recoveryAuthority: { expectedHeadSha: repaired } });
    assert.equal(repairIdentity.publicationBranch, 'tachiko/existing-pr');
    await bootstrap.verifyDurable({ identity: repairIdentity, expectedHeadSha: repaired, progressBaseSha: adoptedHead });
    assert.equal(fixture.git(fixture.remote, ['rev-parse', 'refs/heads/tachiko/existing-pr']).trim(), repaired);
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

  it('rejects nested Git metadata and hidden index flags before host verification can inspect them', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    const bootstrap = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
    const request = { runId: 'luna-hidden-index', target: { kind: 'issue' as const, owner: 'acme', repo: 'widgets', issueNumber: 99 }, baseBranch: fixture.branch, baseSha: fixture.baseSha };
    const identity = await bootstrap.plan(request); await bootstrap.prepare({ ...request, existing: identity });
    fixture.git(identity.workspacePath, ['update-index', '--assume-unchanged', 'README.md']);
    await assert.rejects(async () => await bootstrap.guard(identity).assertValid(), /hidden-worktree flags/);
    fixture.git(identity.workspacePath, ['update-index', '--no-assume-unchanged', 'README.md']);
    const nestedGit = path.join(identity.workspacePath, 'nested', '.git');
    const marker = path.join(fixture.root, 'nested-filter-ran');
    const command = path.join(fixture.root, 'nested-filter.sh');
    writeFileSync(command, `#!/bin/sh\ntouch '${marker}'\n`); chmodSync(command, 0o755);
    mkdirSync(path.join(nestedGit, 'info'), { recursive: true });
    writeFileSync(path.join(nestedGit, 'config'), `[filter "marker"]\n\tclean = ${command}\n`);
    writeFileSync(path.join(nestedGit, 'info', 'attributes'), '*.txt filter=marker\n');
    await assert.rejects(async () => await bootstrap.guard(identity).assertValid(), /nested Git repositories/);
    assert.equal(existsSync(marker), false, 'nested worker Git config/attributes payload must never execute');
  });

  it('disables replacement refs for every host-side standalone inspection', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    const bootstrap = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
    const request = { runId: 'luna-replace-ref', target: { kind: 'issue' as const, owner: 'acme', repo: 'widgets', issueNumber: 99 }, baseBranch: fixture.branch, baseSha: fixture.baseSha };
    const replacement = fixture.commit(fixture.source, 'replacement.txt', 'replacement\n');
    fixture.git(fixture.source, ['replace', fixture.baseSha, replacement]);
    const identity = await bootstrap.plan(request);
    await assert.doesNotReject(() => bootstrap.prepare({ ...request, existing: identity }));
    assert.equal(fixture.commands.some(({ args }) => args.includes('core.useReplaceRefs=false')), true);
  });

  it('rejects legacy graft ancestry before host Git can inspect the worker checkout', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    const bootstrap = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
    const request = { runId: 'luna-legacy-graft', target: { kind: 'issue' as const, owner: 'acme', repo: 'widgets', issueNumber: 99 }, baseBranch: fixture.branch, baseSha: fixture.baseSha };
    const identity = await bootstrap.plan(request); await bootstrap.prepare({ ...request, existing: identity });
    mkdirSync(path.join(identity.workspacePath, '.git', 'info'), { recursive: true });
    writeFileSync(path.join(identity.workspacePath, '.git', 'info', 'grafts'), `${fixture.baseSha}\n`);
    await assert.rejects(async () => await bootstrap.guard(identity).assertValid(), /legacy graft ancestry/);
  });

  it('rejects executable worktree config before its fsmonitor payload can run', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    const bootstrap = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
    const request = { runId: 'luna-worktree-config', target: { kind: 'issue' as const, owner: 'acme', repo: 'widgets', issueNumber: 99 }, baseBranch: fixture.branch, baseSha: fixture.baseSha };
    const identity = await bootstrap.plan(request); await bootstrap.prepare({ ...request, existing: identity });
    const marker = path.join(fixture.root, 'worktree-config-ran');
    const command = path.join(fixture.root, 'worktree-fsmonitor.sh');
    writeFileSync(command, `#!/bin/sh\ntouch '${marker}'\n`); chmodSync(command, 0o755);
    writeFileSync(path.join(identity.workspacePath, '.git', 'config.worktree'), `[core]\nfsmonitor = ${command}\n`);
    await assert.rejects(async () => await bootstrap.guard(identity).assertValid(), /config requests executable/);
    assert.equal(existsSync(marker), false);
  });

  it('rejects a worker-controlled core.worktree override before host Git inspects another tree', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    const bootstrap = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
    const request = { runId: 'luna-core-worktree', target: { kind: 'issue' as const, owner: 'acme', repo: 'widgets', issueNumber: 99 }, baseBranch: fixture.branch, baseSha: fixture.baseSha };
    const identity = await bootstrap.plan(request); await bootstrap.prepare({ ...request, existing: identity });
    fixture.git(identity.workspacePath, ['config', 'core.worktree', '../other-tree']);
    await assert.rejects(async () => { await bootstrap.guard(identity).assertValid(); }, /Git config requests executable behavior/);
  });

  it('rejects stat-cache settings that can hide tracked worker byte changes', async () => {
    for (const [key, value] of [['core.trustctime', 'false'], ['core.checkStat', 'minimal'], ['core.filemode', 'false'], ['core.symlinks', 'false']] as const) {
      const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
      const bootstrap = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
      const request = { runId: `luna-${key}`, target: { kind: 'issue' as const, owner: 'acme', repo: 'widgets', issueNumber: 99 }, baseBranch: fixture.branch, baseSha: fixture.baseSha };
      const identity = await bootstrap.plan(request); await bootstrap.prepare({ ...request, existing: identity });
      fixture.git(identity.workspacePath, ['config', key, value]);
      await assert.rejects(async () => await bootstrap.guard(identity).assertValid(), /Git config requests executable behavior/, key);
    }
  });
});
