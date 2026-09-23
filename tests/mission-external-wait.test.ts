import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { normalizeWaitObservation } from '../src/domain/wait.js';
import {
  ExternalMissionStore,
  createExternalMissionState,
  parseArgvJson,
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
    probeArgv: ['probe-tool'],
    wakeArgv: ['wake-tool'],
    pollIntervalMs: 250,
    probeTimeoutMs: 1_000,
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

  it('validates argv vectors and never treats them as shell text', () => {
    assert.deepEqual(parseArgvJson('["gh","run","view","123"]', '--probe-argv'), ['gh', 'run', 'view', '123']);
    assert.deepEqual(parseArgvJson('["echo $(touch /tmp/nope)"]', '--probe-argv'), ['echo $(touch /tmp/nope)']);
    assert.throws(() => validateExternalMissionConfig({ id: 'bad id', probeArgv: ['probe'], wakeArgv: [], pollIntervalMs: 250, probeTimeoutMs: 1000 }), /Mission id/);
  });
});
