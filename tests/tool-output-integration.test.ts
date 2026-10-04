import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, appendFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { FileToolOutputStore, InMemoryToolOutputStore, readToolOutput, searchToolOutput, type ToolOutputStore, type ToolOutputEnvelope } from '../src/evidence/tool-output.js';
import { NodeProcessRunner } from '../src/github/transport.js';

function abortOnReadyStore(controller: AbortController): InMemoryToolOutputStore {
  const store = new InMemoryToolOutputStore();
  const start = store.startCapture.bind(store);
  let observed = '';
  store.startCapture = (policy) => {
    const writer = start(policy);
    return {
      write(channel, chunk) {
        writer.write(channel, chunk);
        observed = (observed + chunk).slice(-256);
        if (observed.includes('READY')) controller.abort();
      },
      finish: () => writer.finish(),
      abort: () => writer.abort?.(),
    };
  };
  return store;
}

/** Observe fixture exit without ever signalling a PID that could have been reused. */
async function waitForFixtureExit(identityPath: string): Promise<void> {
  const deadline = Date.now() + 6_000;
  while (!existsSync(identityPath) && Date.now() < deadline) await delay(25);
  assert.ok(existsSync(identityPath), `Fixture identity was not published; retained ${identityPath}`);
  const identity = JSON.parse(readFileSync(identityPath, 'utf8')) as { pid: number; startTicks?: string };
  assert.ok(Number.isSafeInteger(identity.pid) && identity.pid > 0);
  if (process.platform === 'linux') assert.match(identity.startTicks ?? '', /^\d+$/);
  while (Date.now() < deadline) {
    try {
      if (process.platform === 'linux') {
        const stat = readFileSync(`/proc/${identity.pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
        assert.match(fields[19] ?? '', /^\d+$/);
        // A zombie has exited; a different start time is a different process.
        if (fields[0] === 'Z' || fields[0] === 'X' || fields[19] !== identity.startTicks) return;
      } else {
        // Signal 0 only probes existence. Never send TERM/KILL to this PID.
        process.kill(identity.pid, 0);
      }
    } catch (error) {
      if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
      throw error;
    }
    await delay(25);
  }
  assert.fail(`Fixture exit remains unproven; retained ${identityPath}`);
}

describe('bounded output integration', () => {
  it('attaches bounded evidence to a real command while retaining the exact exit code', async () => {
    const store = new InMemoryToolOutputStore();
    const result = await new NodeProcessRunner({ outputStore: store, outputPolicy: { previewBytes: 64, diagnosticBytes: 256, maxDiagnostics: 4, readBytes: 128 } }).run(
      process.execPath,
      ['-e', "process.stdout.write('x'.repeat(20000)); process.stderr.write('ERROR: command failed\\\\n'); process.exitCode = 23"],
      { timeoutMs: 5_000 },
    );

    assert.equal(result.exitCode, 23);
    assert.equal(result.output?.outcome, 'failed');
    assert.equal(result.output?.overflow.truncated, true);
    assert.ok(result.output?.diagnostics.some((line) => line.includes('command failed')));
    assert.equal(result.output?.artifact?.stdoutBytes, 20_000);
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

  it('retains complete evidence beyond the old 16 MiB cap with bounded returned streams', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-large-output-'));
    try {
      const store = new FileToolOutputStore(directory);
      const size = 17 * 1024 * 1024;
      const marker = 'AFTER_FORMER_CAP';
      const result = await new NodeProcessRunner({ outputStore: store }).run(
        process.execPath,
        ['-e', `process.stdout.write('x'.repeat(${size})); process.stdout.write('\\n${marker}\\n')`],
        { timeoutMs: 10_000 },
      );
      assert.equal(result.exitCode, 0);
      assert.equal(result.output?.outcome, 'passed');
      assert.equal(result.output?.overflow.capture, false);
      assert.equal(result.output?.artifact?.stdoutBytes, size + marker.length + 2);
      assert.ok(Buffer.byteLength(result.stdout) <= 4096);
      assert.equal(readToolOutput(result.output!, store, { channel: 'stdout', offset: size }).text, `\n${marker}\n`);
      assert.equal(searchToolOutput(result.output!, store, { query: marker })[0]?.text, marker);
    } finally { rmSync(directory, { recursive: true, force: true }); }
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

  it('uses the same content digest for buffered and file-backed artifacts', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-file-output-hash-'));
    try {
      const fileStore = new FileToolOutputStore(directory);
      const bufferedStore = new InMemoryToolOutputStore();
      const fileResult = await new NodeProcessRunner({ outputStore: fileStore }).run(
        process.execPath,
        ['-e', "process.stdout.write('hash stdout'); process.stderr.write('hash stderr')"],
        { timeoutMs: 5_000 },
      );
      const bufferedResult = await new NodeProcessRunner({ outputStore: bufferedStore }).run(
        process.execPath,
        ['-e', "process.stdout.write('hash stdout'); process.stderr.write('hash stderr')"],
        { timeoutMs: 5_000 },
      );

      assert.equal(fileResult.output?.artifact?.sha256, bufferedResult.output?.artifact?.sha256);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not persist default provider-shaped output or internal command artifacts', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-no-default-capture-'));
    try {
      const transcript = '{"type":"reasoning","text":"PRIVATE_TRANSCRIPT_SENTINEL"}\n';
      const result = await new NodeProcessRunner().run(process.execPath,
        ['-e', `process.stdout.write(${JSON.stringify(transcript)})`],
        { timeoutMs: 5_000, env: { ...process.env, TACHIKO_EVIDENCE_DIR: directory } });
      assert.equal(result.stdout, transcript);
      assert.equal(result.output, undefined);
      assert.deepEqual(readdirSync(directory), []);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('preserves narrowed environment and rechecks admission at the streamed child boundary', async () => {
    const store = new InMemoryToolOutputStore();
    const order: string[] = [];
    const result = await new NodeProcessRunner({ outputStore: store }).run(process.execPath,
      ['-e', "process.stdout.write(JSON.stringify({ kept: process.env.KEPT, home: process.env.HOME }))"],
      { timeoutMs: 5_000, env: { KEPT: 'only-explicit' }, beforeSpawn() { order.push('admitted'); } });
    assert.deepEqual(order, ['admitted']);
    assert.deepEqual(JSON.parse(result.stdout), { kept: 'only-explicit' });
    const refused = new Error('admission refused');
    await assert.rejects(new NodeProcessRunner({ outputStore: store }).run(process.execPath,
      ['-e', "throw new Error('must not run')"],
      { timeoutMs: 5_000, beforeSpawn() { throw refused; } }), (error) => error === refused);
  });

  it('does not create a child or leave artifact files after admission refusal', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-output-refused-'));
    try {
      const marker = path.join(directory, 'child-started');
      const refusal = new Error('refused');
      await assert.rejects(new NodeProcessRunner({ outputStore: new FileToolOutputStore(directory) }).run(
        process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`],
        { timeoutMs: 5_000, beforeSpawn() { throw refusal; } }), (error) => error === refusal);
      assert.equal(existsSync(marker), false);
      assert.deepEqual(readdirSync(directory), []);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('preserves cancellation and start errors with explicit evidence state', async () => {
    const store = new InMemoryToolOutputStore();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(new NodeProcessRunner({ outputStore: store }).run(process.execPath,
      ['-e', 'setTimeout(() => {}, 1000)'], { timeoutMs: 5_000, signal: controller.signal }),
      (error: unknown) => {
        const value = error as { code?: string; output?: { outcome: string; exitCode: number | null } };
        assert.equal(value.code, 'ABORT_ERR');
        assert.equal(value.output?.outcome, 'cancelled');
        assert.equal(value.output?.exitCode, null);
        return true;
      });
    await assert.rejects(new NodeProcessRunner({ outputStore: store }).run('/not-a-real-executable-49', [],
      { timeoutMs: 5_000 }), (error: unknown) => {
        const value = error as { code?: string; output?: { outcome: string } };
        assert.equal(value.code, 'ENOENT');
        assert.equal(value.output?.outcome, 'unknown');
        return true;
      });
  });

  it('contains evidence-write failures without replacing the command exit code', async () => {
    const unavailable = (): never => { throw new Error('fixture storage unavailable'); };
    const store: ToolOutputStore = { save: unavailable, read: unavailable, search: unavailable, delete() {},
      startCapture() { return { write: unavailable, finish: unavailable }; } };
    const result = await new NodeProcessRunner({ outputStore: store }).run(process.execPath,
      ['-e', "process.stderr.write('ERROR: original failure'); process.exitCode = 23"], { timeoutMs: 5_000 });
    assert.equal(result.exitCode, 23);
    assert.equal(result.output?.outcome, 'failed');
    assert.equal(result.output?.artifact, null);
    assert.equal(result.output?.overflow.capture, true);
    assert.match(result.output?.diagnostics.join('\n') ?? '', /original failure/);
  });

  it('keeps file evidence private, lossless across UTF-8 ranges, and explicitly deletable', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-private-output-'));
    try {
      const store = new FileToolOutputStore(directory);
      const text = 'α中🙂é\n';
      const artifact = store.save({ stdout: text, stderr: '' });
      const names = readdirSync(directory);
      assert.equal(names.length, 2);
      for (const name of names) assert.equal(statSync(path.join(directory, name)).mode & 0o077, 0);
      assert.equal(readFileSync(path.join(directory, `${artifact.id}.stdout`), 'utf8'), text);
      let restored = ''; let offset = 0;
      while (offset < artifact.stdoutBytes) {
        const range = store.read(artifact, { channel: 'stdout', offset, length: 1 });
        restored += range.text; offset = range.nextOffset;
      }
      assert.equal(restored, text);
      store.delete(artifact);
      assert.deepEqual(readdirSync(directory), []);
      assert.throws(() => store.read(artifact, { channel: 'stdout' }));
      store.delete(artifact);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('rejects same-size file replacement and appended bytes under the original artifact identity', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-output-integrity-'));
    try {
      const store = new FileToolOutputStore(directory);
      for (const mutation of ['replace', 'append'] as const) {
        const artifact = store.save({ stdout: 'original needle\n', stderr: 'stderr\n' });
        const file = path.join(directory, `${artifact.id}.stdout`);
        if (mutation === 'replace') writeFileSync(file, 'tampered needle\n');
        else appendFileSync(file, 'extra');
        assert.throws(() => store.read(artifact, { channel: 'stdout', length: 2 }), /changed/);
        assert.throws(() => store.search(artifact, { query: 'needle' }), /changed/);
        // A read of the other channel also verifies the complete two-stream identity.
        assert.throws(() => store.read(artifact, { channel: 'stderr' }), /changed/);
        store.delete(artifact);
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('retains a numeric SIGTERM-handler exit code independently from timeout classification', { skip: process.platform === 'win32' }, async () => {
    await assert.rejects(new NodeProcessRunner({ outputStore: new InMemoryToolOutputStore() }).run(process.execPath,
      ['-e', "process.on('SIGTERM', () => { process.exitCode = 7; clearInterval(keepAlive); }); const keepAlive = setInterval(() => {}, 100); process.stdout.write('READY\\n');"],
      { timeoutMs: 1_000 }), (error: unknown) => {
        const value = error as { code?: string; output?: ToolOutputEnvelope };
        assert.equal(value.code, 'ETIMEDOUT');
        assert.equal(value.output?.outcome, 'timed_out');
        assert.equal(value.output?.exitCode, 7);
        assert.match(value.output?.stdout.preview ?? '', /READY/);
        return true;
      });
  });

  it('cancels an active command and retains its numeric SIGTERM-handler exit code', { skip: process.platform === 'win32' }, async () => {
    const controller = new AbortController();
    const store = abortOnReadyStore(controller);
    await assert.rejects(new NodeProcessRunner({ outputStore: store }).run(process.execPath,
      ['-e', "process.on('SIGTERM', () => { process.exitCode = 9; clearInterval(keepAlive); }); const keepAlive = setInterval(() => {}, 100); process.stdout.write('READY\\n');"],
      { timeoutMs: 5_000, signal: controller.signal }), (error: unknown) => {
        const value = error as { code?: string; output?: ToolOutputEnvelope };
        assert.equal(value.code, 'ABORT_ERR');
        assert.equal(value.output?.outcome, 'cancelled');
        assert.equal(value.output?.exitCode, 9);
        assert.match(value.output?.stdout.preview ?? '', /READY/);
        return true;
      });
  });

  for (const reason of ['timeout', 'cancel'] as const) {
    it(`bounds ${reason} cleanup when the owned child ignores SIGTERM`, { skip: process.platform === 'win32' }, async () => {
      const controller = new AbortController();
      const store = reason === 'cancel' ? abortOnReadyStore(controller) : new InMemoryToolOutputStore();
      const started = Date.now();
      await assert.rejects(new NodeProcessRunner({ outputStore: store }).run(process.execPath,
        ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 100); process.stdout.write('READY\\n');"],
        { timeoutMs: reason === 'timeout' ? 1_000 : 5_000, signal: controller.signal }), (error: unknown) => {
          const value = error as { code?: string; output?: ToolOutputEnvelope };
          assert.equal(value.code, reason === 'cancel' ? 'ABORT_ERR' : 'ETIMEDOUT');
          assert.equal(value.output?.outcome, reason === 'cancel' ? 'cancelled' : 'timed_out');
          assert.equal(value.output?.exitCode, null);
          assert.match(value.output?.stdout.preview ?? '', /READY/);
          return true;
        });
      assert.ok(Date.now() - started < 4_000);
    });
  }

  it('bounds inherited-pipe waits and marks forced capture incomplete without claiming tree quiescence', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-held-pipe-fixture-'));
    const identityPath = path.join(directory, 'grandchild.json');
    const grandchild = String.raw`const fs = require('node:fs');
      const identity = { pid: process.pid };
      if (process.platform === 'linux') {
        const stat = fs.readFileSync('/proc/self/stat', 'utf8');
        identity.startTicks = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[19];
      }
      process.stdout.on('error', () => process.exit(0));
      setTimeout(() => process.exit(0), 4000);
      fs.writeFileSync(${JSON.stringify(identityPath + '.tmp')}, JSON.stringify(identity), { flag: 'wx', mode: 0o600 });
      fs.renameSync(${JSON.stringify(identityPath + '.tmp')}, ${JSON.stringify(identityPath)});
      setInterval(() => process.stdout.write('held-pipe\n'), 50);`;
    try {
      const fixture = `const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: ['ignore', 'inherit', 'inherit'] }); child.unref(); process.stdout.write('READY\\n');`;
      const started = Date.now();
      await assert.rejects(new NodeProcessRunner({ outputStore: new InMemoryToolOutputStore() }).run(process.execPath,
        ['-e', fixture], { timeoutMs: 1_000 }), (error: unknown) => {
          const value = error as { code?: string; output?: ToolOutputEnvelope; directChildExitObserved?: boolean };
          assert.equal(value.code, 'ECHILD_CLEANUP_UNPROVEN');
          assert.equal(value.directChildExitObserved, true);
          assert.equal(value.output?.outcome, 'timed_out');
          assert.equal(value.output?.exitCode, 0);
          assert.equal(value.output?.overflow.capture, true);
          return true;
        });
      assert.ok(Date.now() - started < 3_500);
    } finally {
      // Product latency/refusal above is independent of this fixture's cleanup.
      // Keep the identity file on failure so the outer job guard can report it.
      await waitForFixtureExit(identityPath);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
