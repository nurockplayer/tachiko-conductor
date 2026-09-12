import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { applyTransition, isValidationFresh } from '../src/domain/state-machine.js';
import type { Run, ValidationResult } from '../src/domain/types.js';
import { isValidationResultCoherent } from '../src/domain/validation.js';
import { JsonFileStore } from '../src/store/json-file-store.js';
import { evaluateHostedCheckPolicy } from '../src/validation/hosted-policy.js';
import { ConfiguredLocalValidationAdapter } from '../src/validation/local-command.js';
import { T0, TARGET, approval, validationPassed } from './helpers.js';

const H = 'a'.repeat(40);
const H2 = 'b'.repeat(40);
const dirs: string[] = [];

function seed(overrides: Partial<Run> = {}): Run {
  return {
    id: 'c20-seed', state: 'IMPLEMENTING', target: TARGET, headSha: H,
    pullRequest: { number: 7, headSha: H }, createdAt: T0, updatedAt: T0, history: [],
    ...overrides,
  };
}

function evidence(): ValidationResult {
  return validationPassed(H);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('C20-e476-v1 Steward regression seed', () => {
  it('F02 reads and lists historical gate_passed records without rewriting them', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-c20-legacy-'));
    dirs.push(dir);
    const legacy = {
      ...seed({ id: 'legacy', state: 'MERGE_READY' }),
      history: [{ type: 'gate_passed', from: 'FINAL_GATE', to: 'MERGE_READY', at: T0 }],
    };
    const file = path.join(dir, 'legacy.json');
    const bytes = `${JSON.stringify(legacy)}\n`;
    writeFileSync(file, bytes, 'utf8');
    const store = new JsonFileStore({ dir });
    assert.deepEqual(store.read('legacy'), legacy);
    assert.equal(store.list().length, 1);
    assert.equal(readFileSync(file, 'utf8'), bytes);
  });

  it('F03 rejects implementation success without the accepted same-PR exact-head tuple', () => {
    assert.throws(() => applyTransition(seed(), {
      type: 'agent_succeeded', headSha: H2,
      agentResult: { exitStatus: 'success', summary: 'fixed', headSha: H2 },
    }, T0));
  });

  it('F05 treats missing named required evidence as unknown for pending and failing subsets', () => {
    for (const overall of ['pending', 'failing'] as const) {
      assert.equal(evaluateHostedCheckPolicy({
        overall, observedCheckNames: ['ci'],
        policy: { mode: 'required', requiredCheckNames: ['ci', 'security'] },
      }), 'unknown');
    }
  });

  it('F06 rejects a public approval without complete validation admission', () => {
    assert.throws(() => applyTransition(
      seed({ state: 'REVIEWING' }),
      { type: 'review_approved', reviewResult: approval('probe', H) },
      T0,
    ));
  });

  it('F06 rejects freshness for a different accepted PR at the same head and policy', () => {
    assert.equal(isValidationFresh(
      seed({ pullRequest: { number: 8, headSha: H }, validationResult: evidence() }),
      {
        local: { kind: 'configured', revision: 'test-config-v1' },
        hosted: { kind: 'configured', mode: 'required', revision: 'test-hosted-policy-v1' },
      },
    ), false);
  });

  it('F07 rejects an empty local command plan or emits coherent non-passing evidence', async () => {
    let result;
    try {
      result = await new ConfiguredLocalValidationAdapter({ revision: 'local-v1', commands: [] })
        .validate({ target: TARGET, headSha: H });
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.match(error.message, /command|configuration|validation plan|empty/i);
      return;
    }
    assert.notEqual(result.status, 'passed');
    assert.equal(isValidationResultCoherent({
      headSha: H, status: 'unknown', local: result,
      hosted: {
        status: 'passed', observedAt: T0, pullRequestNumber: 7,
        availability: 'available', overall: 'passing', policyRevision: 'host-v1',
        policyMode: 'required', requiredCheckNames: ['ci'], observedCheckNames: ['ci'],
      },
    }), true);
  });
});
