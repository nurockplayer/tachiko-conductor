import assert from 'node:assert/strict';
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { hasPreparedStandaloneLunaInvocation, StandaloneGitBootstrap } from '../src/workspace/standalone-git-bootstrap.js';
import { ExecutionAdmissionRefusal } from '../src/adapters/agent.js';
import { IMPLEMENTATION_BOOTSTRAP_ERROR_CODE, ImplementationBootstrapError } from '../src/adapters/bootstrap.js';
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

  it('revalidates the configured publication remote before the first immutable-base prepare fetch', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    let changedAfterPlan = false;
    const delegated: { args: readonly string[]; cwd?: string }[] = [];
    const runner: ProcessRunner = { run: async (file, args, options) => {
      const command = args.filter((value, index) => !(value === '-c' && args[index + 1] !== undefined) &&
        !['core.hooksPath=/dev/null', 'core.fsmonitor=false', 'core.attributesFile=/dev/null', 'core.useReplaceRefs=false', 'core.commitGraph=false'].includes(value)).join(' ');
      if (file === 'git' && command.includes('remote get-url --all')) {
        const url = changedAfterPlan ? 'git@github.com:other/project.git' : 'git@github.com:acme/widgets.git';
        return { stdout: `${url}\n`, stderr: '', exitCode: 0 };
      }
      delegated.push({ args: [...args], cwd: options.cwd });
      return fixture.runner.run(file, args, options);
    } };
    const bootstrap = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner });
    const request = { runId: 'luna-remote-changed-after-plan', target: { kind: 'issue' as const, owner: 'acme', repo: 'widgets', issueNumber: 99 }, baseBranch: fixture.branch, baseSha: fixture.baseSha };
    const identity = await bootstrap.plan(request);
    changedAfterPlan = true;

    await assert.rejects(() => bootstrap.prepare({ ...request, existing: identity }), /publication remote does not exactly match/i);
    const delegatedGit = delegated.filter(({ args }) => args.length > 0);
    const delegatedFetches = delegatedGit.filter(({ args }) => args.includes('fetch'));
    const delegatedInitializations = delegatedGit.filter(({ args }) => args.includes('init'));
    assert.deepEqual(delegatedFetches, [], 'the changed remote is rejected before either immutable-base or workspace import fetch');
    assert.deepEqual(delegatedInitializations, [], 'the changed remote is rejected before workspace initialization');
    assert.equal(existsSync(identity.workspacePath), false);
  });

  it('refuses immutable-base import when the configured remote no longer serves a locally cached planned commit', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    let preparing = false;
    let exactBaseFetches = 0;
    let beforeMutationCalls = 0;
    let failedFetchExit: number | undefined;
    let immutableFetchArgs: string[] | undefined;
    const runner: ProcessRunner = {
      async run(file, args, options) {
        const immutableFetch = preparing && file === 'git' && args.includes('fetch') && args.includes('origin') && args.at(-1) === fixture.baseSha;
        if (immutableFetch) {
          exactBaseFetches += 1;
          immutableFetchArgs = [...args];
          const original = options.beforeSpawn;
          const result = await fixture.runner.run(file, args, { ...options, beforeSpawn: () => {
            beforeMutationCalls += 1;
            original?.();
          } });
          failedFetchExit = result.exitCode;
          return result;
        }
        return fixture.runner.run(file, args, options);
      },
    };
    const bootstrap = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner });
    const request = { runId: 'luna-base-remote-unavailable', target: { kind: 'issue' as const, owner: 'acme', repo: 'widgets', issueNumber: 99 }, baseBranch: fixture.branch, baseSha: fixture.baseSha };
    const identity = await bootstrap.plan(request);
    assert.equal(fixture.git(fixture.source, ['cat-file', '-e', `${fixture.baseSha}^{commit}`]), '', 'the trusted source checkout still caches the planned commit');
    fixture.git(fixture.remote, ['update-ref', '-d', `refs/heads/${fixture.branch}`]);
    fixture.git(fixture.remote, ['reflog', 'expire', '--expire=now', '--all']);
    fixture.git(fixture.remote, ['gc', '--prune=now']);
    assert.throws(() => fixture.git(fixture.remote, ['cat-file', '-e', `${fixture.baseSha}^{commit}`]),
      (error: unknown) => error instanceof Error,
      'the isolated bare remote no longer has the planned commit object');
    assert.equal(fixture.git(fixture.source, ['cat-file', '-e', `${fixture.baseSha}^{commit}`]), '',
      'the trusted source still has its local copy before prepare');
    preparing = true;

    await assert.rejects(() => bootstrap.prepare({ ...request, existing: identity }), (error: unknown) =>
      error instanceof ImplementationBootstrapError && error.code === IMPLEMENTATION_BOOTSTRAP_ERROR_CODE.COMMAND_FAILED);

    assert.equal(exactBaseFetches, 1, 'prepare attempted exactly the authorized immutable-base import');
    assert.ok(immutableFetchArgs?.includes('--refetch'), 'the immutable-base import bypasses cached-object negotiation');
    assert.equal(beforeMutationCalls, 1, 'the actual failed fetch crossed its synchronous admission callback');
    assert.notEqual(failedFetchExit, 0, 'the configured remote rejected the unavailable object despite the local cache');
    assert.equal(existsSync(identity.workspacePath), false, 'the worker checkout was not initialized after fetch failure');
    const prepareCommands = fixture.commands.slice(fixture.commands.findIndex(({ args }) => args.includes('fetch')));
    assert.equal(prepareCommands.some(({ args }) => args.includes('init') || args.includes('checkout') || args.includes('switch') || args.includes('update-ref')), false,
      'no fallback or workspace/ref mutation follows the failed immutable-base import');
  });

  it('rejects a wrong FETCH_HEAD after actual immutable-base import before checkout mutations', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    let preparing = false;
    let exactBaseFetches = 0;
    let beforeMutationCalls = 0;
    let wrongFetchHead: string | undefined;
    const runner: ProcessRunner = {
      async run(file, args, options) {
        const immutableFetch = preparing && file === 'git' && args.includes('fetch') && args.includes('origin') && args.at(-1) === fixture.baseSha;
        if (immutableFetch) {
          exactBaseFetches += 1;
          const original = options.beforeSpawn;
          const result = await fixture.runner.run(file, args, { ...options, beforeSpawn: () => {
            beforeMutationCalls += 1;
            original?.();
          } });
          if (result.exitCode === 0) {
            wrongFetchHead = fixture.commit(fixture.source, 'wrong-luna-fetch-head.txt', 'different cached commit\n');
            writeFileSync(path.join(fixture.source, '.git', 'FETCH_HEAD'), `${wrongFetchHead}\t\tfixture wrong fetch head\n`);
          }
          return result;
        }
        return fixture.runner.run(file, args, options);
      },
    };
    const bootstrap = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner });
    const request = { runId: 'luna-base-wrong-fetch-head', target: { kind: 'issue' as const, owner: 'acme', repo: 'widgets', issueNumber: 99 }, baseBranch: fixture.branch, baseSha: fixture.baseSha };
    const identity = await bootstrap.plan(request);
    preparing = true;

    await assert.rejects(() => bootstrap.prepare({ ...request, existing: identity }), (error: unknown) =>
      error instanceof ImplementationBootstrapError && error.code === IMPLEMENTATION_BOOTSTRAP_ERROR_CODE.BASE_DRIFT);

    assert.notEqual(wrongFetchHead, undefined);
    assert.notEqual(wrongFetchHead, fixture.baseSha);
    assert.equal(fixture.git(fixture.source, ['rev-parse', 'FETCH_HEAD']), wrongFetchHead, 'the negative case observes the wrong fetched identity');
    assert.equal(exactBaseFetches, 1);
    assert.equal(beforeMutationCalls, 1, 'the real fetch crossed its synchronous admission callback');
    assert.equal(existsSync(identity.workspacePath), false, 'workspace initialization is refused after FETCH_HEAD mismatch');
    const prepareCommands = fixture.commands.slice(fixture.commands.findIndex(({ args }) => args.includes('fetch')));
    assert.equal(prepareCommands.some(({ args }) => args.includes('init') || args.includes('checkout') || args.includes('switch') || args.includes('update-ref')), false,
      'the wrong FETCH_HEAD is rejected before subsequent workspace/ref effects');
  });

  it('rejects a persisted run ID that cannot form a safe standalone branch', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    const bootstrap = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
    await assert.rejects(
      () => bootstrap.plan({ runId: 'foo..bar', target: { kind: 'issue', owner: 'acme', repo: 'widgets', issueNumber: 99 }, baseBranch: fixture.branch, baseSha: fixture.baseSha }),
      /invalid Git branch name/,
    );
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
    fixture.git(fixture.source, ['config', 'core.commitGraph', 'true']);
    fixture.git(fixture.source, ['commit-graph', 'write', '--reachable']);
    assert.equal(existsSync(path.join(fixture.source, '.git', 'objects', 'info', 'commit-graph')), true);
    const order: string[] = [];
    const hostGitArgs: string[][] = [];
    const trustedSourceAncestryArgs: string[][] = [];
    let tracePublication = false;
    let workspacePath: string | undefined;
    const runner: ProcessRunner = { run: async (file, args, options) => {
      if (file === 'git') hostGitArgs.push([...args]);
      if (args.includes('push')) {
        // Model an injected runner's async setup, then execute the host check
        // immediately before delegating to the real child process.
        await Promise.resolve();
        options.beforeSpawn?.();
        order.push('push-spawn');
        return fixture.runner.run(file, args, { ...options, beforeSpawn: undefined });
      }
      const result = await fixture.runner.run(file, args, options);
      if (tracePublication && file === 'git' && options.cwd === realpathSync(fixture.source) && args.includes('fetch') && workspacePath !== undefined && args.includes(workspacePath)) {
        order.push('trusted-import-complete');
      }
      if (tracePublication && file === 'git' && options.cwd === realpathSync(fixture.source) && args.includes('merge-base') && args.includes('--is-ancestor')) {
        trustedSourceAncestryArgs.push([...args]);
        order.push('trusted-source-ancestry');
      }
      return result;
    } };
    const bootstrap = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner });
    const request = { runId: 'luna-99', target: { kind: 'issue' as const, owner: 'acme', repo: 'widgets', issueNumber: 99 }, baseBranch: fixture.branch, baseSha: fixture.baseSha };
    const identity = await bootstrap.plan(request);
    await bootstrap.prepare({ ...request, existing: identity });
    workspacePath = identity.workspacePath;
    assert.equal(fixture.git(identity.workspacePath, ['remote']).trim(), '');
    assert.equal(existsSync(`${identity.workspacePath}/.git`), true);
    writeFileSync(`${identity.workspacePath}/luna.txt`, 'host publishes this\n');
    fixture.git(identity.workspacePath, ['add', 'luna.txt']);
    fixture.git(identity.workspacePath, ['-c', 'user.name=Luna', '-c', 'user.email=luna@example.invalid', 'commit', '-m', 'luna commit']);
    const head = fixture.git(identity.workspacePath, ['rev-parse', 'HEAD']).trim();
    tracePublication = true;
    const durable = await bootstrap.verifyDurable({ identity, expectedHeadSha: head, workspaceGuard: bootstrap.guard(identity), beforeMutation: () => {}, beforePublish: () => { order.push('fence'); } });
    const importIndex = order.indexOf('trusted-import-complete');
    const ancestryIndex = order.indexOf('trusted-source-ancestry');
    const fenceIndex = order.indexOf('fence');
    const spawnIndex = order.indexOf('push-spawn');
    assert.ok(importIndex >= 0 && importIndex < ancestryIndex && ancestryIndex < fenceIndex && fenceIndex < spawnIndex,
      `trusted import, source ancestry, durable fence and real push spawn must be ordered: ${order.join(' → ')}`);
    assert.ok(trustedSourceAncestryArgs.some((args) => args.includes(fixture.baseSha) && args.includes(head)),
      'the trusted-source ancestry proof must use the exact captured base and worker HEAD');
    assert.equal(durable.headSha, head);
    assert.equal(fixture.git(fixture.remote, ['rev-parse', `refs/heads/${identity.branch}`]).trim(), head);
    assert.ok(hostGitArgs.every((args) => args.some((arg, index) => arg === '-c' && args[index + 1] === 'core.commitGraph=false')));
  });

  it('runs the synchronous durable publication fence immediately before push and never pushes when it fails', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    const runner: ProcessRunner = { run: async (file, args, options) => {
      if (args.includes('push')) {
        await Promise.resolve();
        options.beforeSpawn?.();
        return fixture.runner.run(file, args, { ...options, beforeSpawn: undefined });
      }
      return fixture.runner.run(file, args, options);
    } };
    const bootstrap = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner });
    const request = { runId: 'luna-pre-push-fence', target: { kind: 'issue' as const, owner: 'acme', repo: 'widgets', issueNumber: 99 }, baseBranch: fixture.branch, baseSha: fixture.baseSha };
    const identity = await bootstrap.plan(request);
    await bootstrap.prepare({ ...request, existing: identity });
    const head = fixture.commit(identity.workspacePath, 'luna.txt', 'candidate\n');
    const before = fixture.commands.length;
    const ordered: string[] = [];
    await assert.rejects(() => bootstrap.verifyDurable({
      identity, expectedHeadSha: head, progressBaseSha: fixture.baseSha, workspaceGuard: bootstrap.guard(identity),
      beforeMutation: () => {}, beforePublish: () => { ordered.push('fence'); throw new Error('stale durable Run'); },
    }), /stale durable Run/);
    const publicationCommands = fixture.commands.slice(before).filter((command) => command.args.includes('push'));
    assert.deepEqual(ordered, ['fence']);
    assert.equal(publicationCommands.length, 0);
    assert.equal(fixture.git(fixture.remote, ['for-each-ref', 'refs/heads/tachiko/luna-pre-push-fence']).trim(), '');
  });

  it('rechecks both mutation callbacks at real trusted fetch boundaries and publishes with an existing ref', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    const phases: string[] = [];
    let verifyPhase = false;
    const runner: ProcessRunner = {
      async run(file, args, options) {
        const sourceCommand = file === 'git' && options.cwd === realpathSync(fixture.source);
        const sourceFetch = sourceCommand && args.includes('fetch');
        const workerImport = sourceFetch && args.includes('--no-recurse-submodules');
        const publicationImport = sourceFetch && args.includes('origin') && !workerImport;
        const sourcePush = sourceCommand && args.includes('push');
        if (verifyPhase && (sourceFetch || sourcePush)) {
          options.beforeSpawn?.();
          phases.push(workerImport ? 'worker-import' : publicationImport ? 'publication-import' : 'push');
          return fixture.runner.run(file, args, { ...options, beforeSpawn: undefined });
        }
        return fixture.runner.run(file, args, options);
      },
    };
    const bootstrap = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner });
    const request = { runId: 'luna-two-real-fetch-fences', target: { kind: 'issue' as const, owner: 'acme', repo: 'widgets', issueNumber: 99 }, baseBranch: fixture.branch, baseSha: fixture.baseSha };
    const identity = await bootstrap.plan(request);
    await bootstrap.prepare({ ...request, existing: identity });
    const publicationRef = `refs/heads/${identity.publicationBranch ?? identity.branch}`;
    fixture.git(fixture.remote, ['update-ref', publicationRef, fixture.baseSha]);
    const head = fixture.commit(identity.workspacePath, 'two-fences.txt', 'publish both imports\n');
    verifyPhase = true;
    const mutationFenceEvents: string[] = [];
    let publishFenceCalls = 0;
    const result = await bootstrap.verifyDurable({
      identity, expectedHeadSha: head, progressBaseSha: fixture.baseSha, workspaceGuard: bootstrap.guard(identity),
      beforeMutation: () => mutationFenceEvents.push('mutation'),
      beforePublish: () => { publishFenceCalls += 1; mutationFenceEvents.push('publish'); },
    });
    assert.equal(result.headSha, head);
    assert.deepEqual(phases, ['worker-import', 'publication-import', 'push'], 'both real imports and the final publication execute through runner fences');
    assert.deepEqual(mutationFenceEvents, ['mutation', 'mutation', 'publish'], 'both fetch callbacks and the publication callback run at their respective actual boundaries');
    assert.equal(publishFenceCalls, 1);
    assert.equal(fixture.git(fixture.remote, ['rev-parse', publicationRef]).trim(), head, 'the exact candidate HEAD is published');
  });

  it('retains the first authorized worker import but fences the existing publication-ref import after authority changes', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    const id = 'luna-successive-import-fence';
    const refusal = new ExecutionAdmissionRefusal('authority changed during remote-head read', true, { cause: new Error('captured publication Run superseded') });
    let revoked = false;
    let firstImportEffects = 0;
    let secondImportEffects = 0;
    let pushEffects = 0;
    let remoteHeadRead = false;
    let verificationPhase = false;
    let publicationRef: string | undefined;
    const runner: ProcessRunner = {
      async run(file, args, options) {
        const trustedSource = file === 'git' && options.cwd === realpathSync(fixture.source);
        const sourceFetch = trustedSource && args.includes('fetch');
        const workerImport = sourceFetch && args.includes('--no-recurse-submodules');
        const remoteRefImport = verificationPhase && trustedSource && args.includes('fetch') && args.includes('origin') && !workerImport && args.at(-1) === publicationRef;
        const push = verificationPhase && trustedSource && args.includes('push');
        const remoteHead = verificationPhase && trustedSource && args.includes('ls-remote') && args[args.length - 1] === publicationRef;
        if (remoteHead && !remoteHeadRead) {
          remoteHeadRead = true;
          assert.equal(firstImportEffects, 1, 'the first worker-head import completed before the targeted remote-head read');
          const result = await fixture.runner.run(file, args, options);
          revoked = true;
          return result;
        }
        options.beforeSpawn?.();
        const result = await fixture.runner.run(file, args, { ...options, beforeSpawn: undefined });
        if (verificationPhase && workerImport) firstImportEffects += 1;
        if (remoteRefImport) secondImportEffects += 1;
        if (push) pushEffects += 1;
        return result;
      },
    };
    const bootstrap = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner });
    const request = { runId: id, target: { kind: 'issue' as const, owner: 'acme', repo: 'widgets', issueNumber: 99 }, baseBranch: fixture.branch, baseSha: fixture.baseSha };
    const identity = await bootstrap.plan(request);
    await bootstrap.prepare({ ...request, existing: identity });
    publicationRef = `refs/heads/${identity.publicationBranch ?? identity.branch}`;
    fixture.git(fixture.remote, ['update-ref', publicationRef, fixture.baseSha]);
    const head = fixture.commit(identity.workspacePath, 'successive.txt', 'worker import\n');
    verificationPhase = true;
    await assert.rejects(() => bootstrap.verifyDurable({
      identity, expectedHeadSha: head, workspaceGuard: bootstrap.guard(identity),
      beforeMutation: () => { if (revoked) throw refusal; },
      beforePublish: () => { if (revoked) throw refusal; },
    }), (error: unknown) => error === refusal);
    assert.equal(remoteHeadRead, true, 'the existing publication ref was actually read after the first import');
    assert.equal(firstImportEffects, 1, 'the first authorized trusted-source worker import completed and remains an earlier effect');
    assert.equal(secondImportEffects, 0, 'the second trusted-source publication-ref import is blocked before spawn');
    assert.equal(pushEffects, 0, 'no push follows the refused second import');
  });

  it('rejects missing publication authority without pushing and preserves callback-free adoption', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    const bootstrap = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
    const request = { runId: 'luna-required-fence', target: { kind: 'issue' as const, owner: 'acme', repo: 'widgets', issueNumber: 99 }, baseBranch: fixture.branch, baseSha: fixture.baseSha };
    const identity = await bootstrap.plan(request); await bootstrap.prepare({ ...request, existing: identity });
    const head = fixture.commit(identity.workspacePath, 'candidate.txt', 'candidate\n');
    const before = fixture.commands.length;
    await assert.rejects(() => bootstrap.verifyDurable({ identity, expectedHeadSha: head, progressBaseSha: fixture.baseSha, workspaceGuard: bootstrap.guard(identity), beforePublish: () => {} }), /requires a synchronous host-owned beforeMutation fence/);
    assert.equal(fixture.commands.slice(before).some((command) => command.args.includes('fetch')), false, 'missing mutation authority is rejected before either trusted-source import');
    await assert.rejects(() => bootstrap.verifyDurable({ identity, expectedHeadSha: head, progressBaseSha: fixture.baseSha, workspaceGuard: bootstrap.guard(identity), beforeMutation: () => {} }), /requires a synchronous host-owned beforePublish fence/);
    await assert.rejects(() => bootstrap.verifyDurable({ identity, expectedHeadSha: head, progressBaseSha: fixture.baseSha, beforeMutation: () => {}, beforePublish: () => {} }), /requires the exact current source-minted workspace guard/);
    await assert.rejects(() => bootstrap.verifyDurable({ identity, expectedHeadSha: head, progressBaseSha: fixture.baseSha, workspaceGuard: bootstrap.guard(identity) }), /requires a synchronous host-owned/);
    assert.equal(fixture.commands.slice(before).some((command) => command.args.includes('push')), false);
    assert.equal(fixture.git(fixture.remote, ['for-each-ref', 'refs/heads/tachiko/luna-required-fence']).trim(), '');
    await bootstrap.prepare({ ...request, existing: identity, recoveryAuthority: { expectedHeadSha: head } });
    await assert.doesNotReject(() => bootstrap.verifyDurable({ identity, expectedHeadSha: head, progressBaseSha: fixture.baseSha, workspaceGuard: bootstrap.guard(identity), adoptExistingHead: true }));
  });

  it('rejects a forged or superseded proof and never publishes when trusted source ancestry fails', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    const publicationRef = 'refs/heads/tachiko/luna-source-proof';
    fixture.git(fixture.source, ['push', 'origin', `${fixture.baseSha}:${publicationRef}`]);
    let sourceAncestryFailure: 'exit' | 'throw' | undefined;
    const runner: ProcessRunner = { run: async (file, args, options) => {
      if (sourceAncestryFailure !== undefined && file === 'git' && options.cwd === realpathSync(fixture.source) && args.includes('merge-base') && args.includes('--is-ancestor')) {
        if (sourceAncestryFailure === 'throw') throw new Error('injected source ancestry transport failure');
        return { stdout: '', stderr: 'injected source ancestry failure', exitCode: 1 };
      }
      return fixture.runner.run(file, args, options);
    } };
    const bootstrap = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner });
    const request = { runId: 'luna-source-proof', target: { kind: 'issue' as const, owner: 'acme', repo: 'widgets', issueNumber: 99 }, baseBranch: fixture.branch, baseSha: fixture.baseSha, publicationBranch: 'tachiko/luna-source-proof' };
    const identity = await bootstrap.plan(request);
    await bootstrap.prepare({ ...request, existing: identity });
    const oldGuard = bootstrap.guard(identity);
    await bootstrap.prepare({ ...request, existing: identity });
    const head = fixture.commit(identity.workspacePath, 'source-check.txt', 'candidate\n');
    const before = fixture.commands.length;
    await assert.rejects(() => bootstrap.verifyDurable({
      identity, expectedHeadSha: head, progressBaseSha: fixture.baseSha,
      workspaceGuard: Object.freeze({ assertValid() {} }), beforeMutation: () => {}, beforePublish: () => assert.fail('forged proof reached publication fence'),
    }), /exact current source-minted workspace guard/);
    await assert.rejects(() => bootstrap.verifyDurable({
      identity, expectedHeadSha: fixture.baseSha, progressBaseSha: fixture.baseSha, workspaceGuard: oldGuard,
      beforeMutation: () => {}, beforePublish: () => assert.fail('superseded proof reached publication fence'),
    }), /exact current source-minted workspace guard/);
    const freshGuard = bootstrap.guard(identity);
    const beforeWrongBase = fixture.commands.length;
    await assert.rejects(() => bootstrap.verifyDurable({
      identity, expectedHeadSha: head, progressBaseSha: 'f'.repeat(40), workspaceGuard: freshGuard,
      beforeMutation: () => {}, beforePublish: () => assert.fail('mismatched proof base reached publication fence'),
    }), /publication base differs from its source-authorized HEAD/);
    assert.equal(fixture.commands.length, beforeWrongBase, 'source authority mismatches fail before the first asynchronous Git check');
    let fenceCalls = 0;
    sourceAncestryFailure = 'exit';
    await assert.rejects(() => bootstrap.verifyDurable({
      identity, expectedHeadSha: head, progressBaseSha: fixture.baseSha, workspaceGuard: freshGuard,
      beforeMutation: () => {}, beforePublish: () => { fenceCalls += 1; },
    }), /does not descend from its authorized base/);
    sourceAncestryFailure = 'throw';
    await assert.rejects(() => bootstrap.verifyDurable({
      identity, expectedHeadSha: head, progressBaseSha: fixture.baseSha, workspaceGuard: freshGuard,
      beforeMutation: () => {}, beforePublish: () => { fenceCalls += 1; },
    }), /injected source ancestry transport failure/);
    assert.equal(fenceCalls, 0);
    assert.equal(fixture.commands.slice(before).some((command) => command.args.includes('push')), false);
    assert.equal(fixture.git(fixture.remote, ['rev-parse', publicationRef]).trim(), fixture.baseSha, 'the pre-existing publication ref remains unchanged');
  });

  it('preserves a divergent existing remote branch without crossing the publication fence', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    const publisher = path.join(fixture.root, 'divergent-publisher');
    fixture.git(fixture.root, ['clone', fixture.remote, publisher]);
    fixture.git(publisher, ['checkout', fixture.branch]);
    const divergentHead = fixture.commit(publisher, 'divergent.txt', 'remote-only commit\n');
    const publicationRef = 'refs/heads/tachiko/luna-divergent';
    fixture.git(publisher, ['push', 'origin', `${divergentHead}:${publicationRef}`]);
    let fenceCalls = 0;
    const bootstrap = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
    const request = { runId: 'luna-divergent', target: { kind: 'issue' as const, owner: 'acme', repo: 'widgets', issueNumber: 99 }, baseBranch: fixture.branch, baseSha: fixture.baseSha, publicationBranch: 'tachiko/luna-divergent' };
    const identity = await bootstrap.plan(request);
    await bootstrap.prepare({ ...request, existing: identity });
    const head = fixture.commit(identity.workspacePath, 'worker.txt', 'worker-only commit\n');
    const before = fixture.commands.length;
    await assert.rejects(() => bootstrap.verifyDurable({
      identity, expectedHeadSha: head, workspaceGuard: bootstrap.guard(identity),
      beforeMutation: () => {}, beforePublish: () => { fenceCalls += 1; },
    }), /does not descend from its authorized base/);
    assert.equal(fenceCalls, 0);
    assert.equal(fixture.commands.slice(before).some((command) => command.args.includes('push')), false);
    assert.equal(fixture.git(fixture.remote, ['rev-parse', publicationRef]).trim(), divergentHead, 'the divergent existing remote ref is preserved');
  });

  it('rejects publication when a successful reprepare replaces the captured proof at the actual push boundary', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    let bootstrap!: StandaloneGitBootstrap;
    let spawnReached = false;
    let reprepare: Promise<unknown> | undefined;
    const runner: ProcessRunner = { run: async (file, args, options) => {
      if (args.includes('push')) {
        await Promise.resolve(); // injected-runner preparation barrier
        options.beforeSpawn?.();
        spawnReached = true;
        return fixture.runner.run(file, args, { ...options, beforeSpawn: undefined });
      }
      return fixture.runner.run(file, args, options);
    } };
    bootstrap = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner });
    const request = { runId: 'luna-revoke-at-spawn', target: { kind: 'issue' as const, owner: 'acme', repo: 'widgets', issueNumber: 99 }, baseBranch: fixture.branch, baseSha: fixture.baseSha };
    const identity = await bootstrap.plan(request);
    await bootstrap.prepare({ ...request, existing: identity });
    const guard = bootstrap.guard(identity);
    const head = fixture.commit(identity.workspacePath, 'revoke.txt', 'candidate\n');
    let fenced = false;
    await assert.rejects(() => bootstrap.verifyDurable({
      identity, expectedHeadSha: head, progressBaseSha: fixture.baseSha, workspaceGuard: guard,
      beforeMutation: () => {}, beforePublish: () => {
        fenced = true;
        // prepare() revokes the current proof synchronously before its first await.
        reprepare = bootstrap.prepare({ ...request, existing: identity, recoveryAuthority: { expectedHeadSha: head } });
      },
    }), /proof changed before final acceptance/);
    await reprepare;
    await assert.doesNotReject(async () => await bootstrap.guard(identity).assertValid(), 'the successful reprepare leaves a current new proof');
    assert.equal(fenced, true);
    assert.equal(spawnReached, false);
    assert.equal(fixture.git(fixture.remote, ['for-each-ref', 'refs/heads/tachiko/luna-revoke-at-spawn']).trim(), '');
  });

  it('rejects a proof superseded during asynchronous publication checks before spawning push', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    let bootstrap!: StandaloneGitBootstrap;
    let reprepare: Promise<unknown> | undefined;
    let pushSpawned = false;
    const request = { runId: 'luna-async-proof', target: { kind: 'issue' as const, owner: 'acme', repo: 'widgets', issueNumber: 99 }, baseBranch: fixture.branch, baseSha: fixture.baseSha };
    let identity!: Awaited<ReturnType<StandaloneGitBootstrap['plan']>>;
    const runner: ProcessRunner = { run: async (file, args, options) => {
      if (file === 'git' && args.includes('ls-remote') && args.includes('refs/heads/tachiko/luna-async-proof') && options.cwd === realpathSync(fixture.source)) {
        const result = await fixture.runner.run(file, args, options);
        reprepare = bootstrap.prepare({ ...request, existing: identity, recoveryAuthority: { expectedHeadSha: head } });
        await reprepare;
        return result;
      }
      if (args.includes('push')) {
        await Promise.resolve();
        options.beforeSpawn?.();
        pushSpawned = true;
        return fixture.runner.run(file, args, { ...options, beforeSpawn: undefined });
      }
      return fixture.runner.run(file, args, options);
    } };
    bootstrap = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner });
    identity = await bootstrap.plan(request);
    await bootstrap.prepare({ ...request, existing: identity });
    const guard = bootstrap.guard(identity);
    const head = fixture.commit(identity.workspacePath, 'async-proof.txt', 'candidate\n');
    await assert.rejects(() => bootstrap.verifyDurable({
      identity, expectedHeadSha: head, progressBaseSha: fixture.baseSha, workspaceGuard: guard,
      beforeMutation: () => {}, beforePublish: () => {},
    }), /proof changed before final acceptance/);
    await reprepare;
    await assert.doesNotReject(async () => await bootstrap.guard(identity).assertValid(), 'the asynchronous overlap completed a successful replacement proof');
    assert.equal(pushSpawned, false);
    assert.equal(fixture.git(fixture.remote, ['for-each-ref', 'refs/heads/tachiko/luna-async-proof']).trim(), '');
  });

  it('binds proof to exact target, run, branch, workspace and authorized repair head, invalidating before failed reprepare', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    const bootstrap = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
    const target = { kind: 'issue' as const, owner: 'acme', repo: 'widgets', issueNumber: 99 };
    const request = { runId: 'luna-proof', target, baseBranch: fixture.branch, baseSha: fixture.baseSha };
    const identity = await bootstrap.plan(request); await bootstrap.prepare({ ...request, existing: identity });
    const guard = bootstrap.guard(identity);
    const invocation = { target, baseSha: fixture.baseSha, workspacePath: identity.workspacePath, branch: identity.branch, workspaceGuard: guard, runtimeOwnership: { runId: request.runId, generation: 'generation' } };
    assert.equal(Object.isFrozen(guard), true);
    assert.equal(hasPreparedStandaloneLunaInvocation(invocation), true);
    assert.equal(hasPreparedStandaloneLunaInvocation({ ...invocation, branch: 'other' }), false);
    assert.equal(hasPreparedStandaloneLunaInvocation({ ...invocation, baseSha: 'f'.repeat(40) }), false);
    assert.equal(hasPreparedStandaloneLunaInvocation({ ...invocation, runtimeOwnership: { runId: 'other', generation: 'generation' } }), false);
    assert.equal(hasPreparedStandaloneLunaInvocation({ ...invocation, target: { ...target, issueNumber: 100 } }), false);
    assert.equal(hasPreparedStandaloneLunaInvocation({ ...invocation, workspaceGuard: Object.freeze({ assertValid() {} }) }), false);
    await assert.rejects(() => bootstrap.prepare({ ...request, runId: 'invalid..run', existing: identity }), /invalid Git branch/);
    assert.equal(hasPreparedStandaloneLunaInvocation(invocation), false);
    await assert.rejects(async () => { await guard.assertValid(); }, /preparation proof was superseded/);
    await assert.rejects(async () => { await bootstrap.guard(identity).assertValid(); });
  });

  it('rejects an in-flight guard check when successful reprepare supersedes its proof', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    let releaseCheck!: () => void;
    let checkStarted!: () => void;
    const started = new Promise<void>((resolve) => { checkStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseCheck = resolve; });
    let armed = false;
    let paused = false;
    const runner: ProcessRunner = { run: async (file, args, options) => {
      if (armed && !paused && args.includes('ls-files') && args.includes('-v')) {
        paused = true;
        checkStarted();
        await blocked;
      }
      return fixture.runner.run(file, args, options);
    } };
    const bootstrap = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner });
    const request = { runId: 'luna-inflight-proof', target: { kind: 'issue' as const, owner: 'acme', repo: 'widgets', issueNumber: 99 }, baseBranch: fixture.branch, baseSha: fixture.baseSha };
    const identity = await bootstrap.plan(request); await bootstrap.prepare({ ...request, existing: identity });
    armed = true;
    const oldGuard = bootstrap.guard(identity);
    const pendingCheck = oldGuard.assertValid();
    await started;
    await bootstrap.prepare({ ...request, existing: identity });
    releaseCheck();
    await assert.rejects(async () => await pendingCheck, /preparation proof was superseded/);
    await assert.doesNotReject(async () => await bootstrap.guard(identity).assertValid(), 'the current guard remains reusable');
  });

  it('accepts a standalone checkout when optional info and hooks directories are absent at preparation', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    let workspacePath: string | undefined;
    const runner: ProcessRunner = { run: async (file, args, options) => {
      const result = await fixture.runner.run(file, args, options);
      if (args.includes('remote') && workspacePath !== undefined && options.cwd === workspacePath) {
        rmSync(path.join(workspacePath, '.git', 'info'), { recursive: true, force: true });
        rmSync(path.join(workspacePath, '.git', 'hooks'), { recursive: true, force: true });
      }
      return result;
    } };
    const bootstrap = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner });
    const request = { runId: 'luna-optional-git-dirs', target: { kind: 'issue' as const, owner: 'acme', repo: 'widgets', issueNumber: 99 }, baseBranch: fixture.branch, baseSha: fixture.baseSha };
    const identity = await bootstrap.plan(request); workspacePath = identity.workspacePath;
    await bootstrap.prepare({ ...request, existing: identity });
    await assert.doesNotReject(async () => await bootstrap.guard(identity).assertValid());
  });

  it('rejects a workspace replacement introduced during the final awaited Git check', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    let workspacePath: string | undefined;
    let armed = false;
    let replaced = false;
    const runner: ProcessRunner = { run: async (file, args, options) => {
      const result = await fixture.runner.run(file, args, options);
      if (armed && !replaced && args.includes('rev-parse') && args.includes('HEAD') && options.cwd === workspacePath) {
        replaced = true;
        const moved = `${workspacePath}-during-check`;
        renameSync(workspacePath!, moved);
        symlinkSync(moved, workspacePath!);
      }
      return result;
    } };
    const bootstrap = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner });
    const request = { runId: 'luna-final-check-replacement', target: { kind: 'issue' as const, owner: 'acme', repo: 'widgets', issueNumber: 99 }, baseBranch: fixture.branch, baseSha: fixture.baseSha };
    const identity = await bootstrap.plan(request); workspacePath = identity.workspacePath;
    await bootstrap.prepare({ ...request, existing: identity });
    armed = true;
    await assert.rejects(async () => await bootstrap.guard(identity).assertValid(), /physical identity changed/);
    assert.equal(replaced, true);
  });

  it('mints a new proof from reconstructed repair preparation while retaining immutable bootstrap base', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    const target = { kind: 'issue' as const, owner: 'acme', repo: 'widgets', issueNumber: 99 };
    const request = { runId: 'luna-reconstructed-proof', target, baseBranch: fixture.branch, baseSha: fixture.baseSha };
    const first = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
    const planned = await first.plan(request); const identity = await first.prepare({ ...request, existing: planned });
    const repairHead = fixture.commit(identity.workspacePath, 'repair-base.txt', 'repair base\n');
    const reconstructed = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
    const repairedIdentity = await reconstructed.prepare({ ...request, existing: identity, recoveryAuthority: { expectedHeadSha: repairHead } });
    const guard = reconstructed.guard(repairedIdentity);
    assert.equal(repairedIdentity.baseSha, fixture.baseSha);
    assert.equal(hasPreparedStandaloneLunaInvocation({ target, baseSha: repairHead, workspacePath: repairedIdentity.workspacePath, branch: repairedIdentity.branch, workspaceGuard: guard, runtimeOwnership: { runId: request.runId, generation: 'repair' } }), true);
    assert.equal(hasPreparedStandaloneLunaInvocation({ target, baseSha: fixture.baseSha, workspacePath: repairedIdentity.workspacePath, branch: repairedIdentity.branch, workspaceGuard: guard, runtimeOwnership: { runId: request.runId, generation: 'repair' } }), false);
  });

  it('recovers an authorized descendant after the original named base ref is removed', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    const target = { kind: 'issue' as const, owner: 'acme', repo: 'widgets', issueNumber: 99 };
    const request = { runId: 'luna-historical-base-ref-removed', target, baseBranch: fixture.branch, baseSha: fixture.baseSha };
    const bootstrap = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
    const identity = await bootstrap.plan(request);
    const authorizedHead = fixture.commit(fixture.source, 'authorized-recovery.txt', 'authorized recovery\n');
    fixture.git(fixture.source, ['push', 'origin', `${authorizedHead}:refs/heads/${identity.branch}`]);
    fixture.git(fixture.remote, ['branch', '-D', fixture.branch]);

    const recovered = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
    const prepared = await recovered.prepare({ ...request, existing: identity, recoveryAuthority: { expectedHeadSha: authorizedHead } });
    assert.equal(prepared.baseSha, fixture.baseSha, 'recovery retains the immutable planned base');
    assert.equal(fixture.git(prepared.workspacePath, ['rev-parse', 'HEAD']), authorizedHead);
    assert.equal(fixture.git(prepared.workspacePath, ['cat-file', '-e', `${fixture.baseSha}^{commit}`]), '');
  });

  for (const boundary of ['trusted-source-fetch', 'workspace-import'] as const) {
    it(`refuses standalone recovery at ${boundary} after preserving earlier real Git effects`, async () => {
      const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
      const target = { kind: 'issue' as const, owner: 'acme', repo: 'widgets', issueNumber: 99 };
      const request = { runId: `luna-recovery-${boundary}`, target, baseBranch: fixture.branch, baseSha: fixture.baseSha };
      const planner = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
      const identity = await planner.plan(request);
      const authorizedHead = fixture.commit(fixture.source, 'authorized-recovery.txt', 'authorized non-base head\n');
      fixture.git(fixture.source, ['push', 'origin', `HEAD:refs/heads/tachiko/${request.runId}-authorized`]);

      let release!: () => void;
      let entered!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const reached = new Promise<void>((resolve) => { entered = resolve; });
      const attempts: { readonly args: readonly string[]; readonly cwd?: string }[] = [];
      const delegated: { readonly args: readonly string[]; readonly cwd?: string }[] = [];
      let targetSpawnAttempted = false;
      let authorityRefused = false;
      const commandArgs = (args: readonly string[]) => {
        let offset = 0;
        while (args[offset] === '-c') offset += 2;
        return args.slice(offset);
      };
      const refusal = new ExecutionAdmissionRefusal(`held at ${boundary}`, false, { cause: new Error('admission changed after runner preparation') });
      const runner: ProcessRunner = { run: async (file, args, options) => {
        attempts.push({ args: [...args], cwd: options.cwd });
        const command = commandArgs(args);
        const isTrustedFetch = file === 'git' && options.cwd === realpathSync(fixture.source) && command[0] === 'fetch' && command.at(-1) === authorizedHead;
        const isWorkspaceImport = file === 'git' && options.cwd === identity.workspacePath && command[0] === 'fetch' && command.includes(realpathSync(fixture.source)) && command.at(-1) === authorizedHead;
        if (!targetSpawnAttempted && (boundary === 'trusted-source-fetch' ? isTrustedFetch : isWorkspaceImport)) {
          targetSpawnAttempted = true;
          entered();
          await held;
          // The actual ProcessRunner callback is the accepted final synchronous
          // boundary. It is invoked only after the injected runner's async prep.
          options.beforeSpawn?.();
        }
        delegated.push({ args: [...args], cwd: options.cwd });
        return fixture.runner.run(file, args, options);
      } };
      const bootstrap = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner });
      const pending = bootstrap.prepare({ ...request, existing: identity, recoveryAuthority: { expectedHeadSha: authorizedHead }, beforeMutation: () => { if (authorityRefused) throw refusal; } });
      await reached;
      authorityRefused = true;
      release();
      await assert.rejects(pending, (error: unknown) => {
        assert.strictEqual(error, refusal);
        assert.strictEqual((error as Error).cause, refusal.cause);
        return true;
      });

      assert.equal(targetSpawnAttempted, true, 'the asynchronous runner reached the exact recovery-fetch boundary');
      assert.equal(delegated.some(({ args, cwd }) => cwd === fixture.workspaceRoot && commandArgs(args)[0] === 'init' && commandArgs(args).includes(identity.workspacePath)), true, 'the earlier workspace initialization remains real');
      assert.equal(delegated.some(({ args, cwd }) => cwd === identity.workspacePath && commandArgs(args)[0] === 'fetch' && commandArgs(args).at(-1) === identity.baseSha), true, 'the earlier authorized base import remains real');
      assert.equal(delegated.some(({ args, cwd }) => cwd === realpathSync(fixture.source) && commandArgs(args)[0] === 'fetch' && commandArgs(args).at(-1) === authorizedHead), boundary === 'workspace-import', 'trusted-source fetch delegates only before the workspace-import boundary');
      assert.equal(delegated.some(({ args, cwd }) => cwd === identity.workspacePath && commandArgs(args)[0] === 'fetch' && commandArgs(args).at(-1) === authorizedHead), false, 'the current or later authorized-head import never reaches Git');
      assert.equal(delegated.some(({ args, cwd }) => cwd === identity.workspacePath && (commandArgs(args)[0] === 'checkout' || commandArgs(args)[0] === 'switch')), false, 'checkout and branch switch remain blocked after refusal');
      assert.equal(existsSync(identity.workspacePath), true, 'earlier workspace initialization is not rolled back');
      assert.doesNotThrow(() => fixture.git(identity.workspacePath, ['cat-file', '-e', `${identity.baseSha}^{commit}`]), 'earlier base objects remain imported');
    });
  }

  it('rejects workspace path replacement and Git object-store redirection after preparation', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    const bootstrap = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
    const request = { runId: 'luna-physical-replacement', target: { kind: 'issue' as const, owner: 'acme', repo: 'widgets', issueNumber: 99 }, baseBranch: fixture.branch, baseSha: fixture.baseSha };
    const identity = await bootstrap.plan(request); await bootstrap.prepare({ ...request, existing: identity });
    const guard = bootstrap.guard(identity);
    const moved = `${identity.workspacePath}-moved`;
    renameSync(identity.workspacePath, moved);
    symlinkSync(moved, identity.workspacePath);
    await assert.rejects(async () => { await guard.assertValid(); }, /physical identity changed/);
  });

  it('rejects replacement of the captured Git object directory and hardlinked Git metadata files', async () => {
    {
      const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
      const bootstrap = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
      const request = { runId: 'luna-object-dir-replaced', target: { kind: 'issue' as const, owner: 'acme', repo: 'widgets', issueNumber: 99 }, baseBranch: fixture.branch, baseSha: fixture.baseSha };
      const identity = await bootstrap.plan(request); await bootstrap.prepare({ ...request, existing: identity });
      const objects = path.join(identity.workspacePath, '.git', 'objects');
      renameSync(objects, `${objects}-saved`); mkdirSync(objects);
      await assert.rejects(async () => { await bootstrap.guard(identity).assertValid(); }, /metadata directory physical identity changed/);
    }
    {
      const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
      const bootstrap = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
      const request = { runId: 'luna-hardlinked-config', target: { kind: 'issue' as const, owner: 'acme', repo: 'widgets', issueNumber: 99 }, baseBranch: fixture.branch, baseSha: fixture.baseSha };
      const identity = await bootstrap.plan(request); await bootstrap.prepare({ ...request, existing: identity });
      const config = path.join(identity.workspacePath, '.git', 'config');
      const outsideLink = path.join(fixture.root, 'config-hardlink');
      const before = readFileSync(config, 'utf8');
      linkSync(config, outsideLink);
      await assert.rejects(async () => { await bootstrap.guard(identity).assertValid(); }, /private regular files/);
      assert.equal(readFileSync(outsideLink, 'utf8'), before, 'rejection leaves shared external metadata unchanged');
    }
  });

  it('rejects an initial no-progress result before host publication', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    const bootstrap = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
    const request = { runId: 'luna-99-empty', target: { kind: 'issue' as const, owner: 'acme', repo: 'widgets', issueNumber: 99 }, baseBranch: fixture.branch, baseSha: fixture.baseSha };
    const identity = await bootstrap.plan(request); await bootstrap.prepare({ ...request, existing: identity });
    await assert.rejects(() => bootstrap.verifyDurable({ identity, expectedHeadSha: fixture.baseSha, workspaceGuard: bootstrap.guard(identity), beforeMutation: () => {}, beforePublish: () => {} }), /did not advance/);
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
    await assert.rejects(() => bootstrap.verifyDurable({ identity, expectedHeadSha: head, workspaceGuard: bootstrap.guard(identity), beforeMutation: () => {}, beforePublish: () => {} }), /publication remote/);
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
    await assert.doesNotReject(() => bootstrap.verifyDurable({ identity, expectedHeadSha: adoptedHead, progressBaseSha: fixture.baseSha, workspaceGuard: bootstrap.guard(identity), adoptExistingHead: true }));
    assert.notEqual(identity.branch, identity.publicationBranch);
    fixture.commit(identity.workspacePath, 'repair.txt', 'repair\n');
    const repaired = fixture.git(identity.workspacePath, ['rev-parse', 'HEAD']).trim();
    await bootstrap.verifyDurable({ identity, expectedHeadSha: repaired, progressBaseSha: adoptedHead, workspaceGuard: bootstrap.guard(identity), beforeMutation: () => {}, beforePublish: () => {} });
    assert.equal(fixture.git(fixture.remote, ['rev-parse', 'refs/heads/tachiko/existing-pr']).trim(), repaired);
    fixture.git(identity.workspacePath, ['reset', '--hard', fixture.baseSha]);
    await assert.rejects(
      () => bootstrap.verifyDurable({ identity, expectedHeadSha: adoptedHead, progressBaseSha: fixture.baseSha, workspaceGuard: bootstrap.guard(identity), adoptExistingHead: true }),
      /differs from the reported exact HEAD/,
    );
  });

  it('rejects adoption when successful reprepare supersedes its captured proof during the final tree check', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    const adoptedHead = fixture.commit(fixture.source, 'pr.txt', 'authoritative PR change\n');
    fixture.git(fixture.source, ['push', 'origin', `HEAD:refs/heads/tachiko/luna-adoption-race`]);
    let bootstrap!: StandaloneGitBootstrap;
    let identity!: Awaited<ReturnType<StandaloneGitBootstrap['plan']>>;
    let reprepare: Promise<unknown> | undefined;
    let armed = false;
    let reprepareStarted = false;
    const request = { runId: 'luna-adoption-race', target: { kind: 'issue' as const, owner: 'acme', repo: 'widgets', issueNumber: 99 }, baseBranch: fixture.branch, baseSha: fixture.baseSha, publicationBranch: 'tachiko/luna-adoption-race' };
    const runner: ProcessRunner = { run: async (file, args, options) => {
      const result = await fixture.runner.run(file, args, options);
      if (armed && !reprepareStarted && file === 'git' && args.some((arg) => arg.endsWith('^{tree}'))) {
        reprepareStarted = true;
        reprepare = bootstrap.prepare({ ...request, existing: identity, recoveryAuthority: { expectedHeadSha: adoptedHead } });
        await reprepare;
      }
      return result;
    } };
    bootstrap = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner });
    identity = await bootstrap.plan(request);
    await bootstrap.prepare({ ...request, existing: identity, recoveryAuthority: { expectedHeadSha: adoptedHead } });
    const guard = bootstrap.guard(identity);
    const before = fixture.commands.length;
    armed = true;
    await assert.rejects(() => bootstrap.verifyDurable({
      identity, expectedHeadSha: adoptedHead, progressBaseSha: fixture.baseSha,
      workspaceGuard: guard, adoptExistingHead: true,
    }), /proof changed before final acceptance/);
    await reprepare;
    assert.equal(reprepareStarted, true, 'the real final tree read must overlap a successful replacement proof');
    assert.equal(fixture.commands.slice(before).some((command) => command.args.includes('push')), false);
    assert.equal(fixture.git(fixture.remote, ['rev-parse', 'refs/heads/tachiko/luna-adoption-race']).trim(), adoptedHead);
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
    const followup = fixture.commit(identity.workspacePath, 'repair-followup.txt', 'follow-up\n');
    await bootstrap.verifyDurable({ identity: repairIdentity, expectedHeadSha: followup, progressBaseSha: repaired, workspaceGuard: bootstrap.guard(repairIdentity), beforeMutation: () => {}, beforePublish: () => {} });
    assert.equal(fixture.git(fixture.remote, ['rev-parse', 'refs/heads/tachiko/existing-pr']).trim(), followup);
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

  it('rejects a worker-created common-dir redirect before host Git inspects the checkout', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    const bootstrap = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
    const request = { runId: 'luna-common-dir', target: { kind: 'issue' as const, owner: 'acme', repo: 'widgets', issueNumber: 99 }, baseBranch: fixture.branch, baseSha: fixture.baseSha };
    const identity = await bootstrap.plan(request); await bootstrap.prepare({ ...request, existing: identity });
    writeFileSync(path.join(identity.workspacePath, '.git', 'commondir'), '../worker-controlled-common\n');
    await assert.rejects(async () => await bootstrap.guard(identity).assertValid(), /redirects its common metadata/);
  });

  it('rejects alternate Git object stores before host Git verification', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    const bootstrap = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
    const request = { runId: 'luna-alternates', target: { kind: 'issue' as const, owner: 'acme', repo: 'widgets', issueNumber: 99 }, baseBranch: fixture.branch, baseSha: fixture.baseSha };
    const identity = await bootstrap.plan(request); await bootstrap.prepare({ ...request, existing: identity });
    writeFileSync(path.join(identity.workspacePath, '.git', 'objects', 'info', 'alternates'), `${path.join(fixture.source, '.git', 'objects')}\n`);
    await assert.rejects(async () => { await bootstrap.guard(identity).assertValid(); }, /redirects object storage through alternates/);
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

  it('keeps planning read-only and gates the immutable-base prepare fetch after injected runner preparation', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    const refusal = new ExecutionAdmissionRefusal('planning fetch lost admission', false);
    let armed = false;
    let enteredResolve!: () => void;
    let releaseResolve!: () => void;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    const released = new Promise<void>((resolve) => { releaseResolve = resolve; });
    const runner: ProcessRunner = { run: async (file, args, options) => {
      const selected = file === 'git' && args.includes('fetch') && args.includes('origin');
      if (selected) { enteredResolve(); await released; armed = true; }
      options.beforeSpawn?.();
      return fixture.runner.run(file, args, { ...options, beforeSpawn: undefined });
    } };
    const bootstrap = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner });
    const request = { runId: 'luna-plan-fetch-fence', target: { kind: 'issue' as const, owner: 'acme', repo: 'widgets', issueNumber: 99 }, baseBranch: fixture.branch, baseSha: fixture.baseSha };
    const planned = await bootstrap.plan(request);
    assert.equal(fixture.commands.some(({ args }) => args.includes('fetch')), false, 'read-only planning does not fetch or change FETCH_HEAD');
    const preparing = bootstrap.prepare({ ...request, existing: planned, beforeMutation: () => { if (armed) throw refusal; } });
    await entered;
    releaseResolve();
    await assert.rejects(preparing, (error) => error === refusal);
    assert.equal(fixture.commands.some(({ args }) => args.includes('fetch') && args.includes('origin')), false);
  });

  for (const boundary of ['init', 'checkout', 'switch'] as const) {
    it(`gates standalone ${boundary} after asynchronous runner preparation`, async () => {
      const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
      const refusal = new ExecutionAdmissionRefusal(`blocked ${boundary}`, false);
      let armed = false;
      let enteredResolve!: () => void;
      let releaseResolve!: () => void;
      const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
      const released = new Promise<void>((resolve) => { releaseResolve = resolve; });
      const runner: ProcessRunner = { run: async (file, args, options) => {
        const selected = file === 'git' && args.includes(boundary);
        if (selected) { enteredResolve(); await released; armed = true; }
        options.beforeSpawn?.();
        return fixture.runner.run(file, args, { ...options, beforeSpawn: undefined });
      } };
      const bootstrap = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner });
      const request = { runId: `luna-${boundary}-fence`, target: { kind: 'issue' as const, owner: 'acme', repo: 'widgets', issueNumber: 99 }, baseBranch: fixture.branch, baseSha: fixture.baseSha };
      const identity = await bootstrap.plan(request);
      const preparing = bootstrap.prepare({ ...request, existing: identity, beforeMutation: () => { if (armed) throw refusal; } });
      await entered;
      releaseResolve();
      await assert.rejects(preparing, (error) => error === refusal);
      assert.equal(fixture.commands.some(({ args }) => args.includes(boundary)), false, 'the intercepted command never reaches real Git');
      if (boundary === 'init') assert.equal(existsSync(identity.workspacePath), false);
      if (boundary === 'switch') {
        assert.equal(fixture.git(identity.workspacePath, ['rev-parse', '--abbrev-ref', 'HEAD']), 'HEAD', 'blocked switch leaves the checkout detached');
      }
    });
  }
});
