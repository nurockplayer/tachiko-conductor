import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { it } from 'node:test';
import { newRun, T0, TEST_VALIDATION_AUTHORITY, validationPassed, validationFailed } from './helpers.js';
import type { Run } from '../src/domain/types.js';
import { CANCEL_RUN_DECISION } from '../src/domain/decisions.js';
import { buildImplementationPacket } from '../src/agents/implementation-packet.js';
import { createRepairAdmissionSnapshot, createRepairAttemptBinding, activeRepairAdmission } from '../src/domain/repair-admission.js';
import { applyTransition } from '../src/domain/state-machine.js';
import { JsonFileStore } from '../src/store/json-file-store.js';
import { JsonFileOracleReceiptStore } from '../src/oracle/receipt-store.js';
import { hasAuthenticatedCompletion, type NativeCompletionHosts } from '../src/oracle/completion-proof.js';
import { nativeReviewCoherent, unresolvedNativeReview, resolveNativeReviewer, issuedReviewRecoveryConfiguration } from '../src/oracle/native-reviewer.js';
import { nativeLeadCoherent, unresolvedNativeLead, validLeadEvidence, resolveNativeLead, leadConsumptionValid, nativeLeadReentry } from '../src/oracle/native-lead.js';
import { runReviewLoop } from '../src/reviewers/loop.js';
import { canonicalReviewTarget } from '../src/reviewers/risk-policy.js';
import { oracleDigest, textDigest } from '../src/oracle/source-evidence.js';
import { recoverRunAdmission, resumeCommand, isDispatchRunOwnerRetiredCommand, buildWorkflowDeps, main, publishAdmissionRuntimeProjection } from '../src/cli.js';
import { createHostAdmissionRegistry, resolveRunOwnerReceiptPath } from '../src/mission-admission/host-registry.js';
import { readRunOwnerReceipt, writeRunOwnerReceipt } from '../src/mission-admission/run-owner-receipt.js';
import { GitHubDispatchRuntime } from '../src/dispatch/github-runtime.js';
import { renderDispatchRuntime, selectDispatchRuntime } from '../src/dispatch/queue.js';
import { LiveGitHubAdapter } from '../src/github/live-state.js';
import { NodeProcessRunner } from '../src/github/transport.js';
import { runWorkflow } from '../src/workflow/run.js';
import { MissionAdmissionRegistry, deterministicMissionId } from '../src/mission-admission/registry.js';

// No Git, service, worker, or subprocess fixture. Real file persistence, immutable
// publication, HMAC authentication, store CAS and public command fences are used.
// Controlled Run/request fixtures do not claim an actual implementation delivery.
function fixture(role: 'review' | 'lead', canonicalOwner = false) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'native-completion-trust-'));
  const receipts = new JsonFileOracleReceiptStore(path.join(root, 'host-receipts'));
  const sign = (e: any) => createHmac('sha256', 'controlled-test-authenticator-not-production').update(oracleDigest({ kind: e.kind, identity: e.identity, ...(e.kind === 'completion' ? { terminalSha256: e.terminalSha256 } : e.disposition ? { disposition: e.disposition } : { result: e.result }) })).digest('hex');
  let authenticates = true;
  const authenticate = (e: any) => authenticates && e.authentication.transportReceipt === sign(e);
  const hosts: NativeCompletionHosts = { review: { receipts, authenticate }, lead: { receipts, authenticate } };
  const store = (trusted: NativeCompletionHosts | undefined = hosts, directory = 'runs') => new JsonFileStore({ dir: path.join(root, directory), nativeCompletionHosts: trusted });
  const baseSha = 'a'.repeat(40), headSha = 'b'.repeat(40), text = 'bounded original implementation\n';
  const files = [{ path: 'implementation.txt', base: null, head: { text, sha256: textDigest(text), oid: createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex') } }];
  const diff = 'controlled original source manifest';
  const manifest = { baseSha, headSha, files, diff, sourceSha256: oracleDigest(files), diffSha256: textDigest(diff) };
  const run: any = { ...newRun(`trust-${role}`), dispatchClaimId: 'claim-trust', headSha, pullRequest: { number: 7, headSha } };
  const reviewIdentity: any = { runId: run.id, claimId: run.dispatchClaimId, missionId: canonicalOwner ? deterministicMissionId({ repository: 'acme/widgets', issue: 42 }) : 'mission-trust', laneId: `run:${run.id}`, phase: 'review', role: 'independent-reviewer', targetKey: canonicalReviewTarget(run.target)!.key, repository: 'acme/widgets', pullRequestNumber: 7, baseSha, headSha, scope: 'complete-candidate', sourceSha256: manifest.sourceSha256, diffSha256: manifest.diffSha256, floor: 'R5', requestedEffort: 'Extra High', requestedModel: 'controlled-oracle', requestId: 'review-request', correlationId: 'review-request', ownerGeneration: 1, contractRevision: JSON.stringify([role === 'lead' ? 'original-contract' : undefined, 'original-contract']), policyRevision: 'independent-unpromoted-v1', bindingId: 'controlled-host' };
  const reviewRequest: any = { kind: 'request', id: 'review-request.request', identity: reviewIdentity, manifest };
  const origin: any = { kind: 'terminal', id: 'review-request.terminal', identity: reviewIdentity, result: { verdict: role === 'lead' ? 'request_changes' : 'approve', reviewerName: 'controlled-independent', headSha, findings: role === 'lead' ? [{ severity: 'blocking', summary: 'Bounded original finding' }] : [] }, authentication: { actorId: 'independent', model: reviewIdentity.requestedModel, effort: reviewIdentity.requestedEffort, transportReceipt: '' } };
  origin.authentication.transportReceipt = sign(origin);
  receipts.recordNative(reviewRequest);
  let request = reviewRequest, terminal = origin;
  const state = (identity: any) => ({ identity, status: 'pending', submissionPossible: true, observations: 0, nextObservationAt: T0 });
  run.nativeReview = { requests: [state(reviewIdentity)], activeRequestId: reviewIdentity.requestId };
  if (role === 'lead') {
    receipts.recordNative(origin);
    run.nativeReview.requests[0] = { ...state(reviewIdentity), status: 'qualified_complete', terminalDigest: oracleDigest(origin), completionProof: receipts.recordAuthenticatedCompletion('review', origin, authenticate) };
    run.nativeReview.accepted = { requestId: reviewIdentity.requestId, receiptId: origin.id, digest: oracleDigest(origin), identity: reviewIdentity };
    const execution: any = { profile: 'routine', revision: 'test-execution-v1', executor: 'luna-isolated', model: 'gpt-5.6-luna', reasoningEffort: 'high', timeoutMs: 30000, sandboxMode: 'workspace-write', approvalPolicy: 'never' };
    const authority: any = { implementationAuthoritySha256: 'c'.repeat(64), target: run.target, pullRequest: run.pullRequest, bootstrap: { bootstrapKind: 'standalone-isolated', owner: 'acme', repo: 'widgets', issueNumber: 42, baseSha, workspacePath: path.join(root, 'workspace'), branch: 'candidate' }, taskShape: { revision: 'original-contract', shape: 'bounded' }, originalExecution: execution, execution, validation: validationPassed(headSha), reviewIdentity, scope: { sourceId: 'original-scope', sourceScope: 'issue', sourceUpdatedAt: T0, freshness: 'current', text: 'Create implementation.txt only.' }, issue: { id: 'I_42', number: 42, title: 'Bounded fixture', body: 'Original scope', state: 'open', url: '', createdAt: T0, updatedAt: T0 }, maxAttempts: 1 };
    run.bootstrap = { ...authority.bootstrap, baseBranch: 'main' };
    authority.bootstrap = run.bootstrap;
    run.execution = execution; run.repairTaskShapeAuthority = authority.taskShape;
    const input: any = { kind: 'initial', identity: { runId: run.id, target: run.target, workspacePath: run.bootstrap.workspacePath, branch: run.bootstrap.branch, baseSha, execution }, authority: { repository: { owner: 'acme', repo: 'widgets' }, issue: { id: authority.issue.id, number: 42, updatedAt: T0, title: authority.issue.title, body: authority.issue.body }, acceptedScope: authority.scope }, repair: null };
    const originalPacket = buildImplementationPacket(input); assert.equal(originalPacket.kind, 'packet');
    if (originalPacket.kind !== 'packet') throw new Error('Controlled original packet invalid');
    run.implementationAuthority = { input, taskShape: authority.taskShape, packetSha256: oracleDigest(originalPacket.packet) };
    authority.implementationAuthoritySha256 = oracleDigest(run.implementationAuthority);
    const blockingFindingIds = [`${oracleDigest(origin)}:0`];
    const packet = { origin, manifest, authority, blockingFindingIds, remainingRepairs: 1 };
    const identity: any = { requestId: 'lead-request', correlationId: 'lead-request', incarnation: oracleDigest({ runId: run.id, claimId: run.dispatchClaimId, missionId: reviewIdentity.missionId, origin: run.nativeReview.accepted, packetSha256: oracleDigest(packet), blockingFindingIds, repairOrdinal: 1 }), runId: run.id, claimId: run.dispatchClaimId, missionId: reviewIdentity.missionId, laneId: reviewIdentity.laneId, ownerGeneration: 1, phase: 'lead-disposition', role: 'bounded-lead', repository: 'acme/widgets', targetKey: reviewIdentity.targetKey, pullRequestNumber: 7, baseSha, headSha, origin: { requestId: origin.identity.requestId, receiptId: origin.id, digest: oracleDigest(origin) }, authoritySha256: oracleDigest(authority), sourceSha256: manifest.sourceSha256, diffSha256: manifest.diffSha256, packetSha256: oracleDigest(packet), blockingFindingIds, repairOrdinal: 1, repairLimit: 1, bindingId: 'controlled-sol', policyRevision: 'bounded-lead-v1', requestedModel: 'controlled-sol', requestedEffort: 'High' };
    request = { kind: 'request', id: `${identity.requestId}.request`, identity, packet };
    terminal = { kind: 'terminal', id: `${identity.requestId}.terminal`, identity, disposition: { outcome: 'repair', origin: identity.origin, authoritySha256: identity.authoritySha256, acceptedFindingIds: blockingFindingIds, instructions: 'Repair the exact original blocking finding within implementation.txt.' }, authentication: { actorId: 'bounded-sol', role: 'bounded-lead', readOnly: true, model: identity.requestedModel, effort: 'High', transportReceipt: '' } };
    terminal.authentication.transportReceipt = sign(terminal);
    assert.equal(validLeadEvidence(request), true, 'controlled complete lead request packet is valid');
    receipts.recordLead(request);
    run.nativeLead = { requests: [state(identity)], acceptances: [], ownerSuccessions: [], activeRequestId: identity.requestId };
  }
  const key = role === 'review' ? 'nativeReview' : 'nativeLead';
  store().create(run);
  const complete = () => {
    if (role === 'lead') receipts.recordLead(terminal); else receipts.recordNative(terminal);
    const proof = receipts.recordAuthenticatedCompletion(role, terminal, authenticate);
    const next = structuredClone(run);
    Object.assign(next[key].requests[0], { status: 'qualified_complete', terminalDigest: oracleDigest(terminal), completionProof: proof });
    return next as Run;
  };
  const unresolved = (r: Run) => role === 'lead' ? unresolvedNativeLead(r) : unresolvedNativeReview(r);
  const registry = () => new MissionAdmissionRegistry({ filePath: path.join(root, 'mission.json'), config: { schemaVersion: 1, revision: 'controlled-v1', limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } } });
  return { root, role, key, run: run as Run, request, terminal, receipts, hosts, store, complete, unresolved, registry, setAuthentication: (value: boolean) => { authenticates = value; }, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

it('lead: exact authenticated terminal disposition binds acceptance instructions at persistence and fresh load', () => {
  const f = fixture('lead');
  try {
    const next: any = f.complete(), q = next.nativeLead.requests[0];
    const acceptance = { requestId: q.identity.requestId, receiptId: f.terminal.id, digest: q.terminalDigest, identity: q.identity, disposition: f.terminal.disposition };
    const forged: any = structuredClone(next);
    forged.nativeLead.acceptances = [{ ...acceptance, disposition: { ...acceptance.disposition, instructions: 'Substituted bounded instructions' } }];
    assert.throws(() => f.store().update(forged), /exact authenticated immutable terminal/);
    assert.throws(() => f.store().updateIfUnchanged(f.run, forged), /exact authenticated immutable terminal/);
    assert.throws(() => f.store(f.hosts, 'substituted-import').create(forged), /exact authenticated immutable terminal/);
    next.nativeLead.acceptances = [acceptance]; f.store().update(next);
    assert.deepEqual(f.store().read(next.id)!.nativeLead!.acceptances, [acceptance]);
    writeFileSync(path.join(f.root, 'runs', `${next.id}.json`), JSON.stringify(forged));
    assert.throws(() => f.store().read(next.id), /exact authenticated immutable terminal/);
    assert.equal(f.unresolved(f.store({}).read(next.id)!), true);
  } finally { f.cleanup(); }
});

for (const role of ['review', 'lead'] as const) {
  it(`${role}: unsupported receipt/authentication context is unavailable before service issue`, () => {
    const f = fixture(role);
    try {
      let calls = 0;
      const binding = role === 'lead' ? { bindingId: 'controlled-sol', policyRevision: 'bounded-lead-v1', model: 'controlled-sol', effort: 'High', readOnly: true, qualified: true, allowTransportReplacement: false } : { bindingId: 'controlled-oracle', contractRevision: 'original-contract', policyRevision: 'independent-unpromoted-v1', scope: 'complete-candidate', model: 'controlled-oracle', supportedEfforts: ['Extra High'], authorActorIds: ['author'], allowTransportReplacement: false };
      const host: any = { ...f.hosts[role], binding, source: () => f.request.manifest ?? f.request.packet.manifest, async submit() { calls++; throw new Error('Must not issue'); } };
      assert.equal(role === 'lead' ? resolveNativeLead(host).available() : resolveNativeReviewer(host).native!.available(), true);
      const fake: any = { ...host, receipts: { recordNative() {}, readNative() { return null; }, recordLead() {}, readLead() { return null; }, recordAuthenticatedCompletion() { return { file: '/caller/native/authenticated/fake.json', digest: 'a'.repeat(64) }; }, verifyAuthenticatedCompletion() { return true; } } };
      assert.equal(role === 'lead' ? resolveNativeLead(fake).available() : resolveNativeReviewer(fake).native!.available(), false);
      assert.equal(calls, 0);
    } finally { f.cleanup(); }
  });

  it(`${role}: caller private root, false host authentication and forged verifier cannot clear uncertainty`, async () => {
    const f = fixture(role);
    try {
      const next: any = structuredClone(applyTransition(f.run, { type: 'wait_dependency', reason: 'Controlled issued-work wait' })), q = next[f.key].requests[0];
      const native = path.join(f.root, 'worker', 'native'), records = role === 'lead' ? path.join(native, 'lead') : native;
      mkdirSync(records, { recursive: true, mode: 0o700 }); mkdirSync(path.join(native, 'authenticated'), { mode: 0o700 });
      const terminal = structuredClone(f.terminal); terminal.authentication.transportReceipt = 'not-authenticated';
      const record = { version: 'native-authenticated-completion/v1', namespace: role, request: f.request, evidence: terminal };
      const file = path.join(native, 'authenticated', `${role}.${q.identity.requestId}.json`);
      for (const [name, value] of [[path.join(records, `${f.request.id}.json`), f.request], [path.join(records, `${terminal.id}.json`), terminal], [file, record]] as const) writeFileSync(name, JSON.stringify(value), { mode: 0o600 });
      Object.assign(q, { status: 'qualified_complete', terminalDigest: oracleDigest(terminal), completionProof: { file, digest: oracleDigest(record) } });
      assert.equal(hasAuthenticatedCompletion(q.identity, q.terminalDigest, q.completionProof, role), false);
      assert.equal(f.unresolved(next), true);
      assert.throws(() => f.store().update(next), /completion/);
      assert.throws(() => f.store().updateIfUnchanged(f.run, next), /completion/);
      assert.throws(() => f.store(f.hosts, 'import').create(next), /completion/);
      assert.throws(() => f.store({}, 'untrusted-import').create(next), /completion/);
      assert.throws(() => applyTransition(next, { type: 'start' }), /Native ledger/);
      const forgedHost: any = { receipts: { verifyAuthenticatedCompletion: () => true }, authenticate: () => true };
      assert.throws(() => f.store({ [role]: forgedHost }, 'forged-context').create(next), /configured host/);
      // A raw imported file can be inspected without context, but cannot produce
      // a binding or bypass actual cancellation/retirement/current eligibility.
      writeFileSync(path.join(f.root, 'runs', `${next.id}.json`), JSON.stringify(next));
      assert.throws(() => f.store().read(next.id), /completion/);
      const untrusted = f.store({}).read(next.id)!;
      assert.equal(f.unresolved(untrusted), true);
      assert.throws(() => applyTransition(untrusted, { type: 'start' }), /Native ledger/);
      assert.throws(() => recoverRunAdmission(f.store({}), f.registry(), next.id, 1, true, path.join(f.root, 'owner.json'), { retireWork: true }), /unresolved/);
      await assert.rejects(resumeCommand({ store: f.store({}) } as any, next.id, CANCEL_RUN_DECISION, { admission: f.registry(), dispatchClaimId: 'claim-trust' }), /uncertain|cancellation/);
      assert.equal(await isDispatchRunOwnerRetiredCommand(f.store({}), untrusted, f.registry()), false);
      assert.equal(f.receipts[role === 'lead' ? 'readLead' : 'readNative'](terminal.id), null);
    } finally { f.cleanup(); }
  });

  it(`${role}: configured authentication is reconstructed on restart/CAS and after JSON cloning`, () => {
    const f = fixture(role);
    try {
      const next = f.complete();
      assert.equal(f.unresolved(next), true, 'publication or a matching path alone does not grant a binding');
      assert.equal(f.store().updateIfUnchanged(f.run, next), true);
      assert.equal(f.unresolved(next), false);
      const loaded = f.store().read(next.id)!;
      assert.equal(f.unresolved(loaded), false);
      const cloned = structuredClone(loaded);
      assert.equal(f.unresolved(cloned), true, 'clone carries evidence, no memory-only authority');
      assert.equal(f.store().updateIfUnchanged(loaded, cloned), true, 'actual configured CAS reauthenticates the clone');
      assert.equal(f.unresolved(cloned), false);
      assert.equal(applyTransition(cloned, { type: 'start' }).state, 'IMPLEMENTING');
      const proofRow = (loaded as any)[f.key].requests[0];
      assert.equal(hasAuthenticatedCompletion({ ...proofRow.identity, requestId: 'foreign' }, proofRow.terminalDigest, proofRow.completionProof, role), false);
      const malformed: any = structuredClone(loaded); malformed[f.key].requests[0].completionProof.extra = undefined;
      assert.throws(() => f.store().update(malformed), /completion/);
      const noContext = f.store({}).read(next.id)!;
      assert.equal(f.unresolved(noContext), true);
      assert.throws(() => applyTransition(noContext, { type: 'start' }), /Native ledger/);
      const foreign = new JsonFileOracleReceiptStore(path.join(f.root, 'foreign-host'));
      assert.throws(() => f.store({ [role]: { receipts: foreign, authenticate: f.hosts[role]!.authenticate } }).read(next.id), /completion/);
      f.setAuthentication(false);
      assert.equal(f.unresolved(loaded), true, 'each predicate rechecks actual authentication');
      assert.throws(() => f.store().read(next.id), /completion/);
      f.setAuthentication(true);
      assert.equal(f.unresolved(f.store().read(next.id)!), false);
      const proof = (loaded as any)[f.key].requests[0].completionProof;
      const record = JSON.parse(readFileSync(proof.file, 'utf8')); record.evidence.authentication.transportReceipt = 'changed';
      writeFileSync(proof.file, JSON.stringify(record), { mode: 0o600 });
      assert.equal(f.unresolved(loaded), true);
      assert.throws(() => f.store().read(next.id), /completion/);
    } finally { f.cleanup(); }
  });

  it(`${role}: authenticated proof cannot authorize a substituted review payload`, () => {
    const f = fixture(role);
    try {
      f.store().update(f.complete());
      const loaded = f.store().read(f.run.id)!;
      const identity = loaded.nativeReview!.requests[0]!.identity;
      const terminal = f.receipts.readNative(`${identity.requestId}.terminal`)!;
      assert.equal(terminal.kind, 'terminal');
      if (terminal.kind !== 'terminal') throw new Error('Controlled terminal missing');
      const accepted = { requestId: identity.requestId, receiptId: terminal.id, digest: oracleDigest(terminal), identity };
      const reviewing: Run = { ...loaded, state: 'REVIEWING', validationResult: validationPassed(identity.headSha), nativeReview: { ...loaded.nativeReview!, accepted } };
      const type = terminal.result.verdict === 'approve' ? 'review_approved' : 'changes_requested';
      assert.equal(applyTransition(reviewing, { type, reviewResult: terminal.result }, T0, TEST_VALIDATION_AUTHORITY).state, type === 'review_approved' ? 'FINAL_GATE' : 'CHANGES_REQUESTED');
      const forged: any = { ...terminal.result, findings: [{ severity: 'blocking', summary: 'Substituted original finding' }], verdict: 'request_changes' };
      assert.throws(() => applyTransition(reviewing, { type: 'changes_requested', reviewResult: forged }, T0, TEST_VALIDATION_AUTHORITY), /exact authenticated immutable terminal/);
      assert.throws(() => applyTransition(reviewing, { type, reviewResult: { ...terminal.result, unexpected: undefined } as any }, T0, TEST_VALIDATION_AUTHORITY), /exact authenticated immutable terminal/);
    } finally { f.cleanup(); }
  });

  it(`${role}: a losing CAS cannot authenticate a candidate or overwrite unrelated concurrent history`, () => {
    const f = fixture(role);
    try {
      const candidate = f.complete();
      const concurrent = applyTransition(f.run, { type: 'wait_dependency', reason: 'Unrelated concurrent wait' });
      f.store().update(concurrent);
      assert.equal(f.store().updateIfUnchanged(f.run, candidate), false);
      assert.equal(f.unresolved(candidate), true);
      assert.deepEqual(f.store().read(f.run.id)!.history, concurrent.history);
      assert.equal(f.unresolved(f.store().read(f.run.id)!), true);
      assert.throws(() => applyTransition(candidate, { type: 'start' }), /Native ledger/);
    } finally { f.cleanup(); }
  });

  it(`${role}: a raw digest cannot be promoted through update/CAS/reducer`, () => {
    const f = fixture(role);
    try {
      const next: any = structuredClone(f.run);
      Object.assign(next[f.key].requests[0], { status: 'qualified_complete', terminalDigest: oracleDigest(f.terminal) });
      assert.throws(() => f.store().update(next), /monotonic/);
      assert.throws(() => f.store().updateIfUnchanged(f.run, next), /monotonic/);
      assert.throws(() => applyTransition(next, { type: 'start' }), /Unresolved native history|Native ledger/);
      assert.equal(f.unresolved(f.store().read(next.id)!), true);
    } finally { f.cleanup(); }
  });

  for (const status of ['qualified_complete', 'retired', 'replaced'] as const) {
    it(`${role}: authenticated ${status} history survives binding drift without current eligibility`, () => {
      const f = fixture(role);
      try {
        const historical: any = f.complete(), ledger = historical[f.key], row = ledger.requests[0];
        row.status = status;
        if (status === 'qualified_complete') {
          const acceptance = { requestId: row.identity.requestId, receiptId: f.terminal.id, digest: row.terminalDigest, identity: row.identity };
          if (role === 'review') ledger.accepted = acceptance;
          else ledger.acceptances.push({ ...acceptance, disposition: f.terminal.disposition });
        } else delete ledger.activeRequestId;
        if (status === 'replaced') {
          const replacement = structuredClone(row); replacement.identity.requestId += '-replacement'; replacement.identity.correlationId = replacement.identity.requestId;
          replacement.status = 'pending'; replacement.submissionPossible = false; delete replacement.terminalDigest; delete replacement.completionProof;
          row.failure = 'transport_failure'; row.replacedBy = replacement.identity.requestId;
          if (role === 'lead') row.replacementReason = 'irrecoverable_transport';
          ledger.requests.push(replacement); ledger.activeRequestId = replacement.identity.requestId;
        }
        const drifted: any = { ...f.hosts[role], binding: { bindingId: 'revoked-current-binding', model: 'different-current-model', qualified: false }, source() { throw new Error('Historical authentication must not read current execution/source'); }, async submit() { throw new Error('Historical authentication must not submit'); } };
        const hosts = { ...f.hosts, [role]: drifted };
        const imported = f.store(hosts, `historical-${status}`); imported.create(historical);
        buildWorkflowDeps(imported, undefined, {}); imported.configureNativeCompletionHosts({});
        assert.equal(f.unresolved(imported.list()[0]!), false, 'model-free factory cannot erase historical authentication');
        const loaded = f.store(hosts, `historical-${status}`).read(historical.id)!;
        assert.equal(f.unresolved(loaded), false, 'genuine old completion remains terminal independently of current role/binding');
        assert.deepEqual((loaded as any)[f.key], ledger);
        assert.equal(role === 'lead' ? resolveNativeLead(drifted).validate({ run: loaded } as any) : resolveNativeReviewer(drifted).native!.validate({ run: loaded } as any), role === 'lead' ? null : false);
        assert.equal(f.unresolved(f.store({}, `historical-${status}`).read(historical.id)!), true, 'missing trusted context never adopts old acceptance');
      } finally { f.cleanup(); }
    });
  }

  for (const status of ['qualified_complete', 'retired', 'replaced'] as const) {
    it(`${role}: prior-schema ${status} history stays readable and unresolved without an old permit`, () => {
      const f = fixture(role);
      try {
        const historical: any = f.complete();
        const ledger = historical[f.key], row = ledger.requests[0];
        delete row.completionProof; row.status = status;
        if (role === 'lead') delete historical.nativeReview.requests[0].completionProof;
        if (status === 'qualified_complete' && role === 'review') ledger.accepted = { requestId: row.identity.requestId, receiptId: f.terminal.id, digest: row.terminalDigest, identity: row.identity };
        if (status !== 'qualified_complete') delete ledger.activeRequestId;
        if (status === 'replaced') {
          const replacement = structuredClone(row); replacement.identity.requestId += '-replacement'; replacement.identity.correlationId = replacement.identity.requestId;
          replacement.status = 'pending'; delete replacement.terminalDigest;
          row.failure = 'transport_failure'; row.replacedBy = replacement.identity.requestId;
          if (role === 'lead') row.replacementReason = 'irrecoverable_transport';
          ledger.requests.push(replacement); ledger.activeRequestId = replacement.identity.requestId;
        }
        writeFileSync(path.join(f.root, 'runs', `${historical.id}.json`), JSON.stringify(historical));
        for (const hosts of [f.hosts, {}]) {
          const store = f.store(hosts), loaded = store.read(historical.id)!;
          assert.equal(role === 'lead' ? nativeLeadCoherent(loaded) : nativeReviewCoherent(loaded), true);
          assert.equal(f.unresolved(loaded), true);
          assert.deepEqual((loaded as any)[f.key], ledger);
          assert.equal(store.list().length, 1);
          assert.throws(() => applyTransition(loaded, { type: 'start' }), /Unresolved native history/);
          assert.throws(() => recoverRunAdmission(store, f.registry(), loaded.id, 1, true, path.join(f.root, 'owner.json'), { retireWork: true }), /unresolved/);
          store.update(loaded);
        }
        const reauthenticated: any = structuredClone(historical);
        reauthenticated[f.key].requests[0].completionProof = (f.complete() as any)[f.key].requests[0].completionProof;
        if (role === 'lead') reauthenticated.nativeReview.requests[0].completionProof = (f.complete() as any).nativeReview.requests[0].completionProof;
        const current = f.store().read(historical.id)!;
        assert.equal(f.store().updateIfUnchanged(current, reauthenticated), true, 'exact configured evidence can safely restore completion proof without changing old identity/digest');
        assert.equal(hasAuthenticatedCompletion(reauthenticated[f.key].requests[0].identity, reauthenticated[f.key].requests[0].terminalDigest, reauthenticated[f.key].requests[0].completionProof, role), true);
        assert.equal(resolveNativeReviewer().native!.validate({ run: historical } as any), false);
        assert.equal(resolveNativeLead().validate({ run: historical } as any), null);
      } finally { f.cleanup(); }
    });
  }
}

// Direct admission callers use controlled valid source/authority/packet fixtures.
// No worker, actual mission token, Git operation or service is invoked here.
function repairCase(finding: 'review_blocking' | 'validation_failed', uncertainty: 'none' | 'proofless-oracle' | 'inactive-oracle' | 'inactive-lead') {
  const f = fixture('lead');
  const completed: any = f.complete(), lead = completed.nativeLead.requests[0];
  const acceptance = { requestId: lead.identity.requestId, receiptId: f.terminal.id, digest: lead.terminalDigest, identity: lead.identity, disposition: f.terminal.disposition };
  completed.nativeLead.acceptances = [acceptance]; completed.nativeReview.repairLimit = 1;
  const origin: any = f.receipts.readNative(`${completed.nativeReview.activeRequestId}.terminal`)!;
  const previous: any = { ...completed, state: 'CHANGES_REQUESTED', validationResult: finding === 'validation_failed' ? validationFailed(completed.headSha) : validationPassed(completed.headSha), ...(finding === 'review_blocking' ? { reviewResult: origin.result } : {}) };
  f.store().update(previous);
  if (uncertainty === 'proofless-oracle') delete previous.nativeReview.requests[0].completionProof;
  if (uncertainty === 'inactive-oracle') {
    const old = structuredClone(previous.nativeReview.requests[0]);
    old.identity.requestId = 'inactive-oracle'; old.identity.correlationId = old.identity.requestId; old.identity.headSha = 'e'.repeat(40);
    old.status = 'retired'; delete old.terminalDigest; delete old.completionProof;
    previous.nativeReview.requests.push(old);
  }
  if (uncertainty === 'inactive-lead') {
    const old = structuredClone(previous.nativeLead.requests[0]);
    old.identity.requestId = 'inactive-lead'; old.identity.correlationId = old.identity.requestId; old.identity.incarnation = 'e'.repeat(64);
    old.status = 'retired'; delete old.terminalDigest; delete old.completionProof;
    previous.nativeLead.requests.push(old);
  }
  // Reproduce persisted historical uncertainty without erasing or promoting it.
  if (uncertainty !== 'none') writeFileSync(path.join(f.root, 'runs', `${previous.id}.json`), JSON.stringify(previous));
  const current = f.store().read(previous.id)!;
  const currentLead = current.nativeLead!.requests[0]!;
  const reference = { ...acceptance, implementationAuthoritySha256: oracleDigest(current.implementationAuthority), originEvidence: origin, consumptionGeneration: 1, instructionsSha256: oracleDigest(acceptance.disposition) };
  const packetInput: any = { ...current.implementationAuthority!.input, identity: { ...current.implementationAuthority!.input.identity, baseSha: current.headSha! }, kind: finding === 'review_blocking' ? 'review-repair' : 'validation-repair', repair: { headSha: current.headSha!, pullRequestNumber: 7, evidenceRef: `run:${current.id}:review:${current.headSha}`, evidence: finding === 'validation_failed' ? JSON.stringify(current.validationResult) : JSON.stringify({ verdict: current.reviewResult?.verdict, headSha: current.headSha, pullRequestNumber: 7 }), evidenceKind: finding === 'review_blocking' ? 'review' : 'validation', evidenceHeadSha: current.headSha!, evidencePullRequestNumber: 7, evidenceStatus: finding === 'review_blocking' ? 'request_changes' : 'failed', blockingFindings: finding === 'review_blocking' ? origin.result.findings.map((v: any) => `[blocking] ${v.summary}`) : [], ...(finding === 'review_blocking' ? { leadDisposition: reference } : {}) } };
  const packet = buildImplementationPacket(packetInput); assert.equal(packet.kind, 'packet');
  if (packet.kind !== 'packet') throw new Error('Controlled repair packet invalid');
  const admission = { ...createRepairAdmissionSnapshot(current.repairTaskShapeAuthority!, finding, current.headSha!, 7, current.execution!, T0), budgetLimit: 1, attemptBinding: createRepairAttemptBinding(current, current.execution!), ...(finding === 'review_blocking' ? { leadDisposition: reference, packetSha256: oracleDigest(packet.packet) } : {}) };
  const next: Run = { ...current, state: 'IMPLEMENTING', repairAdmissions: [admission], history: [...current.history, { type: 'start_fix', from: 'CHANGES_REQUESTED', to: 'IMPLEMENTING', at: T0, repairAdmissionIndex: 0 }] };
  assert.equal(hasAuthenticatedCompletion(currentLead.identity, currentLead.terminalDigest, currentLead.completionProof, 'lead'), true, 'current lead proof is genuinely configured/authenticated');
  assert.equal(nativeReviewCoherent(current), true); assert.equal(nativeLeadCoherent(current), true);
  return { ...f, current, next, reference, admission };
}

for (const finding of ['review_blocking', 'validation_failed'] as const) {
  for (const uncertainty of ['proofless-oracle', 'inactive-oracle', 'inactive-lead'] as const) {
    for (const operation of ['update', 'CAS'] as const) {
      it(`R1 raw admission ${finding}/${uncertainty}/${operation} rejects unresolved history`, () => {
        const f = repairCase(finding, uncertainty);
        try {
          assert.equal(unresolvedNativeReview(f.current) || unresolvedNativeLead(f.current), true);
          assert.throws(() => applyTransition(f.current, { type: 'start_fix', repairAdmission: f.admission }, T0), /Unresolved native history/);
          const helper = leadConsumptionValid(f.current, f.reference);
          let rawError: unknown, rawResult: unknown;
          try { rawResult = operation === 'update' ? f.store().update(f.next) : f.store().updateIfUnchanged(f.current, f.next); } catch (error) { rawError = error; }
          const after = f.store().read(f.current.id)!;
          console.log(JSON.stringify({ finding, uncertainty, operation, helper, rawResult, rawError: rawError === undefined ? null : String(rawError), beforeUnresolved: unresolvedNativeReview(f.current) || unresolvedNativeLead(f.current), afterState: after.state, afterAdmissionCount: after.repairAdmissions?.length ?? 0, afterStartFixCount: after.history.filter(h => h.type === 'start_fix').length, fixtureWorkerOrServiceInvocations: 0 }));
          assert.match(String(rawError), /unresolved native history/i, 'actual raw store must reject unresolved admission');
          if (finding === 'review_blocking') assert.equal(helper, false, 'same shared helper must fence genuine lead proof when history is unresolved');
          assert.deepEqual(after, f.current);
        } finally { f.cleanup(); }
      });
    }
  }
  it(`R1 all-terminal ${finding} admits once and retains exact unfinished recovery`, () => {
    const f = repairCase(finding, 'none');
    try {
      assert.equal(unresolvedNativeReview(f.current) || unresolvedNativeLead(f.current), false);
      if (finding === 'review_blocking') assert.equal(leadConsumptionValid(f.current, f.reference), true);
      const reduced = applyTransition(f.current, { type: 'start_fix', repairAdmission: f.admission }, T0);
      assert.deepEqual(reduced.repairAdmissions, f.next.repairAdmissions);
      assert.equal(f.store().updateIfUnchanged(f.current, f.next), true);
      const recovered = f.store().read(f.current.id)!;
      assert.ok(activeRepairAdmission(recovered));
      assert.equal(f.store().updateIfUnchanged(recovered, recovered), true, 'exact unfinished persistence recovery adds no admission/debit');
      assert.equal(f.store().read(f.current.id)!.repairAdmissions!.length, 1);
      assert.equal(f.store().read(f.current.id)!.history.filter(h => h.type === 'start_fix').length, 1);
      assert.equal(f.store().updateIfUnchanged(f.current, f.next), false, 'consumed stale predecessor cannot readmit');
    } finally { f.cleanup(); }
  });
}

for (const finding of ['review_blocking', 'validation_failed'] as const) {
  for (const unknown of ['oracle', 'lead'] as const) {
    for (const operation of ['update', 'CAS'] as const) {
      it(`R1 next-candidate ${finding}/${unknown}/${operation} cannot introduce uncertainty with admission`, () => {
        const f = repairCase(finding, 'none');
        try {
          const next: any = structuredClone(f.next), key = unknown === 'oracle' ? 'nativeReview' : 'nativeLead';
          const historical = structuredClone(next[key].requests[0]);
          historical.identity.requestId = 'next-unknown'; historical.identity.correlationId = historical.identity.requestId;
          if (unknown === 'oracle') historical.identity.headSha = 'e'.repeat(40); else historical.identity.incarnation = 'e'.repeat(64);
          historical.status = 'retired'; delete historical.terminalDigest; delete historical.completionProof;
          next[key].requests.push(historical);
          assert.equal(unresolvedNativeReview(f.current) || unresolvedNativeLead(f.current), false);
          if (operation === 'update') assert.throws(() => f.store().update(next), /unresolved native history/i);
          else assert.throws(() => f.store().updateIfUnchanged(f.current, next), /unresolved native history/i);
          assert.deepEqual(f.store().read(f.current.id), f.current);
        } finally { f.cleanup(); }
      });
    }
  }
}
for (const operation of ['update', 'CAS'] as const) {
  it(`R1 bare start_fix/${operation} cannot bypass unresolved-history fence`, () => {
    const f = repairCase('validation_failed', 'inactive-lead');
    try {
      const next = { ...f.next, repairAdmissions: undefined };
      if (operation === 'update') assert.throws(() => f.store().update(next), /unresolved native history/i);
      else assert.throws(() => f.store().updateIfUnchanged(f.current, next), /unresolved native history/i);
      assert.deepEqual(f.store().read(f.current.id), f.current);
    } finally { f.cleanup(); }
  });
}

it('C2 an exact retired Oracle terminal attaches evidence without active identity or acceptance restoration', async () => {
  const f = inactiveOracleFixture(); try {
    await f.boundary.advance(f.context());
    const r = f.store().read(f.run.id)!, q = r.nativeReview!.requests[0]!;
    const retired: Run = { ...r, nativeReview: { ...r.nativeReview!, activeRequestId: undefined, requests: [{ ...q, status: 'retired', terminalStatus: 'incomplete', observations: 3, nextObservationAt: '2099-01-01T00:00:00.000Z' }] } };
    assert.equal(f.store().updateIfUnchanged(r, retired), true);
    f.receipts.recordNative(f.terminal(q.identity));
    const observed = await f.boundary.observe!(f.context());
    assert.equal(unresolvedNativeReview(observed.run), false); assert.equal(observed.run.nativeReview!.requests[0]!.status, 'retired');
    assert.equal(observed.run.nativeReview!.requests[0]!.observations, 3); assert.equal(observed.run.nativeReview!.requests[0]!.failure, 'transport_failure');
    assert.equal(observed.run.nativeReview!.activeRequestId, undefined); assert.equal(observed.run.nativeReview!.accepted, undefined);
    assert.equal(f.reads().length, 0); assert.equal(f.submissions(), 1); assert.equal(f.boundary.validate(f.context()), false);
  } finally { f.cleanup(); }
});
for (const failure of ['claim', 'CAS'] as const) {
  it(`C2 inactive cache ${failure} loser preserves durable uncertainty and unrelated current history`, async () => {
    const f = inactiveOracleFixture(); try {
      await f.issue(); const before = f.store().read(f.run.id)!, q = before.nativeReview!.requests[0]!;
      f.receipts.recordNative(f.terminal(q.identity));
      let claims = 0, concurrent: Run | undefined;
      const context = f.context({
        async assertLiveClaim() { if (failure === 'claim' && ++claims > 1) throw new Error('Controlled lost retained claim'); },
        ...(failure === 'CAS' ? { store: { read: (id: string) => f.store().read(id), updateIfUnchanged(expected: Run, next: Run) {
          if (!concurrent) { const current = f.store().read(f.run.id)!; concurrent = applyTransition(current, { type: 'wait_dependency', reason: 'Unrelated concurrent owner observation' }, T0); f.store().update(concurrent); }
          return f.store().updateIfUnchanged(expected, next);
        } } } : {}),
      });
      if (failure === 'claim') await assert.rejects(f.boundary.observe!(context), /lost retained claim/); else await f.boundary.observe!(context);
      const current = f.store().read(f.run.id)!; assert.equal(unresolvedNativeReview(current), true);
      assert.equal(current.nativeReview!.requests[0]!.completionProof, undefined); assert.deepEqual(current.nativeReview!.accepted, before.nativeReview!.accepted);
      if (concurrent) assert.deepEqual(current, concurrent);
      assert.equal(f.reads().length, 0); assert.equal(f.submissions(), 2); assert.equal(current.repairAdmissions?.length ?? 0, 0);
    } finally { f.cleanup(); }
  });
}
it('C2 a false observer authenticator cannot promote an exact cached inactive Oracle terminal', async () => {
  const f = inactiveOracleFixture(); try {
    await f.issue(); const before = f.store().read(f.run.id)!;
    f.receipts.recordNative(f.terminal(before.nativeReview!.requests[0]!.identity)); f.host.authenticate = () => false;
    const observed = await f.boundary.observe!(f.context());
    assert.equal(unresolvedNativeReview(observed.run), true); assert.equal(observed.run.nativeReview!.requests[0]!.completionProof, undefined);
    assert.deepEqual(observed.run.nativeReview!.accepted, before.nativeReview!.accepted); assert.equal(f.submissions(), 2);
    assert.throws(() => applyTransition(observed.run, { type: 'review_approved', reviewResult: f.terminal(before.nativeReview!.requests[1]!.identity).result }, T0, TEST_VALIDATION_AUTHORITY), /Unresolved native history/);
  } finally { f.cleanup(); }
});
it('C2 HOLD observation preserves incomplete transport and actual returned URL without replacing or resetting its finite budget', async () => {
  const f = inactiveOracleFixture(); try {
    await f.boundary.advance(f.context()); const workflow = oracleWorkflow(f);
    f.setObserve(async () => ({ outcome: 'pending', conversationUrl: 'https://fixture.invalid/original-oracle' }));
    for (let i = 1; i <= 3; i++) {
      f.tick(); const observed = await workflow.poll(true), q = observed.run.nativeReview!.requests[0]!;
      assert.equal(q.status, 'incomplete'); assert.equal(q.failure, 'transport_failure'); assert.equal(q.observations, i);
      assert.equal(q.conversationUrl, 'https://fixture.invalid/original-oracle'); assert.equal(observed.run.nativeReview!.requests.length, 1);
    }
    f.tick(); await workflow.poll(true); assert.equal(f.reads().length, 3); assert.equal(f.submissions(), 1);
    assert.equal(f.store().read(f.run.id)!.nativeReview!.wait!.kind, 'qualification'); assert.equal(workflow.workers(), 0);
  } finally { f.cleanup(); }
});

for (const uncertainty of ['proofless-oracle', 'inactive-oracle', 'inactive-lead'] as const) {
  it(`R1 qualified unfinished recovery preserves one attempt and fences ${uncertainty}`, () => {
    const f = repairCase('review_blocking', 'none');
    try {
      assert.equal(f.store().updateIfUnchanged(f.current, f.next), true);
      const run = f.store().read(f.current.id)!;
      const q = f.request.identity, authority = f.request.packet.authority;
      const host: any = { ...f.hosts.lead, binding: { bindingId: q.bindingId, policyRevision: q.policyRevision, model: q.requestedModel, effort: 'High', readOnly: true, qualified: true, allowTransportReplacement: false }, source: () => f.request.packet.manifest, async submit() { throw new Error('Recovery qualification must not submit'); } };
      const snapshot: any = { repository: { owner: 'acme', repo: 'widgets' }, issue: authority.issue, headSha: run.headSha, pullRequest: { ...run.pullRequest, baseSha: q.baseSha }, handoff: { sourceId: authority.scope.sourceId, sourceScope: authority.scope.sourceScope, sourceUpdatedAt: authority.scope.sourceUpdatedAt, freshness: 'current', sections: { scope: authority.scope.text } }, problems: [] };
      const context = (current: Run): any => ({ run: current, consumed: f.reference, snapshot, owner: { missionId: q.missionId, laneId: q.laneId, generation: 1 }, execution: current.execution, maxAttempts: 1, store: f.store(), now: () => T0, assertCurrent() {}, onSubmission: (r: Run) => r });
      const boundary = resolveNativeLead(host);
      assert.deepEqual(boundary.validate(context(run)), f.reference, 'genuine current qualification recovers the exact already-admitted attempt at the budget limit');
      const uncertain: any = structuredClone(run);
      if (uncertainty === 'proofless-oracle') delete uncertain.nativeReview.requests[0].completionProof;
      else {
        const key = uncertainty === 'inactive-oracle' ? 'nativeReview' : 'nativeLead';
        const old = structuredClone(uncertain[key].requests[0]);
        old.identity.requestId = 'unfinished-unknown'; old.identity.correlationId = old.identity.requestId;
        if (key === 'nativeReview') old.identity.headSha = 'e'.repeat(40); else old.identity.incarnation = 'e'.repeat(64);
        old.status = 'retired'; delete old.terminalDigest; delete old.completionProof;
        uncertain[key].requests.push(old);
      }
      writeFileSync(path.join(f.root, 'runs', `${run.id}.json`), JSON.stringify(uncertain));
      const restarted = f.store().read(run.id)!;
      assert.equal(boundary.validate(context(restarted)), null, 'uncertainty cannot reuse a consumed reference as current execution permission');
      assert.equal(restarted.repairAdmissions!.length, 1);
      assert.equal(restarted.history.filter(h => h.type === 'start_fix').length, 1);
    } finally { f.cleanup(); }
  });
}

// B1: trusted historical verification is an installed dependency, independent
// of whether a current execution role is enabled. These remain no-Git controls.
for (const role of ['review', 'lead'] as const) {
  it(`${role}: disabled factories preserve explicit historical roots through list, restart and reducer cloning`, () => {
    const f = fixture(role);
    try {
      const store = f.store(); store.update(f.complete());
      const before = store.read(f.run.id)!;
      buildWorkflowDeps(store, undefined, {});
      store.configureNativeCompletionHosts({});
      const wrong = new JsonFileOracleReceiptStore(path.join(f.root, 'different-current-root'));
      store.configureNativeCompletionHosts({ [role]: { receipts: wrong, authenticate: () => false } });
      assert.equal(f.unresolved(store.list()[0]!), false);
      assert.equal(f.unresolved(store.read(f.run.id)!), false);
      const restarted = new JsonFileStore({ dir: path.join(f.root, 'runs'), nativeCompletionHosts: [{ [role]: { receipts: wrong, authenticate: () => false } }, f.hosts] });
      assert.equal(f.unresolved(restarted.read(f.run.id)!), false);
      const cloned = structuredClone(before);
      assert.equal(restarted.updateIfUnchanged(before, cloned), true);
      assert.equal(applyTransition(restarted.read(f.run.id)!, { type: 'start' }).state, 'IMPLEMENTING');
      assert.equal(f.unresolved(f.store({}).read(f.run.id)!), true, 'no-context history remains readable and unresolved');
      assert.equal(resolveNativeLead().available(), false);
      assert.equal(resolveNativeReviewer().native!.available(), false);
    } finally { f.cleanup(); }
  });

  it(`${role}: actual CLI initial list and model-free stopped retirement use explicit historical trust`, async () => {
    const f = fixture(role), originalUserInfo = os.userInfo, data = process.env.TACHIKO_DATA_DIR, log = console.log;
    const output: string[] = [];
    try {
      const completed: any = f.complete();
      if (role === 'review') {
        completed.execution = { profile: 'routine', revision: 'test-execution-v1', executor: 'luna-isolated', model: 'gpt-5.6-luna', reasoningEffort: 'high', timeoutMs: 30000, sandboxMode: 'workspace-write', approvalPolicy: 'never' };
        completed.repairTaskShapeAuthority = { revision: 'original-contract', shape: 'bounded' };
      }
      f.store().update(completed);
      os.userInfo = (() => ({ ...originalUserInfo(), homedir: f.root })) as typeof os.userInfo;
      process.env.TACHIKO_DATA_DIR = path.join(f.root, 'runs'); console.log = (...values) => { output.push(values.join(' ')); };
      let authentications = 0;
      const historical: NativeCompletionHosts = {};
      for (const key of ['review', 'lead'] as const) Object.assign(historical, { [key]: { receipts: f.receipts, authenticate: (e: any) => { authentications++; return f.hosts[key]!.authenticate(e); } } });
      assert.equal(await main(['run', 'list'], { historicalCompletionHosts: historical }), 0);
      assert.ok(authentications > 0, 'authentication occurs on the initial list before any workflow factory');
      const registry = createHostAdmissionRegistry(), r = f.store().read(f.run.id)!;
      const evidence = { repository: 'acme/widgets', run: r.id, issue: 42, pullRequest: 7, claim: r.dispatchClaimId!, ...(r.bootstrap ? { workspace: r.bootstrap.workspacePath } : {}) };
      const admitted = registry.admit({ laneId: `run:${r.id}`, role: 'production_captain', evidence });
      assert.equal(admitted.outcome, 'admitted'); if (admitted.outcome !== 'admitted') throw new Error('Controlled owner admission failed');
      const receipt = resolveRunOwnerReceiptPath('acme/widgets', r.id, evidence);
      writeRunOwnerReceipt(receipt, { schemaVersion: 1, laneId: `run:${r.id}`, missionId: admitted.missionId, repository: 'acme/widgets', runId: r.id, issue: 42, claimId: r.dispatchClaimId, ...(r.bootstrap ? { workspace: r.bootstrap.workspacePath } : {}), generation: 1, phase: 'execution_possible', token: admitted.token });
      await assert.rejects(main(['run', 'admission', 'recover', r.id, '--generation', '1', '--stopped', '--retire-work']), /unresolved/);
      assert.equal(registry.readLane(`run:${r.id}`)!.status, 'active');
      assert.equal(await main(['run', 'admission', 'recover', r.id, '--generation', '1', '--stopped', '--retire-work'], { historicalCompletionHosts: historical }), 0);
      assert.equal(registry.readLane(`run:${r.id}`)!.status, 'released');
      assert.equal(readRunOwnerReceipt(receipt)!.workDisposition, 'retired');
      const restarted = new JsonFileStore({ dir: path.join(f.root, 'runs'), nativeCompletionHosts: historical });
      assert.equal(await isDispatchRunOwnerRetiredCommand(restarted, restarted.read(r.id)!, registry), true);
      assert.equal(await isDispatchRunOwnerRetiredCommand(f.store({}), f.store({}).read(r.id)!, registry), false);
      assert.ok(output.some(line => line.includes(r.id)));
    } finally { os.userInfo = originalUserInfo; console.log = log; if (data === undefined) delete process.env.TACHIKO_DATA_DIR; else process.env.TACHIKO_DATA_DIR = data; f.cleanup(); }
  });
}

function observationFixture(canonicalOwner = false) {
  const f = fixture('lead', canonicalOwner);
  let reads: string[] = [], time = Date.parse(T0);
  let observe: (identity: any) => Promise<any> = async () => { throw new Error('Controlled service-read failure'); };
  const host: any = { ...f.hosts.lead, binding: { bindingId: 'controlled-sol', policyRevision: 'bounded-lead-v1', model: 'controlled-sol', effort: 'High', readOnly: true, qualified: true, allowTransportReplacement: true }, source: () => f.request.packet.manifest, async submit() { throw new Error('No observation control may submit'); }, async observe(identity: any) { reads.push(identity.requestId); return observe(identity); }, replacementDisposition: () => 'irrecoverable_transport' };
  const boundary = resolveNativeLead(host);
  const context = (extra: any = {}) => ({ run: f.store().read(f.run.id)!, store: f.store(), now: () => new Date(time).toISOString(), owner: { missionId: f.request.identity.missionId, laneId: `run:${f.run.id}`, generation: 1 }, assertCurrent() {}, async assertLiveClaim() {}, ...extra });
  const replacement = (observations = 3) => {
    const run: any = f.store().read(f.run.id)!, original = run.nativeLead.requests[0];
    const identity = { ...original.identity, requestId: 'replacement-request', correlationId: 'replacement-request' };
    Object.assign(original, { status: 'replaced', observations, nextObservationAt: new Date(time + 300000).toISOString(), replacedBy: identity.requestId, replacementReason: 'irrecoverable_transport', failure: 'transport_failure' });
    run.nativeLead.requests.push({ identity, status: 'pending', submissionPossible: true, observations: 0, nextObservationAt: T0 }); run.nativeLead.activeRequestId = identity.requestId;
    f.receipts.recordLead({ ...f.request, id: `${identity.requestId}.request`, identity }); f.store().update(run);
    return identity;
  };
  const terminal = (identity: any, outcome: 'repair' | 'stop' = 'repair') => {
    const e: any = { ...structuredClone(f.terminal), id: `${identity.requestId}.terminal`, identity, ...(outcome === 'stop' ? { disposition: { outcome: 'stop', reason: 'cannot_safely_repair', evidence: 'Controlled late original stop' } } : {}) };
    e.authentication.transportReceipt = createHmac('sha256', 'controlled-test-authenticator-not-production').update(oracleDigest({ kind: e.kind, identity: e.identity, disposition: e.disposition })).digest('hex');
    f.receipts.recordLead(e); return e;
  };
  const advance = (extra: any = {}) => {
    const a = f.request.packet.authority;
    const r: any = f.store().read(f.run.id)!;
    return boundary.advance({ ...context(), run: r, snapshot: { repository: { owner: 'acme', repo: 'widgets' }, issue: a.issue, headSha: r.headSha, pullRequest: { ...r.pullRequest, baseSha: f.request.identity.baseSha }, handoff: { sourceId: a.scope.sourceId, sourceScope: a.scope.sourceScope, sourceUpdatedAt: a.scope.sourceUpdatedAt, freshness: 'current', sections: { scope: a.scope.text } }, problems: [] }, execution: a.execution, maxAttempts: 1, onSubmission: (run: Run) => run, ...extra } as any);
  };
  return { ...f, host, boundary, context, replacement, terminal, advance, reads: () => reads, tick: () => { time += 30000; }, setObserve: (fn: typeof observe) => { observe = fn; } };
}

it('B3 thrown observation persists typed finite uncertainty and reentry without issuance or retirement', async () => {
  const f = observationFixture(); try {
    const r: any = f.store().read(f.run.id)!; r.state = 'WAITING_DEPENDENCY'; r.interruptedFrom = 'CHANGES_REQUESTED'; f.store().update(r);
    for (let i = 1; i <= 3; i++) {
      const result = await f.boundary.observe(f.context() as any), q = result.run.nativeLead!.requests[0]!;
      assert.equal(q.observations, i); assert.equal(q.status, 'terminal_unknown'); assert.equal(q.failure, undefined);
      assert.equal(q.terminalDigest, undefined); assert.equal(f.unresolved(result.run), true); f.tick();
    }
    const result = await f.boundary.observe(f.context() as any);
    assert.equal(result.run.nativeLead!.requests.length, 1); assert.equal(f.reads().length, 3);
    assert.equal(nativeLeadReentry(result.run, f.context().now()), true, 'separate unheld qualification can examine an explicit bounded disposition');
    assert.equal(result.run.repairAdmissions?.length ?? 0, 0); assert.equal((result.run as any).workDisposition, undefined);
    assert.equal(await isDispatchRunOwnerRetiredCommand(f.store(), result.run, f.registry()), false);
  } finally { f.cleanup(); }
});
it('B3 thrown read preserves refusal and refuses stale claim/status writes', async () => {
  const f = observationFixture(); try {
    const r: any = f.store().read(f.run.id)!; Object.assign(r.nativeLead.requests[0], { status: 'incomplete', failure: 'safety_refusal' }); f.store().update(r);
    const result = await f.boundary.observe(f.context() as any);
    assert.equal(result.run.nativeLead!.requests[0]!.status, 'incomplete'); assert.equal(result.run.nativeLead!.requests[0]!.failure, 'safety_refusal');
    f.tick(); let checks = 0;
    await assert.rejects(f.boundary.observe(f.context({ async assertLiveClaim() { if (++checks > 1) throw new Error('Controlled lost current claim'); } }) as any), /lost current claim/);
    const current = f.store().read(f.run.id)!;
    assert.equal(current.nativeLead!.requests[0]!.observations, 2, 'the already-issued read debit survives lost ownership');
    assert.equal(current.nativeLead!.requests[0]!.failure, 'safety_refusal'); assert.equal(current.nativeLead!.requests.length, 1);
  } finally { f.cleanup(); }
});
for (const observations of [0, 3]) {
  it(`B4 cached active and inactive terminals reconcile despite original budget ${observations} and future due time`, async () => {
    const f = observationFixture(); try {
      const identity = f.replacement(observations); f.terminal(identity); f.terminal(f.request.identity, 'stop');
      const result = await f.boundary.observe(f.context() as any);
      assert.equal(f.reads().length, 0); assert.equal(result.run.nativeLead!.acceptances.length, 2);
      assert.equal(result.run.nativeLead!.requests[0]!.status, 'replaced'); assert.equal(result.run.nativeLead!.requests[0]!.observations, observations);
      assert.equal(result.run.nativeLead!.requests[1]!.observations, 0); assert.equal(f.unresolved(result.run), false);
      assert.equal(result.run.repairAdmissions?.length ?? 0, 0); assert.equal(result.run.history.some(h => h.nativeLeadStop !== undefined), false);
    } finally { f.cleanup(); }
  });
}
it('B4 a due active replacement is observed when original is exhausted', async () => {
  const f = observationFixture(); try {
    const identity = f.replacement(); f.setObserve(async () => ({ outcome: 'pending' }));
    await f.boundary.observe(f.context() as any); assert.deepEqual(f.reads(), [identity.requestId]);
    const r: any = f.store().read(f.run.id)!;
    assert.equal(r.nativeLead.requests[0].observations, 3); assert.equal(r.nativeLead.requests[1].observations, 1);
    assert.equal(f.unresolved(r), true);
  } finally { f.cleanup(); }
});
it('B4 two due unresolved identities receive bounded fair service reads without another identity', async () => {
  const f = observationFixture(); try {
    const identity = f.replacement(0), r: any = f.store().read(f.run.id)!;
    r.nativeLead.requests[0].nextObservationAt = T0; f.store().update(r);
    f.setObserve(async () => ({ outcome: 'pending' }));
    await f.boundary.observe(f.context() as any); f.tick(); await f.boundary.observe(f.context() as any);
    assert.deepEqual(f.reads(), [identity.requestId, f.request.identity.requestId]);
    const next = f.store().read(f.run.id)!;
    assert.deepEqual(next.nativeLead!.requests.map(q => q.observations), [1, 1]);
    assert.equal(next.nativeLead!.requests[0]!.status, 'replaced'); assert.equal(next.nativeLead!.requests.length, 2);
    assert.equal(f.unresolved(next), true); assert.equal(next.repairAdmissions?.length ?? 0, 0);
  } finally { f.cleanup(); }
});
it('B4 cached rejected completion reconciles after exhausted service allowance without accepting a disposition', async () => {
  const f = observationFixture(); try {
    const r: any = f.store().read(f.run.id)!;
    Object.assign(r.nativeLead.requests[0], { observations: 3, nextObservationAt: '2099-01-01T00:00:00.000Z' }); f.store().update(r);
    const e: any = { kind: 'completion', id: `${f.request.identity.requestId}.completion`, identity: f.request.identity, terminalSha256: 'f'.repeat(64), reason: 'rejected_disposition', authentication: { actorId: 'bounded-sol', role: 'bounded-lead', readOnly: true, model: f.request.identity.requestedModel, effort: 'High', transportReceipt: '' } };
    e.authentication.transportReceipt = createHmac('sha256', 'controlled-test-authenticator-not-production').update(oracleDigest({ kind: e.kind, identity: e.identity, terminalSha256: e.terminalSha256 })).digest('hex');
    f.receipts.recordLead(e);
    const result = await f.boundary.observe(f.context() as any), q = result.run.nativeLead!.requests[0]!;
    assert.equal(f.reads().length, 0); assert.equal(q.observations, 3); assert.equal(q.status, 'incomplete'); assert.equal(q.failure, 'missing_evidence');
    assert.equal(f.unresolved(result.run), false); assert.equal(result.run.nativeLead!.acceptances.length, 0);
    assert.equal(result.run.repairAdmissions?.length ?? 0, 0);
  } finally { f.cleanup(); }
});
it('B3 three thrown reads permit only a separately qualified unheld replacement, never a HOLD submission', async () => {
  const f = observationFixture(); try {
    const r: any = f.store().read(f.run.id)!;
    r.state = 'CHANGES_REQUESTED'; r.reviewResult = f.request.packet.origin.result; r.validationResult = f.request.packet.authority.validation; f.store().update(r);
    for (let i = 0; i < 3; i++) { await f.boundary.observe(f.context() as any); f.tick(); }
    let submitted = 0; f.host.submit = async () => { submitted++; return { outcome: 'terminal_unknown' }; };
    const held = await f.advance({ observationOnly: true });
    assert.equal(submitted, 0); assert.equal(held.run.nativeLead!.requests.length, 1);
    const result = await f.advance({ assertInitiation: async () => {}, withIssueBoundary: async (operation: () => Promise<any>) => operation() });
    assert.equal(submitted, 1); assert.equal(result.run.nativeLead!.requests.length, 2);
    assert.equal(result.run.nativeLead!.requests[0]!.observations, 3); assert.equal(result.run.nativeLead!.requests[0]!.status, 'replaced');
    f.tick(); await f.advance({ assertInitiation: async () => {}, withIssueBoundary: async (operation: () => Promise<any>) => operation() });
    assert.equal(submitted, 1); assert.equal(f.store().read(f.run.id)!.nativeLead!.requests.length, 2);
    assert.equal(result.run.repairAdmissions?.length ?? 0, 0); assert.equal(f.unresolved(result.run), true);
  } finally { f.cleanup(); }
});
it('B4 ordinary advance reconciles cached exhausted inactive stop before current replacement acceptance', async () => {
  const f = observationFixture(); try {
    const r: any = f.store().read(f.run.id)!; r.state = 'CHANGES_REQUESTED'; r.reviewResult = f.request.packet.origin.result; r.validationResult = f.request.packet.authority.validation; f.store().update(r);
    const identity = f.replacement(); f.terminal(f.request.identity, 'stop'); f.terminal(identity);
    const result = await f.advance();
    assert.equal(result.outcome, 'wait'); assert.equal(f.reads().length, 0);
    assert.equal(result.run.nativeLead!.acceptances.length, 2); assert.equal(f.unresolved(result.run), false);
    assert.equal(result.run.nativeLead!.requests[0]!.status, 'replaced'); assert.equal(result.run.nativeLead!.requests[1]!.status, 'qualified_complete');
    assert.equal(result.run.repairAdmissions?.length ?? 0, 0);
  } finally { f.cleanup(); }
});
for (const original of ['unknown', 'cached-stop'] as const) {
  it(`B2 actual review loop retains a reenterable replacement wait with ${original} original`, async () => {
    const f = observationFixture(); try {
      const r: any = f.store().read(f.run.id)!;
      r.state = 'CHANGES_REQUESTED'; r.reviewResult = f.request.packet.origin.result; r.validationResult = f.request.packet.authority.validation; f.store().update(r);
      const identity = f.replacement(); f.terminal(identity);
      if (original === 'cached-stop') f.terminal(f.request.identity, 'stop');
      const a = f.request.packet.authority;
      const snapshot: any = { repository: { owner: 'acme', repo: 'widgets' }, issue: a.issue, headSha: r.headSha, pullRequest: { ...r.pullRequest, state: 'open', baseSha: identity.baseSha, headRef: r.bootstrap.branch, baseRef: 'main', headRepository: { owner: 'acme', repo: 'widgets' } }, handoff: { sourceId: a.scope.sourceId, sourceScope: a.scope.sourceScope, sourceUpdatedAt: a.scope.sourceUpdatedAt, freshness: 'current', sections: { scope: a.scope.text } }, problems: [] };
      const reviewer = resolveNativeReviewer({ ...f.hosts.review, binding: { bindingId: 'controlled-host', contractRevision: 'original-contract', policyRevision: 'independent-unpromoted-v1', scope: 'complete-candidate', model: 'controlled-oracle', supportedEfforts: ['Extra High'], authorActorIds: ['author'], allowTransportReplacement: false }, source: () => f.request.packet.manifest, async submit() { throw new Error('Wait must not issue another Oracle'); } } as any);
      const result = await runReviewLoop({ store: f.store(), github: { async readLiveSnapshot() { return snapshot; } } as any, implementation: { async implement() { throw new Error('Unresolved/evidence-only wait must not run a worker'); } } as any, reviewer, nativeLead: f.boundary, reviewOwner: f.context().owner, resolveValidationAuthority: () => TEST_VALIDATION_AUTHORITY, resolveRepairExecutionProfile: () => a.execution, assertReviewClaim: async () => {}, assertLeadInitiation: async () => {}, withLeadBoundary: async operation => operation(), withNativeEffectBoundary: operation => operation() }, r.id, { maxAttempts: 1, now: f.context().now });
      assert.equal(result.outcome, 'waiting_dependency', JSON.stringify(result)); assert.equal(result.run.state, 'WAITING_DEPENDENCY');
      assert.equal(result.run.nativeLead!.wait!.kind, 'request'); f.tick();
      assert.equal(nativeLeadReentry(result.run, f.context().now()), true);
      assert.equal(result.run.repairAdmissions?.length ?? 0, 0); assert.equal(result.run.history.filter(h => h.type === 'start_fix').length, 0);
      assert.equal(f.unresolved(result.run), original === 'unknown');
      assert.equal(result.run.history.some(h => h.nativeLeadStop !== undefined), false);
      assert.equal(f.reads().length, 0, 'these polls use exact immutable cache or retain unknown evidence without service reads');
    } finally { f.cleanup(); }
  });
}

// These cases enter the real executable CLI, retained dispatcher, canonical
// owner readmission and workflow. Only GitHub/host service reads are controlled;
// every process and new queue/submission boundary is forbidden explicitly.
for (const command of [['dispatch', 'once'], ['dispatch', 'serve', '--max-cycles', '1']]) {
  for (const held of [true, false]) for (const cached of [true, false]) {
    it(`C1 actual ${command.join(' ')} retained lead recovery held=${held}/cached=${cached} is observation-only`, async () => {
      const f = observationFixture(true), originalUserInfo = os.userInfo, data = process.env.TACHIKO_DATA_DIR, log = console.log;
      const list = GitHubDispatchRuntime.prototype.listRuntimeComments, update = GitHubDispatchRuntime.prototype.updateRuntimeComment, queue = GitHubDispatchRuntime.prototype.readQueueComment, create = GitHubDispatchRuntime.prototype.createRuntimeComment, snapshot = LiveGitHubAdapter.prototype.readLiveSnapshot, processRun = NodeProcessRunner.prototype.run;
      let children = 0, submissions = 0, reads = 0;
      try {
        os.userInfo = (() => ({ ...originalUserInfo(), homedir: f.root })) as typeof os.userInfo;
        process.env.TACHIKO_DATA_DIR = path.join(f.root, 'runs'); console.log = () => {};
        const r: any = f.store().read(f.run.id)!;
        r.state = 'WAITING_DEPENDENCY'; r.interruptedFrom = 'CHANGES_REQUESTED'; r.reviewResult = f.request.packet.origin.result; r.validationResult = f.request.packet.authority.validation;
        r.nativeLead.recoveryConfiguration = { revision: 'original-dispatch', owner: 'acme', repo: 'widgets', controlIssue: 90, queueCommentId: 91, leaseDurationMs: 60000 }; f.store().update(r);
        const registry = createHostAdmissionRegistry(), evidence = { repository: 'acme/widgets', run: r.id, issue: 42, pullRequest: 7, claim: r.dispatchClaimId, workspace: r.bootstrap.workspacePath };
        const owner = registry.admit({ laneId: `run:${r.id}`, role: 'production_captain', evidence, highAutonomy: true });
        assert.equal(owner.outcome, 'admitted'); if (owner.outcome !== 'admitted') throw new Error('Controlled canonical owner admission failed');
        assert.equal(owner.missionId, f.request.identity.missionId);
        const receipt = resolveRunOwnerReceiptPath('acme/widgets', r.id, evidence);
        const base: any = { schemaVersion: 1, laneId: `run:${r.id}`, missionId: owner.missionId, repository: 'acme/widgets', runId: r.id, issue: 42, claimId: r.dispatchClaimId, workspace: r.bootstrap.workspacePath };
        registry.park(owner.token, 'workflow_wait', () => writeRunOwnerReceipt(receipt, { ...base, phase: 'park_transition', generation: 1, token: owner.token }), () => writeRunOwnerReceipt(receipt, { ...base, phase: 'parked', generation: 2 }));
        publishAdmissionRuntimeProjection(path.join(f.root, 'runs'), registry, f.store(), { stage: held ? 'maintenance_hold' : 'idle', supervisor: 'parked', maintenanceHold: { active: held } });
        let comments = [{ id: 'retained-runtime', body: renderDispatchRuntime({ issue: 42, claimId: r.dispatchClaimId, runId: r.id, profile: 'routine', repairTaskShapeAuthority: r.repairTaskShapeAuthority, state: 'running', claimedAt: T0, heartbeatAt: T0, leaseUntil: '2099-01-01T00:00:00.000Z' }) }];
        GitHubDispatchRuntime.prototype.listRuntimeComments = async () => structuredClone(comments);
        GitHubDispatchRuntime.prototype.updateRuntimeComment = async (_id, body) => { comments = [{ id: 'retained-runtime', body }]; return comments[0]!; };
        GitHubDispatchRuntime.prototype.readQueueComment = async () => { throw new Error('Issued recovery must not read a new queue'); };
        GitHubDispatchRuntime.prototype.createRuntimeComment = async () => { throw new Error('Issued recovery must retain A'); };
        LiveGitHubAdapter.prototype.readLiveSnapshot = async () => ({ headSha: r.headSha } as any);
        NodeProcessRunner.prototype.run = async () => { children++; throw new Error('No recovery child is permitted'); };
        f.host.submit = async () => { submissions++; throw new Error('No issued-recovery submission is permitted'); };
        if (cached) f.terminal(f.request.identity);
        f.setObserve(async () => { reads++; return { outcome: 'pending' }; });
        assert.equal(await main(command, { historicalCompletionHosts: f.hosts, nativeLeadHost: f.host }), 0);
        const current = f.store().read(r.id)!;
        assert.equal(current.nativeLead!.ownerSuccessions.length, 1, 'actual readmission records exact generation1→3 succession');
        assert.equal(current.nativeLead!.ownerSuccessions[0]!.status, 'confirmed');
        assert.equal(current.nativeLead!.requests[0]!.observations, cached ? 0 : 1);
        assert.equal(f.unresolved(current), !cached); assert.equal(reads, cached ? 0 : 1);
        assert.equal(children, 0); assert.equal(submissions, 0); assert.equal(current.repairAdmissions?.length ?? 0, 0);
        assert.equal(current.history.filter(h => h.type === 'start_fix').length, 0);
        assert.equal(selectDispatchRuntime(comments)!.claim.issue, 42);
        assert.equal(registry.readLane(`run:${r.id}`)!.status, 'parked');
        assert.equal(readRunOwnerReceipt(receipt)!.workDisposition, undefined);
      } finally {
        GitHubDispatchRuntime.prototype.listRuntimeComments = list; GitHubDispatchRuntime.prototype.updateRuntimeComment = update; GitHubDispatchRuntime.prototype.readQueueComment = queue; GitHubDispatchRuntime.prototype.createRuntimeComment = create; LiveGitHubAdapter.prototype.readLiveSnapshot = snapshot; NodeProcessRunner.prototype.run = processRun;
        os.userInfo = originalUserInfo; console.log = log; if (data === undefined) delete process.env.TACHIKO_DATA_DIR; else process.env.TACHIKO_DATA_DIR = data; f.cleanup();
      }
    });
  }
}

function inactiveOracleFixture(verdict: 'approve' | 'request_changes' = 'approve') {
  const f = fixture('lead', true), directory = 'oracle-runs', store = () => f.store(f.hosts, directory);
  const r: any = structuredClone(f.run), a = f.request.packet.authority;
  delete r.nativeLead; delete r.nativeReview; r.state = 'REVIEWING'; r.validationResult = a.validation; store().create(r);
  let time = Date.parse(T0), submissions = 0, reads: string[] = [];
  const terminal = (identity: any, chosen: 'approve' | 'request_changes' = verdict) => {
    const e: any = { ...structuredClone(f.request.packet.origin), id: `${identity.requestId}.terminal`, identity, result: { ...f.request.packet.origin.result, verdict: chosen, findings: chosen === 'approve' ? [] : f.request.packet.origin.result.findings } };
    e.authentication.transportReceipt = createHmac('sha256', 'controlled-test-authenticator-not-production').update(oracleDigest({ kind: e.kind, identity: e.identity, result: e.result })).digest('hex'); return e;
  };
  let observation: (identity: any) => Promise<any> = async () => ({ outcome: 'pending' });
  const host: any = { ...f.hosts.review, binding: { bindingId: 'controlled-host', contractRevision: 'original-contract', policyRevision: 'independent-unpromoted-v1', scope: 'complete-candidate', model: 'controlled-oracle', supportedEfforts: ['Extra High'], authorActorIds: ['controlled-author'], allowTransportReplacement: true }, source: () => f.request.packet.manifest, async submit(q: any) { submissions++; return submissions === 1 ? { outcome: 'incomplete', reason: 'transport_failure' } : { outcome: 'complete', evidence: terminal(q.identity) }; }, async observe(identity: any) { reads.push(identity.requestId); return observation(identity); } };
  const reviewer = resolveNativeReviewer(host), boundary = reviewer.native!;
  const snapshot: any = { repository: { owner: 'acme', repo: 'widgets' }, issue: a.issue, headSha: r.headSha, pullRequest: { ...r.pullRequest, state: 'open', baseSha: f.request.identity.baseSha, headRef: r.bootstrap.branch, baseRef: 'main', headRepository: { owner: 'acme', repo: 'widgets' } }, handoff: { sourceId: a.scope.sourceId, sourceScope: a.scope.sourceScope, sourceUpdatedAt: a.scope.sourceUpdatedAt, freshness: 'current', sections: { scope: a.scope.text } }, problems: [] };
  const now = () => new Date(time).toISOString();
  const config = { revision: 'original-dispatch', owner: 'acme', repo: 'widgets', controlIssue: 90, queueCommentId: 91, leaseDurationMs: 60000 };
  const context = (extra: any = {}) => ({ run: store().read(r.id)!, store: store(), snapshot, now, owner: { missionId: f.request.identity.missionId, laneId: `run:${r.id}`, generation: 1 }, assertCurrent() {}, async assertLiveClaim() {}, onSubmission: (run: Run) => run, recoveryConfiguration: config, ...extra });
  const issue = async () => { assert.equal((await boundary.advance(context())).outcome, 'wait'); time += 30000; assert.equal((await boundary.advance(context())).outcome, 'complete'); assert.equal(submissions, 2); };
  return { ...f, run: r as Run, store, directory, snapshot, config, context, host, reviewer, boundary, terminal, now, issue, tick: () => { time += 30000; }, reads: () => reads, submissions: () => submissions, setObserve: (fn: typeof observation) => { observation = fn; } };
}
function oracleWorkflow(f: ReturnType<typeof inactiveOracleFixture>) {
  const registry = f.registry(), evidence = { repository: 'acme/widgets', run: f.run.id, issue: 42, pullRequest: 7, claim: f.run.dispatchClaimId!, workspace: f.run.bootstrap!.workspacePath };
  const admitted = registry.admit({ laneId: `run:${f.run.id}`, role: 'production_captain', evidence, highAutonomy: true });
  assert.equal(admitted.outcome, 'admitted'); if (admitted.outcome !== 'admitted') throw new Error('Controlled actual workflow owner admission failed');
  assert.equal(admitted.missionId, f.context().owner.missionId);
  let workers = 0, snapshots = 0;
  const live = () => ({ ...f.snapshot, observedAt: f.now(), pullRequest: { ...f.snapshot.pullRequest, id: 'PR_7', title: 'Bounded fixture', url: '', isDraft: false, mergeable: true, mergeStateStatus: 'CLEAN' }, checks: { availability: 'available', overall: 'passing', checks: [{ id: 'test', name: 'test', state: 'passing', url: null, updatedAt: f.now() }] }, reviews: { decision: 'none', latestByAuthor: [], unresolvedThreads: 0 }, conversations: [] });
  const deps: any = { store: f.store(), github: { async readLiveSnapshot() { snapshots++; return live(); } }, implementation: { kind: 'implementation', async implement() { workers++; throw new Error('No bounded Oracle control may create a repair worker'); } }, reviewer: f.reviewer, validation: { kind: 'validation', configRevision: 'test-config-v1', async validate() { throw new Error('Seeded fresh validation must not be rerun by this bounded control'); } }, hostedCheckPolicy: { revision: 'test-hosted-policy-v1', policy: { mode: 'required' } } };
  const poll = (held = false) => runWorkflow(deps, f.run.id, { maxReviewAttempts: 1, now: f.now, assertReviewClaim: async r => { assert.equal(r.dispatchClaimId, f.run.dispatchClaimId); }, admissionFence: { registry, token: admitted.token, productionMissionId: admitted.missionId, executionWorkspace: f.run.bootstrap!.workspacePath }, leadObservationOnly: held, leadRecoveryConfiguration: f.config });
  return { poll, deps, registry, workers: () => workers, snapshots: () => snapshots };
}
for (const verdict of ['approve', 'request_changes'] as const) for (const held of [true, false]) {
  it(`C2 actual workflow retains ${verdict} replacement wait, reconciles old via ${held ? 'HOLD' : 'ordinary'} caller, then freshly qualifies current verdict`, async () => {
    const f = inactiveOracleFixture(verdict); try {
      const workflow = oracleWorkflow(f);
      await workflow.poll(); f.tick(); const replaced = await workflow.poll();
      assert.equal(replaced.outcome, 'waiting_dependency'); assert.equal(replaced.run.state, 'WAITING_DEPENDENCY');
      assert.equal(replaced.run.nativeReview!.wait!.kind, 'request'); assert.equal(f.submissions(), 2);
      assert.equal(replaced.run.history.some(h => h.type === 'review_approved' || h.type === 'changes_requested'), false);
      assert.equal(workflow.workers(), 0); assert.equal(replaced.run.repairAdmissions?.length ?? 0, 0);
      const original = replaced.run.nativeReview!.requests[0]!, replacement = replaced.run.nativeReview!.accepted!;
      f.setObserve(async identity => { assert.equal(identity.requestId, original.identity.requestId); return { outcome: 'complete', evidence: f.terminal(identity, verdict === 'approve' ? 'request_changes' : 'approve') }; });
      f.tick(); const settled = await workflow.poll(held);
      assert.equal(settled.outcome, 'waiting_dependency'); assert.equal(unresolvedNativeReview(settled.run), false);
      assert.equal(settled.run.nativeReview!.requests[0]!.status, 'replaced'); assert.deepEqual(settled.run.nativeReview!.accepted, replacement);
      assert.equal(settled.run.history.some(h => h.type === 'review_approved' || h.type === 'changes_requested'), false);
      assert.equal(f.submissions(), 2); assert.equal(workflow.workers(), 0);
      f.tick(); await workflow.poll(); const adopted = f.store().read(f.run.id)!;
      assert.ok(adopted.history.some(h => h.type === (verdict === 'approve' ? 'review_approved' : 'changes_requested')));
      assert.equal(adopted.reviewResult!.verdict, verdict); assert.deepEqual(adopted.nativeReview!.accepted, replacement);
      assert.equal(adopted.nativeReview!.requests.length, 2); assert.equal(f.submissions(), 2); assert.equal(workflow.workers(), 0);
    } finally { f.cleanup(); }
  });
}
it('C2 exhausted original enters attention; explicit cache observation settles only evidence without automatic reentry', async () => {
  const f = inactiveOracleFixture(); try {
    await f.issue(); const workflow = oracleWorkflow(f);
    for (let i = 0; i < 3; i++) { f.tick(); await workflow.poll(); }
    const attention = f.store().read(f.run.id)!;
    assert.equal(attention.nativeReview!.wait!.kind, 'qualification');
    assert.equal(attention.nativeReview!.requests[0]!.observations, 3); assert.equal(f.reads().length, 3);
    f.tick(); await workflow.poll(); assert.equal(f.reads().length, 3);
    const original = attention.nativeReview!.requests[0]!; f.receipts.recordNative(f.terminal(original.identity));
    f.tick(); await workflow.poll(); assert.equal(unresolvedNativeReview(f.store().read(f.run.id)!), true, 'attention does not become periodic cache polling');
    const observed = await f.boundary.observe!(f.context());
    assert.equal(unresolvedNativeReview(observed.run), false); assert.equal(observed.run.nativeReview!.requests[0]!.observations, 3);
    assert.equal(observed.run.nativeReview!.requests[0]!.status, 'replaced'); assert.equal(observed.run.nativeReview!.requests[0]!.failure, 'transport_failure');
    assert.equal(observed.run.nativeReview!.wait!.kind, 'qualification'); assert.equal(f.reads().length, 3);
    assert.equal(workflow.workers(), 0); assert.equal(f.submissions(), 2); assert.equal(observed.run.repairAdmissions?.length ?? 0, 0);
  } finally { f.cleanup(); }
});
it('C2 settled inactive history never bypasses fresh current-role qualification in actual workflow', async () => {
  const f = inactiveOracleFixture(); try {
    const workflow = oracleWorkflow(f); await workflow.poll(); f.tick(); await workflow.poll();
    const original = f.store().read(f.run.id)!.nativeReview!.requests[0]!;
    f.receipts.recordNative(f.terminal(original.identity)); f.tick(); await workflow.poll(true);
    assert.equal(unresolvedNativeReview(f.store().read(f.run.id)!), false);
    f.host.binding.model = 'revoked-current-role'; f.tick(); await workflow.poll();
    const r = f.store().read(f.run.id)!;
    assert.equal(r.history.some(h => h.type === 'review_approved' || h.type === 'changes_requested'), false);
    assert.equal(workflow.workers(), 0); assert.equal(f.submissions(), 2); assert.equal(r.repairAdmissions?.length ?? 0, 0);
  } finally { f.cleanup(); }
});
for (const command of [['dispatch', 'once'], ['dispatch', 'serve', '--max-cycles', '1']]) {
  for (const held of [true, false]) for (const cached of [true, false]) {
    it(`C2 actual Oracle-only ${command.join(' ')} held=${held}/cached=${cached} retains A and reconciles inactive history`, async () => {
      const f = inactiveOracleFixture(), originalUserInfo = os.userInfo, data = process.env.TACHIKO_DATA_DIR, log = console.log;
      const list = GitHubDispatchRuntime.prototype.listRuntimeComments, update = GitHubDispatchRuntime.prototype.updateRuntimeComment, queue = GitHubDispatchRuntime.prototype.readQueueComment, create = GitHubDispatchRuntime.prototype.createRuntimeComment, snapshot = LiveGitHubAdapter.prototype.readLiveSnapshot, processRun = NodeProcessRunner.prototype.run;
      let children = 0, submissions = 0;
      try {
        await f.issue(); const r = f.store().read(f.run.id)!, original = r.nativeReview!.requests[0]!, accepted = r.nativeReview!.accepted!;
        assert.equal(r.nativeLead, undefined, 'recovery must not depend on a lead ledger');
        os.userInfo = (() => ({ ...originalUserInfo(), homedir: f.root })) as typeof os.userInfo;
        process.env.TACHIKO_DATA_DIR = path.join(f.root, f.directory); console.log = () => {};
        const registry = createHostAdmissionRegistry(), evidence = { repository: 'acme/widgets', run: r.id, issue: 42, pullRequest: 7, claim: r.dispatchClaimId!, workspace: r.bootstrap!.workspacePath };
        const owner = registry.admit({ laneId: `run:${r.id}`, role: 'production_captain', evidence, highAutonomy: true });
        assert.equal(owner.outcome, 'admitted'); if (owner.outcome !== 'admitted') throw new Error('Controlled Oracle owner admission failed');
        assert.equal(owner.missionId, original.identity.missionId);
        const receipt = resolveRunOwnerReceiptPath('acme/widgets', r.id, evidence), base: any = { schemaVersion: 1, laneId: `run:${r.id}`, missionId: owner.missionId, repository: 'acme/widgets', runId: r.id, issue: 42, claimId: r.dispatchClaimId, workspace: r.bootstrap!.workspacePath };
        registry.park(owner.token, 'workflow_wait', () => writeRunOwnerReceipt(receipt, { ...base, phase: 'park_transition', generation: 1, token: owner.token }), () => writeRunOwnerReceipt(receipt, { ...base, phase: 'parked', generation: 2 }));
        publishAdmissionRuntimeProjection(path.join(f.root, f.directory), registry, f.store(), { stage: held ? 'maintenance_hold' : 'idle', supervisor: 'parked', maintenanceHold: { active: held } });
        let comments = [{ id: 'oracle-retained', body: renderDispatchRuntime({ issue: 42, claimId: r.dispatchClaimId!, runId: r.id, profile: 'routine', repairTaskShapeAuthority: r.repairTaskShapeAuthority, state: 'running', claimedAt: T0, heartbeatAt: T0, leaseUntil: '2099-01-01T00:00:00.000Z' }) }];
        GitHubDispatchRuntime.prototype.listRuntimeComments = async () => structuredClone(comments);
        GitHubDispatchRuntime.prototype.updateRuntimeComment = async (_id, body) => { comments = [{ id: 'oracle-retained', body }]; return comments[0]!; };
        GitHubDispatchRuntime.prototype.readQueueComment = async () => { throw new Error('Oracle-only issued recovery must use original control descriptor'); };
        GitHubDispatchRuntime.prototype.createRuntimeComment = async () => { throw new Error('Oracle-only recovery cannot claim B'); };
        LiveGitHubAdapter.prototype.readLiveSnapshot = async () => f.snapshot;
        NodeProcessRunner.prototype.run = async () => { children++; throw new Error('Oracle-only recovery cannot create a process'); };
        f.host.submit = async () => { submissions++; throw new Error('Oracle-only recovery cannot submit'); };
        if (cached) f.receipts.recordNative(f.terminal(original.identity)); else f.setObserve(async identity => ({ outcome: 'complete', evidence: f.terminal(identity) }));
        assert.equal(await main(command, { historicalCompletionHosts: f.hosts, nativeReviewerHost: f.host }), 0);
        const current = f.store().read(r.id)!;
        assert.equal(unresolvedNativeReview(current), false); assert.equal(current.nativeReview!.requests[0]!.status, 'replaced');
        assert.equal(current.nativeReview!.requests[0]!.observations, cached ? 0 : 1); assert.equal(f.reads().length, cached ? 0 : 1);
        assert.deepEqual(current.nativeReview!.accepted, accepted); assert.equal(current.nativeReview!.requests.length, 2);
        assert.equal(current.history.some(h => h.type === 'review_approved' || h.type === 'changes_requested'), false);
        assert.equal(current.repairAdmissions?.length ?? 0, 0); assert.equal(children, 0); assert.equal(submissions, 0);
        assert.equal(selectDispatchRuntime(comments)!.claim.issue, 42); assert.equal(registry.readLane(`run:${r.id}`)!.status, 'parked');
        assert.equal(readRunOwnerReceipt(receipt)!.workDisposition, undefined);
      } finally {
        GitHubDispatchRuntime.prototype.listRuntimeComments = list; GitHubDispatchRuntime.prototype.updateRuntimeComment = update; GitHubDispatchRuntime.prototype.readQueueComment = queue; GitHubDispatchRuntime.prototype.createRuntimeComment = create; LiveGitHubAdapter.prototype.readLiveSnapshot = snapshot; NodeProcessRunner.prototype.run = processRun;
        os.userInfo = originalUserInfo; console.log = log; if (data === undefined) delete process.env.TACHIKO_DATA_DIR; else process.env.TACHIKO_DATA_DIR = data; f.cleanup();
      }
    });
  }
}
it('C2 Oracle descriptor is captured before first issuance, immutable, strict and absent in readable legacy history', async () => {
  const f = inactiveOracleFixture(); try {
    await f.issue(); const r = f.store().read(f.run.id)!;
    assert.deepEqual(r.nativeReview!.recoveryConfiguration, f.config);
    const changed = { ...r, nativeReview: { ...r.nativeReview!, recoveryConfiguration: { ...f.config, revision: 'changed-control' } } };
    assert.throws(() => f.store().updateIfUnchanged(r, changed), /monotonic/);
    assert.throws(() => f.store().update({ ...r, nativeReview: { ...r.nativeReview!, recoveryConfiguration: { ...f.config, callerRoot: f.root } as any } }), /ledger/);
    const historical = structuredClone(r); delete (historical.nativeReview as any).recoveryConfiguration;
    const file = path.join(f.root, f.directory, `${r.id}.json`); writeFileSync(file, JSON.stringify(historical));
    const loaded = f.store().read(r.id)!; assert.equal(unresolvedNativeReview(loaded), true);
    assert.throws(() => issuedReviewRecoveryConfiguration(loaded), /immutable dispatch control location/);
  } finally { f.cleanup(); }
});
it('C2 submitted legacy Oracle history cannot acquire a fabricated original descriptor from current context or raw CAS', async () => {
  const f = inactiveOracleFixture(); try {
    await f.boundary.advance(f.context({ recoveryConfiguration: undefined }));
    const original = f.store().read(f.run.id)!;
    assert.equal(original.nativeReview!.requests[0]!.submissionPossible, true); assert.equal(original.nativeReview!.recoveryConfiguration, undefined);
    assert.throws(() => f.store().updateIfUnchanged(original, { ...original, nativeReview: { ...original.nativeReview!, recoveryConfiguration: f.config } }), /monotonic/);
    f.tick(); await f.boundary.advance(f.context());
    const replaced = f.store().read(f.run.id)!;
    assert.equal(f.submissions(), 2); assert.equal(replaced.nativeReview!.requests.length, 2);
    assert.equal(replaced.nativeReview!.recoveryConfiguration, undefined, 'a later replacement context is not original dispatch provenance');
    assert.throws(() => issuedReviewRecoveryConfiguration(replaced), /immutable dispatch control location/);
  } finally { f.cleanup(); }
});
for (const verdict of ['approve', 'request_changes'] as const) for (const cached of [true, false]) {
  it(`C2 actual producer reconciles inactive ${verdict} via ${cached ? 'cache' : 'bounded observation'} without restoring eligibility`, async () => {
    const f = inactiveOracleFixture(verdict); try {
      await f.issue(); const before = f.store().read(f.run.id)!, original = before.nativeReview!.requests[0]!, active = before.nativeReview!.activeRequestId;
      if (cached) f.receipts.recordNative(f.terminal(original.identity, verdict === 'approve' ? 'request_changes' : 'approve')); else f.setObserve(async identity => ({ outcome: 'complete', evidence: f.terminal(identity, verdict === 'approve' ? 'request_changes' : 'approve') }));
      const reconciled = await f.boundary.advance(f.context());
      assert.equal(reconciled.outcome, 'wait', 'historical completion is evidence-only on this poll');
      assert.equal(unresolvedNativeReview(reconciled.run), false); assert.equal(reconciled.run.nativeReview!.requests[0]!.status, 'replaced');
      assert.equal(reconciled.run.nativeReview!.activeRequestId, active); assert.deepEqual(reconciled.run.nativeReview!.accepted, before.nativeReview!.accepted);
      assert.equal(f.reads().length, cached ? 0 : 1); assert.equal(f.submissions(), 2);
      const clone = structuredClone(reconciled.run); assert.equal(f.store().updateIfUnchanged(f.store().read(f.run.id)!, clone), true);
      const current = await f.boundary.advance(f.context()); assert.equal(current.outcome, 'complete'); if (current.outcome !== 'complete') throw new Error('Fresh current qualification missing');
      assert.equal(f.boundary.validate({ ...f.context(), run: { ...current.run, reviewResult: current.result } }), true);
      const adopted = applyTransition(current.run, { type: verdict === 'approve' ? 'review_approved' : 'changes_requested', reviewResult: current.result }, f.now(), TEST_VALIDATION_AUTHORITY);
      assert.equal(adopted.state, verdict === 'approve' ? 'FINAL_GATE' : 'CHANGES_REQUESTED');
      assert.equal(current.run.nativeReview!.requests.length, 2); assert.equal(current.run.repairAdmissions?.length ?? 0, 0);
    } finally { f.cleanup(); }
  });
}
for (const operation of ['update', 'CAS'] as const) {
  it(`C2 ${operation} accepts exact authenticated inactive evidence and rejects raw/foreign/missing proof`, async () => {
    const f = inactiveOracleFixture(); try {
      await f.issue(); const before = f.store().read(f.run.id)!, original = before.nativeReview!.requests[0]!, e = f.terminal(original.identity);
      f.receipts.recordNative(e); const proof = f.receipts.recordAuthenticatedCompletion('review', e, evidence => evidence.kind === 'terminal' && 'result' in evidence && f.hosts.review!.authenticate(evidence));
      const valid: any = structuredClone(before); Object.assign(valid.nativeReview.requests[0], { terminalDigest: oracleDigest(e), completionProof: proof });
      for (const invalid of ['missing', 'foreign'] as const) {
        const next = structuredClone(valid); if (invalid === 'missing') delete next.nativeReview.requests[0].completionProof; else next.nativeReview.requests[0].completionProof.digest = 'f'.repeat(64);
        assert.throws(() => operation === 'update' ? f.store().update(next) : f.store().updateIfUnchanged(before, next), /completion|monotonic/);
        assert.equal(unresolvedNativeReview(f.store().read(f.run.id)!), true);
      }
      if (operation === 'update') f.store().update(valid); else assert.equal(f.store().updateIfUnchanged(before, valid), true);
      const loaded = f.store().read(f.run.id)!; assert.equal(unresolvedNativeReview(loaded), false); assert.equal(loaded.nativeReview!.requests[0]!.status, 'replaced');
      assert.equal(loaded.nativeReview!.activeRequestId, before.nativeReview!.activeRequestId); assert.deepEqual(loaded.nativeReview!.accepted, before.nativeReview!.accepted);
      assert.equal(unresolvedNativeReview(new JsonFileStore({ dir: path.join(f.root, f.directory) }).read(f.run.id)!), true);
    } finally { f.cleanup(); }
  });
}
