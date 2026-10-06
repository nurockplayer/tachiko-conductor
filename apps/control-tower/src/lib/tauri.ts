import { invoke } from '@tauri-apps/api/core';
import type { ControlTowerSnapshot } from '../../../../src/operational/read-model.js';

export type NativeSnapshotInvoke = () => Promise<unknown>;

function parseSnapshot(snapshot: unknown): ControlTowerSnapshot {
  if (typeof snapshot !== 'object' || snapshot === null || !Array.isArray((snapshot as { rows?: unknown }).rows) || typeof (snapshot as { system?: unknown }).system !== 'object') {
    throw new Error('native collector returned an invalid read-model envelope');
  }
  return snapshot as ControlTowerSnapshot;
}

export function createSingleFlightCollector(invokeSnapshot: NativeSnapshotInvoke): () => Promise<ControlTowerSnapshot> {
  let pending: Promise<ControlTowerSnapshot> | undefined;
  return (): Promise<ControlTowerSnapshot> => {
    if (pending) return pending;
    pending = invokeSnapshot().then(parseSnapshot).finally(() => { pending = undefined; });
    return pending;
  };
}

export const collectLiveSnapshot = createSingleFlightCollector(() => invoke<unknown>('collect_control_tower_snapshot'));
