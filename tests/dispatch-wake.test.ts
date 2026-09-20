import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { createDispatchWakeWaiter, dispatchWakePath, signalDispatchWake } from '../src/dispatch/wake.js';

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
});
