import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';

import { StandaloneGitBootstrap } from '../src/workspace/standalone-git-bootstrap.js';
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
    assert.equal(fixture.git(fixture.source, ['rev-parse', `refs/heads/${identity.branch}`]).trim(), head);
  });
});
