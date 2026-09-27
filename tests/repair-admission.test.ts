import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  createRepairAttemptBinding,
  createRepairAdmissionSnapshot,
  decideRepairAdmission,
  isRepairHandoffCompatible,
  isRepairAdmissionSnapshot,
  isRepairHandoffRecord,
  resolveRepairPredecessor,
  parseRepairTaskShapeAuthority,
  RepairAdmissionIdentityError,
  REPAIR_FINDING_TAXONOMY_REVISION,
} from '../src/domain/repair-admission.js';
import { createRun } from '../src/domain/run.js';
import { JsonFileStore } from '../src/store/json-file-store.js';
import { applyTransition } from '../src/domain/state-machine.js';
import { TARGET, T0, TEST_VALIDATION_AUTHORITY, changesRequested, successResult, validationPassed } from './helpers.js';

const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const authority = { revision: 'task-shape-v1', shape: 'bounded' as const };
const routineExecution = { profile: 'routine' as const, revision: 'execution-v1', executor: 'codex-cli', timeoutMs: 1_000 };

describe('revisioned repair admission authority', () => {
  it('maps only explicit bounded/interacting/decision authority and accepts no prose input', () => {
    assert.deepEqual(decideRepairAdmission(authority), { kind: 'admit', executionProfile: 'routine' });
    assert.deepEqual(decideRepairAdmission({ revision: 'task-shape-v1', shape: 'interacting' }), { kind: 'admit', executionProfile: 'complex' });
    assert.deepEqual(decideRepairAdmission({ revision: 'task-shape-v1', shape: 'decision' }), { kind: 'park', escalation: 'decision_required' });
  });

  it('creates bounded, versioned exact-HEAD/PR admission evidence', () => {
    const snapshot = createRepairAdmissionSnapshot(authority, 'review_blocking', HEAD, 7, routineExecution, '2026-09-20T00:00:00.000Z');
    assert.equal(snapshot.taxonomyRevision, REPAIR_FINDING_TAXONOMY_REVISION);
    assert.equal(snapshot.headSha, HEAD);
    assert.equal(snapshot.pullRequestNumber, 7);
    assert.equal(snapshot.executionRevision, 'execution-v1');
    assert.equal(snapshot.execution.revision, 'execution-v1');
    assert.equal(isRepairAdmissionSnapshot(snapshot), true);
    assert.equal(isRepairAdmissionSnapshot({ ...snapshot, headSha: '' }), false);
    assert.equal(isRepairAdmissionSnapshot({ ...snapshot, taskShape: 'interacting' }), false);
    assert.throws(
      () => createRepairAdmissionSnapshot({ revision: 'task-shape-v1', shape: 'interacting' }, 'review_blocking', HEAD, 7, routineExecution, '2026-09-20T00:00:00.000Z'),
      /does not match/,
    );
  });

  it('keeps WorkerRouter handoffs sessionless and holds generationless App Server continuations', () => {
    const workerBinding = { admissionIndex: 0, startFixHistoryIndex: 0, freshExecutor: true, runtimeGeneration: 'repair-1' };
    const sessionless = { kind: 'sessionless' as const, provider: 'worker-router' as const };
    const workerExecutor = { kind: 'executor' as const, identity: { provider: 'worker-router', sessionId: 'session-1' } };
    assert.equal(isRepairHandoffCompatible('worker-router', workerBinding, sessionless), true);
    assert.equal(isRepairHandoffCompatible('worker-router', workerBinding, sessionless, sessionless), true);
    assert.equal(isRepairHandoffCompatible('worker-router', workerBinding, workerExecutor), false);
    assert.equal(isRepairHandoffCompatible('worker-router', workerBinding, workerExecutor, workerExecutor), false);
    assert.equal(isRepairHandoffCompatible('worker-router', workerBinding, workerExecutor, sessionless), false);

    const appServer = { provider: 'codex-app-server', sessionId: 'app-session' } as const;
    assert.throws(
      () => createRepairAttemptBinding({ history: [], executor: appServer }, routineExecution),
      RepairAdmissionIdentityError,
    );
    const generationlessCli = { ...routineExecution, executor: 'codex-cli' };
    assert.throws(
      () => createRepairAttemptBinding({ history: [], executor: appServer }, generationlessCli),
      /no generation/,
    );
    const generationBound = { ...appServer, generation: 'app-generation' };
    const binding = createRepairAttemptBinding({ history: [], executor: generationBound }, routineExecution);
    assert.equal(binding.freshExecutor, false);
    assert.equal(binding.runtimeGeneration, 'app-generation');
    const snapshot = {
      ...createRepairAdmissionSnapshot(authority, 'review_blocking', HEAD, 7, routineExecution, '2026-09-20T00:00:00.000Z'),
      attemptBinding: binding,
    };
    assert.equal(isRepairAdmissionSnapshot(snapshot), true);
    assert.equal(isRepairAdmissionSnapshot({ ...snapshot, attemptBinding: { ...binding, runtimeGeneration: 'other' } }), false);
    assert.equal(createRepairAttemptBinding({ history: [], executor: { provider: 'codex-cli', sessionId: 'cli-session' } }, routineExecution).freshExecutor, false);
  });

  it('binds coherent result-only physical predecessors and rejects conflicting identity carriers', () => {
    const appServer = { provider: 'codex-app-server', sessionId: 'app-session', generation: 'app-generation' } as const;
    const cli = { provider: 'codex-cli', sessionId: 'cli-session', generation: 'cli-generation' } as const;
    assert.deepEqual(resolveRepairPredecessor({ agentResult: { executor: appServer, sessionId: appServer.sessionId } }), appServer);
    const appBinding = createRepairAttemptBinding({ history: [], agentResult: { executor: appServer, sessionId: appServer.sessionId } }, routineExecution);
    assert.equal(appBinding.freshExecutor, false);
    assert.deepEqual(appBinding.predecessorExecutor, appServer);
    assert.equal(appBinding.runtimeGeneration, appServer.generation);
    const cliBinding = createRepairAttemptBinding({ history: [], agentResult: { executor: cli, sessionId: cli.sessionId } }, routineExecution);
    assert.equal(cliBinding.freshExecutor, false);
    const generationlessCliBinding = createRepairAttemptBinding({ history: [], agentResult: { executor: { provider: 'codex-cli', sessionId: 'legacy-cli' } } }, routineExecution);
    assert.equal(generationlessCliBinding.freshExecutor, false);
    assert.throws(() => createRepairAttemptBinding({ history: [], executor: cli, agentResult: { executor: appServer } }, routineExecution), /identities disagree/);
    assert.throws(() => createRepairAttemptBinding({ history: [], agentResult: { executor: cli, sessionId: 'other-session' } }, routineExecution), /session disagrees/);
  });

  it('accepts only closed repair handoff JSON records and explicit identity keys', () => {
    const base = { admissionHistoryIndex: 0, startFixHistoryIndex: 1,
      outcome: { kind: 'executor', identity: { provider: 'codex-cli', sessionId: 'thread', generation: 'g1' } } };
    assert.equal(isRepairHandoffRecord(base), true);
    assert.equal(isRepairHandoffRecord({ ...base, extra: true }), false);
    assert.equal(isRepairHandoffRecord({ ...base, outcome: { ...base.outcome, extra: true } }), false);
    assert.equal(isRepairHandoffRecord({ ...base, outcome: { kind: 'executor', identity: { ...base.outcome.identity, extra: true } } }), false);
    assert.equal(isRepairHandoffRecord({ ...base, outcome: { kind: 'sessionless', provider: 'worker-router', identity: {} } }), false);
    assert.equal(isRepairHandoffRecord({ ...base, outcome: [] }), false);
  });

  it('rejects a handbuilt nonfresh generationless App Server binding before start_fix is appended', () => {
    const appServer = { provider: 'codex-app-server', sessionId: 'legacy-app-session' } as const;
    let run = createRun(TARGET, T0, 'handbuilt-generationless-binding', routineExecution, undefined, authority);
    run = applyTransition(run, { type: 'start' }, T0);
    run = applyTransition(run, { type: 'agent_succeeded', agentResult: { ...successResult(HEAD), executor: appServer, sessionId: appServer.sessionId }, headSha: HEAD }, T0);
    run = applyTransition(run, { type: 'validation_passed', validationResult: validationPassed(HEAD), pullRequest: { number: 7, headSha: HEAD } }, T0);
    run = { ...run, executor: appServer };
    run = applyTransition(run, { type: 'changes_requested', reviewResult: changesRequested('reviewer', HEAD) }, T0, TEST_VALIDATION_AUTHORITY);
    const execution = { ...routineExecution, executor: 'codex-cli' };
    const receipt = createRepairAdmissionSnapshot(authority, 'review_blocking', HEAD, 7, execution, T0);
    const attemptBinding = {
      admissionIndex: 0,
      startFixHistoryIndex: run.history.length,
      predecessorExecutor: appServer,
      predecessorSessionId: appServer.sessionId,
      freshExecutor: false,
      runtimeGeneration: 'repair-generation',
    };
    const admission = { ...receipt, attemptBinding };
    assert.equal(isRepairAdmissionSnapshot(admission), false);
    assert.throws(() => applyTransition(run, { type: 'start_fix', repairAdmission: admission }, T0),
      (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'invalid-repair-admission');
    assert.equal(run.history.some((event) => event.type === 'start_fix'), false, 'invalid binding never changes the source Run');
  });

  it('rejects conflicting predecessor session carriers on a fresh binding without changing the Run', () => {
    const predecessor = { provider: 'claude-code', sessionId: 'previous-thread' } as const;
    const execution = { ...routineExecution, executor: 'luna-isolated', model: 'gpt-5.6-luna' };
    let run = createRun(TARGET, T0, 'fresh-conflicting-predecessor-session', routineExecution, undefined, authority);
    run = applyTransition(run, { type: 'start' }, T0);
    run = applyTransition(run, { type: 'agent_succeeded', headSha: HEAD,
      agentResult: { ...successResult(HEAD), executor: predecessor, sessionId: predecessor.sessionId } }, T0);
    run = applyTransition(run, { type: 'validation_passed', validationResult: validationPassed(HEAD), pullRequest: { number: 7, headSha: HEAD } }, T0);
    run = applyTransition(run, { type: 'changes_requested', reviewResult: changesRequested('reviewer', HEAD) }, T0, TEST_VALIDATION_AUTHORITY);
    const original = run;
    const receipt = createRepairAdmissionSnapshot(authority, 'review_blocking', HEAD, 7, execution, T0);
    const binding = createRepairAttemptBinding(run, execution);
    assert.equal(binding.freshExecutor, true);
    const forgedAdmission = { ...receipt, attemptBinding: { ...binding, predecessorSessionId: 'conflicting-thread' } };
    assert.equal(isRepairAdmissionSnapshot(forgedAdmission), false);
    assert.throws(() => applyTransition(run, { type: 'start_fix', repairAdmission: forgedAdmission }, T0),
      (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'invalid-repair-admission');
    assert.deepEqual(run, original, 'a forged fresh binding never appends start_fix or mutates its predecessor');
  });

  it('survives restart, participates in CAS, and cannot be retroactively removed', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-repair-admission-'));
    try {
      const store = new JsonFileStore({ dir });
      const initial = createRun(TARGET, '2026-09-20T00:00:00.000Z', 'repair-admission', undefined, undefined, authority);
      store.create(initial);
      const snapshot = createRepairAdmissionSnapshot(authority, 'review_blocking', HEAD, 7, routineExecution, '2026-09-20T00:00:01.000Z');
      const admitted = { ...initial, repairAdmissions: [snapshot] };
      assert.equal(store.updateIfUnchanged(initial, admitted), true);
      assert.deepEqual(new JsonFileStore({ dir }).read(initial.id)?.repairAdmissions, [snapshot]);
      assert.equal(store.updateIfUnchanged(initial, { ...initial, repairAdmissions: [] }), false);
      assert.throws(() => store.update({ ...admitted, repairAdmissions: [] }), /append-only/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads legacy Run JSON with no task-shape authority or admission ledger', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-repair-legacy-'));
    try {
      const store = new JsonFileStore({ dir });
      store.create(createRun(TARGET, '2026-09-20T00:00:00.000Z', 'legacy'));
      const legacy = new JsonFileStore({ dir }).read('legacy');
      assert.equal(legacy?.repairTaskShapeAuthority, undefined);
      assert.equal(legacy?.repairAdmissions, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts only strict revisioned JSON authority at the unattended boundary', () => {
    assert.deepEqual(parseRepairTaskShapeAuthority('{"revision":"task-shape-v1","shape":"bounded"}'), authority);
    assert.throws(() => parseRepairTaskShapeAuthority('{"revision":"task-shape-v1","shape":"bounded","prose":"small fix"}'), /strict JSON/);
    assert.throws(() => parseRepairTaskShapeAuthority('small fix'), /valid JSON/);
  });
});
