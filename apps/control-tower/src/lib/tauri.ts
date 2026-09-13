import { invoke } from '@tauri-apps/api/core';
import type { ControlTowerSnapshot } from '../../../../src/operational/read-model.js';

export async function collectLiveSnapshot(): Promise<ControlTowerSnapshot> {
  const snapshot = await invoke<unknown>('collect_control_tower_snapshot');
  if (typeof snapshot !== 'object' || snapshot === null || !Array.isArray((snapshot as { rows?: unknown }).rows) || typeof (snapshot as { system?: unknown }).system !== 'object') {
    throw new Error('native collector returned an invalid read-model envelope');
  }
  return snapshot as ControlTowerSnapshot;
}
