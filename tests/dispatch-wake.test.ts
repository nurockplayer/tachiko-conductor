import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { createDispatchWakeWaiter, dispatchWakePath, signalDispatchWake } from '../src/dispatch/wake.js';
import { MissionAdmissionRegistry, type AdmissionConfig } from '../src/mission-admission/registry.js';
import { dispatchContinuously } from '../src/dispatch/continuous.js';
import type { DispatchOnceResult } from '../src/dispatch/runner.js';
import { createHostAdmissionRegistry } from '../src/mission-admission/host-registry.js';

const admissionConfig: AdmissionConfig = { schemaVersion: 1, revision: 'wake-test-v1', limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } };

describe('dispatch wake signal', () => {
  it('requires an absolute path and creates a coalescible wake token outside the repository', async () => {
    assert.throws(() => dispatchWakePath({ TACHIKO_DISPATCH_WAKE_PATH: 'relative' }), /absolute path/);
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-dispatch-wake-'));
    const wakePath = path.join(directory, 'dispatch', 'wake');
    try {
      const wait = createDispatchWakeWaiter(wakePath);
      const token = signalDispatchWake(wakePath);
      await wait(1_000);
      assert.match(token, /^[0-9a-f-]{36}$/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('publishes a release before waking one serial reconciliation', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-dispatch-release-wake-'));
    const wakePath = path.join(directory, 'dispatch', 'wake');
    const registryPath = path.join(directory, 'host', 'registry.json');
    try {
      const registry = new MissionAdmissionRegistry({
        filePath: registryPath,
        config: admissionConfig,
        onPublishedTransition: () => { signalDispatchWake(wakePath); },
      });
      const owner = registry.admit({ laneId: 'owner', role: 'production_captain', evidence: { repository: 'acme/widgets', issue: 1 } });
      assert.equal(owner.outcome, 'admitted');
      if (owner.outcome !== 'admitted') throw new Error('expected active owner');
      const wait = createDispatchWakeWaiter(wakePath);
      let reconciliations = 0;
      const idle: DispatchOnceResult = { outcome: 'no_eligible_work', reasons: [] };
      const result = await dispatchContinuously({
        dispatchOnce: async () => { reconciliations += 1; return idle; },
        sleep: async (milliseconds) => {
          assert.equal(reconciliations, 1);
          registry.release(owner.token, true);
          assert.equal(JSON.parse(readFileSync(registryPath, 'utf8')).revision, registry.snapshot().revision);
          await wait(milliseconds);
        },
        idlePollMs: 1_000,
        maxCycles: 2,
      });
      assert.equal(result.cycles, 2);
      assert.equal(reconciliations, 2, 'one release transition should trigger one reconciliation');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('wires host registry transitions to the existing dispatch wake path', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-host-admission-wake-'));
    const wakePath = path.join(directory, 'dispatch', 'wake');
    try {
      const registry = createHostAdmissionRegistry({ homeDirectory: directory, env: {
        HOME: directory,
        TACHIKO_DATA_DIR: path.join(directory, 'runs'),
        TACHIKO_DISPATCH_WAKE_PATH: wakePath,
      } });
      const result = registry.admit({ laneId: 'host-wake', role: 'production_captain', evidence: { repository: 'acme/widgets', issue: 1 } });
      assert.equal(result.outcome, 'admitted');
      assert.match(readFileSync(wakePath, 'utf8').trim(), /^[0-9a-f-]{36}$/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
