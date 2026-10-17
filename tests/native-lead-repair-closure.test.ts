import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { it } from 'node:test';
import { fixture } from './native-lead-fixture.js';
import { TARGET } from './helpers.js';
import type { NativeReviewerHost } from '../src/oracle/types.js';
import type { Run } from '../src/domain/types.js';
import { createRun } from '../src/domain/run.js';
import { applyTransition } from '../src/domain/state-machine.js';
import { buildImplementationPacket } from '../src/agents/implementation-packet.js';
import { activeNativeLead, nativeLeadCoherent, nativeLeadReentry, unresolvedNativeLead } from '../src/oracle/native-lead.js';
import { nativeReviewCoherent, unresolvedNativeReview } from '../src/oracle/native-reviewer.js';
import { hasAuthenticatedCompletion } from '../src/oracle/completion-proof.js';
import { oracleDigest } from '../src/oracle/source-evidence.js';
import { readRunOwnerReceipt, writeRunOwnerReceipt } from '../src/mission-admission/run-owner-receipt.js';
import { resolveRunOwnerReceiptPath } from '../src/mission-admission/host-registry.js';
import { buildWorkflowDeps, recoverRunAdmission, runIssueCommand, resumeCommand, runMergedTransitionCommand, isDispatchRunOwnerRetiredCommand, reconcileDispatchMergedRunCommand } from '../src/cli.js';
import { readMergeCandidate, assertNativeMergeSettlement } from '../src/workflow/merge.js';
import { dispatchOnceCommand } from '../src/dispatch/command.js';
import { selectDispatchRuntime } from '../src/dispatch/queue.js';
import type { NativeMergePolicy } from '../src/workflow/merge.js';

type Fixture = ReturnType<typeof fixture>;
const expand = (f: Fixture) => f.setLiveOverride(s => ({ ...s, handoff: { ...s.handoff!, sections: { scope: 'Expanded unadmitted scope: replace unrelated authority.' } } }));
async function ready(f: Fixture) { await f.poll(); if (f.run().state === 'WAITING_DEPENDENCY') { f.tick(); await f.poll(); } assert.equal(f.run().state, 'MERGE_READY'); }
function mergeFixture(f: Fixture) {
  const r = f.run();
  let merge: string | undefined; let writes = 0; let tree = ''; let invalid = false;
  const policy: NativeMergePolicy = { enabled: true, revision: 'merge-fixture', releaseId: 'release-fixture', campaign: 'fixture', dispatchRevision: f.config.revision, owner: 'acme', repo: 'widgets', controlIssue: 1, queueCommentId: 2, baseBranch: 'main', method: 'squash', integrationPolicy: 'bootstrap-base-tree-v1', reviewPolicyRevision: 'independent-unpromoted-v1', localValidationRevision: 'test-config-v1', hostedValidationRevision: 'test-hosted-policy-v1' };
  const github = { ...f.github,
    async readIssue(target: Parameters<typeof f.github.readIssue>[0]) { return { target, title: 'fixture', body: 'fixture', state: merge && target.kind === 'issue' && target.issueNumber === 42 ? 'closed' as const : 'open' as const }; },
    async squashPullRequest() { writes++; tree = f.git.git(f.git.source, ['rev-parse', `${r.headSha}^{tree}`]); merge = f.git.git(f.git.source, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit-tree', tree, '-p', f.git.baseSha, '-m', 'controlled squash']); return; },
    async readPullRequest() { const s = await f.github.readLiveSnapshot(TARGET); return merge ? { ...s.pullRequest!, state: 'merged' as const, mergeCommitSha: merge } : s.pullRequest!; },
    async readDefaultBranch() { return { branch: 'main', headSha: merge ?? f.git.baseSha }; },
    async readCommit() { return { sha: merge!, treeSha: invalid ? 'e'.repeat(40) : tree, parents: [f.git.baseSha] }; },
    async isAncestor() { return true; },
  };
  const workflow = { ...f.workflow(), github, nativeMergeHost: { policy, candidate: (base: string, head: string) => readMergeCandidate(f.git.source, base, head) } };
  const issue = () => runIssueCommand(workflow, 'acme/widgets#42', { execution: f.execution, repairTaskShapeAuthority: f.shape, dispatchClaimId: r.dispatchClaimId, admission: f.registry(), runOwnerReceiptPath: f.receiptPath, now: f.now, maxReviewAttempts: 1, assertReviewClaim: async () => {}, assertMergeInitiation: async () => {}, withDispatchAdmissionLock: async op => op() });
  return { workflow, github, policy, issue, writes: () => writes, invalidate: () => { invalid = true; } };
}
async function canonical<T>(f: Fixture, operation: (receipt: string) => Promise<T>): Promise<T> {
  const original = os.userInfo;
  try {
    os.userInfo = (() => ({ ...original(), homedir: f.root })) as typeof os.userInfo;
    const receipt = resolveRunOwnerReceiptPath('acme/widgets', f.run().id);
    writeRunOwnerReceipt(receipt, readRunOwnerReceipt(f.receiptPath)!);
    return await operation(receipt);
  } finally { os.userInfo = original; }
}

for (const window of ['before-first-oracle', 'before-first-lead', 'before-consumption', 'before-publication'] as const) {
  it(`retains initial implementation authority across ${window} live scope expansion`, async () => {
    const f = fixture(); try {
      let publicationCut = false;
      if (window === 'before-first-oracle') f.setSnapshotHook(() => { if (f.counts().validationCalls > 0 && f.counts().reviewCalls === 0) expand(f); });
      if (window === 'before-first-lead') { const submit = f.reviewer.submit; Object.assign(f.reviewer, { submit: async (q: Parameters<NativeReviewerHost['submit']>[0]) => { const e = await submit(q); expand(f); return e; } }); }
      if (window === 'before-consumption') f.setLeadSubmit(async q => { const e = f.terminal(q); expand(f); return { outcome: 'complete', evidence: e }; });
      if (window === 'before-publication') f.setSnapshotHook(() => { const r = f.store().list()[0]; if (r?.bootstrap && existsSync(path.join(r.bootstrap.workspacePath, 'repair.txt'))) { publicationCut = true; expand(f); } });
      const outcome = await f.poll();
      const r = f.run();
      if (window === 'before-publication') console.log(JSON.stringify({control:'initial-authority-publication-scope',outcome:outcome.outcome,state:r.state,reason:r.interrupt?.reason,
        initialPacketPresent:existsSync(f.prompts)&&readFileSync(f.prompts,'utf8').includes('Packet: tachiko.implementation-packet.v1'),initialAuthorityPresent:r.implementationAuthority!==undefined,
        workerStatus:r.agentResult?.exitStatus,initialFilePresent:r.bootstrap!==undefined&&existsSync(path.join(r.bootstrap.workspacePath,'implementation.txt')),
        repairFilePresent:r.bootstrap!==undefined&&existsSync(path.join(r.bootstrap.workspacePath,'repair.txt')),publicationCut,counts:f.counts(),
        historyCount:r.history.length,startFixCount:r.history.filter(h=>h.type==='start_fix').length,repairAdmissionCount:r.repairAdmissions?.length??0,
        validationStatus:r.validationResult?.status,reviewVerdict:r.reviewResult?.verdict,headPresent:r.headSha!==undefined,
        leadRequests:r.nativeLead?.requests.map(q=>({status:q.status,failure:q.failure,observations:q.observations,digestPresent:q.terminalDigest!==undefined})),
        oracleRequests:r.nativeReview?.requests.map(q=>({status:q.status,failure:q.failure,observations:q.observations,digestPresent:q.terminalDigest!==undefined}))}));
      assert.ok(r.implementationAuthority);
      assert.ok(r.implementationAuthority.input.authority.acceptedScope.text.includes('preserve all other authority'));
      assert.equal(readFileSync(f.prompts, 'utf8').includes('Expanded unadmitted'), false);
      assert.equal(f.counts().reviewCalls, window === 'before-first-oracle' ? 0 : 1);
      if (window !== 'before-publication') assert.equal(r.repairAdmissions?.length ?? 0, 0);
      else {
        assert.equal(r.repairAdmissions?.length, 1);
        assert.equal(f.git.git(f.git.remote, ['rev-parse', `refs/heads/${r.bootstrap!.branch}`]), f.reviewRequests[0]!.identity.headSha, 'unadmitted scope cannot publish the repair');
      }
    } finally { f.cleanup(); }
  });
}
it('pins the actual initial packet before any worker and rejects original binding replacement/deletion', async () => {
  const f = fixture(); try {
    const durable = f.store(); const cas = durable.updateIfUnchanged.bind(durable); let lost = false;
    durable.updateIfUnchanged = (a, b) => { if (!a.implementationAuthority && b.implementationAuthority && !lost) { lost = true; return false; } return cas(a, b); };
    await f.poll(f.lead, durable);
    assert.equal(lost, true); assert.equal(existsSync(f.prompts), false);
    await ready(f); const r = f.run();
    const changed = structuredClone(r.implementationAuthority!);
    Object.assign(changed.input.authority.acceptedScope, { text: 'Manufactured original scope' });
    const packet = buildImplementationPacket(changed.input); assert.equal(packet.kind, 'packet');
    if (packet.kind === 'packet') Object.assign(changed, { packetSha256: oracleDigest(packet.packet) });
    assert.throws(() => f.store().update({ ...r, implementationAuthority: changed }), /immutable/);
    assert.throws(() => f.store().update({ ...r, implementationAuthority: undefined }), /immutable/);
  } finally { f.cleanup(); }
});
it('missing imported historical initial provenance cannot be manufactured at first lead', async () => {
  const f = fixture(); try {
    const submit = f.reviewer.submit; Object.assign(f.reviewer, { submit: async () => ({ outcome: 'pending' }) });
    await f.poll(); const r = f.run(); const request = f.receipts.readNative(`${r.nativeReview!.activeRequestId}.request`)!;
    assert.equal(request.kind, 'request');
    const file = path.join(f.root, 'runs', `${r.id}.json`); const { implementationAuthority: _original, ...legacy } = r; writeFileSync(file, JSON.stringify(legacy));
    Object.assign(f.reviewer, { observe: async () => { assert.equal(request.kind, 'request'); return submit(request as Extract<typeof request, { kind: 'request' }>); } });
    f.tick(); await f.poll();
    assert.equal(f.run().implementationAuthority, undefined); assert.equal(f.counts().leadCalls, 0); assert.equal(f.run().repairAdmissions, undefined);
  } finally { f.cleanup(); }
});

for (const role of ['lead', 'review'] as const) {
  it(`fences raw ${role} completion at update/CAS/reducer and readable historical import cannot retire across retries`, async () => {
    const f = fixture(); try {
      if (role === 'lead') f.setLeadSubmit(async () => ({ outcome: 'pending' })); else Object.assign(f.reviewer, { submit: async () => ({ outcome: 'pending' }) });
      await f.poll(); const r = f.run();
      const forged: Run = role === 'lead' ? { ...r, nativeLead: { ...r.nativeLead!, requests: r.nativeLead!.requests.map(q => ({ ...q, status: 'qualified_complete', terminalDigest: 'a'.repeat(64) })) } } :
        { ...r, nativeReview: { ...r.nativeReview!, requests: r.nativeReview!.requests.map(q => ({ ...q, status: 'qualified_complete', terminalDigest: 'b'.repeat(64) })) } };
      assert.equal(role === 'lead' ? nativeLeadCoherent(forged) : nativeReviewCoherent(forged), true, 'prior-schema shape is readable; digest is not completion authority');
      assert.equal(role === 'lead' ? unresolvedNativeLead(forged) : unresolvedNativeReview(forged), true);
      assert.throws(() => f.store().update(forged), /coherent/);
      assert.throws(() => f.store().updateIfUnchanged(r, forged), /coherent/);
      assert.throws(() => applyTransition(forged, { type: 'start_fix' }), /Unresolved native history/);
      const generation = f.registry().readLane(`run:${r.id}`)!.generation;
      for (let i = 0; i < 2; i++) assert.throws(() => recoverRunAdmission(f.store(), f.registry(), r.id, generation, true, f.receiptPath, { retireWork: true }), /unresolved/);
      assert.notEqual(readRunOwnerReceipt(f.receiptPath)?.workDisposition, 'retired');
      writeFileSync(path.join(f.root, 'runs', `${r.id}.json`), JSON.stringify(forged));
      const historical = f.store().read(r.id)!;
      assert.equal(role === 'lead' ? unresolvedNativeLead(historical) : unresolvedNativeReview(historical), true);
      assert.throws(() => recoverRunAdmission(f.store(), f.registry(), r.id, generation, true, f.receiptPath, { retireWork: true }), /unresolved/);
      assert.notEqual(readRunOwnerReceipt(f.receiptPath)?.workDisposition, 'retired');
    } finally { f.cleanup(); }
  });
}
it('requires trusted authentication and the exact immutable request/evidence, then retains historical completion without old eligibility', async () => {
  const f = fixture(); try {
    f.setLeadSubmit(async () => ({ outcome: 'pending' })); await f.poll(); const r = f.run(); const q = f.leadRequests[0]!; const e = f.terminal(q);
    f.receipts.recordLead(e);
    assert.throws(() => f.receipts.recordAuthenticatedCompletion('lead', e, () => false), /authentication/);
    const wrong = { ...e, identity: { ...e.identity, requestId: 'foreign', correlationId: 'foreign' }, id: 'foreign.terminal' };
    assert.throws(() => f.receipts.recordAuthenticatedCompletion('lead', wrong, () => true), /authentication/);
    f.tick(); await f.poll(); f.tick(); await f.poll(); const completed = f.run(); assert.equal(completed.state, 'MERGE_READY');
    const lead = completed.nativeLead!.requests[0]!; const review = completed.nativeReview!.requests[0]!;
    assert.equal(hasAuthenticatedCompletion(lead.identity, lead.terminalDigest, lead.completionProof, 'lead'), true);
    assert.equal(hasAuthenticatedCompletion(review.identity, review.terminalDigest, review.completionProof, 'review'), true);
    const historical: Run = { ...completed, nativeLead: { ...completed.nativeLead!, activeRequestId: undefined, requests: completed.nativeLead!.requests.map(x => ({ ...x, status: 'retired' })) }, nativeReview: { ...completed.nativeReview!, activeRequestId: undefined, accepted: undefined, requests: completed.nativeReview!.requests.map(x => ({ ...x, status: 'retired' })) } };
    f.store().update(historical);
    assert.equal(unresolvedNativeLead(f.run()), false); assert.equal(unresolvedNativeReview(f.run()), false);
    assert.equal(f.workflow().reviewer.native!.validate({ run: f.run(), snapshot: await f.github.readLiveSnapshot(TARGET), assertCurrent: () => {} }), false, 'historical completion never restores current approval');
    const proof = lead.completionProof!;
    assert.equal(hasAuthenticatedCompletion(review.identity, review.terminalDigest, proof, 'review'), false);
    assert.equal(hasAuthenticatedCompletion(lead.identity, lead.terminalDigest, { ...proof, unexpected: undefined } as typeof proof, 'lead'), false);
    renameSync(proof.file, `${proof.file}.missing`);
    assert.equal(unresolvedNativeLead(historical), true);
    assert.throws(() => f.store().read(r.id), /corrupt|incompatible/);
    renameSync(`${proof.file}.missing`, proof.file);
    const bytes = readFileSync(proof.file);
    writeFileSync(proof.file, '{"invalid":true}');
    assert.equal(unresolvedNativeLead(historical), true);
    assert.throws(() => f.store().read(r.id), /corrupt|incompatible/);
    writeFileSync(proof.file, bytes);
  } finally { f.cleanup(); }
});

for (const cut of ['parked', 'active', 'park-transition', 'release-transition', 'released'] as const) {
  it(`carries operation-owned stopped proof through ${cut} retirement and idempotent retry`, async () => {
    const f = fixture(); try {
      await ready(f); const r = f.run(); const registry = f.registry(); let lane = registry.readLane(`run:${r.id}`)!;
      if (cut === 'active' || cut === 'release-transition' || cut === 'park-transition') {
        const old = readRunOwnerReceipt(f.receiptPath)!;
        const admitted = registry.admit({ laneId: lane.laneId, role: 'production_captain', evidence: lane.evidence, highAutonomy: true }, { beforePublish: a => writeRunOwnerReceipt(f.receiptPath, { ...old, phase: 'pre_execution', token: a.token, generation: a.token.generation }) });
        assert.equal(admitted.outcome, 'admitted');
        if (admitted.outcome === 'admitted' && cut === 'park-transition') {
          assert.throws(() => registry.park(admitted.token, 'workflow_settled', () => writeRunOwnerReceipt(f.receiptPath, { ...readRunOwnerReceipt(f.receiptPath)!, phase: 'park_transition' }), () => { throw new Error('park receipt crash'); }), /park receipt crash/);
        }
        lane = registry.readLane(lane.laneId)!;
      }
      if (cut === 'release-transition') { let fault = true; f.setRegistryFault(() => { if (fault) { fault = false; throw new Error('release publication crash'); } });
        assert.throws(() => recoverRunAdmission(f.store(), f.registry(), r.id, lane.generation, true, f.receiptPath, { retireWork: true }), /release publication crash/);
        assert.equal(readRunOwnerReceipt(f.receiptPath)?.phase, 'release_transition');
      }
      if (cut === 'released') {
        assert.throws(() => recoverRunAdmission(f.store(), registry, r.id, lane.generation, true, f.receiptPath, { retireWork: true, parkReceiptFinalization: () => { throw new Error('released receipt crash'); } }), /released receipt crash/);
        assert.equal(readRunOwnerReceipt(f.receiptPath)?.phase, 'released');
      }
      recoverRunAdmission(f.store(), f.registry(), r.id, lane.generation, true, f.receiptPath, { retireWork: true });
      recoverRunAdmission(f.store(), f.registry(), r.id, lane.generation, true, f.receiptPath, { retireWork: true });
      assert.equal(readRunOwnerReceipt(f.receiptPath)?.workDisposition, 'retired');
      assert.equal(f.run().nativeLead!.stoppedRecoveries!.length, 1);
    } finally { f.cleanup(); }
  });
}
it('rejects unrelated Run mutation after its own stopped proof rather than waiving final comparison', async () => {
  const f = fixture(); try {
    await ready(f); const r = f.run(); const durable = f.store(); const cas = durable.updateIfUnchanged.bind(durable); let injected = false;
    durable.updateIfUnchanged = (a, b) => { const ok = cas(a, b); if (ok && !injected && (b.nativeLead?.stoppedRecoveries?.length ?? 0) > (a.nativeLead?.stoppedRecoveries?.length ?? 0)) { injected = true; f.store().update({ ...b, updatedAt: new Date(Date.parse(b.updatedAt) + 1).toISOString() }); } return ok; };
    const generation = f.registry().readLane(`run:${r.id}`)!.generation;
    assert.throws(() => recoverRunAdmission(durable, f.registry(), r.id, generation, true, f.receiptPath, { retireWork: true }), /final owner proof/);
    assert.equal(injected, true); assert.equal(readRunOwnerReceipt(f.receiptPath)?.workDisposition, undefined);
  } finally { f.cleanup(); }
});

for (const observation of ['transport_failure', 'safety_refusal'] as const) {
  it(`preserves held ${observation} evidence and backoff; unheld replacement remains bounded`, async () => {
    const f = fixture(); try {
      f.setLeadSubmit(async () => ({ outcome: 'pending' })); await f.poll(); f.setHold(true);
      f.setLeadObserve(async () => ({ outcome: 'incomplete', reason: observation })); Object.assign(f.lead, { replacementDisposition: () => 'irrecoverable_transport' });
      let prior = Date.parse(activeNativeLead(f.run())!.nextObservationAt);
      for (let i = 0; i < (observation==='transport_failure'?3:1); i++) { f.tick(); await f.poll(); const q = activeNativeLead(f.run())!; assert.equal(q.observations, i + 1); assert.equal(q.failure, observation); assert.ok(Date.parse(q.nextObservationAt) >= prior + 30000); prior = Date.parse(q.nextObservationAt); }
      if(observation==='safety_refusal'){const generation=f.registry().readLane(`run:${f.run().id}`)!.generation,reads=f.counts().observations;f.tick();await f.poll();assert.equal(f.counts().observations,reads);assert.equal(f.registry().readLane(`run:${f.run().id}`)!.generation,generation);}
      assert.equal(f.counts().leadCalls, 1); assert.equal(f.run().repairAdmissions, undefined); assert.equal(f.counts().boundaries, 0);
      f.setHold(false); f.tick(); await f.poll();
      assert.equal(f.counts().leadCalls, observation === 'transport_failure' ? 2 : 1);
      f.tick(); await f.poll(); assert.ok(f.counts().leadCalls <= 2);
    } finally { f.cleanup(); }
  });
}
it('never downgrades held incomplete/refusal evidence when a later observation is only pending', async () => {
  const f = fixture(); try {
    f.setLeadSubmit(async () => ({ outcome: 'pending' })); await f.poll(); f.setHold(true);
    for (const reason of ['transport_failure', 'safety_refusal'] as const) { f.setLeadObserve(async () => reason ? { outcome: 'incomplete', reason } : { outcome: 'pending' }); f.tick(); await f.poll(); }
    const reads=f.counts().observations; f.setLeadObserve(async()=>({outcome:'pending'})); f.tick(); await f.poll(); assert.equal(f.counts().observations,reads,'automatic refusal polling is disabled');
    // Exercise monotonic evidence through the actual observer/store CAS without
    // using the automatic scheduler to grant another refusal observation.
    await runIssueCommand(f.workflow(),'acme/widgets#42',{execution:f.execution,repairTaskShapeAuthority:f.shape,dispatchClaimId:f.run().dispatchClaimId,admission:f.registry(),runOwnerReceiptPath:f.receiptPath,now:f.now,maxReviewAttempts:1,leadObservationOnly:true,async assertReviewClaim(){},withDispatchAdmissionLock:async op=>op()});
    const q = activeNativeLead(f.run())!; assert.equal(q.status, 'incomplete'); assert.equal(q.failure, 'safety_refusal'); assert.equal(q.observations, 3);
    Object.assign(f.lead, { replacementDisposition: () => 'irrecoverable_transport' }); f.setHold(false); f.tick(); await f.poll(); assert.equal(f.counts().leadCalls, 1);
  } finally { f.cleanup(); }
});

it('completes actual lead/new-HEAD/fresh gates/native squash/settlement/reconciliation before queue delivery', async () => {
  const f = fixture(); try {
    await ready(f); const m = mergeFixture(f); await m.issue(); const r = f.run(); assertNativeMergeSettlement(r);
    const refusedReview:Run={...r,nativeReview:{...r.nativeReview!,requests:r.nativeReview!.requests.map(q=>q.identity.requestId===r.nativeReview!.activeRequestId?{...q,failure:'safety_refusal'}:q)}};
    assert.throws(()=>assertNativeMergeSettlement(refusedReview),/review.*qualification/i,'a genuine merge attempt cannot reuse a refused Oracle projection as current settlement authority');
    assert.equal(m.writes(), 1); assert.equal(f.registry().readLane(`run:${r.id}`)!.parkedReason, 'workflow_settled');
    assert.equal(isDispatchRunOwnerRetiredCommand(f.store(), r, f.registry()), false);
    assert.equal(selectDispatchRuntime(await f.runtime.listRuntimeComments())!.claim.issue, 42);
    let earlyNext = 0;
    await dispatchOnceCommand({ ...f.config, merge: m.policy }, { workflow: m.workflow, runtime: f.runtime, admission: f.registry(), now: f.now,
      resolveExecutionProfile: () => f.execution, reconcileMergedRun: async () => null, isRunOwnerRetired: () => false,
      runIssue: async () => { earlyNext++; throw new Error('successor before exact release'); },
      resumeClaimedRun: async () => ({ outcome: 'merge_ready', run: r }) });
    assert.equal(earlyNext, 0); assert.equal(selectDispatchRuntime(await f.runtime.listRuntimeComments())!.claim.issue, 42);

    await canonical(f, async receipt => {
      const settled = await reconcileDispatchMergedRunCommand(f.store(), r, m.github, f.registry(), async op => op());
      assert.equal(settled!.state, 'MERGED'); assert.equal(f.registry().readLane(`run:${r.id}`)!.status, 'released');
      assert.equal(readRunOwnerReceipt(receipt)?.settlementReason, 'workflow_settled');
      assert.equal(isDispatchRunOwnerRetiredCommand(f.store(), settled!, f.registry()), true);
      assert.deepEqual(await runMergedTransitionCommand(f.store(), r.id, m.github, f.registry(), async op => op()), settled);
      let nextEffects = 0;
      const dispatch = () => dispatchOnceCommand({ ...f.config, merge: m.policy }, { workflow: m.workflow, runtime: f.runtime, admission: f.registry(), now: f.now, resolveExecutionProfile: () => f.execution, reconcileMergedRun: x => reconcileDispatchMergedRunCommand(f.store(), x, m.github, f.registry(), async op => op()), isRunOwnerRetired: x => isDispatchRunOwnerRetiredCommand(f.store(), x, f.registry()), runIssue: async (ref, execution, claimId, shape) => { nextEffects++; assert.equal(f.store().read(r.id)!.state, 'MERGED'); assert.equal(isDispatchRunOwnerRetiredCommand(f.store(), f.store().read(r.id)!, f.registry()), true); const unavailable = { ...buildWorkflowDeps(f.store()), github: m.github }; return runIssueCommand(unavailable, ref, { execution, repairTaskShapeAuthority: shape, dispatchClaimId: claimId, admission: f.registry(), now: f.now, maxReviewAttempts: 1 }); }, resumeClaimedRun: async () => { throw new Error('completed row must not execute again'); } });
      await dispatch(); assert.equal(nextEffects, 1, 'a successor can be claimed only after exact released integration proof');
      const nextClaim = selectDispatchRuntime(await f.runtime.listRuntimeComments())!.claim;
      assert.equal(nextClaim.issue, 43);
      const next = f.store().read(nextClaim.runId!)!;
      assert.equal(next.state, 'WAITING_DEPENDENCY');
      assert.equal(next.nativeReview!.requests.length, 0, 'typed unavailable default factory submits no service request');
      assert.equal(f.registry().readLane(`run:${next.id}`)!.status, 'parked', 'B has actual owner admission only after qualified A release');
      assert.equal(m.writes(), 1);
    });
  } finally { f.cleanup(); }
});
it('retains failed integration and stop/HOLD fences without merge, retirement or successor effects', async () => {
  const f = fixture(); try {
    await ready(f); const m = mergeFixture(f); m.invalidate(); await m.issue(); const r = f.run();
    assert.equal(m.writes(), 1); assert.throws(() => assertNativeMergeSettlement(r), /qualified/);
    assert.equal(f.registry().readLane(`run:${r.id}`)!.parkedReason, 'workflow_wait');
    await canonical(f, async () => { await assert.rejects(() => runMergedTransitionCommand(f.store(), r.id, m.github, f.registry(), async op => op()), /tree|integration/); });
    assert.equal(f.registry().readLane(`run:${r.id}`)!.status, 'parked');
  } finally { f.cleanup(); }
  const stop = fixture(); try {
    stop.setLeadSubmit(async q => ({ outcome: 'complete', evidence: stop.terminal(q, 'stop') })); await stop.poll(); const r = stop.run();
    assert.throws(() => recoverRunAdmission(stop.store(), stop.registry(), r.id, stop.registry().readLane(`run:${r.id}`)!.generation, true, stop.receiptPath, { retireWork: true }), /unresolved/);
    assert.equal(isDispatchRunOwnerRetiredCommand(stop.store(), r, stop.registry()), false);
    assert.equal(stop.counts().boundaries, 0);
  } finally { stop.cleanup(); }
});

for (const entry of ['run', 'resume', 'merged'] as const) {
  it(`uses only operation-owned post-succession snapshots at the ${entry} caller`, async () => {
    const f = fixture(); try {
      if (entry === 'run') { f.setLeadSubmit(async () => ({ outcome: 'pending' })); await f.poll(); }
      else await ready(f);
      let r = f.run();
      if (entry === 'resume') { const waiting = applyTransition(r, { type: 'wait_dependency', reason: 'explicit fixture retry', interrupt: { choices: ['Retry exact dependency'] } }, f.now()); f.store().update(waiting); r = waiting; }
      const beforeEffects = f.counts(); const beforePackets = readFileSync(f.prompts, 'utf8');
      const durable = f.store(); const cas = durable.updateIfUnchanged.bind(durable); let injected = false;
      durable.updateIfUnchanged = (a, b) => {
        const ok = cas(a, b);
        if (ok && !injected && b.nativeLead?.ownerSuccessions.some((s, i) => s.status === 'confirmed' && a.nativeLead?.ownerSuccessions[i]?.status === 'prepared')) {
          injected = true;
          f.store().update({ ...b, updatedAt: new Date(Date.parse(b.updatedAt) + 1).toISOString() });
        }
        return ok;
      };
      if (entry === 'run') {
        f.tick(); await assert.rejects(() => f.poll(f.lead, durable), /operation-owned admission/);
        assert.equal(f.counts().leadCalls, 1); assert.equal(f.run().repairAdmissions, undefined);
      } else if (entry === 'resume') {
        const stages: string[] = [];
        await assert.rejects(() => resumeCommand(f.workflow(f.lead, durable), r.id, 'Retry exact dependency', { execution: f.execution, dispatchClaimId: r.dispatchClaimId, admission: f.registry(), runOwnerReceiptPath: f.receiptPath, now: f.now, publishRuntimeProjection: (_registry, _store, view) => { stages.push(view.stage); } }), /changed|reload/);
        assert.deepEqual(stages, ['pre_execution_released'], 'resume CAS failed before workflow/onExecutionStart entry');
        assert.deepEqual(f.run().history, r.history);
      } else {
        await canonical(f, async () => {
          const m = mergeFixture(f); const lane = f.registry().readLane(`run:${r.id}`)!;
          const tree = f.git.git(f.git.source, ['rev-parse', `${r.headSha}^{tree}`]);
          const commit = f.git.git(f.git.source, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit-tree', tree, '-p', f.git.baseSha, '-m', 'controlled recovery squash']);
          // Exact issued-attempt fixture supplements the separate end-to-end issuance test.
          f.store().update({ ...r, mergeAttempt: { identity: { attemptId: 'controlled-issued-recovery', runId: r.id, claimId: r.dispatchClaimId!, missionId: lane.missionId, laneId: lane.laneId, generation: lane.generation - 1, pullRequestNumber: 7, sourceBranch: r.bootstrap!.branch, headSha: r.headSha!, baseSha: f.git.baseSha, treeSha: tree, reviewDigest: r.nativeReview!.accepted!.digest, validationDigest: oracleDigest(r.validationResult), policy: m.policy, preparedAt: f.now() }, submissionPossible: true, issuanceGeneration: lane.generation - 1, observations: 3, nextObservationAt: f.now() } });
          const github = { ...m.github, async readPullRequest() { return { ...(await f.github.readLiveSnapshot(TARGET)).pullRequest!, state: 'merged' as const, mergeCommitSha: commit }; }, async readDefaultBranch() { return { branch: 'main', headSha: commit }; }, async readCommit() { return { sha: commit, treeSha: tree, parents: [f.git.baseSha] }; } };
          await assert.rejects(() => runMergedTransitionCommand(durable, r.id, github, f.registry(), async op => op()), /qualified merge recovery CAS/);
          assert.equal(f.run().mergeAttempt!.qualification, undefined);
        });
      }
      assert.equal(injected, true);
      assert.equal(f.registry().readLane(`run:${r.id}`)!.status, entry === 'resume' ? 'released' : 'active');
      assert.deepEqual(f.counts(), beforeEffects, 'no service/validation or repair process boundary ran');
      assert.equal(readFileSync(f.prompts, 'utf8'), beforePackets, 'no child consumed another packet');
      assert.equal(selectDispatchRuntime(await f.runtime.listRuntimeComments())!.claim.issue, 42, 'A row remains retained');
      if (entry === 'resume') {
        assert.equal(readRunOwnerReceipt(f.receiptPath)?.workDisposition, undefined, 'known pre-execution release never retires work');
        await canonical(f, async () => { assert.equal(isDispatchRunOwnerRetiredCommand(f.store(), f.run(), f.registry()), false, 'released capability is not delivery/retirement proof'); });
      }
    } finally { f.cleanup(); }
  });
}

it('reconciles a genuine held terminal after incomplete evidence without promoting a prior refusal to repair permission', async () => {
  for (const failure of ['transport_failure', 'safety_refusal'] as const) {
    const f = fixture(); try {
      f.setLeadSubmit(async () => ({ outcome: 'pending' })); await f.poll(); f.setHold(true);
      f.setLeadObserve(async () => ({ outcome: 'incomplete', reason: failure })); f.tick(); await f.poll();
      f.setLeadObserve(async () => ({ outcome: 'complete', evidence: f.terminal(f.leadRequests[0]!) })); f.tick();
      if(failure==='safety_refusal') {
        f.receipts.recordLead(f.terminal(f.leadRequests[0]!));
        await runIssueCommand(f.workflow(),'acme/widgets#42',{execution:f.execution,repairTaskShapeAuthority:f.shape,dispatchClaimId:f.run().dispatchClaimId,admission:f.registry(),runOwnerReceiptPath:f.receiptPath,now:f.now,maxReviewAttempts:1,leadObservationOnly:true,nativeCachedOnly:true,async assertReviewClaim(){},withDispatchAdmissionLock:async op=>op()});
      } else await f.poll();
      const observed = f.run(); assert.equal(unresolvedNativeLead(observed), false);
      assert.equal(activeNativeLead(observed)!.failure, failure); assert.equal(activeNativeLead(observed)!.observations, failure==='transport_failure'?2:1);
      assert.equal(observed.repairAdmissions, undefined); assert.equal(f.counts().leadCalls, 1); assert.equal(f.counts().boundaries, 0);
      f.setHold(false); f.tick(); await f.poll();
      assert.equal(f.run().repairAdmissions?.length ?? 0, failure === 'transport_failure' ? 1 : 0);
      assert.equal(f.counts().leadCalls, 1);
    } finally { f.cleanup(); }
  }
});

it('a late inactive authenticated stop reconciles only its original uncertainty and cannot veto the qualified replacement cycle', async () => {
  const f = fixture(); try {
    let submissions = 0;
    f.setLeadSubmit(async q => ++submissions === 1 ? { outcome: 'terminal_unknown' } : { outcome: 'complete', evidence: f.terminal(q) });
    Object.assign(f.lead, { replacementDisposition: () => 'irrecoverable_transport' });
    await f.poll(); const original = f.leadRequests[0]!;
    f.tick(); await f.poll();
    assert.equal(f.counts().leadCalls, 2);
    assert.equal(f.run().state, 'WAITING_DEPENDENCY');
    assert.equal(f.run().repairAdmissions?.length ?? 0, 0, 'replacement cannot consume while the original is unknown');
    assert.equal(f.run().history.filter(h => h.type === 'start_fix').length, 0);
    assert.equal(f.counts().boundaries, 0, 'no repair process or publication boundary may run while original work is unknown');
    assert.equal(f.run().telemetry?.events.filter(e => e.kind === 'spawn' && e.role === 'worker').length, 1, 'actual initial implementation worker telemetry is separate from repair boundaries');
    const initialPackets = readFileSync(f.prompts, 'utf8');
    assert.equal(initialPackets.split('Packet: tachiko.implementation-packet.v1').length - 1, 1, 'one original packet actually reached the fixture worker');
    assert.equal(f.run().implementationAuthority?.input.kind, 'initial');
    assert.ok(initialPackets.includes(f.run().implementationAuthority!.input.identity.baseSha), 'actual initial worker received the original packet base');
    assert.ok(initialPackets.includes(f.run().implementationAuthority!.input.authority.acceptedScope.text), 'actual initial worker received original accepted scope');
    f.setLeadObserve(async identity => { assert.equal(identity.requestId, original.identity.requestId); return { outcome: 'complete', evidence: f.terminal(original, 'stop') }; });
    for (let i = 0; i < 4 && (f.run().state !== 'MERGE_READY' || unresolvedNativeLead(f.run())); i++) { f.tick(); await f.poll(); }
    const r = f.run(); assert.equal(r.state, 'MERGE_READY'); assert.equal(unresolvedNativeLead(r), false);
    assert.ok(r.nativeLead!.acceptances.some(a => a.requestId === original.identity.requestId && a.disposition.outcome === 'stop'));
    assert.equal(r.history.some(h => h.nativeLeadStop !== undefined), false, 'inactive output is never adopted as the current stop disposition');
    assert.equal(r.repairAdmissions!.length, 1); assert.equal(r.repairAdmissions![0]!.leadDisposition!.requestId, f.leadRequests[1]!.identity.requestId);
    const m = mergeFixture(f); await m.issue(); assert.equal(m.writes(), 1); assertNativeMergeSettlement(f.run());
    assert.equal(f.registry().readLane(`run:${r.id}`)!.parkedReason, 'workflow_settled');
    await canonical(f, async receipt => {
      const settled = await reconcileDispatchMergedRunCommand(f.store(), f.run(), m.github, f.registry(), async op => op());
      assert.equal(settled!.state, 'MERGED'); assert.equal(f.registry().readLane(`run:${r.id}`)!.status, 'released');
      assert.equal(readRunOwnerReceipt(receipt)?.settlementReason, 'workflow_settled');
      let successors = 0;
      await dispatchOnceCommand({ ...f.config, merge: m.policy }, {
        workflow: m.workflow, runtime: f.runtime, admission: f.registry(), now: f.now, resolveExecutionProfile: () => f.execution,
        reconcileMergedRun: x => reconcileDispatchMergedRunCommand(f.store(), x, m.github, f.registry(), async op => op()),
        isRunOwnerRetired: x => isDispatchRunOwnerRetiredCommand(f.store(), x, f.registry()),
        runIssue: async (ref, execution, claimId, shape) => {
          successors++; assert.equal(f.store().read(r.id)!.state, 'MERGED');
          assert.equal(isDispatchRunOwnerRetiredCommand(f.store(), f.store().read(r.id)!, f.registry()), true);
          return runIssueCommand({ ...buildWorkflowDeps(f.store()), github: m.github }, ref, { execution, repairTaskShapeAuthority: shape, dispatchClaimId: claimId, admission: f.registry(), now: f.now, maxReviewAttempts: 1 });
        },
        resumeClaimedRun: async () => { throw new Error('settled A cannot execute again'); },
      });
      assert.equal(successors, 1); const claim = selectDispatchRuntime(await f.runtime.listRuntimeComments())!.claim;
      assert.equal(claim.issue, 43); const next = f.store().read(claim.runId!)!;
      assert.equal(next.state, 'WAITING_DEPENDENCY'); assert.equal(next.nativeReview!.requests.length, 0);
      assert.equal(f.registry().readLane(`run:${next.id}`)!.status, 'parked');
      assert.equal(f.store().read(r.id)!.state, 'MERGED'); assert.equal(m.writes(), 1);
    });
    assert.equal(f.counts().leadCalls, 2); assert.equal(f.counts().boundaries, 2);
  } finally { f.cleanup(); }
});
