import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { applyTransition, isValidationFresh } from '../src/domain/state-machine.js';
import type { LocalValidationCommandEvidence, Run, ValidationResult } from '../src/domain/types.js';
import { isValidationResultCoherent } from '../src/domain/validation.js';
import {
  FileToolOutputStore, InMemoryToolOutputStore, boundToolOutput, readToolOutput,
  type ToolOutputEnvelope, type ToolOutputStream,
} from '../src/evidence/tool-output.js';
import { JsonFileStore } from '../src/store/json-file-store.js';
import { T0, TEST_VALIDATION_AUTHORITY, newRun, successResult, validationPassed } from './helpers.js';

const HEAD = 'a'.repeat(40);
const directories: string[] = [];
function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-validation-output-contract-'));
  directories.push(directory);
  return directory;
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function commandResult(
  outcome: LocalValidationCommandEvidence['outcome'], exitCode: number | null, output?: ToolOutputEnvelope,
): ValidationResult {
  const status = outcome === 'passed' ? 'passed' : outcome === 'failed' || outcome === 'timed_out' ? 'failed' : 'unknown';
  return {
    ...validationPassed(HEAD), status,
    local: {
      status, configRevision: 'test-config-v1',
      commands: [{ commandIndex: 0, executable: 'test', outcome, exitCode, durationMs: 1,
        ...(output === undefined ? {} : { output }) }],
    },
  };
}

function output(outcome: ToolOutputEnvelope['outcome'], exitCode: number | null): ToolOutputEnvelope {
  return boundToolOutput({ outcome, exitCode, stdout: 'fixture stdout', stderr: 'ERROR: fixture diagnostic',
    store: new InMemoryToolOutputStore(),
    policy: { previewBytes: 32, diagnosticBytes: 128, maxDiagnostics: 4, readBytes: 64 } });
}

function validatingRun(id: string): Run {
  return applyTransition(applyTransition(newRun(id), { type: 'start' }, T0),
    { type: 'agent_succeeded', agentResult: successResult(HEAD) }, T0);
}

function acceptedRun(id: string, result: ValidationResult): Run {
  return applyTransition(validatingRun(id), {
    type: result.status === 'passed' ? 'validation_passed' : 'validation_failed',
    validationResult: result, pullRequest: { number: 7, headSha: HEAD },
  }, T0);
}

/** Keep all old accounting equations coherent while corrupting one bound. */
function changedStdout(envelope: ToolOutputEnvelope, stdout: ToolOutputStream): ToolOutputEnvelope {
  const totalBytes = stdout.bytes + envelope.stderr.bytes;
  const retainedBytes = stdout.previewBytes + envelope.stderr.previewBytes;
  return {
    ...envelope, stdout,
    artifact: { ...envelope.artifact!, stdoutBytes: stdout.bytes, totalBytes },
    overflow: {
      ...envelope.overflow, totalBytes, retainedBytes, omittedBytes: Math.max(0, totalBytes - retainedBytes),
      stdout: stdout.truncated,
      truncated: envelope.overflow.capture || envelope.overflow.summary || envelope.overflow.diagnostics ||
        stdout.truncated || envelope.stderr.truncated,
    },
  };
}

function invalidAdvertisedBounds(): Array<readonly [string, ToolOutputEnvelope]> {
  const value = output('passed', 0);
  return [
    ['summary one byte over', { ...value, summary: 's'.repeat(129) }],
    ['summary large overflow', { ...value, summary: 's'.repeat(30_000) }],
    ['diagnostic byte overflow', { ...value, diagnostics: ['d'.repeat(129)] }],
    ['diagnostic count overflow', { ...value, diagnostics: ['a', 'b', 'c', 'd', 'e'] }],
    ['preview exceeds advertised budget', { ...value, overflow: { ...value.overflow, previewLimitBytes: 1 } }],
    ['preview exceeds stream bytes', changedStdout(value, { ...value.stdout, bytes: 1 })],
    ['hidden preview truncation', changedStdout(value, { ...value.stdout, preview: 'f', previewBytes: 1 })],
    ['false truncation flag', changedStdout(value, { ...value.stdout, truncated: true })],
    ['zero preview budget', { ...value, overflow: { ...value.overflow, previewLimitBytes: 0 } }],
    ['zero diagnostic budget', { ...value, overflow: { ...value.overflow, diagnosticLimitBytes: 0 } }],
    ['zero diagnostic line budget', { ...value, overflow: { ...value.overflow, diagnosticLimitLines: 0 } }],
  ];
}

describe('optional validation output contract', () => {
  it('keeps legacy validation records valid and unchanged through restart', () => {
    const dir = temporaryDirectory();
    const run = acceptedRun('legacy-output-absent', validationPassed(HEAD));
    // Optional undefined object properties (such as history.reason) are absent
    // in durable JSON; compare every field of that encoded representation.
    const expected = JSON.parse(JSON.stringify(run)) as Run;
    new JsonFileStore({ dir }).create(run);
    const file = path.join(dir, `${run.id}.json`);
    const bytes = readFileSync(file, 'utf8');
    const restored = new JsonFileStore({ dir }).read(run.id);
    assert.deepEqual(restored, expected);
    assert.equal(Object.hasOwn(restored!.validationResult!.local.commands[0]!, 'output'), false);
    assert.equal(readFileSync(file, 'utf8'), bytes);
  });

  const cases = [
    ['passed', 0, 'passed'], ['failed', 23, 'failed'], ['timed_out', 7, 'timed_out'],
    ['unavailable', null, 'unknown'], ['malformed', null, 'unknown'],
  ] as const;
  for (const [outcome, exitCode, envelopeOutcome] of cases) {
    it(`accepts coherent optional ${outcome} evidence without changing command truth`, () => {
      const result = commandResult(outcome, exitCode, output(envelopeOutcome, exitCode));
      assert.equal(isValidationResultCoherent(result), true);
      assert.equal(result.local.commands[0]?.outcome, outcome);
      assert.equal(result.local.commands[0]?.exitCode, exitCode);
    });
  }

  it('rejects mismatched output outcome or exit code rather than promoting failure', () => {
    for (const incompatible of [output('passed', 0), output('failed', 7), output('cancelled', 23)]) {
      assert.equal(isValidationResultCoherent(commandResult('failed', 23, incompatible)), false);
    }
    const failed = commandResult('failed', 23, output('failed', 23));
    assert.equal(isValidationResultCoherent({ ...failed, status: 'passed', local: { ...failed.local, status: 'passed' } }), false);
    assert.throws(() => acceptedRun('not-promoted', { ...failed, status: 'passed' }), /conflicts|requires/);
  });

  it('rejects malformed envelopes and a missing artifact disguised as complete', () => {
    const valid = output('passed', 0);
    const malformed: unknown[] = [null, {}, { ...valid, version: 'unknown' },
      { ...valid, artifact: null },
      { ...valid, stdout: { ...valid.stdout, previewBytes: -1 } }];
    for (const value of malformed) {
      assert.equal(isValidationResultCoherent(commandResult('passed', 0, value as ToolOutputEnvelope)), false);
    }
  });

  it('retains unavailable capture explicitly without changing a failed command into success', () => {
    const evidence = output('failed', 23);
    const unavailable: ToolOutputEnvelope = {
      ...evidence, artifact: null, overflow: { ...evidence.overflow, capture: true, truncated: true },
    };
    const result = commandResult('failed', 23, unavailable);
    assert.equal(isValidationResultCoherent(result), true);
    const dir = temporaryDirectory();
    const run = acceptedRun('capture-unavailable', result);
    new JsonFileStore({ dir }).create(run);
    const restored = new JsonFileStore({ dir }).read(run.id)!;
    assert.equal(restored.state, 'CHANGES_REQUESTED');
    assert.equal(restored.validationResult?.status, 'failed');
    assert.equal(restored.validationResult?.local.commands[0]?.output?.artifact, null);
    assert.equal(restored.validationResult?.local.commands[0]?.output?.overflow.capture, true);
  });

  it('does not make supplemental capture availability a new command-success authority', () => {
    const evidence = output('passed', 0);
    const unavailable: ToolOutputEnvelope = {
      ...evidence, artifact: null, overflow: { ...evidence.overflow, capture: true, truncated: true },
    };
    const result = commandResult('passed', 0, unavailable);
    assert.equal(isValidationResultCoherent(result), true);
    assert.equal(result.local.commands[0]?.exitCode, 0);
    assert.equal(result.local.commands[0]?.output?.overflow.capture, true);
  });

  it('round-trips the bounded envelope and exact HEAD/policy while the private artifact stays drillable', () => {
    const evidenceDirectory = temporaryDirectory();
    const evidence = boundToolOutput({ outcome: 'passed', exitCode: 0,
      stdout: 'complete private fixture output '.repeat(100), stderr: '',
      store: new FileToolOutputStore(evidenceDirectory),
      policy: { previewBytes: 32, diagnosticBytes: 128, maxDiagnostics: 4, readBytes: 64 } });
    const result = commandResult('passed', 0, evidence);
    const dir = temporaryDirectory();
    const run = acceptedRun('durable-output', result);
    new JsonFileStore({ dir }).create(run);
    const restored = new JsonFileStore({ dir }).read(run.id)!;
    assert.deepEqual(restored.validationResult, result);
    assert.equal(restored.validationResult?.headSha, HEAD);
    assert.equal(restored.validationResult?.local.configRevision, 'test-config-v1');
    assert.equal(isValidationFresh(restored, TEST_VALIDATION_AUTHORITY), true);
    assert.equal(isValidationFresh(restored, { ...TEST_VALIDATION_AUTHORITY,
      local: { kind: 'configured', revision: 'different-policy' } }), false);
    const recovered = restored.validationResult!.local.commands[0]!.output!;
    const range = readToolOutput(recovered, new FileToolOutputStore(evidenceDirectory), { channel: 'stdout', length: 8 });
    assert.equal(range.text, 'complete');
    assert.equal(recovered.overflow.capture, false);
    assert.equal(recovered.overflow.stdout, true);
    assert.throws(() => acceptedRun('wrong-head', { ...result, headSha: 'b'.repeat(40) }), /exact current HEAD/);
  });

  it('rejects contradictory persisted output on a fresh read without rewriting the corrupt bytes', () => {
    const dir = temporaryDirectory();
    const run = acceptedRun('output-corruption', commandResult('passed', 0, output('passed', 0)));
    new JsonFileStore({ dir }).create(run);
    const file = path.join(dir, `${run.id}.json`);
    const corrupted = JSON.parse(readFileSync(file, 'utf8'));
    corrupted.validationResult.local.commands[0].output.exitCode = 23;
    const bytes = JSON.stringify(corrupted);
    writeFileSync(file, bytes);
    assert.throws(() => new JsonFileStore({ dir }).read(run.id), /corrupt or incompatible/);
    assert.equal(readFileSync(file, 'utf8'), bytes);
  });

  it('rejects internally inconsistent advertised bounds at both coherence and persisted-read boundaries', () => {
    const dir = temporaryDirectory();
    const run = acceptedRun('invalid-advertised-bounds', commandResult('passed', 0, output('passed', 0)));
    new JsonFileStore({ dir }).create(run);
    const file = path.join(dir, `${run.id}.json`);
    for (const [label, invalid] of invalidAdvertisedBounds()) {
      assert.equal(isValidationResultCoherent(commandResult('passed', 0, invalid)), false, label);
      const corrupted = JSON.parse(JSON.stringify(run));
      corrupted.validationResult.local.commands[0].output = invalid;
      const bytes = JSON.stringify(corrupted);
      writeFileSync(file, bytes);
      assert.throws(() => new JsonFileStore({ dir }).read(run.id), /corrupt or incompatible/, label);
      assert.equal(readFileSync(file, 'utf8'), bytes, `${label}: rejected bytes are not rewritten`);
    }
  });

  it('preserves genuine producer envelopes for UTF-8 edge budgets, empty streams and explicit larger policies', () => {
    const specimens = [
      boundToolOutput({ outcome: 'passed', exitCode: 0, stdout: 'α中🙂', stderr: 'ERROR: α中🙂',
        summary: '🙂'.repeat(10), store: new InMemoryToolOutputStore(),
        policy: { previewBytes: 1, diagnosticBytes: 1, maxDiagnostics: 1, readBytes: 1 } }),
      boundToolOutput({ outcome: 'passed', exitCode: 0, stdout: '', stderr: '', store: new InMemoryToolOutputStore() }),
      boundToolOutput({ outcome: 'passed', exitCode: 0, stdout: 'x'.repeat(30_000), stderr: '', summary: 's'.repeat(30_000),
        store: new InMemoryToolOutputStore(),
        policy: { previewBytes: 32_768, diagnosticBytes: 32_768, maxDiagnostics: 4, readBytes: 32_768 } }),
    ];
    for (const evidence of specimens) {
      assert.equal(isValidationResultCoherent(commandResult('passed', 0, evidence)), true);
    }
  });

});
