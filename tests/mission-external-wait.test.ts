import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { normalizeWaitObservation } from '../src/domain/wait.js';
import {
  ExternalMissionStore,
  createExternalMissionState,
  parseArgvJson,
  startExternalMission,
  superviseExternalMissionAsync,
  validateExternalMissionConfig,
} from '../src/mission/external-wait.js';

const tempDirs: string[] = [];

function missionStore(): ExternalMissionStore {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-mission-wait-'));
  tempDirs.push(directory);
  const store = new ExternalMissionStore(directory, 'desktop-followup-47');
  const config = validateExternalMissionConfig({
    id: 'desktop-followup-47',
    generation: 'generation-1',
    owner: 'operator@example.test',
    sessionId: '01234567-89ab-cdef-0123-456789abcdef',
    worktree: path.resolve(process.cwd()),
    cwd: path.resolve(process.cwd()),
    probeArgv: ['probe-tool'],
    wakeArgv: ['wake-tool'],
    pollIntervalMs: 250,
    probeTimeoutMs: 1_000,
    overallTimeoutMs: 1_000,
    onTimeout: 'continue',
  });
  store.write(createExternalMissionState(config));
  return store;
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('standalone external mission wait', () => {
  it('coalesces several unchanged active polls and creates one durable receipt and callback at completion', async () => {
    const store = missionStore();
    let probes = 0;
    let callbacks = 0;
    let receiptId: string | undefined;
    const observe = (config: NonNullable<ReturnType<ExternalMissionStore['read']>>['config']) => {
      probes += 1;
      return normalizeWaitObservation({
        source: 'subprocess', subjectId: config.id, observedAt: new Date(1_000 + probes).toISOString(),
        snapshot: probes < 4
          ? { status: 'active', items: 2, turns: 1 }
          : { status: 'completed', items: 2, turns: 1 },
      });
    };
    const wake = (_config: unknown, _store: ExternalMissionStore, receipt: { id: string }) => { callbacks += 1; receiptId = receipt.id; };
    const sleep = async (milliseconds: number) => { assert.equal(milliseconds, 250); };

    await superviseExternalMissionAsync(store, { observe, wake, sleep, maxPolls: 3 });
    assert.equal(probes, 3);
    assert.equal(callbacks, 0);
    assert.equal(store.read()?.receipt, null);
    assert.equal(store.read()?.probeCount, 3);

    // A process restart resumes from the durable active baseline and sees one boundary.
    await superviseExternalMissionAsync(store, { observe, wake, sleep, maxPolls: 3 });
    const completed = store.read();
    assert.equal(probes, 4);
    assert.equal(callbacks, 1);
    assert.equal(completed?.status, 'completed');
    assert.equal(completed?.receipt?.reason, 'completion');
    assert.equal(completed?.receipt?.id, receiptId);
    assert.equal(completed?.callback, 'delivered');

    // Reentry after delivery is read-only with respect to the probe and callback.
    await superviseExternalMissionAsync(store, { observe, wake, sleep, maxPolls: 1 });
    assert.equal(probes, 4);
    assert.equal(callbacks, 1);
  });

  it('retries callback delivery with the same idempotency key after a callback failure', async () => {
    const store = missionStore();
    const keys: string[] = [];
    let callbackAttempts = 0;
    const observe = (config: { id: string }) => normalizeWaitObservation({
      source: 'subprocess', subjectId: config.id, observedAt: new Date().toISOString(), snapshot: { status: 'blocked' },
    });
    await superviseExternalMissionAsync(store, {
      observe,
      wake: (_config, _store, receipt) => { keys.push(receipt.id); callbackAttempts += 1; if (callbackAttempts === 1) throw new Error('transient callback failure'); },
    });
    assert.equal(store.read()?.callback, 'failed');
    await superviseExternalMissionAsync(store, { observe, wake: (_config, _store, receipt) => { keys.push(receipt.id); } });
    assert.equal(store.read()?.callback, 'delivered');
    assert.equal(keys[0], keys[1]);
  });

  it('emits one durable failure receipt and wake at a failed status transition', async () => {
    const store = missionStore();
    let callbacks = 0;
    let receiptReason: string | undefined;
    await superviseExternalMissionAsync(store, {
      observe: (config) => normalizeWaitObservation({ source: 'subprocess', subjectId: config.id, observedAt: new Date().toISOString(), snapshot: { status: 'failed', evidence: [{ kind: 'failure', detail: 'worker exited unsuccessfully' }] } }),
      wake: (_config, _store, receipt) => { callbacks += 1; receiptReason = receipt.reason; },
    });
    await superviseExternalMissionAsync(store, { observe: () => assert.fail('failed receipt replay must not probe') });
    assert.equal(callbacks, 1);
    assert.equal(receiptReason, 'failure');
    assert.equal(store.read()?.receipt?.status, 'failed');
    assert.equal(store.read()?.callback, 'delivered');
  });

  it('holds the writer lock across persistence and spawn so child writes start only afterward', async () => {
    const store = missionStore();
    const config = store.read()!.config;
    let childAttempt: Promise<void> | undefined;
    const result = startExternalMission(store, config, () => {
      const started = store.read()!;
      assert.equal(started.status, 'starting');
      assert.equal(started.receipt, null);
      childAttempt = superviseExternalMissionAsync(store);
    });
    assert.equal(result.started, true);
    await assert.rejects(childAttempt!, /already owns/);
    await superviseExternalMissionAsync(store, {
      observe: (mission) => normalizeWaitObservation({ source: 'subprocess', subjectId: mission.id, observedAt: new Date().toISOString(), snapshot: { status: 'completed' } }),
      wake: () => undefined,
    });
    assert.equal(store.read()?.status, 'completed');
    assert.equal(store.read()?.receipt?.id, `mission-receipt:${config.id}:${config.generation}`);
  });

  it('Codex callback durably claims a receipt before launching one resumptive turn', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-codex-wake-'));
    tempDirs.push(directory);
    const fakeCodex = path.join(directory, 'codex');
    const calls = path.join(directory, 'codex-calls.jsonl');
    writeFileSync(fakeCodex, '#!/usr/bin/env node\nimport fs from "node:fs"; const args=process.argv.slice(2); fs.appendFileSync(process.env.FAKE_CODEX_CALLS, JSON.stringify(args) + "\\n"); if (fs.readFileSync(process.env.FAKE_CODEX_CALLS, "utf8").trim().split("\\n").length===1) process.exit(4); console.log(JSON.stringify({type:"turn.started",thread_id:"thread-test",turn_id:"turn-test"})); setTimeout(() => console.log("FAKE_CODEX_FINISHED"), 1500);\n');
    chmodSync(fakeCodex, 0o700);
    const callback = path.resolve('scripts/mission-codex-wake.mjs');
    const claimDirectory = path.join(directory, 'claims');
    const env = {
      ...process.env,
      TACHIKO_MISSION_RECEIPT_ID: 'mission-receipt:desktop-followup-47:generation-1',
      TACHIKO_MISSION_RECEIPT_PATH: path.join(directory, 'receipt.json'),
      TACHIKO_MISSION_ID: 'desktop-followup-47',
      TACHIKO_MISSION_OWNER: 'operator@example.test',
      TACHIKO_MISSION_SESSION_ID: '01234567-89ab-cdef-0123-456789abcdef',
      TACHIKO_MISSION_WORKTREE: path.resolve(process.cwd()),
      TACHIKO_MISSION_CWD: path.resolve(process.cwd()),
      TACHIKO_MISSION_CLAIM_DIR: claimDirectory,
      TACHIKO_CODEX_BIN: fakeCodex,
      FAKE_CODEX_CALLS: calls,
    };
    assert.throws(() => execFileSync(process.execPath, [callback], { env, stdio: 'ignore', timeout: 5_000 }));
    assert.equal(existsSync(path.join(claimDirectory, `${createHash('sha256').update(env.TACHIKO_MISSION_RECEIPT_ID).digest('hex')}.claimed.json`)), false);
    execFileSync(process.execPath, [callback], { env, timeout: 5_000 });
    execFileSync(process.execPath, [callback], { env, timeout: 1_000 });
    for (let attempt = 0; attempt < 30 && !existsSync(calls); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    const entries = readFileSync(calls, 'utf8').trim().split('\n');
    assert.equal(entries.length, 2);
    assert.equal(JSON.parse(entries[0]!)[0], 'exec');
    assert.equal(JSON.parse(entries[0]!)[1], 'resume');
    assert.equal(JSON.parse(entries[1]!)[2], '--json');
    assert.equal(JSON.parse(entries[1]!)[3], '01234567-89ab-cdef-0123-456789abcdef');
    const key = createHash('sha256').update(env.TACHIKO_MISSION_RECEIPT_ID).digest('hex');
    const stdoutPath = path.join(claimDirectory, 'logs', `${key}.stdout.log`);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        if (readFileSync(stdoutPath, 'utf8').includes('FAKE_CODEX_FINISHED')) break;
      } catch { /* Detached Codex process has not created the log yet. */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.match(readFileSync(stdoutPath, 'utf8'), /FAKE_CODEX_FINISHED/);
  });

  it('validates argv vectors and never treats them as shell text', () => {
    assert.deepEqual(parseArgvJson('["gh","run","view","123"]', '--probe-argv'), ['gh', 'run', 'view', '123']);
    assert.deepEqual(parseArgvJson('["echo $(touch /tmp/nope)"]', '--probe-argv'), ['echo $(touch /tmp/nope)']);
    assert.throws(() => validateExternalMissionConfig({ id: 'bad id', owner: 'o', sessionId: 's', worktree: process.cwd(), cwd: process.cwd(), probeArgv: ['probe'], wakeArgv: [], pollIntervalMs: 250, probeTimeoutMs: 1000, overallTimeoutMs: 1000, onTimeout: 'continue' }), /Mission id/);
  });

  it('fails closed when an existing mission id is rebound to another callback or worktree identity', () => {
    const store = missionStore();
    const original = store.read()!.config;
    assert.throws(() => startExternalMission(store, { ...original, sessionId: 'another-session' }, () => assert.fail('must not launch')), /different durable wait configuration/);
    assert.throws(() => startExternalMission(store, { ...original, worktree: `${original.worktree}-other` }, () => assert.fail('must not launch')), /different durable wait configuration/);
  });

  it('continues model-free after elapsed deadlines or emits one policy timeout receipt', async () => {
    const continuing = missionStore();
    const initial = continuing.read()!;
    continuing.write({ ...initial, deadlineAt: new Date(0).toISOString() });
    let probes = 0;
    const now = () => 10_000;
    await superviseExternalMissionAsync(continuing, {
      now,
      observe: (config) => { probes += 1; return normalizeWaitObservation({ source: 'subprocess', subjectId: config.id, observedAt: new Date(10_000 + probes).toISOString(), snapshot: { status: 'active' } }); },
      wake: () => assert.fail('continue timeout must not wake'),
      sleep: async () => undefined,
      maxPolls: 2,
    });
    assert.equal(probes, 2);
    assert.equal(continuing.read()?.timeoutCount, 1);
    assert.equal(continuing.read()?.receipt, null);

    const policyStore = missionStore();
    const policy = validateExternalMissionConfig({ ...policyStore.read()!.config, generation: 'policy-gen', onTimeout: 'policy-action' });
    policyStore.write({ ...createExternalMissionState(policy), deadlineAt: new Date(0).toISOString() });
    const receipts: string[] = [];
    await superviseExternalMissionAsync(policyStore, {
      now,
      observe: (config) => normalizeWaitObservation({ source: 'subprocess', subjectId: config.id, observedAt: new Date(10_000).toISOString(), snapshot: { status: 'active' } }),
      wake: (_config, _store, receipt) => { receipts.push(receipt.id); },
    });
    await superviseExternalMissionAsync(policyStore, { now, observe: () => assert.fail('receipt replay must not probe'), wake: (_config, _store, receipt) => { receipts.push(receipt.id); } });
    assert.equal(receipts.length, 1);
    assert.equal(policyStore.read()?.receipt?.reason, 'timeout-policy');
    assert.equal(policyStore.read()?.receipt?.status, 'active');
  });
});
