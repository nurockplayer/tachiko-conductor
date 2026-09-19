import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

import { ConfiguredLocalValidationAdapter } from '../src/validation/local-command.js';
import { FileToolOutputStore, InMemoryToolOutputStore, searchToolOutput } from '../src/evidence/tool-output.js';
import { NodeProcessRunner } from '../src/github/transport.js';

const TARGET = { kind: 'issue' as const, owner: 'acme', repo: 'widgets', issueNumber: 49 };

function workspace(): { readonly path: string; readonly headSha: string } {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-output-integration-'));
  for (const args of [['init'], ['config', 'user.email', 'output@example.test'], ['config', 'user.name', 'Output'], ['add', '.'], ['commit', '-m', 'initial']]) {
    if (args[0] === 'add') writeFileSync(path.join(directory, 'README.md'), 'output\n');
    assert.equal(spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).status, 0);
  }
  return {
    path: directory,
    headSha: spawnSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
  };
}

describe('bounded output integration', () => {
  it('attaches bounded evidence to a real command while retaining the exact exit code', async () => {
    const store = new InMemoryToolOutputStore();
    const result = await new NodeProcessRunner({ outputStore: store, outputPolicy: { previewBytes: 64, diagnosticBytes: 256, maxDiagnostics: 4, readBytes: 128 } }).run(
      process.execPath,
      ['-e', "process.stdout.write('x'.repeat(20000)); process.stderr.write('ERROR: command failed\\\\n'); process.exit(23)"],
      { timeoutMs: 5_000 },
    );

    assert.equal(result.exitCode, 23);
    assert.equal(result.output?.outcome, 'failed');
    assert.equal(result.output?.overflow.truncated, true);
    assert.ok(result.output?.diagnostics.some((line) => line.includes('command failed')));
    assert.equal(result.output?.artifact.stdoutBytes, 20_000);
  });

  it('keeps bounded timeout evidence available to the caller', async () => {
    const store = new InMemoryToolOutputStore();
    await assert.rejects(
      new NodeProcessRunner({ outputStore: store }).run(
        process.execPath,
        ['-e', "process.stderr.write('ERROR: timeout evidence\\n'); setTimeout(() => {}, 1000)"],
        { timeoutMs: 200 },
      ),
      (error: unknown) => {
        const value = error as { readonly code?: unknown; readonly output?: { readonly outcome?: unknown; readonly diagnostics?: readonly string[] } };
        assert.equal(value.code, 'ETIMEDOUT');
        assert.equal(value.output?.outcome, 'timed_out');
        assert.ok(value.output?.diagnostics?.some((line) => line.includes('timeout evidence')));
        return true;
      },
    );
  });

  it('preserves explicit overflow evidence when execFile reaches its safety cap', async () => {
    const store = new InMemoryToolOutputStore();
    await assert.rejects(
      new NodeProcessRunner({ outputStore: store }).run(
        process.execPath,
        ['-e', "process.stdout.write('x'.repeat(17 * 1024 * 1024))"],
        { timeoutMs: 10_000 },
      ),
      (error: unknown) => {
        const value = error as { readonly code?: unknown; readonly output?: { readonly overflow?: { readonly capture?: boolean }; readonly artifact?: { readonly totalBytes?: number } } };
        assert.equal(value.code, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
        assert.equal(value.output?.overflow?.capture, true);
        assert.ok((value.output?.artifact?.totalBytes ?? 0) > 0);
        return true;
      },
    );
  });

  it('searches a file-backed artifact in bounded chunks with byte offsets', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-file-output-'));
    try {
      const store = new FileToolOutputStore(directory);
      const result = await new NodeProcessRunner({ outputStore: store }).run(
        process.execPath,
        ['-e', "process.stdout.write('α\\r\\nneedle here\\r\\nend\\r\\n')"],
        { timeoutMs: 5_000 },
      );
      const matches = searchToolOutput(result.output!, store, { channel: 'stdout', query: 'needle' });
      assert.deepEqual(matches, [{ channel: 'stdout', line: 2, offset: 4, text: 'needle here' }]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('records validation output without changing exact-HEAD acceptance', async () => {
    const owned = workspace();
    try {
      const store = new InMemoryToolOutputStore();
      const result = await new ConfiguredLocalValidationAdapter({
        revision: 'output-v1',
        outputStore: store,
        outputPolicy: { previewBytes: 32, diagnosticBytes: 128, maxDiagnostics: 4, readBytes: 128 },
        commands: [{
          argv: [process.execPath, '-e', "process.stdout.write('validation '.repeat(200));"],
          timeoutMs: 5_000,
        }],
      }).validate({ target: TARGET, headSha: owned.headSha, workspacePath: owned.path });

      assert.equal(result.status, 'passed');
      assert.equal(result.commands[0]?.exitCode, 0);
      assert.equal(result.commands[0]?.output?.overflow.truncated, true);
      assert.equal(result.commands[0]?.output?.exitCode, 0);
      assert.equal(spawnSync('git', ['-C', owned.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(), owned.headSha);
    } finally {
      rmSync(owned.path, { recursive: true, force: true });
    }
  });
});
