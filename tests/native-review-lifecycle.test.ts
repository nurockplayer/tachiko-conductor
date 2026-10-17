import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { GitHubAdapter, GitHubLiveSnapshot } from '../src/adapters/github.js';
import { buildWorkflowDeps, recoverRunAdmission, runIssueCommand, runMergedTransitionCommand } from '../src/cli.js';
import { createRun } from '../src/domain/run.js';
import { applyTransition } from '../src/domain/state-machine.js';
import type { Run } from '../src/domain/types.js';
import { dispatchOnceCommand } from '../src/dispatch/command.js';
import { dispatchContinuously } from '../src/dispatch/continuous.js';
import { DISPATCH_QUEUE_MARKER, renderDispatchRuntime, selectDispatchRuntime, type DispatchRuntimeClaim, type DispatchRuntimeComment } from '../src/dispatch/queue.js';
import type { ResolvedExecutionConfiguration } from '../src/execution-profiles.js';
import { MissionAdmissionRegistry, type AdmissionConfig } from '../src/mission-admission/registry.js';
import { readRunOwnerReceipt } from '../src/mission-admission/run-owner-receipt.js';
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

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'native-review-'));
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
  let lastRequest: RequestEvidence | undefined;
  let submit: (r: RequestEvidence) => Promise<NativeReviewObservation> = async () => ({ outcome: 'pending', conversationUrl: 'https://review.example.invalid/exact?conversation=returned' });
  let observe: NonNullable<NativeReviewerHost['observe']> = async () => ({ outcome: 'pending' });
  const now = () => new Date(clock).toISOString();
  const store = () => new JsonFileStore({ dir: path.join(directory, 'runs') });
  const registry = () => new MissionAdmissionRegistry({ filePath: path.join(directory, 'host', 'admission.json'), config: admissionConfig, now });
  const receipts = () => new JsonFileOracleReceiptStore(path.join(directory, 'oracle'));
  const receiptPath = path.join(directory, 'owner.json');
  const runtime = new Runtime();
  const github: GitHubAdapter = {
    kind: 'github',
    async readIssue(target) { return { target, title: 'native slice', body: 'controlled source', state: 'open' }; },
    async readBranch() { throw new Error('unused'); },
    async listPullRequests() { return []; },
    async readPullRequest() { const snapshot = await github.readLiveSnapshot(TARGET); return { ...snapshot.pullRequest!, state: 'merged' }; },
    async readLiveSnapshot(): Promise<GitHubLiveSnapshot> {
      snapshotReads += 1; onSnapshot?.();
      return {
        repository: { owner: TARGET.owner, repo: TARGET.repo, defaultBranch: 'main', defaultBranchHeadSha: liveBase },
        issue: { id: 'I_42', number: 42, title: 'native slice', body: 'controlled source', state: 'open', url: '', createdAt: T0, updatedAt: T0 },
        pullRequest: { id: 'PR_7', number: 7, title: 'native candidate', url: '', state: 'open', isDraft: false, mergeable: true, mergeStateStatus: 'CLEAN', updatedAt: T0,
          headSha: head, baseSha: liveBase, headRef: 'candidate', headRepository: { owner: TARGET.owner, repo: TARGET.repo }, baseRef: 'main', baseRepository: { owner: TARGET.owner, repo: TARGET.repo } },
        headSha: head, checks: { availability: 'available', overall: 'passing', checks: [{ id: 'test', name: 'test', state: 'passing', url: null, updatedAt: T0 }] },
        reviews: { decision: 'none', latestByAuthor: [], unresolvedThreads: 0 }, conversations: [], handoff: null, problems: [], observedAt: now(),
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
    ...buildWorkflowDeps(durableStore, undefined, {}, undefined, binding), github,
    implementation: { kind: 'implementation-agent', async run() { modelCalls += 1; throw new Error('No implementation/repair model may run.'); } },
    validation: { kind: 'validation', configRevision: 'test-config-v1', async validate() { throw new Error('Fresh validation must be reused.'); } },
    hostedCheckPolicy: { revision: 'test-hosted-policy-v1', policy: { mode: 'required' } },
  });
  const seed = (state: 'REVIEWING' | 'FINAL_GATE' | 'MERGE_READY' | 'READY' = 'REVIEWING') => {
    let run = createRun(TARGET, T0, 'run-native', execution, 'claim-native', authority);
    if (state !== 'READY') {
      run = applyTransition(run, { type: 'start' }, T0);
      run = applyTransition(run, { type: 'agent_succeeded', agentResult: successResult(head), headSha: head, pullRequest: { number: 7, headSha: head } }, T0);
      run = applyTransition(run, { type: 'validation_passed', validationResult: validationPassed(head) }, T0);
      if (state !== 'REVIEWING') run = applyTransition(run, { type: 'review_approved', reviewResult: approval('generic green', head) }, T0, TEST_VALIDATION_AUTHORITY);
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
    return await dispatchOnceCommand(config, {
      workflow: wf, runtime, admission, now, resolveExecutionProfile: () => execution,
      async runIssue(ref, selected, claimId, a, registry, _release, _lock, assertReviewClaim) { return await runIssueCommand(wf, ref, { execution: selected, dispatchClaimId: claimId, repairTaskShapeAuthority: a, admission: registry, runOwnerReceiptPath: receiptPath, admissionWorkspace: repository, now, assertReviewClaim }); },
      async resumeClaimedRun(run, claimId, registry, _release, _lock, assertReviewClaim) { return await runIssueCommand(wf, 'acme/widgets#42', { execution: run.execution, dispatchClaimId: claimId, repairTaskShapeAuthority: run.repairTaskShapeAuthority, admission: registry, runOwnerReceiptPath: receiptPath, admissionWorkspace: repository, now, assertReviewClaim }); },
    });
  };
  return { directory, repository, base, head, host, store, registry, receipts, runtime, receiptPath, workflow, seed, poll, terminal, github, now, git,
    tick: () => { clock += 31_000; }, counts: () => ({ modelCalls, submissions, observations, snapshotReads }), request: () => { assert.ok(lastRequest); return lastRequest; },
    setSubmit: (fn: typeof submit) => { submit = fn; }, setObserve: (fn: typeof observe) => { observe = fn; },
    setLiveBase: (b: string) => { liveBase = b; }, setSnapshotHook: (fn: () => void) => { onSnapshot = fn; },
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

describe('native review through the real factory / durable dispatcher', () => {
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
