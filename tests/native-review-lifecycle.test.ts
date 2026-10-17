import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { GitHubAdapter, GitHubLiveSnapshot } from '../src/adapters/github.js';
import { buildWorkflowDeps, recoverRunAdmission, runIssueCommand, runMergedTransitionCommand, reconcileDispatchMergedRunCommand, isDispatchRunOwnerRetiredCommand } from '../src/cli.js';
import { createRun } from '../src/domain/run.js';
import { applyTransition } from '../src/domain/state-machine.js';
import type { Run } from '../src/domain/types.js';
import { dispatchOnceCommand } from '../src/dispatch/command.js';
import { dispatchContinuously } from '../src/dispatch/continuous.js';
import { DISPATCH_QUEUE_MARKER, renderDispatchRuntime, selectDispatchRuntime, type DispatchRuntimeClaim, type DispatchRuntimeComment } from '../src/dispatch/queue.js';
import type { ResolvedExecutionConfiguration } from '../src/execution-profiles.js';
import { resolveRunOwnerReceiptPath } from '../src/mission-admission/host-registry.js';
import { issuedMergeRecoveryConfiguration, readMergeCandidate, type NativeMergeHost, type NativeMergePolicy } from '../src/workflow/merge.js';
import { MissionAdmissionRegistry, type AdmissionConfig } from '../src/mission-admission/registry.js';
import { readRunOwnerReceipt, writeRunOwnerReceipt } from '../src/mission-admission/run-owner-receipt.js';
import { activeNativeReview, nativeReviewCoherent, nativeReviewReentry, resolveNativeReviewer } from '../src/oracle/native-reviewer.js';
import { JsonFileOracleReceiptStore } from '../src/oracle/receipt-store.js';
import { oracleDigest, readNativeSourceManifest, validNativeSourceManifest } from '../src/oracle/source-evidence.js';
import type { NativeOracleEvidence, NativeReviewObservation, NativeReviewerHost, OracleReceipt } from '../src/oracle/types.js';
import { JsonFileStore } from '../src/store/json-file-store.js';
import type { WorkflowDependencies } from '../src/workflow/run.js';
import { runWorkflow } from '../src/workflow/run.js';
import { TARGET, T0, TEST_VALIDATION_AUTHORITY, approval, successResult, validationPassed } from './helpers.js';

const authority = { revision: 'task-v1', shape: 'interacting' } as const;
const execution: ResolvedExecutionConfiguration = { profile: 'complex', revision: 'execution-v1', executor: 'codex-cli', timeoutMs: 60_000 };
const admissionConfig: AdmissionConfig = { schemaVersion: 1, revision: 'admission-v1', limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } };
const config = { revision: 'dispatch-v1', owner: 'acme', repo: 'widgets', controlIssue: 1, queueCommentId: 2, leaseDurationMs: 60_000 };
const queue = `${DISPATCH_QUEUE_MARKER}\nready:\n  - issue: 42\n    route: codex\n    profile: complex\n    task-shape-revision: task-v1\n    task-shape: interacting\n  - issue: 43\n    route: codex\n    profile: complex\n    task-shape-revision: task-v1\n    task-shape: interacting`;
type RequestEvidence = Extract<NativeOracleEvidence, { kind: 'request' }>;
type TerminalEvidence = Extract<NativeOracleEvidence, { kind: 'terminal' }>;

class Runtime {
  comments: DispatchRuntimeComment[] = [];
  async readQueueComment() { return queue; }
  async listRuntimeComments() { return structuredClone(this.comments); }
  async createRuntimeComment(body: string) { const c = { id: 'runtime', body }; this.comments.push(c); return c; }
  async updateRuntimeComment(id: string, body: string) { this.comments = [{ id, body }]; return { id, body }; }
}

function fixture(mergeComposition = false) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'native-review-'));
  const originalUserInfo = os.userInfo;
  if (mergeComposition) os.userInfo = (() => ({ ...originalUserInfo(), homedir: directory })) as typeof os.userInfo;
  const repository = path.join(directory, 'objects');
  mkdirSync(repository);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Controlled fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--quiet');
  writeFileSync(path.join(repository, 'README.md'), 'Original complete source\n');
  git('add', '.'); git('commit', '--quiet', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(path.join(repository, 'README.md'), 'Changed complete source\n');
  git('commit', '--quiet', '-am', 'candidate');
  const head = git('rev-parse', 'HEAD');
  let clock = Date.parse(T0);
  let modelCalls = 0;
  let submissions = 0;
  let observations = 0;
  let snapshotReads = 0;
  let onSnapshot: (() => void) | undefined;
  let liveBase = base;
  let liveHead = head;
  let negativeReview = false;
  let validationCalls = 0;
  let lastRequest: RequestEvidence | undefined;
  let submit: (r: RequestEvidence) => Promise<NativeReviewObservation> = async () => ({ outcome: 'pending', conversationUrl: 'https://review.example.invalid/exact?conversation=returned' });
  let observe: NonNullable<NativeReviewerHost['observe']> = async () => ({ outcome: 'pending' });
  const now = () => new Date(clock).toISOString();
  const store = () => new JsonFileStore({ dir: path.join(directory, 'runs') });
  let onRegistryPublish = () => {};
  const registry = () => new MissionAdmissionRegistry({ beforePublish: () => onRegistryPublish(), filePath: path.join(directory, 'host', 'admission.json'), config: admissionConfig, now });
  const receipts = () => new JsonFileOracleReceiptStore(path.join(directory, 'oracle'));
  const receiptPath = mergeComposition ? resolveRunOwnerReceiptPath('acme/widgets', 'run-native') : path.join(directory, 'owner.json');
  let mergeHost: NativeMergeHost | undefined;
  let configuredMerge: NativeMergePolicy | undefined;
  let hold = false;
  let recoveryOnly = false;
  let squashes = 0;
  let mergeState: 'open' | 'merged' | 'closed' = 'open';
  let mainHead = base;
  const tree = git('rev-parse', `${head}^{tree}`);
  const squash = git('commit-tree', tree, '-p', base, '-m', 'actual squash');
  let proofCommit = { sha: squash, treeSha: tree, parents: [base] };
  let proofAncestry = true;
  let mergeOperation = async () => { mergeState = 'merged' as const; mainHead = squash; };
  const mergePolicy: NativeMergePolicy = { enabled: true, revision: 'merge-v1', releaseId: 'accepted-fixture-release', campaign: 'bounded-v1', dispatchRevision: config.revision, owner: config.owner, repo: config.repo, controlIssue: config.controlIssue, queueCommentId: config.queueCommentId, baseBranch: 'main', method: 'squash', integrationPolicy: 'bootstrap-base-tree-v1', reviewPolicyRevision: 'independent-unpromoted-v1', localValidationRevision: 'test-config-v1', hostedValidationRevision: 'test-hosted-policy-v1' };

  const runtime = new Runtime();
  const github: GitHubAdapter = {
    kind: 'github',
    async readIssue(target) { return { target, title: 'native slice', body: 'controlled source', state: target.issueNumber === 42 && mergeComposition && mergeState === 'merged' ? 'closed' : 'open' }; },
    async readBranch() { throw new Error('unused'); },
    async listPullRequests() { return []; },
    async readPullRequest() { const snapshot = await github.readLiveSnapshot(TARGET); return { ...snapshot.pullRequest!, state: mergeComposition ? mergeState : 'merged', ...(mergeComposition && mergeState === 'merged' ? { mergeCommitSha: squash } : {}) }; },
    async squashPullRequest(owner, repo, number, expectedHead) { assert.equal(owner, TARGET.owner); assert.equal(repo, TARGET.repo); assert.equal(number, 7); assert.equal(expectedHead, head); squashes += 1; await mergeOperation(); },
    async readDefaultBranch() { return { branch: 'main', headSha: mainHead }; },
    async readCommit() { return proofCommit; },
    async isAncestor() { return proofAncestry; },
    async readLiveSnapshot(): Promise<GitHubLiveSnapshot> {
      snapshotReads += 1; onSnapshot?.();
      return {
        repository: { owner: TARGET.owner, repo: TARGET.repo, defaultBranch: 'main', defaultBranchHeadSha: liveBase },
        issue: { id: 'I_42', number: 42, title: 'native slice', body: 'controlled source', state: 'open', url: '', createdAt: T0, updatedAt: T0 },
        pullRequest: { id: 'PR_7', number: 7, title: 'native candidate', url: '', state: 'open', isDraft: false, mergeable: true, mergeStateStatus: 'CLEAN', updatedAt: T0,
          headSha: liveHead, baseSha: liveBase, headRef: 'candidate', headRepository: { owner: TARGET.owner, repo: TARGET.repo }, baseRef: 'main', baseRepository: { owner: TARGET.owner, repo: TARGET.repo } },
        headSha: liveHead, checks: { availability: 'available', overall: 'passing', checks: [{ id: 'test', name: 'test', state: 'passing', url: null, updatedAt: T0 }] },
        reviews: { decision: negativeReview ? 'changes_requested' : 'none', latestByAuthor: negativeReview ? [{ id: 'negative-no-thread', author: 'independent', state: 'changes_requested', commitSha: liveHead, submittedAt: now(), url: '', fresh: true }] : [], unresolvedThreads: 0 }, conversations: [], handoff: null, problems: [], observedAt: now(),
      };
    },
  };
  const host: NativeReviewerHost = {
    binding: { bindingId: 'controlled-release-binding', contractRevision: 'host-contract-v1', policyRevision: 'independent-unpromoted-v1', scope: 'complete-candidate', model: 'controlled-latest-oracle', supportedEfforts: ['Extra High'], authorActorIds: ['author'], allowTransportReplacement: true },
    receipts: receipts(), source: (b, h) => readNativeSourceManifest(repository, b, h),
    async submit(r) { submissions += 1; lastRequest = r; return await submit(r); },
    async observe(i, url) { observations += 1; return await observe(i, url); },
    authenticate(e) { return e.authentication.transportReceipt === oracleDigest({ identity: e.identity, result: e.result, actor: e.authentication.actorId }); },
  };
  const terminal = (r: RequestEvidence, changes = false, actor = 'independent-reviewer'): TerminalEvidence => {
    const result = changes ? { ...approval('controlled reviewer', head), verdict: 'request_changes' as const, findings: [{ severity: 'blocking' as const, summary: 'Preserve this finding', detail: 'Needs qualified lead disposition.' }] } : approval('controlled reviewer', head);
    return { id: `${r.identity.requestId}.terminal`, kind: 'terminal', identity: r.identity, result,
      authentication: { actorId: actor, model: r.identity.requestedModel, effort: r.identity.requestedEffort, transportReceipt: oracleDigest({ identity: r.identity, result, actor }) } };
  };
  const workflow = (binding: NativeReviewerHost | undefined = host, durableStore = store()): WorkflowDependencies => ({
    ...buildWorkflowDeps(durableStore, undefined, {}, undefined, binding, mergeHost), github,
    implementation: { kind: 'implementation-agent', async run() { modelCalls += 1; throw new Error('No implementation/repair model may run.'); } },
    validation: { kind: 'validation', configRevision: 'test-config-v1', async validate(request) { if (!mergeComposition) throw new Error('Fresh validation must be reused.'); validationCalls += 1; return validationPassed(request.headSha).local; } },
    hostedCheckPolicy: { revision: 'test-hosted-policy-v1', policy: { mode: 'required' } },
  });
  const seed = (state: 'REVIEWING' | 'FINAL_GATE' | 'MERGE_READY' | 'READY' | 'VALIDATING' = 'REVIEWING') => {
    let run = createRun(TARGET, T0, 'run-native', execution, 'claim-native', authority);
    if (state !== 'READY') {
      run = applyTransition(run, { type: 'start' }, T0);
      run = applyTransition(run, { type: 'agent_succeeded', agentResult: successResult(head), headSha: head, pullRequest: { number: 7, headSha: head } }, T0);
      if (state !== 'VALIDATING') run = applyTransition(run, { type: 'validation_passed', validationResult: validationPassed(head) }, T0);
      if (state !== 'REVIEWING' && state !== 'VALIDATING') run = applyTransition(run, { type: 'review_approved', reviewResult: approval('generic green', head) }, T0, TEST_VALIDATION_AUTHORITY);
      if (state === 'MERGE_READY') run = { ...run, state: 'MERGE_READY', history: [...run.history, { type: 'final_gate_verified', from: 'FINAL_GATE', to: 'MERGE_READY', at: T0 }] };
    }
    store().create(run);
    const claim: DispatchRuntimeClaim = { issue: 42, claimId: 'claim-native', runId: run.id, profile: execution.profile, repairTaskShapeAuthority: authority,
      state: state === 'MERGE_READY' ? 'merge_ready' : 'running', claimedAt: T0, heartbeatAt: T0, leaseUntil: T0 };
    runtime.comments = [{ id: 'runtime', body: renderDispatchRuntime(claim) }];
    return run;
  };
  const poll = async (binding: NativeReviewerHost | undefined = host, durableStore = store()) => {
    const wf = workflow(binding, durableStore);
    const admission = registry();
    return await dispatchOnceCommand(recoveryOnly ? issuedMergeRecoveryConfiguration(durableStore.read('run-native')!) : { ...config, ...(configuredMerge ? { merge: configuredMerge } : {}) }, {
      workflow: wf, runtime, admission, now, maintenanceHold: hold, issuedMergeRecoveryOnly: recoveryOnly,
      ...(mergeComposition ? { reconcileMergedRun: async (run: Run) => await reconcileDispatchMergedRunCommand(durableStore, run, github, admission, async (op) => op()), isRunOwnerRetired: (run: Run) => isDispatchRunOwnerRetiredCommand(durableStore, run, admission) } : {}),
      resolveExecutionProfile: () => execution,
      async runIssue(ref, selected, claimId, a, registry, _release, _lock, assertReviewClaim, assertMergeInitiation) { return await runIssueCommand(wf, ref, { execution: selected, dispatchClaimId: claimId, repairTaskShapeAuthority: a, admission: registry, runOwnerReceiptPath: mergeComposition && ref.endsWith('#43') ? undefined : receiptPath, admissionWorkspace: repository, now, assertReviewClaim, assertMergeInitiation, withDispatchAdmissionLock: async (op) => op() }); },
      async resumeClaimedRun(run, claimId, registry, _release, _lock, assertReviewClaim, assertMergeInitiation) { return await runIssueCommand(wf, 'acme/widgets#42', { execution: run.execution, dispatchClaimId: claimId, repairTaskShapeAuthority: run.repairTaskShapeAuthority, admission: registry, runOwnerReceiptPath: receiptPath, admissionWorkspace: repository, now, assertReviewClaim, assertMergeInitiation, withDispatchAdmissionLock: async (op) => op() }); },
    });
  };
  return { directory, repository, base, head, host, store, registry, receipts, runtime, receiptPath, workflow, seed, poll, terminal, github, now, git,
    tick: () => { clock += 31_000; }, counts: () => ({ modelCalls, submissions, observations, snapshotReads }), request: () => { assert.ok(lastRequest); return lastRequest; },
    setSubmit: (fn: typeof submit) => { submit = fn; }, setObserve: (fn: typeof observe) => { observe = fn; },
    setLiveHead: (h: string) => { liveHead = h; }, setLiveBase: (b: string) => { liveBase = b; }, setSnapshotHook: (fn: () => void) => { onSnapshot = fn; },
    armMerge: () => {
      const ready = store().read('run-native')!;
      store().update({ ...ready, bootstrap: { bootstrapKind: 'linked-worktree', owner: TARGET.owner, repo: TARGET.repo, issueNumber: 42, baseBranch: 'main', baseSha: base, branch: 'candidate', workspacePath: repository } });
      mergeHost = { policy: mergePolicy, candidate: (b, h) => readMergeCandidate(repository, b, h) }; configuredMerge = mergePolicy;
    },
    mergeCounts: () => ({ squashes }), validationCalls: () => validationCalls,
    setNegativeReview: () => { negativeReview = true; }, squash, tree,
    setMergeOperation: (fn: typeof mergeOperation) => { mergeOperation = fn; },
    setMergeState: (state: typeof mergeState) => { mergeState = state; },
    setMain: (sha: string) => { mainHead = sha; },
    setCommit: (commit: typeof proofCommit) => { proofCommit = commit; },
    setAncestry: (value: boolean) => { proofAncestry = value; },
    setRegistryPublish: (fn: () => void) => { onRegistryPublish = fn; },
    setRecoveryOnly: () => { recoveryOnly = true; },
    setHold: (value: boolean) => { hold = value; },
    setMergeHost: (value: NativeMergeHost | undefined) => { mergeHost = value; configuredMerge = value?.policy; },
    cleanup: () => { if (mergeComposition) os.userInfo = originalUserInfo; rmSync(directory, { recursive: true, force: true }); },
  };
}

describe('native review through the real factory / durable dispatcher', () => {
  it('reconciles live HEAD movement before final-gate native receipt qualification', async () => {
    const f = fixture();
    try {
      f.seed(); f.setSubmit(async (r) => ({ outcome: 'complete', evidence: f.terminal(r) }));
      f.setSnapshotHook(() => { if (f.counts().snapshotReads === 3) f.setLiveHead('e'.repeat(40)); });
      await f.poll();
      const run = f.store().read('run-native')!;
      assert.equal(run.state, 'NEEDS_HUMAN');
      assert.match(run.interrupt!.reason, /live GitHub HEAD/);
      assert.ok(run.interrupt!.choices!.includes('Sync the run to the live HEAD and continue'));
      assert.equal(f.counts().submissions, 1); assert.equal(f.counts().modelCalls, 0);
    } finally { f.cleanup(); }
  });

  it('revalidates retained native MERGE_READY through real dispatch before reporting cached readiness', async () => {
    const f = fixture();
    try {
      f.seed(); f.setSubmit(async (r) => ({ outcome: 'complete', evidence: f.terminal(r) })); await f.poll();
      assert.equal(f.store().read('run-native')!.state, 'MERGE_READY');
      const result = await f.poll({ ...f.host, binding: { ...f.host.binding, policyRevision: 'revoked' } });
      assert.equal(result.outcome, 'dispatched');
      const run = f.store().read('run-native')!;
      assert.equal(run.state, 'WAITING_DEPENDENCY');
      assert.equal(run.nativeReview!.wait!.kind, 'qualification');
      assert.equal(f.counts().submissions, 1); assert.equal(f.counts().observations, 0); assert.equal(f.counts().modelCalls, 0);
    } finally { f.cleanup(); }
  });

  it('waits before any implementation or reviewer spawn when default, malformed, disabled or unqualified binding is supplied', async () => {
    for (const bad of [undefined, {}, { binding: { available: false } }, { binding: { verified: true, model: 'oracle' } }, 'medium-only', 'high-only', 'contradictory-disabled', 'unknown-field']) {
      const f = fixture();
      try {
        const run = f.seed('READY');
        const binding = typeof bad !== 'string' ? bad as NativeReviewerHost | undefined : bad === 'medium-only' || bad === 'high-only'
          ? { ...f.host, binding: { ...f.host.binding, supportedEfforts: [bad === 'medium-only' ? 'Medium' as const : 'High' as const] } }
          : { ...f.host, binding: { ...f.host.binding, ...(bad === 'contradictory-disabled' ? { available: false } : { verified: true }) } };
        // Explicit undefined must use the default production factory, not the harness's controlled host default.
        const wf = f.workflow(f.host);
        const defaultFactory = buildWorkflowDeps(wf.store, undefined, {}, undefined, binding);
        const result = await runIssueCommand({ ...wf, reviewer: defaultFactory.reviewer }, 'acme/widgets#42', { execution, dispatchClaimId: run.dispatchClaimId, repairTaskShapeAuthority: authority, admission: f.registry(), runOwnerReceiptPath: f.receiptPath, admissionWorkspace: f.repository, now: f.now });
        assert.equal(result.outcome, 'waiting_dependency');
        assert.equal(result.run.interruptedFrom, 'READY');
        assert.match(result.run.interrupt!.reason, /Native review unavailable/);
        assert.equal(result.run.telemetry!.events.filter((e) => e.kind === 'spawn').length, 0);
        f.tick();
        assert.equal((await f.poll(binding ?? {} as NativeReviewerHost)).outcome, 'dispatched', 'retained dispatcher readmission still waits with zero execution');
        assert.deepEqual(f.counts(), { modelCalls: 0, submissions: 0, observations: 0, snapshotReads: 0 });
      } finally { f.cleanup(); }
    }
  });

  it('reconstructs the same claim / mission / request and exact returned URL, then consumes the authenticated receipt at the actual final gate', async () => {
    const f = fixture();
    try {
      const original = f.seed();
      assert.equal((await f.poll()).outcome, 'dispatched');
      const pending = f.store().read(original.id)!;
      assert.equal(pending.state, 'WAITING_DEPENDENCY');
      const request = f.request();
      assert.equal(request.identity.floor, 'R5', 'ordinary docs cannot lower the unpromoted native floor');
      assert.equal(request.identity.requestedEffort, 'Extra High');
      assert.equal(request.manifest.files[0]!.head!.text, 'Changed complete source\n');
      const firstOwner = f.registry().readLane(`run:${original.id}`)!;
      assert.equal(firstOwner.status, 'parked');
      assert.equal(readRunOwnerReceipt(f.receiptPath)!.phase, 'parked');
      assert.equal((await f.poll()).outcome, 'existing_claim', 'backoff is durable');
      f.setObserve(async (identity, url) => {
        assert.deepEqual(identity, request.identity);
        assert.equal(url, 'https://review.example.invalid/exact?conversation=returned');
        return { outcome: 'complete', evidence: f.terminal(request) };
      });
      f.tick();
      const result = await f.poll();
      assert.equal(result.outcome, 'dispatched');
      const complete = f.store().read(original.id)!;
      assert.equal(complete.state, 'MERGE_READY');
      assert.equal(complete.nativeReview!.requests.length, 1);
      assert.equal(complete.nativeReview!.accepted!.digest, oracleDigest(f.terminal(request)));
      assert.deepEqual(complete.nativeReview!.accepted!.identity, request.identity);
      assert.equal(f.registry().readLane(`run:${original.id}`)!.missionId, firstOwner.missionId);
      assert.ok(f.registry().readLane(`run:${original.id}`)!.generation > firstOwner.generation);
      assert.equal(complete.telemetry!.events.filter((e) => e.kind === 'spawn' && e.role === 'reviewer').length, 1);
      assert.equal(f.counts().submissions, 1); assert.equal(f.counts().observations, 1); assert.equal(f.counts().modelCalls, 0);
      const evidence = f.receipts().readNative(`${request.identity.requestId}.request`)!;
      f.receipts().recordNative(evidence);
      assert.throws(() => f.receipts().recordNative({ ...evidence, identity: { ...evidence.identity, missionId: 'foreign-mission' } }), /Conflicting/);
      assert.equal(f.receipts().list().length, 0, 'native evidence does not masquerade as legacy policy-qualified receipt');
    } finally { f.cleanup(); }
  });

  it('rejects malformed present optional host capabilities through claim-composed READY and REVIEWING entry before any execution', async () => {
    for (const state of ['READY', 'REVIEWING'] as const) {
      for (const field of ['observe', 'replacementDisposition'] as const) {
        for (const value of ['malformed-not-callable', null]) {
          const f = fixture();
          try {
            const binding = { ...f.host, [field]: value } as unknown as NativeReviewerHost;
            assert.equal(resolveNativeReviewer(binding).native!.available(), false, `${state}:${field}:${value}`);
            f.seed(state);
            assert.equal((await f.poll(binding)).outcome, 'dispatched');
            const run = f.store().read('run-native')!;
            assert.equal(run.state, 'WAITING_DEPENDENCY');
            assert.match(run.interrupt!.reason, /Native review unavailable/);
            assert.equal(run.nativeReview!.requests.length, 0);
            assert.equal(run.telemetry!.events.filter((e) => e.kind === 'spawn').length, 0);
            assert.equal(f.counts().modelCalls, 0);
            assert.equal(f.counts().submissions, 0);
            assert.equal(f.counts().observations, 0);
            assert.equal(f.registry().readLane('run:run-native')!.status, 'parked');
          } finally { f.cleanup(); }
        }
      }
    }
  });

  it('parks pending native review on returned GitHub infrastructure failure, preserves overlap ownership and resumes the original request', async () => {
    for (const retryable of [false, true]) {
      const f = fixture();
      try {
        f.seed(); await f.poll();
        const pending = f.store().read('run-native')!;
        const request = f.request();
        const owner = f.registry().readLane('run:run-native')!;
        const readSnapshot = f.github.readLiveSnapshot;
        f.github.readLiveSnapshot = async () => { throw Object.assign(new Error('controlled GitHub read infrastructure failure'), { retryable }); };
        f.tick();
        const failure = await f.poll();
        assert.equal(failure.outcome, 'dispatched');
        if (failure.outcome !== 'dispatched') throw new Error('Expected returned workflow wait.');
        assert.equal(failure.execution.state, 'WAITING_DEPENDENCY');
        const waiting = f.store().read('run-native')!;
        assert.equal(waiting.interruptedFrom, 'REVIEWING');
        assert.equal(waiting.nativeReview!.wait!.kind, 'request');
        assert.match(waiting.interrupt!.reason, /controlled GitHub read infrastructure failure/);
        assert.deepEqual(activeNativeReview(waiting), activeNativeReview(pending));
        assert.equal(waiting.history.some((event) => event.type === 'fail'), false);
        const retainedOwner = f.registry().readLane('run:run-native')!;
        assert.equal(retainedOwner.status, 'parked');
        assert.equal(retainedOwner.parkedReason, 'workflow_wait');
        assert.equal(retainedOwner.missionId, owner.missionId);
        assert.ok(retainedOwner.generation > owner.generation);
        const receipt = readRunOwnerReceipt(f.receiptPath)!;
        assert.equal(receipt.phase, 'parked');
        assert.equal(receipt.workDisposition, undefined);
        assert.equal(receipt.claimId, request.identity.claimId);
        const overlap = f.registry().admit({ laneId: 'competing-owner', role: 'production_captain', evidence: { repository: 'acme/widgets', issue: 42 } });
        assert.notEqual(overlap.outcome, 'admitted', 'remote pending work retains its mission overlap reservation');
        assert.equal(f.store().list().length, 1);
        assert.equal(f.counts().submissions, 1); assert.equal(f.counts().observations, 0); assert.equal(f.counts().modelCalls, 0);
        assert.equal(waiting.telemetry!.events.filter((e) => e.kind === 'spawn').length, 1);
        assert.equal((await f.poll()).outcome, 'existing_claim', 'infrastructure failure respects durable wait backoff');
        f.github.readLiveSnapshot = readSnapshot;
        f.setObserve(async (identity, url) => {
          assert.deepEqual(identity, request.identity);
          assert.equal(url, activeNativeReview(pending)!.conversationUrl);
          return { outcome: 'complete', evidence: f.terminal(request) };
        });
        f.tick(); await f.poll();
        const ready = f.store().read('run-native')!;
        assert.equal(ready.state, 'MERGE_READY');
        assert.equal(ready.nativeReview!.requests.length, 1);
        assert.equal(ready.nativeReview!.accepted!.requestId, request.identity.requestId);
        assert.equal(f.counts().submissions, 1); assert.equal(f.counts().observations, 1); assert.equal(f.counts().modelCalls, 0);
      } finally { f.cleanup(); }
    }
  });

  it('centrally parks an unresolved native owner even if workflow returns FAILED, while preserving ordinary failure release', async () => {
    for (const pendingReview of [true, false]) {
      const f = fixture();
      try {
        f.seed(); if (pendingReview) await f.poll();
        const before = f.store().read('run-native')!;
        const workflow = f.workflow();
        let faultApplied = false;
        const outcome = await runIssueCommand(workflow, 'acme/widgets#42', {
          execution, dispatchClaimId: before.dispatchClaimId, repairTaskShapeAuthority: authority,
          admission: f.registry(), runOwnerReceiptPath: f.receiptPath, admissionWorkspace: f.repository, now: f.now,
          // A completed local failure between owner admission and workflow
          // entry exercises returned-outcome settlement independently of the
          // review loop's infrastructure-error handling and exception catch.
          releaseDispatchAdmissionLock: () => {
            if (faultApplied) return;
            faultApplied = true;
            const current = workflow.store.read(before.id)!;
            const failed = applyTransition(current, { type: 'fail', reason: 'controlled local terminal outcome' }, f.now());
            assert.equal(workflow.store.updateIfUnchanged!(current, failed), true);
          },
        });
        assert.equal(faultApplied, true);
        assert.equal(outcome.outcome, 'failed');
        assert.equal(outcome.run.state, 'FAILED');
        const owner = f.registry().readLane('run:run-native')!;
        const receipt = readRunOwnerReceipt(f.receiptPath)!;
        assert.equal(owner.status, pendingReview ? 'parked' : 'released');
        assert.equal(receipt.phase, pendingReview ? 'parked' : 'released');
        assert.equal(receipt.workDisposition, undefined);
        if (pendingReview) {
          assert.equal(owner.parkedReason, 'workflow_wait');
          assert.deepEqual(activeNativeReview(outcome.run), activeNativeReview(before));
          assert.equal(activeNativeReview(outcome.run)!.submissionPossible, true);
        }
        assert.equal(f.counts().modelCalls, 0); assert.equal(f.counts().observations, 0);
        assert.equal(f.counts().submissions, pendingReview ? 1 : 0);
      } finally { f.cleanup(); }
    }
  });

  it('accepts authenticated telemetry-bearing approval at final and reconstructed cached gates while retaining full receipt authentication and digest', async () => {
    for (const tamper of ['semantic-review', 'receipt-telemetry'] as const) {
      const f = fixture();
      try {
        f.seed();
        let terminal: TerminalEvidence | undefined;
        f.setSubmit(async (request) => {
          const evidence = f.terminal(request);
          const result = { ...evidence.result, telemetry: { provider: 'qualified-controlled-transport', model: request.identity.requestedModel, reasoningEffort: request.identity.requestedEffort, turns: 1, usage: { inputTokens: 12, outputTokens: 7 } } };
          terminal = { ...evidence, result, authentication: { ...evidence.authentication, transportReceipt: oracleDigest({ identity: request.identity, result, actor: evidence.authentication.actorId }) } };
          return { outcome: 'complete', evidence: terminal };
        });
        await f.poll();
        const ready = f.store().read('run-native')!;
        assert.equal(ready.state, 'MERGE_READY');
        assert.ok(terminal);
        assert.equal(ready.reviewResult!.telemetry, undefined, 'state machine retains its semantic review projection');
        assert.equal(ready.nativeReview!.accepted!.digest, oracleDigest(terminal));
        assert.deepEqual(f.receipts().readNative(terminal.id), terminal, 'full authenticated usage/provenance evidence is retained');
        const cached = () => runIssueCommand(f.workflow(), 'acme/widgets#42', {
          execution, dispatchClaimId: ready.dispatchClaimId, repairTaskShapeAuthority: authority,
          admission: f.registry(), runOwnerReceiptPath: f.receiptPath, admissionWorkspace: f.repository, now: f.now,
          assertReviewClaim: async (run) => {
            const live = selectDispatchRuntime(await f.runtime.listRuntimeComments())!.claim;
            assert.equal(live.claimId, run.dispatchClaimId); assert.equal(live.runId, run.id); assert.equal(live.issue, TARGET.issueNumber);
          },
        });
        assert.equal((await cached()).outcome, 'merge_ready', 'a fresh factory/store/admission rechecks cached qualification');
        if (tamper === 'semantic-review') {
          const current = f.store().read(ready.id)!;
          assert.equal(f.store().updateIfUnchanged(current, { ...current, reviewResult: { ...current.reviewResult!, findings: [{ severity: 'non_blocking', summary: 'foreign semantic review' }] } }), true);
        } else {
          // Deliberately corrupt the immutable file outside its no-replace
          // writer: ignoring telemetry for semantic equality must not omit it
          // from receipt authentication or its accepted digest.
          writeFileSync(path.join(f.directory, 'oracle', 'native', `${terminal.id}.json`), JSON.stringify({ ...terminal, result: { ...terminal.result, telemetry: { ...terminal.result.telemetry, turns: 2 } } }));
        }
        const rejected = await cached();
        assert.equal(rejected.outcome, 'waiting_dependency', tamper);
        assert.equal(rejected.run.nativeReview!.wait!.kind, 'qualification');
        assert.equal(rejected.run.nativeReview!.accepted!.digest, ready.nativeReview!.accepted!.digest);
        assert.equal(f.counts().submissions, 1); assert.equal(f.counts().observations, 0); assert.equal(f.counts().modelCalls, 0);
      } finally { f.cleanup(); }
    }
  });

  it('retains qualified changes-required findings and parks without lead transport or repair', async () => {
    const f = fixture();
    try {
      f.seed(); f.setSubmit(async (r) => ({ outcome: 'complete', evidence: f.terminal(r, true) }));
      await f.poll();
      const run = f.store().read('run-native')!;
      assert.equal(run.state, 'WAITING_DEPENDENCY'); assert.equal(run.interruptedFrom, 'CHANGES_REQUESTED');
      assert.equal(run.reviewResult!.findings[0]!.summary, 'Preserve this finding');
      assert.equal(run.nativeReview!.wait!.kind, 'lead');
      assert.equal(f.counts().modelCalls, 0); assert.equal(run.repairAdmissions, undefined);
    } finally { f.cleanup(); }
  });

  it('keeps every valid legacy suffix readable in a disjoint namespace and prevents legacy writes from replacing native evidence', async () => {
    const f = fixture();
    try {
      const legacy = (id: string): OracleReceipt => ({ id, target: TARGET, requestedHeadSha: f.head, observedHeadSha: f.head, outcome: 'approved', reviewedAt: T0, blockingFindingCount: 0, nonBlockingFindingCount: 0 });
      f.receipts().record(legacy('legacy.native'));
      assert.deepEqual(f.receipts().list(), [{ ...legacy('legacy.native'), policyQualified: false }]);
      f.seed();
      f.setSubmit(async (request) => {
        const terminal = f.terminal(request);
        // These were actual shared filenames before namespace isolation.
        // Include a legacy write after request publication and before terminal
        // publication so isolation works in both directions and on restart.
        f.receipts().record(legacy(`${request.id}.native`));
        f.receipts().record(legacy(`${terminal.id}.native`));
        return { outcome: 'complete', evidence: terminal };
      });
      await f.poll();
      const ready = f.store().read('run-native')!;
      assert.equal(ready.state, 'MERGE_READY');
      const request = f.request(); const terminal = f.terminal(request);
      const requestFile = path.join(f.directory, 'oracle', 'native', `${request.id}.json`);
      const terminalFile = path.join(f.directory, 'oracle', 'native', `${terminal.id}.json`);
      const beforeRequest = readFileSync(requestFile, 'utf8');
      const beforeTerminal = readFileSync(terminalFile, 'utf8');
      const legacyIds = ['legacy.native', `${request.id}.native`, `${terminal.id}.native`];
      for (const id of legacyIds) f.receipts().record(legacy(id));
      assert.deepEqual(f.receipts().list().map((r) => r.id).sort(), legacyIds.sort());
      assert.ok(f.receipts().list().every((r) => r.policyQualified === false));
      assert.equal(readFileSync(requestFile, 'utf8'), beforeRequest);
      assert.equal(readFileSync(terminalFile, 'utf8'), beforeTerminal);
      assert.deepEqual(f.receipts().readNative(request.id), request);
      assert.deepEqual(f.receipts().readNative(terminal.id), terminal);
      assert.equal(ready.nativeReview!.accepted!.digest, oracleDigest(terminal));
      f.receipts().recordNative(terminal);
      assert.throws(() => f.receipts().recordNative({ ...terminal, result: { ...terminal.result, findings: [{ severity: 'non_blocking', summary: 'conflicting immutable finding' }] } }), /Conflicting immutable/);
      assert.equal(readFileSync(terminalFile, 'utf8'), beforeTerminal);

      const oldRoot = path.join(f.directory, 'unqualified-flat-format');
      const oldStore = new JsonFileOracleReceiptStore(oldRoot);
      const oldFile = path.join(oldRoot, `${terminal.id}.native.json`);
      writeFileSync(oldFile, JSON.stringify(terminal));
      assert.equal(oldStore.readNative(terminal.id), null, 'flat ambiguous files never acquire native qualification');
      assert.throws(() => oldStore.list(), /Invalid Oracle receipt/, 'non-legacy flat schema fails closed instead of being hidden or promoted');
      assert.deepEqual(JSON.parse(readFileSync(oldFile, 'utf8')), terminal, 'ambiguous old evidence is retained unchanged');
    } finally { f.cleanup(); }
  });

  it('does not promote generic FINAL_GATE / cached MERGE_READY approvals or verified:true', async () => {
    for (const state of ['FINAL_GATE', 'MERGE_READY'] as const) {
      const f = fixture();
      try {
        const run = f.seed(state);
        const outcome = await runIssueCommand(f.workflow(), 'acme/widgets#42', { execution, dispatchClaimId: run.dispatchClaimId, repairTaskShapeAuthority: authority, admission: f.registry(), runOwnerReceiptPath: f.receiptPath, admissionWorkspace: f.repository, now: f.now });
        assert.equal(outcome.outcome, 'waiting_dependency');
        assert.match(outcome.run.interrupt!.reason, /native|Native/);
        assert.equal(outcome.run.nativeReview!.accepted, undefined);
        assert.equal(f.counts().submissions, 0);
      } finally { f.cleanup(); }
    }
  });

  it('uses a durable finite observation budget and idle backoff without blind resend or busy loop', async () => {
    const f = fixture();
    try {
      f.seed(); await f.poll();
      const drive = await dispatchContinuously({ dispatchOnce: () => f.poll(), sleep: async () => { f.tick(); }, idlePollMs: 30_000, maxCycles: 6 });
      assert.ok(drive.idleWaits >= 4);
      assert.equal(f.counts().observations, 3);
      assert.equal(f.counts().submissions, 1);
      f.tick(); assert.equal((await f.poll()).outcome, 'existing_claim');
      assert.equal(nativeReviewReentry(f.store().read('run-native')!, f.now()), false);
    } finally { f.cleanup(); }
  });

  it('permits one durable transport-failure replacement and rejects late originals / further replacements', async () => {
    const f = fixture();
    try {
      f.seed(); f.setSubmit(async () => ({ outcome: 'incomplete', reason: 'transport_failure' }));
      await f.poll(); const original = f.request();
      f.tick(); await f.poll(); const replacement = f.request();
      assert.notEqual(replacement.identity.requestId, original.identity.requestId);
      const run = f.store().read('run-native')!;
      assert.equal(run.nativeReview!.requests.length, 2);
      assert.equal(run.nativeReview!.requests[0]!.status, 'replaced');
      f.receipts().recordNative(f.terminal(original));
      f.tick(); await f.poll();
      assert.equal(f.store().read('run-native')!.nativeReview!.accepted, undefined);
      assert.equal(f.counts().submissions, 2);
      assert.equal(f.store().read('run-native')!.nativeReview!.requests.length, 2);
      assert.equal(f.store().read('run-native')!.state, 'WAITING_DEPENDENCY');
    } finally { f.cleanup(); }
  });

  it('never turns safety refusal into replacement eligibility, even after restart/configuration churn', async () => {
    const f = fixture();
    try {
      f.seed(); f.setSubmit(async () => ({ outcome: 'incomplete', reason: 'safety_refusal' }));
      await f.poll(); f.tick();
      assert.equal((await f.poll()).outcome, 'existing_claim');
      const run = f.store().read('run-native')!;
      assert.equal(activeNativeReview(run)!.failure, 'safety_refusal');
      assert.equal(f.counts().submissions, 1); assert.equal(run.nativeReview!.requests.length, 1);
    } finally { f.cleanup(); }
  });

  it('reenters a binding-only wait through the retained dispatcher claim when trusted availability changes', async () => {
    const f = fixture();
    try {
      f.seed();
      await f.poll({} as NativeReviewerHost);
      const blocked = f.store().read('run-native')!;
      assert.equal(blocked.nativeReview!.activeRequestId, undefined);
      assert.equal(blocked.nativeReview!.wait!.kind, 'binding');
      f.tick();
      await f.poll();
      const pending = f.store().read('run-native')!;
      assert.equal(pending.dispatchClaimId, blocked.dispatchClaimId);
      assert.equal(pending.nativeReview!.requests.length, 1);
      assert.equal(f.counts().submissions, 1);
    } finally { f.cleanup(); }
  });

  it('records unknown unsupported recovery and uses only an explicit qualified irrecoverable-transport disposition for one replacement', async () => {
    const f = fixture();
    try {
      f.seed(); await f.poll(); const original = f.request();
      const { observe: _observe, ...unsupported } = f.host;
      f.tick(); await f.poll(unsupported);
      assert.equal(activeNativeReview(f.store().read('run-native')!)!.status, 'terminal_unknown');
      assert.equal(f.counts().submissions, 1);
      f.tick();
      await f.poll({ ...unsupported, replacementDisposition: () => 'irrecoverable_transport' });
      const replaced = f.store().read('run-native')!;
      assert.equal(replaced.nativeReview!.requests.length, 2);
      assert.equal(replaced.nativeReview!.requests[0]!.terminalStatus, 'terminal_unknown');
      assert.equal(replaced.nativeReview!.requests[0]!.retirementReason, 'irrecoverable_transport');
      assert.equal(replaced.nativeReview!.requests[0]!.failure, undefined, 'unknown is not fabricated transport failure/cancellation');
      f.receipts().recordNative(f.terminal(original));
      f.tick(); await f.poll(unsupported);
      f.tick(); await f.poll({ ...unsupported, replacementDisposition: () => 'irrecoverable_transport' });
      assert.equal(f.store().read('run-native')!.nativeReview!.accepted, undefined);
      assert.equal(f.counts().submissions, 2);
    } finally { f.cleanup(); }
  });

  it('retains original correlation without inventing a URL after remote acceptance and lost acknowledgement', async () => {
    const f = fixture();
    try {
      f.seed();
      f.setSubmit(async () => { throw new Error('accepted remotely; acknowledgement lost'); });
      await f.poll();
      const request = f.request();
      assert.equal(activeNativeReview(f.store().read('run-native')!)!.status, 'terminal_unknown');
      assert.equal(activeNativeReview(f.store().read('run-native')!)!.conversationUrl, undefined);
      f.setObserve(async (identity, url) => { assert.deepEqual(identity, request.identity); assert.equal(url, undefined); return { outcome: 'complete', evidence: f.terminal(request) }; });
      f.tick(); await f.poll();
      assert.equal(f.store().read('run-native')!.state, 'MERGE_READY');
      assert.equal(f.counts().submissions, 1);
    } finally { f.cleanup(); }
  });

  it('preserves immutable source objects despite worktree changes and rejects absent/truncated source or diff before submission', async () => {
    const f = fixture();
    try {
      const manifest = readNativeSourceManifest(f.repository, f.base, f.head);
      writeFileSync(path.join(f.repository, 'README.md'), 'uncommitted worktree content must not enter review');
      assert.deepEqual(readNativeSourceManifest(f.repository, f.base, f.head), manifest);
      assert.equal(validNativeSourceManifest({ ...manifest, files: manifest.files.map((file) => ({ ...file, head: { ...file.head!, text: 'truncated' } })) }), false);
      f.seed();
      await f.poll({ ...f.host, source: () => ({ ...manifest, diff: '' }) });
      assert.equal(f.counts().submissions, 0);
      assert.match(f.store().read('run-native')!.interrupt!.reason, /incomplete|source/);
    } finally { f.cleanup(); }
  });

  it('rejects foreign identity, missing required provenance, self review and generic verified output from the actual loop', async () => {
    const mutations: readonly (readonly [string, (e: TerminalEvidence) => unknown])[] = [
      ...(['runId', 'claimId', 'missionId', 'targetKey', 'repository', 'scope', 'policyRevision', 'contractRevision', 'bindingId', 'requestedModel', 'role', 'phase', 'requestId', 'correlationId'] as const).map((key) => [key, (e: TerminalEvidence) => ({ ...e, identity: { ...e.identity, [key]: 'foreign' } })] as const),
      ['PR', (e) => ({ ...e, identity: { ...e.identity, pullRequestNumber: 999 } })],
      ['base', (e) => ({ ...e, identity: { ...e.identity, baseSha: 'b'.repeat(40) } })],
      ['HEAD', (e) => ({ ...e, identity: { ...e.identity, headSha: 'c'.repeat(40) } })],
      ['evidence', (e) => ({ ...e, identity: { ...e.identity, sourceSha256: 'd'.repeat(64) } })],
      ['unknown model', (e) => ({ ...e, authentication: { ...e.authentication, model: 'UNKNOWN' } })],
      ['unknown effort', (e) => ({ ...e, authentication: { ...e.authentication, effort: null } })],
      ['lower floor under all-efforts host', (e) => ({ ...e, identity: { ...e.identity, floor: 'R3', requestedEffort: 'Medium' }, authentication: { ...e.authentication, effort: 'Medium' } })],
      ['verified only', (e) => ({ ...e, authentication: undefined, verified: true })],
      ['bad receipt authentication', (e) => ({ ...e, authentication: { ...e.authentication, transportReceipt: 'forged' } })],
    ];
    for (const [name, mutate] of mutations) {
      const f = fixture();
      try {
        f.seed(); f.setSubmit(async (r) => ({ outcome: 'complete', evidence: mutate(f.terminal(r)) as TerminalEvidence }));
        await f.poll({ ...f.host, binding: { ...f.host.binding, supportedEfforts: ['Medium', 'High', 'Extra High'] } });
        const run = f.store().read('run-native')!;
        assert.equal(run.state, 'WAITING_DEPENDENCY', name);
        assert.equal(run.nativeReview!.accepted, undefined, name);
        assert.equal(f.counts().submissions, 1, name);
        assert.equal(f.counts().modelCalls, 0, name);
      } finally { f.cleanup(); }
    }
    const f = fixture();
    try {
      f.seed(); f.setSubmit(async (r) => ({ outcome: 'complete', evidence: f.terminal(r, false, 'author') }));
      await f.poll();
      assert.equal(f.store().read('run-native')!.nativeReview!.accepted, undefined, 'authenticated self-review still cannot qualify');
    } finally { f.cleanup(); }
  });

  it('rechecks host policy and base after review completion and during the real final-gate live read', async () => {
    for (const change of ['policy', 'base'] as const) {
      const f = fixture();
      try {
        f.seed(); f.setSubmit(async (r) => ({ outcome: 'complete', evidence: f.terminal(r) }));
        f.setSnapshotHook(() => {
          if (f.counts().snapshotReads === 3) {
            if (change === 'policy') (f.host.binding as { policyRevision: string }).policyRevision = 'changed-policy';
            else f.setLiveBase('f'.repeat(40));
          }
        });
        await f.poll();
        assert.equal(f.store().read('run-native')!.state, 'WAITING_DEPENDENCY', change);
        assert.equal(f.store().read('run-native')!.nativeReview!.wait!.kind, 'qualification', change);
        assert.equal(f.counts().modelCalls, 0);
      } finally { f.cleanup(); }
    }
  });

  it('retains an observation exception as uncertainty without releasing the inherited pending owner or starting the next row', async () => {
    const f = fixture();
    try {
      f.seed(); await f.poll();
      const before = f.store().read('run-native')!;
      const spawnCount = before.telemetry!.events.filter((e) => e.kind === 'spawn').length;
      f.setObserve(async () => { throw new Error('read-only observation unavailable'); });
      f.tick(); await f.poll();
      const after = f.store().read('run-native')!;
      assert.equal(activeNativeReview(after)!.status, 'terminal_unknown');
      assert.equal(f.registry().readLane('run:run-native')!.status, 'parked');
      assert.equal(readRunOwnerReceipt(f.receiptPath)!.phase, 'parked');
      assert.equal(after.telemetry!.events.filter((e) => e.kind === 'spawn').length, spawnCount);
      assert.equal(f.store().list().length, 1);
      assert.equal(f.counts().submissions, 1);
      assert.throws(() => recoverRunAdmission(f.store(), f.registry(), after.id, readRunOwnerReceipt(f.receiptPath)!.generation, true, f.receiptPath, { retireWork: true }), /cannot retire/);
    } finally { f.cleanup(); }
  });

  it('preserves an actual concurrent file-store winner and rejects a stale owner generation while observation resolves', async () => {
    for (const race of ['run', 'owner'] as const) {
      const f = fixture();
      try {
        f.seed(); await f.poll(); const request = f.request();
        f.setObserve(async () => {
          if (race === 'run') {
            const other = f.store(); const current = other.read('run-native')!;
            other.update({ ...current, updatedAt: '2026-08-14T00:59:00.000Z' });
          } else {
            const receipt = readRunOwnerReceipt(f.receiptPath)!;
            f.registry().park(receipt.token!, 'workflow_wait');
          }
          return { outcome: 'complete', evidence: f.terminal(request) };
        });
        f.tick();
        if (race === 'owner') await assert.rejects(f.poll(), /generation|capability|owner|stale/i);
        else await f.poll();
        const durable = f.store().read('run-native')!;
        assert.equal(durable.nativeReview!.accepted, undefined, race);
        if (race === 'run') assert.equal(durable.updatedAt, '2026-08-14T00:59:00.000Z');
        assert.equal(f.counts().submissions, 1);
      } finally { f.cleanup(); }
    }
  });

  it('distinguishes pre-marker crash, post-marker crash, URL loss and terminal-evidence/CAS cuts across reconstructed real stores', async () => {
    for (const cut of ['before-marker', 'after-marker', 'before-url', 'before-accepted-cas', 'after-accepted-cas'] as const) {
      const f = fixture();
      try {
        f.seed();
        if (cut.includes('accepted')) f.setSubmit(async (r) => ({ outcome: 'complete', evidence: f.terminal(r) }));
        const store = f.store(); const cas = store.updateIfUnchanged.bind(store);
        let tripped = false;
        store.updateIfUnchanged = (expected, next) => {
          const before = activeNativeReview(expected); const after = activeNativeReview(next);
          const trigger = !tripped && (cut === 'before-marker' && before?.submissionPossible === false && after?.submissionPossible === true ||
            cut === 'after-marker' && before?.submissionPossible === true && next.telemetry!.events.length > expected.telemetry!.events.length ||
            cut === 'before-url' && before?.conversationUrl === undefined && after?.conversationUrl !== undefined ||
            cut.includes('accepted') && expected.nativeReview?.accepted === undefined && next.nativeReview?.accepted !== undefined);
          if (trigger) {
            tripped = true;
            if (cut === 'after-accepted-cas') cas(expected, next);
            throw new Error(`controlled crash ${cut}`);
          }
          return cas(expected, next);
        };
        await assert.rejects(f.poll(f.host, store), /controlled crash/);
        assert.equal(tripped, true, cut);
        const durable = f.store().read('run-native')!;
        const active = activeNativeReview(durable)!;
        assert.equal(active.submissionPossible, cut !== 'before-marker', cut);
        if (cut === 'before-url') assert.equal(active.conversationUrl, undefined);
        const localOwner = f.registry().readLane('run:run-native')!;
        if (localOwner.status === 'active') recoverRunAdmission(f.store(), f.registry(), durable.id, localOwner.generation, true, f.receiptPath);
        const evidence = f.receipts().readNative(`${active.identity.requestId}.request`) as RequestEvidence;
        f.setObserve(async (identity, url) => { assert.deepEqual(identity, active.identity); assert.equal(url, undefined); return { outcome: 'complete', evidence: f.terminal(evidence) }; });
        f.setSubmit(async (r) => ({ outcome: 'complete', evidence: f.terminal(r) }));
        f.tick(); await f.poll();
        const recovered = f.store().read('run-native')!;
        assert.equal(recovered.state, 'MERGE_READY', cut);
        assert.equal(recovered.nativeReview!.requests.length, 1, cut);
        assert.equal(recovered.nativeReview!.activeRequestId, active.identity.requestId, cut);
        assert.equal(f.counts().submissions, cut === 'after-marker' ? 0 : 1, cut);
        assert.equal(f.counts().observations, cut === 'after-marker' || cut === 'before-url' ? 1 : 0, cut);
      } finally { f.cleanup(); }
    }
  });

  it('rejects malformed or rolled-back native ledgers at the real file-store boundary', async () => {
    const f = fixture();
    try {
      f.seed(); await f.poll(); const run = f.store().read('run-native')!;
      const active = activeNativeReview(run)!;
      const rolledBack = { ...run, nativeReview: { ...run.nativeReview!, requests: [{ ...active, submissionPossible: false }] } };
      assert.throws(() => f.store().update(rolledBack), /monotonic/);
      assert.throws(() => f.store().update({ ...run, nativeReview: undefined }), /monotonic/);
      const file = path.join(f.directory, 'runs', `${run.id}.json`);
      const json = JSON.parse(readFileSync(file, 'utf8'));
      json.nativeReview.requests[0].identity.claimId = 'foreign-claim';
      writeFileSync(file, JSON.stringify(json));
      assert.throws(() => f.store().read(run.id), /corrupt or incompatible/);
      assert.equal(nativeReviewCoherent({ ...run, nativeReview: { requests: [] } }), true, 'read compatibility adds no qualification');
    } finally { f.cleanup(); }
  });

  it('retains observed external merged proof without native settlement or owner release; historical MERGED retry remains unchanged', async () => {
    const f = fixture();
    try {
      f.seed(); f.setSubmit(async (r) => ({ outcome: 'complete', evidence: f.terminal(r) })); await f.poll();
      const ready: Run = { ...f.store().read('run-native')!, bootstrap: { bootstrapKind: 'linked-worktree', owner: TARGET.owner, repo: TARGET.repo, issueNumber: TARGET.issueNumber, baseBranch: 'main', baseSha: f.base, branch: 'candidate', workspacePath: f.repository } };
      f.store().update(ready);
      const owner = f.registry().readLane('run:run-native')!;
      await assert.rejects(runMergedTransitionCommand(f.store(), ready.id, f.github, f.registry(), async (op) => op()), /Merged PR observed.*unqualified/);
      const observed = f.store().read(ready.id)!;
      assert.equal(observed.state, 'WAITING_DEPENDENCY');
      assert.equal(JSON.parse(observed.interrupt!.evidence!).state, 'merged');
      assert.deepEqual(f.registry().readLane('run:run-native'), owner);
      // Historical terminal records are read-compatible; no new transition or native credit.
      const historical: Run = { ...ready, state: 'MERGED' };
      const historyStore = new JsonFileStore({ dir: path.join(f.directory, 'historical') }); historyStore.create(historical);
      const beforeRetry = historyStore.read(historical.id);
      await assert.rejects(runMergedTransitionCommand(historyStore, historical.id, f.github, f.registry(), async (op) => op()), /Historical terminal Run remains readable and unchanged/);
      assert.deepEqual(historyStore.read(historical.id), beforeRetry);
    } finally { f.cleanup(); }
  });

  it('awaits current retained claim after the durable marker and again when observation returns', async () => {
    for (const boundary of ['submission', 'observation'] as const) {
      const f = fixture();
      try {
        f.seed();
        const replaceClaim = () => {
          const selected = selectDispatchRuntime(f.runtime.comments)!;
          f.runtime.comments = [{ id: selected.id, body: renderDispatchRuntime({ ...selected.claim, claimId: 'replaced-claim' }) }];
        };
        if (boundary === 'submission') {
          const store = f.store(); const cas = store.updateIfUnchanged.bind(store);
          store.updateIfUnchanged = (expected, next) => {
            const matched = cas(expected, next);
            if (matched && activeNativeReview(expected)?.submissionPossible === false && activeNativeReview(next)?.submissionPossible === true) replaceClaim();
            return matched;
          };
          await assert.rejects(f.poll(f.host, store), /claim.*replaced|claim changed|could not start safely/i);
          assert.equal(f.counts().submissions, 0);
        } else {
          await f.poll(); const request = f.request();
          f.setObserve(async () => { replaceClaim(); return { outcome: 'complete', evidence: f.terminal(request) }; });
          f.tick(); await assert.rejects(f.poll(), /claim.*replaced|claim changed|could not start safely/i);
          assert.equal(f.counts().submissions, 1);
        }
        const durable = f.store().read('run-native')!;
        assert.equal(durable.nativeReview!.accepted, undefined);
        assert.equal(activeNativeReview(durable)!.submissionPossible, true);
        assert.equal(f.registry().readLane('run:run-native')!.status, 'active', 'durable marker prevents catch-path pre-execution release');
        assert.equal(durable.telemetry!.events.filter((e) => e.kind === 'spawn').length, boundary === 'submission' ? 0 : 1);
      } finally { f.cleanup(); }
    }
  });

  it('bounds aggregate Git acquisition and forbids lazy fetching / ambient Git or credential environment', () => {
    const f = fixture();
    const previousPath = process.env.PATH;
    const previousDir = process.env.GIT_DIR;
    const previousSentinel = process.env.NATIVE_TEST_CREDENTIAL;
    try {
      for (let i = 0; i < 25; i++) writeFileSync(path.join(f.repository, `many-${i}.txt`), 'x'.repeat(100_000));
      f.git('add', '.'); f.git('commit', '--quiet', '-m', 'aggregate bound');
      const oversized = f.git('rev-parse', 'HEAD');
      const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
      const shimDir = path.join(f.directory, 'tools'); mkdirSync(shimDir);
      const trace = path.join(f.directory, 'local-object-invocations');
      const shim = path.join(shimDir, 'git');
      // Only fixed fixture paths enter this shell script; no user/secret text.
      writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$GIT_NO_LAZY_FETCH:$GIT_TERMINAL_PROMPT:$NATIVE_TEST_CREDENTIAL:$GIT_DIR:$*" >> '${trace}'\nexec '${realGit}' "$@"\n`); chmodSync(shim, 0o755);
      process.env.PATH = `${shimDir}:${previousPath}`;
      process.env.GIT_DIR = path.join(f.directory, 'foreign-git-dir');
      process.env.NATIVE_TEST_CREDENTIAL = 'must-not-propagate';
      assert.throws(() => readNativeSourceManifest(f.repository, f.base, oversized), /ENOBUFS|bound|buffer/i);
      const calls = readFileSync(trace, 'utf8').trim().split('\n');
      assert.ok(calls.length < 30, 'aggregate acquisition stops before collecting all blobs');
      assert.ok(calls.every((line) => line.startsWith('1:0:::')), 'no ambient Git location or credential env is inherited');
      process.env.PATH = previousPath;
      if (previousDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previousDir;
      const blob = f.git('rev-parse', `${f.head}:README.md`);
      f.git('config', 'remote.origin.promisor', 'true');
      f.git('config', 'remote.origin.url', 'unsupported-native-fixture://must-not-fetch');
      const object = path.join(f.repository, '.git', 'objects', blob.slice(0, 2), blob.slice(2));
      assert.equal(existsSync(object), true); unlinkSync(object);
      process.env.PATH = `${shimDir}:${previousPath}`;
      assert.throws(() => readNativeSourceManifest(f.repository, f.base, f.head), /Command failed|object|blob/i);
      assert.equal(readFileSync(trace, 'utf8').includes(' fetch '), false);
    } finally {
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
      if (previousDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previousDir;
      if (previousSentinel === undefined) delete process.env.NATIVE_TEST_CREDENTIAL; else process.env.NATIVE_TEST_CREDENTIAL = previousSentinel;
      f.cleanup();
    }
  });
});

describe('disabled native squash bridge through actual factory / Run / dispatch / owner settlement', () => {
  async function ready(f: ReturnType<typeof fixture>) {
    f.seed('VALIDATING'); f.setSubmit(async (r) => ({ outcome: 'complete', evidence: f.terminal(r) }));
    await f.poll(); assert.equal(f.store().read('run-native')!.state, 'MERGE_READY'); f.armMerge();
  }

  it('issues one expected-HEAD squash, proves actual integration, settles A and admits B with A retained', async () => {
    const f = fixture(true);
    try {
      await ready(f);
      await f.poll();
      const issued = f.store().read('run-native')!;
      assert.equal(f.validationCalls(), 1, 'actual validation workflow consumed fresh controlled validation');
      assert.equal(issued.mergeAttempt!.submissionPossible, true);
      assert.equal(issued.mergeAttempt!.qualification!.mergeCommitSha, f.squash);
      assert.equal(issued.mergeAttempt!.qualification!.treeSha, f.tree);
      assert.equal(f.registry().readLane('run:run-native')!.parkedReason, 'workflow_settled');
      // Disabled reviewer for B is the actual default factory wait, not a
      // stubbed dispatcher or fabricated MERGED/ready successor.
      const result = await f.poll({} as NativeReviewerHost);
      assert.equal(result.outcome, 'dispatched');
      if (result.outcome !== 'dispatched') throw new Error('Expected successor admission.');
      assert.equal(result.entry.issue, 43);
      assert.equal(result.execution.state, 'WAITING_DEPENDENCY');
      const settled = f.store().read('run-native')!;
      assert.equal(settled.state, 'MERGED');
      assert.equal(f.registry().readLane('run:run-native')!.status, 'released');
      assert.equal(readRunOwnerReceipt(f.receiptPath)!.phase, 'released');
      assert.equal(f.store().list().length, 2);
      assert.deepEqual(f.mergeCounts(), { squashes: 1 });
      assert.equal(f.counts().submissions, 1); assert.equal(f.counts().modelCalls, 0);
      assert.match(await f.runtime.readQueueComment(), /issue: 42[\s\S]*issue: 43/);
    } finally { f.cleanup(); }
  });

  it('keeps disabled native cached readiness model-free and sleeps on every unchanged continuous poll', async () => {
    const f = fixture(true);
    try {
      f.seed(); f.setSubmit(async (r) => ({ outcome: 'complete', evidence: f.terminal(r) })); await f.poll();
      let waits = 0;
      const result = await dispatchContinuously({ dispatchOnce: () => f.poll(), sleep: async () => { waits += 1; f.tick(); }, idlePollMs: 30_000, maxCycles: 4 });
      assert.equal(result.idleWaits, 3); assert.equal(waits, 3);
      assert.equal(f.store().read('run-native')!.state, 'MERGE_READY');
      assert.equal(f.store().read('run-native')!.mergeAttempt, undefined);
      assert.equal(f.counts().submissions, 1); assert.equal(f.counts().modelCalls, 0); assert.equal(f.mergeCounts().squashes, 0);
    } finally { f.cleanup(); }
  });

  it('retains lost acknowledgement/open PR with a finite durable budget across restart and config churn', async () => {
    const f = fixture(true);
    try {
      await ready(f);
      f.setMergeOperation(async () => { throw new Error('remote acknowledgement lost'); });
      await f.poll();
      const original = f.store().read('run-native')!.mergeAttempt!;
      assert.equal(original.observations, 1);
      f.setMergeHost(undefined);
      for (let i = 0; i < 5; i++) { f.tick(); await f.poll({} as NativeReviewerHost); }
      const parked = f.store().read('run-native')!;
      assert.equal(parked.mergeAttempt!.observations, 3);
      assert.deepEqual(parked.mergeAttempt!.identity, original.identity);
      assert.equal(parked.mergeAttempt!.qualification, undefined);
      assert.equal(f.registry().readLane('run:run-native')!.parkedReason, 'workflow_wait');
      assert.equal(f.store().list().length, 1);
      assert.equal(f.mergeCounts().squashes, 1); assert.equal(f.counts().submissions, 1); assert.equal(f.counts().modelCalls, 0);
      await assert.rejects(runMergedTransitionCommand(f.store(), parked.id, f.github, f.registry(), async (op) => op()), /merged|unqualified|proof/i);
      assert.throws(() => recoverRunAdmission(f.store(), f.registry(), parked.id, readRunOwnerReceipt(f.receiptPath)!.generation, true, f.receiptPath, { retireWork: true }), /cannot retire/);
    } finally { f.cleanup(); }
  });

  it('allows HOLD only to observe/settle the issued exact attempt, preserving HOLD and stopping B', async () => {
    const f = fixture(true);
    try {
      await ready(f); f.setHold(true);
      assert.equal((await f.poll()).outcome, 'maintenance_hold'); assert.equal(f.mergeCounts().squashes, 0);
      f.setHold(false); f.setMergeOperation(async () => { throw new Error('lost ack'); }); await f.poll();
      f.setMergeHost(undefined); f.setHold(true); f.setMergeState('merged'); f.setMain(f.squash); f.tick();
      await f.poll({} as NativeReviewerHost);
      assert.ok(f.store().read('run-native')!.mergeAttempt!.qualification);
      assert.equal((await f.poll({} as NativeReviewerHost)).outcome, 'maintenance_hold');
      assert.equal(f.store().read('run-native')!.state, 'MERGED');
      assert.equal(f.store().list().length, 1); assert.equal(f.mergeCounts().squashes, 1); assert.equal(f.counts().modelCalls, 0);
      assert.equal((await f.poll({} as NativeReviewerHost)).outcome, 'maintenance_hold');
      assert.equal(f.store().list().length, 1);
    } finally { f.cleanup(); }
  });

  it('records truthful merged-but-unsettled facts for wrong parent/tree/ancestry and fences every settlement retry', async () => {
    for (const bad of ['parent', 'multiple-parents', 'tree', 'ancestry', 'closed-unmerged'] as const) {
      const f = fixture(true);
      try {
        await ready(f);
        if (bad === 'parent') f.setCommit({ sha: f.squash, treeSha: f.tree, parents: ['f'.repeat(40)] });
        if (bad === 'multiple-parents') f.setCommit({ sha: f.squash, treeSha: f.tree, parents: [f.base, f.head] });
        if (bad === 'tree') f.setCommit({ sha: f.squash, treeSha: 'e'.repeat(40), parents: [f.base] });
        if (bad === 'ancestry') f.setAncestry(false);
        if (bad === 'closed-unmerged') f.setMergeOperation(async () => { f.setMergeState('closed'); });
        await f.poll();
        const unresolved = f.store().read('run-native')!;
        assert.equal(unresolved.mergeAttempt!.qualification, undefined, bad);
        assert.equal(unresolved.mergeAttempt!.observedMerged !== undefined, bad !== 'closed-unmerged', bad);
        assert.equal(f.registry().readLane('run:run-native')!.parkedReason, 'workflow_wait');
        await assert.rejects(runMergedTransitionCommand(f.store(), unresolved.id, f.github, f.registry(), async (op) => op()), /unqualified|merged|proof|parent|tree|history/i);
        assert.equal(f.registry().readLane('run:run-native')!.status, 'parked');
        assert.equal(f.mergeCounts().squashes, 1); assert.equal(f.store().list().length, 1);
      } finally { f.cleanup(); }
    }
  });
});

describe('native merge crash and authority fences', () => {
  async function armed(f: ReturnType<typeof fixture>) {
    f.seed('VALIDATING'); f.setSubmit(async (r) => ({ outcome: 'complete', evidence: f.terminal(r) })); await f.poll(); f.armMerge();
  }
  it('preserves prepared / possible / accepted / proof CAS crash cuts without reissuing', async () => {
    for (const cut of ['before-marker', 'after-marker', 'lost-ack', 'before-proof-cas', 'after-proof-cas'] as const) {
      const f = fixture(true);
      try {
        await armed(f);
        if (cut === 'lost-ack') f.setMergeOperation(async () => { f.setMergeState('merged'); f.setMain(f.squash); throw new Error('remote accepted, acknowledgement lost'); });
        const store = f.store(); const cas = store.updateIfUnchanged.bind(store); let tripped = false;
        store.updateIfUnchanged = (expected, next) => {
          const a = expected.mergeAttempt; const b = next.mergeAttempt;
          const trigger = !tripped && (cut === 'before-marker' && a?.submissionPossible === false && b?.submissionPossible === true ||
            cut === 'after-marker' && a?.submissionPossible === false && b?.submissionPossible === true ||
            cut.includes('proof-cas') && a?.qualification === undefined && b?.qualification !== undefined);
          if (trigger) { tripped = true; if (cut === 'after-marker' || cut === 'after-proof-cas') cas(expected, next); throw new Error(`controlled merge crash ${cut}`); }
          return cas(expected, next);
        };
        if (cut === 'lost-ack') await f.poll(f.host, store);
        else await assert.rejects(f.poll(f.host, store), /controlled merge crash|Run changed during native merge observation/);
        const crashed = f.store().read('run-native')!;
        assert.equal(crashed.mergeAttempt!.submissionPossible, cut !== 'before-marker');
        assert.equal(f.mergeCounts().squashes, cut === 'before-marker' || cut === 'after-marker' ? 0 : 1);
        const lane = f.registry().readLane('run:run-native')!;
        if (lane.status === 'active') recoverRunAdmission(f.store(), f.registry(), crashed.id, lane.generation, true, f.receiptPath);
        if (cut === 'before-marker') {
          await f.poll();
          assert.equal(f.store().read(crashed.id)!.mergeAttempt!.submissionPossible, true, 'proven-unsubmitted preparation requires fresh complete admission before first issuance');
          assert.ok(f.store().read(crashed.id)!.mergeAttempt!.issuanceGeneration! > crashed.mergeAttempt!.identity.generation);
        } else if (!crashed.mergeAttempt!.qualification) {
          f.setMergeHost(undefined); f.tick(); await f.poll({} as NativeReviewerHost);
        }
        if (cut !== 'after-marker') {
          const successor = await f.poll({} as NativeReviewerHost);
          assert.equal(f.store().read(crashed.id)!.state, 'MERGED', 'crash recovery must complete durable settlement, not stop at proof');
          assert.equal(successor.outcome, 'dispatched');
          if (successor.outcome !== 'dispatched') throw new Error('Expected safe successor admission.');
          assert.equal(successor.entry.issue, 43); assert.equal(f.store().list().length, 2);
        } else assert.equal(f.store().list().length, 1, 'possible-but-unproven submission still stops B');
        assert.equal(f.mergeCounts().squashes, cut === 'after-marker' ? 0 : 1, 'restart never resends possible submission');
        assert.equal(f.counts().submissions, 1); assert.equal(f.counts().modelCalls, 0);
      } finally { f.cleanup(); }
    }
  });

  it('rejects stale HEAD/base/policy, negative review without a thread, missing qualification and malformed receipt before issuance', async () => {
    for (const bad of ['head', 'base', 'fresh-main', 'policy', 'negative', 'receipt', 'generic-review'] as const) {
      const f = fixture(true);
      try {
        if (bad === 'generic-review') { f.seed('MERGE_READY'); f.armMerge(); }
        else await armed(f);
        if (bad === 'fresh-main') f.setMain('b'.repeat(40));
        if (bad === 'head') f.setLiveHead('c'.repeat(40));
        if (bad === 'base') { f.setLiveBase('b'.repeat(40)); f.setMain('b'.repeat(40)); }
        if (bad === 'policy') (f.host.binding as { policyRevision: string }).policyRevision = 'changed';
        if (bad === 'negative') f.setNegativeReview();
        if (bad === 'receipt') { const accepted = f.store().read('run-native')!.nativeReview!.accepted!; writeFileSync(path.join(f.directory, 'oracle', 'native', `${accepted.receiptId}.json`), '{"invalid":true}'); }
        await f.poll();
        assert.equal(f.mergeCounts().squashes, 0, bad); assert.equal(f.store().read('run-native')!.mergeAttempt, undefined, bad);
        assert.equal(f.counts().modelCalls, 0, bad); assert.equal(f.store().list().length, 1);
      } finally { f.cleanup(); }
    }
  });

  it('checks current claim and owner generation after preparation and immediately before the API', async () => {
    for (const race of ['claim', 'generation'] as const) {
      const f = fixture(true);
      try {
        await armed(f);
        const store = f.store(); const cas = store.updateIfUnchanged.bind(store); let tripped = false;
        store.updateIfUnchanged = (expected, next) => {
          const result = cas(expected, next);
          if (result && !tripped && !expected.mergeAttempt && next.mergeAttempt) {
            tripped = true;
            if (race === 'claim') { const selected = selectDispatchRuntime(f.runtime.comments)!; f.runtime.comments = [{ id: selected.id, body: renderDispatchRuntime({ ...selected.claim, claimId: 'foreign-claim' }) }]; }
            else f.registry().park(readRunOwnerReceipt(f.receiptPath)!.token!, 'workflow_wait');
          }
          return result;
        };
        await assert.rejects(f.poll(f.host, store), /claim|generation|capability|owner|stale/i);
        assert.equal(tripped, true); assert.equal(f.mergeCounts().squashes, 0); assert.equal(f.store().list().length, 1);
      } finally { f.cleanup(); }
    }
  });

  it('rejects monotonic ledger rollback and native/attempt-bearing MERGED bypasses, including released receipt-less retries', async () => {
    const f = fixture(true);
    try {
      await armed(f); f.setMergeOperation(async () => { throw new Error('unknown'); }); await f.poll();
      const run = f.store().read('run-native')!; const attempt = run.mergeAttempt!;
      assert.throws(() => f.store().update({ ...run, mergeAttempt: undefined }), /monotonic/);
      assert.throws(() => f.store().update({ ...run, mergeAttempt: { ...attempt, submissionPossible: false } }), /monotonic/);
      assert.throws(() => f.store().update({ ...run, mergeAttempt: { ...attempt, observations: 0 } }), /monotonic/);
      assert.throws(() => f.store().update({ ...run, state: 'MERGED' }), /monotonic/);
      const history = new JsonFileStore({ dir: path.join(f.directory, 'historical-merge') });
      history.create({ ...run, state: 'MERGED' });
      f.setMergeState('merged'); f.setMain(f.squash); f.setCommit({ sha: f.squash, treeSha: 'f'.repeat(40), parents: [f.base] });
      await assert.rejects(runMergedTransitionCommand(history, run.id, f.github, new MissionAdmissionRegistry({ filePath: path.join(f.directory, 'absent-registry.json'), config: admissionConfig }), async (op) => op()), /parent|tree|quali/i);
      assert.equal(history.read(run.id)!.state, 'MERGED');
      assert.equal(f.registry().readLane('run:run-native')!.status, 'parked');
      assert.equal(f.mergeCounts().squashes, 1);
    } finally { f.cleanup(); }
  });

  it('recovers explicit exact merged evidence after budget exhaustion without resubmitting', async () => {
    const f = fixture(true);
    try {
      await armed(f); f.setMergeOperation(async () => { throw new Error('unknown'); }); await f.poll();
      for (let i = 0; i < 3; i++) { f.tick(); await f.poll(); }
      assert.equal(f.store().read('run-native')!.mergeAttempt!.observations, 3);
      f.setMergeState('merged'); f.setMain(f.squash);
      const settled = await runMergedTransitionCommand(f.store(), 'run-native', f.github, f.registry(), async (op) => op());
      assert.equal(settled.state, 'MERGED'); assert.ok(settled.mergeAttempt!.qualification);
      assert.equal(f.registry().readLane('run:run-native')!.status, 'released'); assert.equal(f.mergeCounts().squashes, 1);
    } finally { f.cleanup(); }
  });
});

describe('native merge existing settlement crash recovery', () => {
  it('recovers Run-CAS-before-registry and registry-before-final-receipt without another merge or premature B', async () => {
    for (const cut of ['registry', 'receipt'] as const) {
      const f = fixture(true);
      try {
        f.seed('VALIDATING'); f.setSubmit(async (r) => ({ outcome: 'complete', evidence: f.terminal(r) })); await f.poll(); f.armMerge(); await f.poll();
        assert.ok(f.store().read('run-native')!.mergeAttempt!.qualification);
        let tripped = false; let saved: ReturnType<typeof readRunOwnerReceipt> = null;
        f.setRegistryPublish(() => {
          if (tripped || f.store().read('run-native')!.state !== 'MERGED') return;
          tripped = true;
          if (cut === 'registry') throw new Error('controlled native registry release crash');
          saved = readRunOwnerReceipt(f.receiptPath); writeFileSync(f.receiptPath, '{broken receipt after registry publication');
        });
        await assert.rejects(runMergedTransitionCommand(f.store(), 'run-native', f.github, f.registry(), async (op) => op()), /controlled native registry|receipt|JSON/i);
        assert.equal(tripped, true); assert.equal(f.store().read('run-native')!.state, 'MERGED'); assert.equal(f.store().list().length, 1);
        assert.equal(f.registry().readLane('run:run-native')!.status, cut === 'registry' ? 'parked' : 'released');
        f.setRegistryPublish(() => {});
        if (saved) writeRunOwnerReceipt(f.receiptPath, saved);
        const settled = await runMergedTransitionCommand(f.store(), 'run-native', f.github, f.registry(), async (op) => op());
        assert.equal(settled.state, 'MERGED'); assert.equal(f.registry().readLane('run:run-native')!.status, 'released'); assert.equal(readRunOwnerReceipt(f.receiptPath)!.phase, 'released');
        assert.equal(f.mergeCounts().squashes, 1); assert.equal(f.counts().submissions, 1); assert.equal(f.counts().modelCalls, 0);
      } finally { f.cleanup(); }
    }
  });
});

it('recovers by the original control scope when host/config is absent and stops before B without manufacturing HOLD', async () => {
  const f = fixture(true);
  try {
    f.seed('VALIDATING'); f.setSubmit(async (r) => ({ outcome: 'complete', evidence: f.terminal(r) })); await f.poll(); f.armMerge();
    f.setMergeOperation(async () => { throw new Error('lost ack'); }); await f.poll();
    f.setMergeHost(undefined); f.setRecoveryOnly();
    const descriptor = issuedMergeRecoveryConfiguration(f.store().read('run-native')!);
    assert.equal(descriptor.controlIssue, config.controlIssue); assert.equal(descriptor.revision, config.revision); assert.equal(descriptor.merge, undefined);
    f.setMergeState('merged'); f.setMain(f.squash); f.tick();
    // Neither queue access nor a new configured host is needed for recovery.
    f.runtime.readQueueComment = async () => { throw new Error('recovery must not read the queue'); };
    await f.poll({} as NativeReviewerHost); await f.poll({} as NativeReviewerHost);
    assert.equal(f.store().read('run-native')!.state, 'MERGED'); assert.equal(f.store().list().length, 1);
    assert.equal(f.registry().readLane('run:run-native')!.status, 'released'); assert.equal(f.mergeCounts().squashes, 1); assert.equal(f.counts().modelCalls, 0);
  } finally { f.cleanup(); }
});

it('refuses absent-lane and receipt-less released native settlement even with qualified integration', async () => {
  const f = fixture(true);
  try {
    f.seed('VALIDATING'); f.setSubmit(async (r) => ({ outcome: 'complete', evidence: f.terminal(r) })); await f.poll(); f.armMerge(); await f.poll();
    const ready = f.store().read('run-native')!;
    await assert.rejects(runMergedTransitionCommand(f.store(), ready.id, f.github, new MissionAdmissionRegistry({ filePath: path.join(f.directory, 'missing-lane.json'), config: admissionConfig }), async (op) => op()), /retained admission lane|owner receipt/);
    assert.equal(f.store().read(ready.id)!.state, 'MERGE_READY');
    await runMergedTransitionCommand(f.store(), ready.id, f.github, f.registry(), async (op) => op());
    const receipt = readRunOwnerReceipt(f.receiptPath)!; rmSync(f.receiptPath);
    await assert.rejects(runMergedTransitionCommand(f.store(), ready.id, f.github, f.registry(), async (op) => op()), /owner receipt|lane identity/);
    assert.throws(() => isDispatchRunOwnerRetiredCommand(f.store(), f.store().read(ready.id)!, f.registry()), /receipt/);
    writeRunOwnerReceipt(f.receiptPath, receipt);
    assert.equal(isDispatchRunOwnerRetiredCommand(f.store(), f.store().read(ready.id)!, f.registry()), true);
    assert.equal(f.mergeCounts().squashes, 1);
  } finally { f.cleanup(); }
});

it('waits behind a foreign active captain and rejects overlapping ownership before merge initiation', async () => {
  const f = fixture(true);
  try {
    f.seed('VALIDATING'); f.setSubmit(async (r) => ({ outcome: 'complete', evidence: f.terminal(r) })); await f.poll(); f.armMerge();
    const foreign = f.registry().admit({ laneId: 'foreign-active', role: 'production_captain', highAutonomy: true, evidence: { repository: 'foreign/repo', issue: 99 } });
    assert.equal(foreign.outcome, 'admitted');
    const result = await f.poll(); assert.equal(result.outcome, 'admission_wait');
    assert.equal(f.mergeCounts().squashes, 0); assert.equal(f.store().read('run-native')!.mergeAttempt, undefined); assert.equal(f.counts().modelCalls, 0);
    assert.equal(f.store().list().length, 1);
  } finally { f.cleanup(); }
});

describe('review repairs: exact owner normalization, fresh progression, stopped proof recovery and complete capabilities', () => {
  async function armed(f: ReturnType<typeof fixture>) {
    f.seed('VALIDATING'); f.setSubmit(async (r) => ({ outcome: 'complete', evidence: f.terminal(r) })); await f.poll(); f.armMerge();
  }
  async function uncertain(f: ReturnType<typeof fixture>) {
    await armed(f); f.setMergeOperation(async () => { throw new Error('controlled lost ack'); }); await f.poll();
    for (let i = 0; i < 3; i++) { f.tick(); await f.poll(); }
    assert.equal(f.store().read('run-native')!.mergeAttempt!.observations, 3);
    f.setMergeState('merged'); f.setMain(f.squash);
  }
  const bQueue = `${DISPATCH_QUEUE_MARKER}\nready:\n  - issue: 43\n    route: codex\n    profile: complex\n    task-shape-revision: task-v1\n    task-shape: interacting`;

  it('rejects stale, foreign, invalid-phase/token parked receipts without overwriting bytes or ownership', async () => {
    for (const bad of ['stale', 'future', 'foreign-mission', 'foreign-claim', 'foreign-workspace', 'foreign-run', 'execution-phase', 'wrong-pre-execution-generation', 'parked-token'] as const) {
      const f = fixture(true);
      try {
        await uncertain(f);
        const lane = f.registry().readLane('run:run-native')!;
        const receipt = readRunOwnerReceipt(f.receiptPath)!;
        const token = { laneId: lane.laneId, generation: lane.generation, token: 'unrelated-token' };
        const corrupt = { ...receipt,
          ...(bad === 'stale' ? { generation: receipt.generation - 2 } : {}),
          ...(bad === 'future' ? { generation: receipt.generation + 2 } : {}),
          ...(bad === 'foreign-mission' ? { missionId: 'foreign-mission' } : {}),
          ...(bad === 'foreign-claim' ? { claimId: 'foreign-claim' } : {}),
          ...(bad === 'foreign-workspace' ? { workspace: f.directory } : {}),
          ...(bad === 'foreign-run' ? { runId: 'foreign-run' } : {}),
          ...(bad === 'execution-phase' ? { phase: 'execution_possible', token } : {}),
          ...(bad === 'wrong-pre-execution-generation' ? { phase: 'pre_execution', token } : {}),
          ...(bad === 'parked-token' ? { token } : {}),
        };
        writeFileSync(f.receiptPath, JSON.stringify(corrupt));
        const bytes = readFileSync(f.receiptPath);
        const run = f.store().read('run-native')!;
        await assert.rejects(runMergedTransitionCommand(f.store(), run.id, f.github, f.registry(), async (op) => op()), /receipt|generation|phase|owner|identity|schema/i, bad);
        assert.deepEqual(readFileSync(f.receiptPath), bytes, bad);
        assert.deepEqual(f.registry().readLane(lane.laneId), lane, bad);
        assert.deepEqual(f.store().read(run.id), run, bad);
        assert.equal(f.mergeCounts().squashes, 1); assert.equal(f.store().list().length, 1);
      } finally { f.cleanup(); }
    }
  });

  it('checks the receipt again inside the admission transaction and accepts only exact interrupted parking/readmission transitions', async () => {
    for (const phase of ['transaction-race', 'park_transition', 'pre_execution'] as const) {
      const f = fixture(true);
      try {
        await uncertain(f);
        const lane = f.registry().readLane('run:run-native')!;
        const receipt = readRunOwnerReceipt(f.receiptPath)!;
        const admission = f.registry();
        let raced: Buffer | undefined;
        if (phase === 'transaction-race') {
          const admit = admission.admit.bind(admission);
          admission.admit = (request, options) => {
            writeRunOwnerReceipt(f.receiptPath, { ...receipt, generation: receipt.generation - 2 });
            raced = readFileSync(f.receiptPath);
            return admit(request, options);
          };
          await assert.rejects(runMergedTransitionCommand(f.store(), 'run-native', f.github, admission, async (op) => op()), /receipt.*generation/i);
          assert.deepEqual(readFileSync(f.receiptPath), raced);
          assert.deepEqual(f.registry().readLane(lane.laneId), lane);
        } else {
          const generation = phase === 'park_transition' ? lane.generation - 1 : lane.generation + 1;
          writeRunOwnerReceipt(f.receiptPath, { ...receipt, phase, generation, token: { laneId: lane.laneId, generation, token: 'interrupted-exact-generation' } });
          const settled = await runMergedTransitionCommand(f.store(), 'run-native', f.github, admission, async (op) => op());
          assert.equal(settled.state, 'MERGED'); assert.equal(readRunOwnerReceipt(f.receiptPath)!.phase, 'released');
          assert.equal(f.registry().readLane(lane.laneId)!.status, 'released');
        }
        assert.equal(f.mergeCounts().squashes, 1); assert.equal(f.counts().modelCalls, 0);
      } finally { f.cleanup(); }
    }
  });

  it('requires fresh integration for missing/changed claims and absent/rerouted historical rows, then accepts a proven later main', async () => {
    for (const claim of ['missing', 'changed'] as const) for (const row of ['absent', 'rerouted'] as const) for (const proof of ['bad-ancestry', 'unavailable'] as const) {
      const f = fixture(true);
      try {
        await armed(f); await f.poll();
        await runMergedTransitionCommand(f.store(), 'run-native', f.github, f.registry(), async (op) => op());
        const settled = f.store().read('run-native')!;
        const receipt = readFileSync(f.receiptPath);
        if (claim === 'missing') f.runtime.comments = [];
        else f.runtime.comments = [{ id: 'runtime', body: renderDispatchRuntime({ issue: 43, claimId: 'new-b-claim', runId: null, profile: 'complex', repairTaskShapeAuthority: authority, state: 'claimed', claimedAt: T0, heartbeatAt: T0, leaseUntil: T0 }) }];
        f.runtime.readQueueComment = async () => row === 'absent' ? bQueue : `${DISPATCH_QUEUE_MARKER}\nready:\n  - issue: 42\n    route: human\n    profile: complex\n    task-shape-revision: task-v1\n    task-shape: interacting\n${bQueue.split('ready:\n')[1]}`;
        const readDefault = f.github.readDefaultBranch!;
        let defaultReads = 0;
        f.github.readDefaultBranch = async (...args) => { defaultReads += 1; if (proof === 'unavailable') throw new Error('fresh proof unavailable'); return readDefault(...args); };
        f.setAncestry(false); f.setMain(f.base);
        const held = await f.poll({} as NativeReviewerHost);
        assert.notEqual(held.outcome, 'dispatched', `${claim}/${row}/${proof}`);
        assert.ok(defaultReads > 0, 'historical retirement must read current default branch');
        assert.equal(f.store().list().length, 1); assert.deepEqual(f.store().read(settled.id), settled); assert.deepEqual(readFileSync(f.receiptPath), receipt);
        const later = f.git('commit-tree', f.tree, '-p', f.squash, '-m', 'later main');
        f.github.readDefaultBranch = async (...args) => { defaultReads += 1; return readDefault(...args); };
        f.github.isAncestor = async (_o, _r, ancestor, descendant) => f.git('merge-base', ancestor, descendant) === ancestor;
        f.setMain(later);
        const next = await f.poll({} as NativeReviewerHost);
        assert.equal(next.outcome, 'dispatched'); if (next.outcome !== 'dispatched') throw new Error('Expected actual successor admission.');
        assert.equal(next.entry.issue, 43); assert.equal(f.store().list().length, 2); assert.equal(f.mergeCounts().squashes, 1); assert.equal(f.counts().modelCalls, 0);
        assert.deepEqual(f.store().read(settled.id), settled, 'freshness cannot rewrite historical qualification');
      } finally { f.cleanup(); }
    }
  });

  it('completes proof-CAS-before-park stopped recovery through MERGED and B, while HOLD/revocation settles only A', async () => {
    for (const held of [false, true]) {
      const f = fixture(true);
      try {
        await armed(f);
        const store = f.store(); const cas = store.updateIfUnchanged.bind(store); let tripped = false;
        store.updateIfUnchanged = (expected, next) => {
          const won = cas(expected, next);
          if (won && !tripped && !expected.mergeAttempt?.qualification && next.mergeAttempt?.qualification) { tripped = true; throw new Error('controlled crash after qualification CAS before park'); }
          return won;
        };
        await assert.rejects(f.poll(f.host, store), /controlled crash|Run changed/);
        const run = f.store().read('run-native')!; const lane = f.registry().readLane('run:run-native')!;
        assert.ok(run.mergeAttempt!.qualification); assert.equal(lane.status, 'active');
        await assert.rejects(runMergedTransitionCommand(f.store(), run.id, f.github, f.registry(), async (op) => op()), /active|fenced/);
        assert.throws(() => recoverRunAdmission(f.store(), f.registry(), run.id, lane.generation, false, f.receiptPath), /stopped/i);
        f.setHold(held); f.setMergeHost(undefined);
        recoverRunAdmission(f.store(), f.registry(), run.id, lane.generation, true, f.receiptPath);
        assert.equal(f.registry().readLane(lane.laneId)!.status, 'released');
        const released = readRunOwnerReceipt(f.receiptPath)!;
        assert.equal(released.phase, 'released'); assert.equal(released.settlementReason, 'workflow_settled');
        const result = await f.poll({} as NativeReviewerHost);
        assert.equal(f.store().read(run.id)!.state, 'MERGED'); assert.equal(f.mergeCounts().squashes, 1); assert.equal(f.counts().submissions, 1); assert.equal(f.counts().modelCalls, 0);
        assert.equal(f.registry().readLane(lane.laneId)!.status, 'released');
        assert.equal(f.store().list().length, held ? 1 : 2);
        assert.equal(result.outcome, held ? 'maintenance_hold' : 'dispatched');
        if (held) { await f.poll({} as NativeReviewerHost); assert.equal(f.store().list().length, 1); }
      } finally { f.cleanup(); }
    }
  });

  it('rejects missing and noncallable complete capability sets before preparation, then settles with a complete set', async () => {
    for (const method of ['squashPullRequest', 'readPullRequest', 'readDefaultBranch', 'readCommit', 'isAncestor'] as const) for (const value of [undefined, null, 'non-callable']) {
      const f = fixture(true);
      try {
        await armed(f);
        const original = f.github[method];
        (f.github as unknown as Record<string, unknown>)[method] = value;
        await f.poll();
        assert.equal(f.mergeCounts().squashes, 0, `${method}/${value}`); assert.equal(f.store().read('run-native')!.mergeAttempt, undefined);
        assert.equal(f.registry().readLane('run:run-native')!.status, 'parked'); assert.equal(f.counts().modelCalls, 0);
        (f.github as unknown as Record<string, unknown>)[method] = original;
        await f.poll();
        const settled = await runMergedTransitionCommand(f.store(), 'run-native', f.github, f.registry(), async (op) => op());
        assert.equal(settled.state, 'MERGED'); assert.equal(f.mergeCounts().squashes, 1); assert.equal(readRunOwnerReceipt(f.receiptPath)!.phase, 'released');
      } finally { f.cleanup(); }
    }
  });
});

it('rechecks complete callable capabilities after asynchronous preparation and at the final submission fence', async () => {
  for (const cut of ['before-preparation', 'before-marker', 'before-api'] as const) {
    const f = fixture(true);
    try {
      f.seed('VALIDATING'); f.setSubmit(async (r) => ({ outcome: 'complete', evidence: f.terminal(r) })); await f.poll(); f.armMerge();
      const original = f.github.readCommit; let capabilityRemoved = false;
      if (cut === 'before-preparation') {
        const read = f.github.readDefaultBranch!;
        f.github.readDefaultBranch = async (...args) => { const result = await read(...args); capabilityRemoved = true; (f.github as unknown as Record<string, unknown>).readCommit = null; return result; };
      }
      const store = f.store(); const cas = store.updateIfUnchanged.bind(store);
      if (cut !== 'before-preparation') store.updateIfUnchanged = (expected, next) => {
        const won = cas(expected, next);
        const trigger = cut === 'before-marker' ? !expected.mergeAttempt && next.mergeAttempt !== undefined : expected.mergeAttempt?.submissionPossible === false && next.mergeAttempt?.submissionPossible;
        if (won && trigger) { capabilityRemoved = true; (f.github as unknown as Record<string, unknown>).readCommit = null; }
        return won;
      };
      await f.poll(f.host, store);
      const attempt = f.store().read('run-native')!.mergeAttempt;
      assert.equal(capabilityRemoved, true, 'capability cut must actually execute');
      assert.equal(f.mergeCounts().squashes, 0, cut);
      if (cut === 'before-preparation') assert.equal(attempt, undefined);
      else assert.equal(attempt!.submissionPossible, cut === 'before-api');
      assert.equal(f.store().list().length, 1); assert.equal(f.counts().modelCalls, 0);
      (f.github as unknown as Record<string, unknown>).readCommit = original;
    } finally { f.cleanup(); }
  }
});

it('recovers every interrupted stopped-parking/release publication through MERGED and safe B admission', async () => {
  for (const cut of ['before-park-registry', 'after-park-registry', 'before-release-registry', 'after-release-registry'] as const) {
    const f = fixture(true);
    try {
      f.seed('VALIDATING'); f.setSubmit(async (r) => ({ outcome: 'complete', evidence: f.terminal(r) })); await f.poll(); f.armMerge();
      const store = f.store(); const cas = store.updateIfUnchanged.bind(store); let crashed = false;
      store.updateIfUnchanged = (expected, next) => {
        const won = cas(expected, next);
        if (won && !crashed && !expected.mergeAttempt?.qualification && next.mergeAttempt?.qualification) { crashed = true; throw new Error('controlled qualified-before-park crash'); }
        return won;
      };
      await assert.rejects(f.poll(f.host, store), /controlled qualified|Run changed/);
      let tripped = false; let saved: ReturnType<typeof readRunOwnerReceipt> = null;
      f.setRegistryPublish(() => {
        if (tripped) return;
        const receipt = readRunOwnerReceipt(f.receiptPath)!;
        const phase = cut.includes('park-') ? 'park_transition' : 'parked_release_transition';
        if (receipt.phase !== phase) return;
        tripped = true;
        if (cut.startsWith('before')) throw new Error(`controlled ${cut}`);
        saved = receipt; writeFileSync(f.receiptPath, '{controlled interrupted receipt finalization');
      });
      const firstLane = f.registry().readLane('run:run-native')!;
      assert.throws(() => recoverRunAdmission(f.store(), f.registry(), 'run-native', firstLane.generation, true, f.receiptPath), /controlled|corrupt/);
      assert.equal(tripped, true, cut); assert.equal(f.store().list().length, 1); assert.equal(f.store().read('run-native')!.state, 'MERGE_READY');
      f.setRegistryPublish(() => {}); if (saved) writeRunOwnerReceipt(f.receiptPath, saved);
      const lane = f.registry().readLane('run:run-native')!;
      recoverRunAdmission(f.store(), f.registry(), 'run-native', lane.status === 'released' ? lane.generation - 1 : lane.generation, true, f.receiptPath);
      const released = readRunOwnerReceipt(f.receiptPath)!;
      assert.equal(released.phase, 'released'); assert.equal(released.settlementReason, 'workflow_settled');
      const successor = await f.poll({} as NativeReviewerHost);
      assert.equal(f.store().read('run-native')!.state, 'MERGED'); assert.equal(successor.outcome, 'dispatched');
      if (successor.outcome !== 'dispatched') throw new Error('Expected safe successor.');
      assert.equal(successor.entry.issue, 43); assert.equal(f.store().list().length, 2); assert.equal(f.mergeCounts().squashes, 1); assert.equal(f.counts().modelCalls, 0);
    } finally { f.cleanup(); }
  }
});
