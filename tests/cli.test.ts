import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  parseIssueNumber,
  resolveRunsDir,
  runCreateCommand,
  runShowCommand,
  runShowView,
  runTransitionCommand,
} from '../src/cli.js';
import type { TransitionType } from '../src/domain/types.js';
import { JsonFileStore } from '../src/store/json-file-store.js';
import { TARGET } from './helpers.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function tempStore(): { store: JsonFileStore; dir: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-cli-'));
  return { store: new JsonFileStore({ dir }), dir };
}

describe('CLI command layer', () => {
  it('creates, shows, and transitions a run through the command functions', () => {
    const { store, dir } = tempStore();
    try {
      const created = runCreateCommand(store, 'acme', 'widgets', { issue: 42 });
      assert.equal(created.state, 'READY');
      assert.deepEqual(created.target, TARGET);

      assert.equal(runShowCommand(store, created.id).state, 'READY');

      const next = runTransitionCommand(store, created.id, 'start');
      assert.equal(next.state, 'IMPLEMENTING');
      assert.equal(runShowCommand(store, created.id).state, 'IMPLEMENTING');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails loudly for an unknown run and for an invalid transition', () => {
    const { store, dir } = tempStore();
    try {
      assert.throws(() => runShowCommand(store, 'missing'), /No run with id "missing"/);

      const created = runCreateCommand(store, 'acme', 'widgets', { issue: 1 });
      assert.throws(() => runTransitionCommand(store, created.id, 'merged'), /Invalid transition "merged" from state READY/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requires exactly one target form on run create', () => {
    const { store, dir } = tempStore();
    try {
      assert.throws(
        () => runCreateCommand(store, 'acme', 'widgets', { issue: 42, branch: 'main' }),
        /exactly one of --issue <n> or --branch <branch>/,
      );
      assert.throws(() => runCreateCommand(store, 'acme', 'widgets', {}), /exactly one of/);
      // the valid branch path is preserved
      const branchRun = runCreateCommand(store, 'acme', 'widgets', { branch: 'main' });
      assert.deepEqual(branchRun.target, { kind: 'repository', owner: 'acme', repo: 'widgets', branch: 'main' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses payload-requiring transitions with an explicit message and leaves the run unchanged', () => {
    const { store, dir } = tempStore();
    try {
      const created = runCreateCommand(store, 'acme', 'widgets', { issue: 42 });
      for (const type of ['agent_succeeded', 'agent_failed', 'review_approved', 'changes_requested'] as const) {
        assert.throws(
          () => runTransitionCommand(store, created.id, type as TransitionType),
          /requires an (agent|review)Result payload/,
        );
      }
      assert.equal(runShowCommand(store, created.id).state, 'READY');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves the data dir from TACHIKO_DATA_DIR or the home default', () => {
    assert.equal(resolveRunsDir({ TACHIKO_DATA_DIR: '/tmp/x' }), '/tmp/x');
    assert.match(resolveRunsDir({}), /\.tachiko-conductor/);
  });

  it('parses issue numbers strictly without partial parses or unsafe integers', () => {
    assert.equal(parseIssueNumber('42'), 42);
    assert.equal(parseIssueNumber('9007199254740991'), 9007199254740991); // Number.MAX_SAFE_INTEGER
    assert.throws(() => parseIssueNumber('42oops'), /Invalid --issue "42oops"/);
    assert.throws(() => parseIssueNumber('3.5'), /Invalid --issue "3.5"/);
    assert.throws(() => parseIssueNumber('0'), /safe integer >= 1/);
    assert.throws(() => parseIssueNumber('-1'), /Invalid --issue "-1"/);
    // 2^53 + 1: silently rounds to 9007199254740992, which is not safe
    assert.throws(() => parseIssueNumber('9007199254740993'), /safe integer >= 1/);
    // long digit-only input overflows to Infinity
    assert.throws(() => parseIssueNumber('999999999999999999999999999999999999'), /safe integer >= 1/);
  });

  it('shows an unresolved interrupt and hides a resolved one in run show', () => {
    const { store, dir } = tempStore();
    try {
      const created = runCreateCommand(store, 'acme', 'widgets', { issue: 42 });

      // unresolved interrupt displays normally
      runTransitionCommand(store, created.id, 'escalate', 'product decision needed');
      let run = runShowCommand(store, created.id);
      assert.deepEqual(runShowView(run).interrupt, { kind: 'needs_human', reason: 'product decision needed' });

      // human_resolved hides the interrupt in the projection but keeps the history
      runTransitionCommand(store, created.id, 'human_resolved', 'decided');
      run = runShowCommand(store, created.id);
      assert.equal(runShowView(run).interrupt, null);
      assert.equal(run.interrupt?.kind, 'needs_human');
      assert.ok(run.interrupt?.resolvedAt);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('hides a resolved dependency interrupt from run show', () => {
    const { store, dir } = tempStore();
    try {
      const created = runCreateCommand(store, 'acme', 'widgets', { issue: 42 });
      runTransitionCommand(store, created.id, 'wait_dependency', 'upstream API');
      runTransitionCommand(store, created.id, 'dependency_satisfied');
      const run = runShowCommand(store, created.id);
      assert.equal(runShowView(run).interrupt, null);
      assert.ok(run.interrupt?.resolvedAt);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('CLI end-to-end across processes', () => {
  interface CliResult {
    stdout: string;
    stderr: string;
    status: number | null;
  }

  it('creates a run in one process, then reads and advances it in fresh processes', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-cli-e2e-'));
    try {
      const env = { ...process.env, TACHIKO_DATA_DIR: dir };
      const runCli = (args: string[]): CliResult => {
        const result = spawnSync(
          process.execPath,
          ['--import', 'tsx', path.join(REPO_ROOT, 'src/cli.ts'), ...args],
          { cwd: REPO_ROOT, env, encoding: 'utf8' },
        );
        return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
      };

      const create = runCli(['run', 'create', '--owner', 'acme', '--repo', 'widgets', '--issue', '42']);
      const id = /Created run ([a-f0-9-]+)/.exec(create.stdout)?.[1];
      assert.ok(id, `expected a run id in output: ${create.stdout}`);
      assert.match(create.stdout, /"state": "READY"/);

      // Supplying both --issue and --branch is rejected.
      const both = runCli(['run', 'create', '--owner', 'acme', '--repo', 'widgets', '--issue', '42', '--branch', 'main']);
      assert.equal(both.status, 1);
      assert.match(both.stderr, /error: run create requires exactly one of/);

      const show1 = runCli(['run', 'show', id]);
      assert.match(show1.stdout, /"state": "READY"/);

      const transition = runCli(['run', 'transition', id, 'start']);
      assert.match(transition.stdout, /"state": "IMPLEMENTING"/);

      const show2 = runCli(['run', 'show', id]);
      assert.match(show2.stdout, /"state": "IMPLEMENTING"/);

      // Payload-requiring transitions are rejected explicitly by the CLI.
      const payload = runCli(['run', 'transition', id, 'agent_succeeded']);
      assert.equal(payload.status, 1);
      assert.match(payload.stderr, /error: Transition "agent_succeeded" requires an agentResult payload/);
      const show3 = runCli(['run', 'show', id]);
      assert.match(show3.stdout, /"state": "IMPLEMENTING"/);

      // Invalid transition across a fresh process fails loudly and keeps state.
      const bad = runCli(['run', 'transition', id, 'merged']);
      assert.equal(bad.status, 1);
      assert.match(bad.stderr, /error: Invalid transition "merged" from state IMPLEMENTING/);
      const show4 = runCli(['run', 'show', id]);
      assert.match(show4.stdout, /"state": "IMPLEMENTING"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
