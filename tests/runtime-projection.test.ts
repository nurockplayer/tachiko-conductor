import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, it } from 'node:test';
import { operationalRuntimeProjectionPath, readOperationalRuntimeProjection, restartVerdict, setMaintenanceHold, writeOperationalRuntimeProjection } from '../src/operational/runtime-projection.js';

const dirs: string[] = []; const dir = () => { const value = mkdtempSync(path.join(os.tmpdir(), 'runtime-')); dirs.push(value); return value; };
afterEach(() => { for (const value of dirs.splice(0)) import('node:fs').then(({ rmSync }) => rmSync(value, { recursive: true, force: true })); });
const base = (overrides = {}) => ({ schemaVersion: 1 as const, updatedAt: '2026-01-01T00:00:00.000Z', supervisor: 'parked' as const, stage: 'idle', eventWakeEligible: false, maintenanceHold: { active: true }, ownership: 'none' as const, checkpoint: 'durable' as const, ...overrides });

it('derives safe restart only from no writer, durable checkpoint, and hold', () => assert.equal(restartVerdict(base()).verdict, 'SAFE TO RESTART'));
it('fails closed for active or ambiguous ownership and checkpoint', () => { assert.equal(restartVerdict(base({ ownership: 'active' })).verdict, 'WAIT FOR CURRENT CHECKPOINT'); assert.equal(restartVerdict(base({ ownership: 'ambiguous' })).verdict, 'UNKNOWN — CANNOT PROVE SAFE'); assert.equal(restartVerdict(base({ checkpoint: 'unknown' })).verdict, 'UNKNOWN — CANNOT PROVE SAFE'); });
it('fails closed for missing or malformed durable projection', () => { const value = dir(); assert.equal(readOperationalRuntimeProjection(value), null); writeOperationalRuntimeProjection(value, base()); writeFileSync(operationalRuntimeProjectionPath(value), '{bad'); assert.equal(readOperationalRuntimeProjection(value), null); });
it('hold survives reload and release is idempotent without discarding a parked manual checkpoint', () => { const value = dir(); writeOperationalRuntimeProjection(value, base({ manualLane: { repository: 'repo', worktree: '/worktree', branch: 'branch', checkpointSha: 'a'.repeat(40), clean: true, state: 'parked', recoverable: true } })); setMaintenanceHold(value, true, 't'); assert.equal(readOperationalRuntimeProjection(value)?.maintenanceHold.active, true); setMaintenanceHold(value, false, 't'); setMaintenanceHold(value, false, 't'); const restored = readOperationalRuntimeProjection(value); assert.equal(restored?.maintenanceHold.active, false); assert.equal(restored?.manualLane?.checkpointSha, 'a'.repeat(40)); });
it('writes and reloads a typed projection', () => { const value = dir(); writeOperationalRuntimeProjection(value, base()); assert.equal(readOperationalRuntimeProjection(value)?.checkpoint, 'durable'); });
