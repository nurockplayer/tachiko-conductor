import { ExecutionAdmissionRefusal } from '../src/adapters/agent.js';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { buildWorkflowDeps, runIssueCommand, recoverRunAdmission, resumeCommand } from '../src/cli.js';
import type { GitHubAdapter, GitHubLiveSnapshot } from '../src/adapters/github.js';
import type { Run } from '../src/domain/types.js';
import { applyTransition } from '../src/domain/state-machine.js';
import { dispatchOnceCommand } from '../src/dispatch/command.js';
import { DISPATCH_QUEUE_MARKER, selectDispatchRuntime, type DispatchRuntimeComment } from '../src/dispatch/queue.js';
import { JsonFileStore } from '../src/store/json-file-store.js';
import { JsonFileOracleReceiptStore } from '../src/oracle/receipt-store.js';
import { readNativeSourceManifest, oracleDigest } from '../src/oracle/source-evidence.js';
import { activeNativeLead, acceptedNativeLead, nativeLeadCoherent, unresolvedNativeLead, validLeadEvidence, resolveNativeLead, type NativeLeadHost, type NativeLeadEvidence, type NativeLeadObservation, issuedLeadRecoveryConfiguration, leadPayloadDigest } from '../src/oracle/native-lead.js';
import type { NativeOracleEvidence, NativeReviewerHost } from '../src/oracle/types.js';
import { MissionAdmissionRegistry } from '../src/mission-admission/registry.js';
import { readRunOwnerReceipt, writeRunOwnerReceipt } from '../src/mission-admission/run-owner-receipt.js';
import { StandaloneGitBootstrap } from '../src/workspace/standalone-git-bootstrap.js';
import { IsolatedLunaAdapter } from '../src/agents/luna-isolated.js';
import type { WorkflowDependencies } from '../src/workflow/run.js';
import { createBootstrapGitFixture } from './bootstrap-fixture.js';
import { T0, TARGET, validationPassed, validationFailed } from './helpers.js';
type LeadRequest = Extract<NativeLeadEvidence, {
  kind: 'request';
}>;
type LeadTerminal = Extract<NativeLeadEvidence, {
  kind: 'terminal';
}>;
import { fixture } from './native-lead-fixture.js';
describe('bounded native lead through real persistence / dispatch / isolated repair', () => {
  it('implements then validates, consumes every qualified finding/instruction exactly once, publishes a new HEAD and passes a NEW Oracle/final gate', async () => {
    const f = fixture();
    try {
      let outcome = await f.poll();
      if (f.run().state === 'WAITING_DEPENDENCY' && f.run().interruptedFrom === 'REVIEWING') {
        f.tick();
        outcome = await f.poll();
      }
      const run = f.run();
      assert.equal(run.state, 'MERGE_READY', JSON.stringify({ outcome, interrupt: run.interrupt, nativeLead: run.nativeLead }));
      assert.deepEqual(f.counts(), { leadCalls: 1, reviewCalls: 2, validationCalls: 2, observations: 0, boundaries: 2 });
      assert.equal(run.repairAdmissions?.length, 1);
      assert.equal(run.history.filter(h => h.type === 'start_fix').length, 1);
      const ref = run.repairAdmissions![0]!.leadDisposition!;
      assert.equal(ref.identity.repairLimit, 1);
      assert.equal(ref.identity.repairOrdinal, 1);
      assert.equal(ref.consumptionGeneration, ref.identity.ownerGeneration);
      assert.deepEqual(ref.identity.blockingFindingIds, [`${ref.identity.origin.digest}:0`, `${ref.identity.origin.digest}:2`]);
      assert.notEqual(f.reviewRequests[0]!.identity.requestId, f.reviewRequests[1]!.identity.requestId);
      assert.notEqual(f.reviewRequests[0]!.identity.headSha, f.reviewRequests[1]!.identity.headSha);
      assert.equal(run.headSha, f.reviewRequests[1]!.identity.headSha);
      assert.equal(run.validationResult?.headSha, run.headSha);
      assert.equal(run.reviewResult?.verdict, 'approve');
      const captured = readFileSync(f.prompts, 'utf8');
      assert.ok(captured.includes('Accept BOTH distinct original blocking findings'));
      assert.ok(captured.includes(ref.identity.origin.digest));
      assert.ok(captured.includes('First original finding.'));
      assert.ok(captured.includes('Second original finding.'));
      assert.equal(nativeLeadCoherent(run), true);
      assert.equal(unresolvedNativeLead(run), false);
      assert.equal(f.registry().readLane(`run:${run.id}`)?.status, 'parked');
      assert.ok(existsSync(path.join(f.root, 'oracle', 'native', 'lead', `${ref.requestId}.terminal.json`)));
      assert.equal(selectDispatchRuntime(await f.runtime.listRuntimeComments())?.claim.issue, 42, 'retained first row is not retired by lead disposition');
      const retired: Run = { ...run, nativeLead: { ...run.nativeLead!, activeRequestId: undefined, wait: undefined, requests: run.nativeLead!.requests.map(r => ({ ...r, status: 'retired' as const })) } };
      assert.equal(nativeLeadCoherent(retired), true, 'declared optional fields may be cleared before JSON serialization');
      assert.equal(nativeLeadCoherent({ ...retired, nativeLead: { ...retired.nativeLead!, unrecognized: undefined } } as Run), false, 'unknown fields remain forbidden even when undefined');
      f.store().update(retired);
      assert.equal(f.run().nativeLead!.requests[0]!.status, 'retired');
      assert.deepEqual(f.run().repairAdmissions, run.repairAdmissions);
    }
    finally {
      f.cleanup();
    }
  });
  it('recovers one pending original by returned URL under exact receipt-proved owner succession, consumes at the fresh generation and never resubmits', async () => {
    const f = fixture();
    try {
      f.setLeadSubmit(async () => ({ outcome: 'pending', conversationUrl: 'https://fixture.invalid/original' }));
      await f.poll();
      const pending = f.run();
      const request = f.leadRequests[0]!;
      assert.equal(pending.state, 'WAITING_DEPENDENCY');
      assert.equal(f.counts().leadCalls, 1);
      assert.equal(unresolvedNativeLead(pending), true);
      const issuance = activeNativeLead(pending)!.identity.ownerGeneration;
      f.setLeadObserve(async (i, url) => { assert.equal(i.requestId, request.identity.requestId); assert.equal(url, 'https://fixture.invalid/original'); return { outcome: 'complete', evidence: f.terminal(request) }; });
      f.tick();
      await f.poll();
      const repaired = f.run();
      assert.equal(repaired.repairAdmissions?.length, 1, JSON.stringify(repaired.interrupt));
      assert.equal(repaired.repairAdmissions![0]!.leadDisposition!.consumptionGeneration, issuance + 2);
      assert.equal(repaired.nativeLead!.ownerSuccessions[0]!.status, 'confirmed');
      assert.equal(f.counts().leadCalls, 1);
      assert.equal(f.counts().observations, 1);
      f.tick();
      await f.poll();
      assert.equal(f.run().state, 'MERGE_READY');
      assert.equal(f.counts().reviewCalls, 2);
    }
    finally {
      f.cleanup();
    }
  });
  it('records closed stop once, retains original findings and claim, and starts no repair or next row', async () => {
    const f = fixture();
    try {
      f.setLeadSubmit(async (r) => ({ outcome: 'complete', evidence: f.terminal(r, 'stop') }));
      await f.poll();
      const stopped = f.run();
      assert.equal(stopped.state, 'NEEDS_HUMAN');
      assert.equal(stopped.interruptedFrom, 'CHANGES_REQUESTED');
      assert.equal(stopped.nativeLead?.wait?.kind, 'stop');
      assert.equal(stopped.history.filter(h => h.nativeLeadStop !== undefined).length, 1);
      assert.equal(stopped.repairAdmissions, undefined);
      assert.equal(stopped.reviewResult?.findings.length, 3);
      assert.equal(unresolvedNativeLead(stopped), false);
      assert.equal((await f.poll()).outcome, 'existing_claim');
      assert.equal(f.counts().leadCalls, 1);
      assert.equal(f.counts().reviewCalls, 1);
      assert.equal(f.registry().readLane(`run:${stopped.id}`)?.status, 'parked');
      assert.equal(readFileSync(f.prompts, 'utf8').split('Packet: tachiko.implementation-packet.v1').length - 1, 1);
    }
    finally {
      f.cleanup();
    }
  });
  for (const kind of ['omitted', 'duplicate', 'foreign', 'extra-stop-fields', 'unknown-outcome', 'wrong-role', 'wrong-model', 'wrong-effort', 'bad-provenance'] as const) {
    it(`rejects ${kind} without a writer or auto-reconsultation`, async () => {
      const f = fixture();
      try {
        f.setLeadSubmit(async (r) => {
          const e = structuredClone(f.terminal(r));
          const d = e.disposition as Extract<LeadTerminal['disposition'], {
            outcome: 'repair';
          }>;
          if (kind === 'omitted')
            Object.assign(d, { acceptedFindingIds: [d.acceptedFindingIds[0]] });
          if (kind === 'duplicate')
            Object.assign(d, { acceptedFindingIds: [d.acceptedFindingIds[0], d.acceptedFindingIds[0]] });
          if (kind === 'foreign')
            Object.assign(d, { acceptedFindingIds: [`${'f'.repeat(64)}:0`, d.acceptedFindingIds[1]] });
          if (kind === 'extra-stop-fields')
            Object.assign(e, { disposition: { ...f.terminal(r, 'stop').disposition, instructions: 'unadmitted executable fields' } });
          if (kind === 'unknown-outcome')
            Object.assign(d, { outcome: 'approve' });
          if (kind === 'wrong-role')
            Object.assign(e.authentication, { role: 'independent-reviewer' });
          if (kind === 'wrong-model')
            Object.assign(e.authentication, { model: 'other-model' });
          if (kind === 'wrong-effort')
            Object.assign(e.authentication, { effort: 'Medium' });
          Object.assign(e.authentication, { transportReceipt: kind === 'bad-provenance' ? 'unverified' : leadPayloadDigest(e) });
          return { outcome: 'complete', evidence: e };
        });
        await f.poll();
        const rejected = f.run();
        assert.equal(rejected.repairAdmissions, undefined);
        assert.equal(f.counts().leadCalls, 1);
        assert.equal(f.counts().reviewCalls, 1);
        assert.equal(acceptedNativeLead(rejected), undefined);
        assert.equal(unresolvedNativeLead(rejected), ['wrong-role', 'wrong-model', 'wrong-effort', 'bad-provenance'].includes(kind));
        f.tick();
        await f.poll();
        assert.equal(f.counts().leadCalls, 1);
        assert.equal(f.run().repairAdmissions, undefined);
      }
      finally {
        f.cleanup();
      }
    });
  }
  for (const bad of ['absent', 'disabled', 'malformed', 'unqualified'] as const) {
    it(`keeps ${bad} lead binding unavailable before lead telemetry/submission and never falls through legacy repair`, async () => {
      const f = fixture();
      try {
        const host = bad === 'absent' ? {} as NativeLeadHost : bad === 'disabled' ? { ...f.lead, binding: { ...f.lead.binding, qualified: false } } as unknown as NativeLeadHost : bad === 'malformed' ? { binding: { model: 'fixture' } } as NativeLeadHost : { ...f.lead, binding: { ...f.lead.binding, readOnly: false } } as unknown as NativeLeadHost;
        await f.poll(host);
        const run = f.run();
        assert.equal(run.state, 'WAITING_DEPENDENCY');
        assert.equal(run.interruptedFrom, 'CHANGES_REQUESTED');
        assert.equal(f.counts().leadCalls, 0);
        assert.equal(run.repairAdmissions, undefined);
        assert.equal(run.telemetry?.events.filter(e => e.kind === 'spawn' && e.role === 'lead').length, 0);
        const removed = { ...f.workflow(host), reviewer: { kind: 'reviewer' as const, async review() { throw new Error('legacy fallback forbidden'); } } };
        f.tick();
        await runIssueCommand(removed, 'acme/widgets#42', { execution: f.execution, repairTaskShapeAuthority: f.shape, dispatchClaimId: run.dispatchClaimId, admission: f.registry(), runOwnerReceiptPath: f.receiptPath, now: f.now, withDispatchAdmissionLock: async (op) => op() });
        assert.equal(f.run().repairAdmissions, undefined);
        assert.equal(f.counts().leadCalls, 0);
      }
      finally {
        f.cleanup();
      }
    });
  }
  it('observes under HOLD as evidence only, then requires a separate unheld current admission to repair', async () => {
    const f = fixture();
    try {
      f.setLeadSubmit(async () => ({ outcome: 'pending', conversationUrl: 'https://fixture.invalid/held' }));
      await f.poll();
      const original = f.leadRequests[0]!;
      f.setHold(true);
      f.tick();
      f.setLeadObserve(async () => ({ outcome: 'complete', evidence: f.terminal(original) }));
      await f.poll();
      const held = f.run();
      assert.equal(held.repairAdmissions, undefined);
      assert.equal(acceptedNativeLead(held)?.disposition.outcome, 'repair');
      assert.equal(f.counts().leadCalls, 1);
      assert.equal(f.counts().reviewCalls, 1);
      assert.equal(f.counts().boundaries, 0);
      f.setHold(false);
      f.tick();
      await f.poll();
      assert.equal(f.run().repairAdmissions?.length, 1);
      assert.equal(f.counts().leadCalls, 1);
    }
    finally {
      f.cleanup();
    }
  });
  it('persists exactly three observations/backoff across restarts, keeps unknown owner fences and rejects cancellation/retirement', async () => {
    const f = fixture();
    try {
      f.setLeadSubmit(async () => ({ outcome: 'pending' }));
      await f.poll();
      const pending = f.run();
      for (let i = 0; i < 5; i++) {
        f.tick();
        await f.poll();
      }
      assert.equal(f.counts().leadCalls, 1);
      assert.equal(f.counts().observations, 3);
      assert.equal(activeNativeLead(f.run())?.observations, 3);
      assert.equal(unresolvedNativeLead(f.run()), true);
      await assert.rejects(() => resumeCommand(f.workflow(), pending.id, 'Cancel the run', { dispatchClaimId: pending.dispatchClaimId, admission: f.registry(), runOwnerReceiptPath: f.receiptPath }), /uncertain|Invalid decision|Choose exactly/);
      const lane = f.registry().readLane(`run:${pending.id}`)!;
      assert.throws(() => recoverRunAdmission(f.store(), f.registry(), pending.id, lane.generation, true, f.receiptPath, { retireWork: true }), /unresolved/);
      assert.equal((await f.poll()).outcome, 'existing_claim');
      assert.equal(selectDispatchRuntime(await f.runtime.listRuntimeComments())?.claim.issue, 42);
    }
    finally {
      f.cleanup();
    }
  });
  for (const cut of ['before-reservation', 'after-reservation', 'after-request', 'after-marker', 'lost-ack', 'after-terminal', 'after-acceptance', 'after-start-fix'] as const) {
    it(`survives ${cut} crash through stopped owner recovery without duplicate submission/admission/worker`, async () => {
      const f = fixture();
      try {
        const durable = f.store();
        const original = durable.updateIfUnchanged.bind(durable);
        let crashed = false;
        durable.updateIfUnchanged = (expected, next) => {
          const old = activeNativeLead(expected), current = activeNativeLead(next);
          const hit = !crashed && (cut === 'before-reservation' && !old && !!current || cut === 'after-request' && current?.submissionPossible === true && old?.submissionPossible === false || cut === 'after-marker' && current?.submissionPossible === true && old?.submissionPossible === false || cut === 'after-terminal' && current?.status === 'qualified_complete' && old?.status !== 'qualified_complete' || (cut === 'after-acceptance' || cut === 'after-start-fix') && next.history.at(-1)?.type === 'start_fix' && expected.history.at(-1)?.type !== 'start_fix');
          if (hit) {
            crashed = true;
            if (cut === 'after-marker' || cut === 'after-start-fix')
              original(expected, next);
            throw new Error(`injected crash ${cut}`);
          }
          return original(expected, next);
        };
        if (cut === 'after-reservation') {
          const record = f.receipts.recordLead.bind(f.receipts);
          f.receipts.recordLead = e => {
            if (!crashed && e.kind === 'request') {
              crashed = true;
              throw new Error('injected crash after-reservation');
            }
            record(e);
          };
        }
        if (cut === 'lost-ack')
          f.setLeadSubmit(async () => { crashed = true; throw new Error('remote accepted; acknowledgement lost'); });
        if (cut === 'lost-ack')
          await f.poll(f.lead, durable);
        else
          await assert.rejects(() => f.poll(f.lead, durable), /injected crash/);
        assert.equal(crashed, true);
        const interrupted = f.run();
        const lane = f.registry().readLane(`run:${interrupted.id}`)!;
        if (lane.status === 'active') {
          assert.equal((await f.poll()).outcome, 'admission_wait', 'active/unknown invocation cannot be taken over');
          recoverRunAdmission(f.store(), f.registry(), interrupted.id, lane.generation, true, f.receiptPath);
        }
        const saved = activeNativeLead(f.run());
        if (saved?.submissionPossible && !saved.terminalDigest && cut !== 'after-terminal') {
          const evidence = f.receipts.readLead(`${saved.identity.requestId}.request`)!;
          assert.equal(evidence.kind, 'request');
          f.setLeadObserve(async (i) => { assert.equal(i.requestId, saved.identity.requestId); return { outcome: 'complete', evidence: f.terminal(evidence as LeadRequest) }; });
        }
        f.tick();
        await f.poll();
        if (f.run().state === 'WAITING_DEPENDENCY' && f.run().interruptedFrom === 'REVIEWING') {
          f.tick();
          await f.poll();
        }
        const finished = f.run();
        assert.equal(finished.state, 'MERGE_READY', JSON.stringify({ cut, interrupt: finished.interrupt }));
        assert.equal(finished.repairAdmissions?.length, 1);
        assert.equal(finished.history.filter(h => h.type === 'start_fix').length, 1);
        assert.equal(f.counts().leadCalls, cut === 'after-marker' ? 0 : 1);
        assert.equal(readFileSync(f.prompts, 'utf8').split('Packet: tachiko.implementation-packet.v1').length - 1, 2);
      }
      finally {
        f.cleanup();
      }
    });
  }
  it('recovers terminal evidence written before a losing acceptance CAS with no second service read', async () => {
    const f = fixture();
    try {
      const durable = f.store();
      const original = durable.updateIfUnchanged.bind(durable);
      let lost = false;
      durable.updateIfUnchanged = (a, b) => {
        if (!lost && activeNativeLead(b)?.status === 'qualified_complete' && activeNativeLead(a)?.status !== 'qualified_complete') {
          lost = true;
          return false;
        }
        return original(a, b);
      };
      await f.poll(f.lead, durable);
      assert.equal(f.run().repairAdmissions, undefined);
      f.tick();
      await f.poll();
      assert.equal(f.run().repairAdmissions?.length, 1);
      assert.equal(f.counts().leadCalls, 1);
      assert.equal(f.counts().observations, 0);
    }
    finally {
      f.cleanup();
    }
  });
  it('starts no writer on a losing start_fix CAS and consumes that incarnation once after a fresh current owner admission', async () => {
    const f = fixture();
    try {
      const durable = f.store();
      const original = durable.updateIfUnchanged.bind(durable);
      let lost = false;
      durable.updateIfUnchanged = (a, b) => {
        if (!lost && b.history.at(-1)?.type === 'start_fix' && a.history.at(-1)?.type !== 'start_fix') {
          lost = true;
          return false;
        }
        return original(a, b);
      };
      await f.poll(f.lead, durable);
      assert.equal(f.run().repairAdmissions, undefined);
      assert.equal(f.counts().boundaries, 0);
      f.tick();
      await f.poll();
      assert.equal(f.run().repairAdmissions?.length, 1);
      assert.equal(f.counts().leadCalls, 1);
    }
    finally {
      f.cleanup();
    }
  });
  it('allows one explicitly qualified irrecoverable replacement and reconciles a late inactive original without consuming it', async () => {
    const f = fixture();
    try {
      let issued = 0;
      f.setLeadSubmit(async (r) => ++issued === 1 ? { outcome: 'terminal_unknown', conversationUrl: 'https://fixture.invalid/old' } : { outcome: 'complete', evidence: f.terminal(r) });
      const host = { ...f.lead, replacementDisposition: () => 'irrecoverable_transport' as const };
      await f.poll(host);
      const first = f.leadRequests[0]!;
      f.tick();
      await f.poll(host);
      const replacement = f.run();
      assert.equal(replacement.nativeLead?.requests.length, 2);
      assert.equal(replacement.repairAdmissions?.length, 1);
      assert.equal(replacement.telemetry?.events.filter(e => e.kind === 'spawn' && e.role === 'lead').length, 2, 'each replacement request is a distinct possible model invocation');
      assert.equal(f.counts().leadCalls, 2);
      assert.notEqual(replacement.repairAdmissions![0]!.leadDisposition!.requestId, first.identity.requestId);
      assert.equal(unresolvedNativeLead(replacement), true);
      f.setLeadObserve(async (i, url) => { assert.equal(i.requestId, first.identity.requestId); assert.equal(url, 'https://fixture.invalid/old'); return { outcome: 'complete', evidence: f.terminal(first) }; });
      f.tick();
      await f.poll(host);
      assert.equal(unresolvedNativeLead(f.run()), false);
      assert.equal(f.run().repairAdmissions?.length, 1);
      assert.equal(f.run().nativeLead?.acceptances.length, 2);
      f.tick();
      await f.poll(host);
      assert.equal(f.counts().leadCalls, 2);
    }
    finally {
      f.cleanup();
    }
  });
  for (const drift of ['head', 'base', 'scope', 'contract', 'execution', 'review-policy', 'lead-policy'] as const) {
    it(`preserves old evidence and prevents repair after ${drift} authority drift`, async () => {
      const f = fixture();
      try {
        f.setLeadSubmit(async () => ({ outcome: 'pending' }));
        await f.poll();
        const request = f.leadRequests[0]!;
        f.setLeadObserve(async () => ({ outcome: 'complete', evidence: f.terminal(request) }));
        if (drift === 'head' || drift === 'base' || drift === 'scope')
          f.setLiveOverride(s => drift === 'head' ? { ...s, headSha: 'e'.repeat(40), pullRequest: { ...s.pullRequest!, headSha: 'e'.repeat(40) } } : drift === 'base' ? { ...s, pullRequest: { ...s.pullRequest!, baseSha: 'f'.repeat(40) } } : { ...s, handoff: { ...s.handoff!, sections: { scope: 'Expanded scope is not admitted' } } });
        const host = drift === 'lead-policy' ? { ...f.lead, binding: { ...f.lead.binding, policyRevision: 'changed' } } : f.lead;
        let durable = f.store();
        if (drift === 'contract' || drift === 'execution' || drift === 'review-policy') {
          // Pure current-authority probes use the real boundary against an unmodified persisted origin.
          const run = f.run();
          const owner = f.registry().readLane(`run:${run.id}`)!;
          const altered = drift === 'contract' ? { ...run, repairTaskShapeAuthority: { ...run.repairTaskShapeAuthority!, revision: 'changed' } } : drift === 'execution' ? { ...run, execution: { ...run.execution!, revision: 'changed' } } : { ...run, nativeReview: { ...run.nativeReview!, accepted: { ...run.nativeReview!.accepted!, identity: { ...run.nativeReview!.accepted!.identity, policyRevision: 'changed' } } } };
          assert.equal(resolveNativeLead(host).validate({ run: altered, snapshot: await f.github.readLiveSnapshot(TARGET), owner: { missionId: owner.missionId, laneId: owner.laneId, generation: owner.generation }, assertCurrent: () => { }, store: durable, now: f.now, execution: f.execution, maxAttempts: 1, onSubmission: r => r }), null);
        }
        else {
          f.tick();
          await f.poll(host);
          assert.equal(f.run().repairAdmissions, undefined);
          assert.equal(f.counts().leadCalls, 1);
        }
        assert.ok(f.receipts.readLead(`${request.identity.requestId}.request`));
      }
      finally {
        f.cleanup();
      }
    });
  }
  for (const cut of ['proof-before-receipt', 'receipt-before-registry', 'registry-before-confirmation'] as const) {
    it(`recovers canonical owner succession ${cut} crash without numeric-generation authority`, async () => {
      const f = fixture();
      try {
        f.setLeadSubmit(async () => ({ outcome: 'pending' }));
        await f.poll();
        const request = f.leadRequests[0]!;
        const durable = f.store();
        const original = durable.updateIfUnchanged.bind(durable);
        let crashed = false;
        durable.updateIfUnchanged = (a, b) => {
          const old = a.nativeLead?.ownerSuccessions ?? [], next = b.nativeLead?.ownerSuccessions ?? [];
          if (!crashed && (cut === 'proof-before-receipt' && next.length > old.length || cut === 'registry-before-confirmation' && next.some((s, i) => s.status === 'confirmed' && old[i]?.status === 'prepared'))) {
            crashed = true;
            if (cut === 'proof-before-receipt')
              original(a, b);
            throw new Error(`injected succession ${cut}`);
          }
          return original(a, b);
        };
        if (cut === 'receipt-before-registry')
          f.setRegistryFault(() => {
            if (!crashed && readRunOwnerReceipt(f.receiptPath)?.phase === 'pre_execution' && f.run().nativeLead?.ownerSuccessions.some(s => s.status === 'prepared')) {
              crashed = true;
              throw new Error('injected succession receipt-before-registry');
            }
          });
        f.tick();
        await assert.rejects(() => f.poll(f.lead, durable), /injected succession/);
        assert.equal(crashed, true);
        assert.equal(f.run().nativeLead?.ownerSuccessions[0]?.status, 'prepared');
        const lane = f.registry().readLane(`run:${f.run().id}`)!;
        if (cut === 'registry-before-confirmation') {
          assert.equal(lane.status, 'active');
          recoverRunAdmission(f.store(), f.registry(), f.run().id, lane.generation, true, f.receiptPath);
        }
        else
          assert.equal(lane.status, 'parked');
        f.setLeadObserve(async () => ({ outcome: 'complete', evidence: f.terminal(request) }));
        f.tick();
        await f.poll();
        assert.equal(f.run().repairAdmissions?.length, 1, JSON.stringify(f.run().interrupt));
        assert.equal(f.counts().leadCalls, 1);
        assert.ok(f.run().nativeLead?.ownerSuccessions.every(s => s.status === 'confirmed'));
      }
      finally {
        f.cleanup();
      }
    });
  }
  for (const foreign of ['mission', 'claim', 'workspace', 'missing', 'unproved-release'] as const) {
    it(`rejects ${foreign} predecessor receipt before canonical overwrite or stale decision consumption`, async () => {
      const f = fixture();
      try {
        f.setLeadSubmit(async () => ({ outcome: 'pending' }));
        await f.poll();
        const pending = f.run();
        const receipt = readRunOwnerReceipt(f.receiptPath)!;
        if (foreign === 'missing') {
          const { unlinkSync } = await import('node:fs');
          unlinkSync(f.receiptPath);
        }
        else if (foreign === 'unproved-release') {
          const lane = f.registry().readLane(`run:${pending.id}`)!;
          f.registry().releaseParked(lane.laneId, lane.generation, true);
          writeRunOwnerReceipt(f.receiptPath, { ...receipt, phase: 'released', generation: lane.generation + 1 });
        }
        else
          writeRunOwnerReceipt(f.receiptPath, { ...receipt, ...(foreign === 'mission' ? { missionId: 'foreign-mission' } : foreign === 'claim' ? { claimId: 'foreign-claim' } : { workspace: path.join(f.root, 'foreign') }) });
        f.tick();
        await assert.rejects(() => f.poll(), /receipt|predecessor|succession|workspace/);
        assert.equal(f.counts().leadCalls, 1);
        assert.equal(f.run().repairAdmissions, undefined);
        if (foreign !== 'missing')
          assert.equal(readRunOwnerReceipt(f.receiptPath)?.phase, foreign === 'unproved-release' ? 'released' : 'parked');
      }
      finally {
        f.cleanup();
      }
    });
  }
  it('rejects altered request source/diff/packet hashes and immutable terminal collisions', async () => {
    const f = fixture();
    try {
      f.setLeadSubmit(async () => ({ outcome: 'pending' }));
      await f.poll();
      const request = f.leadRequests[0]!;
      for (const mutate of [(r: LeadRequest) => Object.assign(r.packet.manifest, { diff: r.packet.manifest.diff + 'tampered' }), (r: LeadRequest) => Object.assign(r.identity, { packetSha256: '0'.repeat(64) }), (r: LeadRequest) => Object.assign(r.packet, { remainingRepairs: 0 }), (r: LeadRequest) => Object.assign(r.identity, { role: 'independent-reviewer' }), (r: LeadRequest) => Object.assign(r.packet.origin.result.findings[0]!, { severity: 'non_blocking' })]) {
        const changed = structuredClone(request);
        mutate(changed);
        assert.equal(validLeadEvidence(changed), false);
        assert.throws(() => f.receipts.recordLead(changed), /Invalid/);
      }
      const terminal = f.terminal(request);
      f.receipts.recordLead(terminal);
      const other = structuredClone(terminal);
      if (other.disposition.outcome === 'repair')
        Object.assign(other.disposition, { instructions: 'Different bounded instructions' });
      Object.assign(other.authentication, { transportReceipt: leadPayloadDigest(other) });
      assert.throws(() => f.receipts.recordLead(other), /Conflicting/);
      assert.equal(f.receipts.readNative(terminal.id), null, 'lead evidence cannot masquerade as independent review');
    }
    finally {
      f.cleanup();
    }
  });
  it('enforces native disposition consumption in the actual reducer and direct store, then preserves immutable historical evidence after new HEAD', async () => {
    const f = fixture();
    try {
      f.setLeadSubmit(async () => ({ outcome: 'pending' }));
      await f.poll();
      const pending = f.run();
      const resumed = applyTransition(pending, { type: 'dependency_satisfied', reason: 'bounded fixture check' }, f.now());
      assert.throws(() => applyTransition(resumed, { type: 'start_fix' }, f.now()), /qualified|admission|budget/);
      assert.throws(() => f.store().update({ ...pending, history: [...pending.history, { type: 'start_fix', from: 'CHANGES_REQUESTED', to: 'IMPLEMENTING', at: f.now() }], state: 'IMPLEMENTING' }), /Native repair|atomic|admission/);
      f.setLeadObserve(async () => ({ outcome: 'complete', evidence: f.terminal(f.leadRequests[0]!) }));
      f.tick();
      await f.poll();
      const admitted = f.run();
      assert.equal(admitted.repairAdmissions?.length, 1);
      const original = structuredClone(admitted.repairAdmissions![0]!);
      for (const mutate of [(r: typeof original) => { Object.assign(r, { leadDisposition: undefined }); }, (r: typeof original) => { Object.assign(r.leadDisposition!, { consumptionGeneration: 999 }); }, (r: typeof original) => { Object.assign(r.leadDisposition!.identity, { repairOrdinal: 2 }); }, (r: typeof original) => { Object.assign(r, { packetSha256: '0'.repeat(64) }); }, (r: typeof original) => {
          if (r.leadDisposition!.disposition.outcome === 'repair')
            Object.assign(r.leadDisposition!.disposition, { instructions: 'altered' });
        }]) {
        const changed = structuredClone(original);
        mutate(changed);
        assert.throws(() => f.store().update({ ...admitted, repairAdmissions: [changed] }), /coherent|monotonic|immutable|append-only/);
      }
      f.tick();
      await f.poll();
      assert.equal(f.run().state, 'MERGE_READY');
      assert.deepEqual(f.run().repairAdmissions![0], original);
    }
    finally {
      f.cleanup();
    }
  });
  it('keeps host-authenticated terminal under newly active HOLD as evidence, preserves active owner on thrown cleanup, and repairs only after stopped recovery/unheld admission', async () => {
    const f = fixture();
    try {
      f.setLeadSubmit(async (r) => { f.setHold(true); return { outcome: 'complete', evidence: f.terminal(r) }; });
      await assert.rejects(() => f.poll(), /HOLD/);
      const run = f.run();
      assert.equal(acceptedNativeLead(run)?.disposition.outcome, 'repair');
      assert.equal(run.repairAdmissions, undefined);
      const lane = f.registry().readLane(`run:${run.id}`)!;
      assert.equal(lane.status, 'active');
      recoverRunAdmission(f.store(), f.registry(), run.id, lane.generation, true, f.receiptPath);
      f.tick();
      await f.poll();
      assert.equal(f.run().repairAdmissions, undefined);
      f.setHold(false);
      f.tick();
      await f.poll();
      assert.equal(f.run().repairAdmissions?.length, 1);
      assert.equal(f.counts().leadCalls, 1);
    }
    finally {
      f.cleanup();
    }
  });
  it('shares the immutable no-reset budget across validation-directed and Oracle-directed repairs without suppressing the last repaired HEAD review', async () => {
    const f = fixture();
    try {
      f.setFirstValidationFailure();
      await f.poll();
      const run = f.run();
      assert.equal(run.state, 'NEEDS_HUMAN', JSON.stringify(run.interrupt));
      assert.equal(run.history.filter(h => h.type === 'start_fix').length, 1);
      assert.equal(run.repairAdmissions?.[0]?.finding, 'validation_failed');
      assert.equal(run.repairAdmissions?.[0]?.budgetLimit, 1);
      assert.equal(f.counts().validationCalls, 2);
      assert.equal(f.counts().reviewCalls, 1, 'the already admitted last repair still gets its required fresh independent review');
      assert.equal(f.counts().leadCalls, 0);
      assert.equal(run.nativeReview?.repairLimit, 1);
      await resumeCommand(f.workflow(), run.id, run.interrupt!.choices![0]!, { dispatchClaimId: run.dispatchClaimId, admission: f.registry(), runOwnerReceiptPath: f.receiptPath, now: f.now, maxReviewAttempts: 1, assertReviewClaim: async () => { }, assertLeadInitiation: async () => { }, withDispatchAdmissionLock: async (op) => op(), withNativeEffectBoundary: op => op() });
      assert.equal(f.run().history.filter(h => h.type === 'start_fix').length, 1);
      assert.equal(f.counts().leadCalls, 0);
    }
    finally {
      f.cleanup();
    }
  });
  it('does not replenish an issued incarnation or repair allowance when the configured maximum changes', async () => {
    const f = fixture();
    try {
      f.setLeadSubmit(async () => ({ outcome: 'pending' }));
      await f.poll();
      f.tick();
      await f.poll(f.lead, f.store(), 2);
      assert.equal(f.run().repairAdmissions, undefined);
      assert.equal(f.run().nativeReview?.repairLimit, 1);
      assert.equal(f.counts().leadCalls, 1);
      assert.equal(f.run().state, 'NEEDS_HUMAN');
    }
    finally {
      f.cleanup();
    }
  });
  it('does not replace safety refusal or timeout/unknown work without explicit irrecoverable policy evidence', async () => {
    for (const refusal of [true, false]) {
      const f = fixture();
      try {
        f.setLeadSubmit(async () => refusal ? { outcome: 'incomplete', reason: 'safety_refusal' } : { outcome: 'terminal_unknown' });
        await f.poll();
        const host = refusal ? { ...f.lead, replacementDisposition: () => 'irrecoverable_transport' as const } : f.lead;
        for (let i = 0; i < 4; i++) {
          f.tick();
          await f.poll(host);
        }
        assert.equal(f.counts().leadCalls, 1);
        assert.equal(f.run().nativeLead?.requests.length, 1);
        assert.equal(f.run().repairAdmissions, undefined);
        assert.equal(unresolvedNativeLead(f.run()), true);
      }
      finally {
        f.cleanup();
      }
    }
  });
  it('bounds replacement identities across repeated recovery/configuration churn and still observes the second exact original', async () => {
    const f = fixture();
    try {
      f.setLeadSubmit(async () => ({ outcome: 'terminal_unknown' }));
      const host = { ...f.lead, replacementDisposition: () => 'irrecoverable_transport' as const };
      await f.poll(host);
      f.tick();
      await f.poll(host);
      assert.equal(f.counts().leadCalls, 2);
      for (let i = 0; i < 8; i++) {
        f.tick();
        await f.poll({ ...host, binding: { ...host.binding } });
      }
      assert.equal(f.counts().leadCalls, 2);
      assert.equal(f.run().nativeLead?.requests.length, 2);
      assert.ok(f.counts().observations <= 6);
      assert.equal(f.run().repairAdmissions, undefined);
    }
    finally {
      f.cleanup();
    }
  });
  it('preserves uncertainty on unsupported observation or conflicting returned URLs without inventing a URL or resending', async () => {
    for (const unsupported of [true, false]) {
      const f = fixture();
      try {
        f.setLeadSubmit(async () => ({ outcome: 'pending', conversationUrl: 'https://fixture.invalid/original' }));
        await f.poll();
        const { observe: _observe, ...without } = f.lead;
        const host = unsupported ? without : f.lead;
        f.setLeadObserve(async () => ({ outcome: 'complete', conversationUrl: 'https://fixture.invalid/conflict', evidence: f.terminal(f.leadRequests[0]!) }));
        f.tick();
        await f.poll(host);
        assert.equal(unresolvedNativeLead(f.run()), true);
        assert.equal(activeNativeLead(f.run())?.conversationUrl, 'https://fixture.invalid/original');
        assert.equal(f.run().repairAdmissions, undefined);
        assert.equal(f.counts().leadCalls, 1);
        if (unsupported)
          assert.equal(activeNativeLead(f.run())?.status, 'terminal_unknown');
      }
      finally {
        f.cleanup();
      }
    }
  });
  for (const state of ['FAILED', 'MERGED'] as const)
    it(`keeps unresolved lead ownership fenced through a forced terminal-looking ${state}`, async () => {
      const f = fixture();
      try {
        f.setLeadSubmit(async () => ({ outcome: 'pending' }));
        await f.poll();
        const run = f.run();
        if (state === 'MERGED') {
          assert.throws(() => f.store().update({ ...run, state }), /Native merge/);
        }
        else
          f.store().update(applyTransition(run, { type: 'fail', reason: 'controlled local terminal projection' }, f.now()));
        await f.poll();
        assert.equal(f.counts().leadCalls, 1);
        assert.equal(selectDispatchRuntime(await f.runtime.listRuntimeComments())?.claim.issue, 42);
        assert.equal(f.registry().readLane(`run:${run.id}`)?.status, 'parked');
        assert.throws(() => recoverRunAdmission(f.store(), f.registry(), run.id, f.registry().readLane(`run:${run.id}`)!.generation, true, f.receiptPath, { retireWork: true }), /unresolved/);
      }
      finally {
        f.cleanup();
      }
    });
  it('does not consume a terminal when current qualified execution disappears during the service turn', async () => {
    const f = fixture();
    try {
      f.setLeadSubmit(async (r) => { f.setExecutionUnavailable(); return { outcome: 'complete', evidence: f.terminal(r) }; });
      await f.poll();
      assert.equal(f.run().repairAdmissions, undefined);
      assert.equal(acceptedNativeLead(f.run())?.disposition.outcome, 'repair');
      assert.equal(f.counts().leadCalls, 1);
      assert.equal(f.counts().boundaries, 0);
    }
    finally {
      f.cleanup();
    }
  });
  it('reconciles an independently authenticated rejected-terminal receipt before another service observation after a crash', async () => {
    const f = fixture();
    try {
      f.setLeadSubmit(async (r) => { const e = f.terminal(r); if (e.disposition.outcome === 'repair')
        Object.assign(e.disposition, { acceptedFindingIds: [e.disposition.acceptedFindingIds[0]] }); return { outcome: 'complete', evidence: { ...e, authentication: { ...e.authentication, transportReceipt: leadPayloadDigest(e) } } }; });
      const durable = f.store(), update = durable.updateIfUnchanged.bind(durable);
      let crashed = false;
      durable.updateIfUnchanged = (a, b) => { if (!crashed && activeNativeLead(b)?.terminalDigest && activeNativeLead(b)?.status === 'incomplete') {
        crashed = true;
        throw new Error('injected completion CAS crash');
      } return update(a, b); };
      await assert.rejects(() => f.poll(f.lead, durable), /completion CAS crash/);
      const run = f.run(), lane = f.registry().readLane(`run:${run.id}`)!;
      recoverRunAdmission(f.store(), f.registry(), run.id, lane.generation, true, f.receiptPath);
      f.tick();
      await f.poll();
      assert.equal(unresolvedNativeLead(f.run()), false);
      assert.equal(acceptedNativeLead(f.run()), undefined);
      assert.equal(f.counts().leadCalls, 1);
      assert.equal(f.counts().observations, 0);
      assert.equal(f.run().repairAdmissions, undefined);
    }
    finally {
      f.cleanup();
    }
  });
  it('enforces HOLD at the final serialized issue fence before the submission marker/service call', async () => {
    const f = fixture();
    try {
      let held = false;
      f.setIssueHook(() => { if (!held) {
        held = true;
        f.setHold(true);
      } });
      await assert.rejects(() => f.poll(), /HOLD/);
      assert.equal(f.counts().leadCalls, 0);
      assert.equal(activeNativeLead(f.run())?.submissionPossible, false);
      assert.equal(f.run().repairAdmissions, undefined);
      const run = f.run(), lane = f.registry().readLane(`run:${run.id}`)!;
      assert.equal(lane.status, 'active');
      recoverRunAdmission(f.store(), f.registry(), run.id, lane.generation, true, f.receiptPath);
      f.tick();
      await f.poll();
      assert.equal(f.counts().leadCalls, 0);
      f.setHold(false);
      f.tick();
      await f.poll();
      assert.equal(f.counts().leadCalls, 1);
      assert.equal(f.run().repairAdmissions?.length, 1);
    }
    finally {
      f.cleanup();
    }
  });
  it('enforces HOLD at actual isolated process creation after admission without starting a second logical repair', async () => {
    const f = fixture();
    try {
      let held = false;
      f.setEffectHook(() => { if (!held) {
        held = true;
        f.setHold(true);
      } });
      await f.poll();
      const run = f.run();
      assert.equal(run.repairAdmissions?.length, 1);
      assert.equal(run.state, 'NEEDS_HUMAN', JSON.stringify(run.interrupt));
      assert.equal(run.interruptedFrom, 'IMPLEMENTING');
      assert.equal(readFileSync(f.prompts, 'utf8').split('Packet: tachiko.implementation-packet.v1').length - 1, 1, 'repair process never spawned');
      f.setHold(false);
      await resumeCommand(f.workflow(), run.id, run.interrupt!.choices?.[0] ?? 'Retry the admitted repair after HOLD release', { dispatchClaimId: run.dispatchClaimId, admission: f.registry(), runOwnerReceiptPath: f.receiptPath, now: f.now, maxReviewAttempts: 1, assertReviewClaim: async () => { }, assertLeadInitiation: async () => { }, withDispatchAdmissionLock: async (op) => op(), withNativeEffectBoundary: op => op() });
      assert.equal(f.run().repairAdmissions?.length, 1);
      assert.equal(f.run().history.filter(h => h.type === 'start_fix').length, 1);
      assert.equal(f.counts().leadCalls, 1);
    }
    finally {
      f.cleanup();
    }
  });
  it('keeps the original isolated worker publication fenced when accepted scope changes after the repair process', async () => {
    const f = fixture();
    try {
      let changed = false;
      f.setSnapshotHook(() => { if (!changed && f.counts().boundaries > 0) {
        changed = true;
        f.setLiveOverride(s => ({ ...s, handoff: { ...s.handoff!, sections: { scope: 'New expanded scope was never admitted' } } }));
      } });
      await f.poll();
      const run = f.run();
      assert.equal(run.repairAdmissions?.length, 1);
      assert.equal(run.state, 'NEEDS_HUMAN');
      assert.equal(f.counts().boundaries, 1, 'repair process ran but host push did not');
      assert.equal(f.counts().reviewCalls, 1);
      assert.equal(f.counts().leadCalls, 1);
      assert.equal((await f.github.readLiveSnapshot(TARGET)).headSha, f.reviewRequests[0]!.identity.headSha, 'remote PR retains the original head');
    }
    finally {
      f.cleanup();
    }
  });
});
