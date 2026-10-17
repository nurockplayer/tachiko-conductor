import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { it } from 'node:test';
import { newRun, T0, TEST_VALIDATION_AUTHORITY, validationPassed } from './helpers.js';
import type { Run } from '../src/domain/types.js';
import { CANCEL_RUN_DECISION } from '../src/domain/decisions.js';
import { applyTransition } from '../src/domain/state-machine.js';
import { JsonFileStore } from '../src/store/json-file-store.js';
import { JsonFileOracleReceiptStore } from '../src/oracle/receipt-store.js';
import { hasAuthenticatedCompletion, type NativeCompletionHosts } from '../src/oracle/completion-proof.js';
import { nativeReviewCoherent, unresolvedNativeReview, resolveNativeReviewer } from '../src/oracle/native-reviewer.js';
import { nativeLeadCoherent, unresolvedNativeLead, validLeadEvidence, resolveNativeLead } from '../src/oracle/native-lead.js';
import { canonicalReviewTarget } from '../src/reviewers/risk-policy.js';
import { oracleDigest, textDigest } from '../src/oracle/source-evidence.js';
import { recoverRunAdmission, resumeCommand, isDispatchRunOwnerRetiredCommand } from '../src/cli.js';
import { MissionAdmissionRegistry } from '../src/mission-admission/registry.js';

// No Git, service, worker, or subprocess fixture. Real file persistence, immutable
// publication, HMAC authentication, store CAS and public command fences are used.
// Controlled Run/request fixtures do not claim an actual implementation delivery.
function fixture(role: 'review' | 'lead') {
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
  const reviewIdentity: any = { runId: run.id, claimId: run.dispatchClaimId, missionId: 'mission-trust', laneId: `run:${run.id}`, phase: 'review', role: 'independent-reviewer', targetKey: canonicalReviewTarget(run.target)!.key, repository: 'acme/widgets', pullRequestNumber: 7, baseSha, headSha, scope: 'complete-candidate', sourceSha256: manifest.sourceSha256, diffSha256: manifest.diffSha256, floor: 'R5', requestedEffort: 'Extra High', requestedModel: 'controlled-oracle', requestId: 'review-request', correlationId: 'review-request', ownerGeneration: 1, contractRevision: 'original-contract', policyRevision: 'independent-unpromoted-v1', bindingId: 'controlled-host' };
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
    const blockingFindingIds = [`${oracleDigest(origin)}:0`];
    const packet = { origin, manifest, authority, blockingFindingIds, remainingRepairs: 1 };
    const identity: any = { requestId: 'lead-request', correlationId: 'lead-request', incarnation: 'd'.repeat(64), runId: run.id, claimId: run.dispatchClaimId, missionId: reviewIdentity.missionId, laneId: reviewIdentity.laneId, ownerGeneration: 1, phase: 'lead-disposition', role: 'bounded-lead', repository: 'acme/widgets', targetKey: reviewIdentity.targetKey, pullRequestNumber: 7, baseSha, headSha, origin: { requestId: origin.identity.requestId, receiptId: origin.id, digest: oracleDigest(origin) }, authoritySha256: oracleDigest(authority), sourceSha256: manifest.sourceSha256, diffSha256: manifest.diffSha256, packetSha256: oracleDigest(packet), blockingFindingIds, repairOrdinal: 1, repairLimit: 1, bindingId: 'controlled-sol', policyRevision: 'bounded-lead-v1', requestedModel: 'controlled-sol', requestedEffort: 'High' };
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
