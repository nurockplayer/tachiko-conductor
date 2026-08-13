#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

import { createRun } from './domain/run.js';
import { applyTransition, transitionRequiresResult } from './domain/state-machine.js';
import {
  TRANSITION_TYPES,
  type InterruptKind,
  type Run,
  type Target,
  type TransitionType,
  type WorkflowState,
} from './domain/types.js';
import { JsonFileStore, type RunStore } from './store/json-file-store.js';

const USAGE = `Tachiko Conductor — local orchestration core.

Usage:
  tachiko run create --owner <owner> --repo <repo> (--issue <n> | --branch <branch>)
  tachiko run show <id>
  tachiko run transition <id> <transition> [--reason <text>]
  tachiko run list
  tachiko --help

Transitions: ${TRANSITION_TYPES.join(', ')}.

agent_succeeded, agent_failed, review_approved and changes_requested require
result payloads (agentResult / reviewResult) that adapters supply; run
transition cannot perform them and rejects them explicitly. Drive those
through the domain API (applyTransition) instead.

Run state is stored under $TACHIKO_DATA_DIR (default ~/.tachiko-conductor/runs).
`;

/** Resolve the directory where run JSON files are stored. */
export function resolveRunsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.TACHIKO_DATA_DIR ?? path.join(os.homedir(), '.tachiko-conductor', 'runs');
}

/**
 * Parse a GitHub issue number strictly: a decimal integer >= 1 that is also a
 * safe JavaScript integer. Partial, malformed, zero, negative, or
 * unrepresentable input (`42oops`, `3.5`, `0`, `-1`, `9007199254740993`,
 * overflow-to-Infinity) is rejected instead of being silently truncated or
 * rounded by a prefix parse.
 */
export function parseIssueNumber(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid --issue "${raw}": expected a positive integer.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Invalid --issue "${raw}": issue numbers must be a safe integer >= 1.`);
  }
  return value;
}

// --- commands (exported so tests can exercise them without spawning a process) ---

export function runCreateCommand(
  store: RunStore,
  owner: string,
  repo: string,
  opts: { issue?: number; branch?: string },
): Run {
  const hasIssue = opts.issue !== undefined;
  const hasBranch = opts.branch !== undefined;
  if (hasIssue && hasBranch) {
    throw new Error('run create requires exactly one of --issue <n> or --branch <branch>; got both.');
  }
  if (!hasIssue && !hasBranch) {
    throw new Error('run create requires exactly one of --issue <n> or --branch <branch>.');
  }
  let target: Target;
  if (opts.issue !== undefined) {
    target = { kind: 'issue', owner, repo, issueNumber: opts.issue };
  } else {
    target = { kind: 'repository', owner, repo, branch: opts.branch ?? 'main' };
  }
  const run = createRun(target);
  store.create(run);
  return run;
}

export function runShowCommand(store: RunStore, id: string): Run {
  const run = store.read(id);
  if (run === null) throw new Error(`No run with id "${id}" found.`);
  return run;
}

export function runTransitionCommand(store: RunStore, id: string, type: TransitionType, reason?: string): Run {
  const requirement = transitionRequiresResult(type);
  if (requirement !== 'none') {
    throw new Error(
      `Transition "${type}" requires an ${requirement}Result payload that this CLI cannot supply. ` +
        `Drive it through the domain API (applyTransition) instead.`,
    );
  }
  const current = store.read(id);
  if (current === null) throw new Error(`No run with id "${id}" found.`);
  const next = applyTransition(current, { type, reason });
  store.update(next);
  return next;
}

export function runListCommand(store: RunStore): Run[] {
  return store.list();
}

export interface RunView {
  id: string;
  target: Target;
  state: WorkflowState;
  headSha: string | null;
  /** Only an unresolved interrupt is a current interrupt. */
  interrupt: { kind: InterruptKind; reason: string } | null;
  transitions: number;
  updatedAt: string;
}

/** Project a run for display; a resolved interrupt is historical, not active. */
export function runShowView(run: Run): RunView {
  const activeInterrupt =
    run.interrupt !== undefined && run.interrupt.resolvedAt === undefined
      ? { kind: run.interrupt.kind, reason: run.interrupt.reason }
      : null;
  return {
    id: run.id,
    target: run.target,
    state: run.state,
    headSha: run.headSha ?? null,
    interrupt: activeInterrupt,
    transitions: run.history.length,
    updatedAt: run.updatedAt,
  };
}

function printRun(run: Run): void {
  console.log(JSON.stringify(runShowView(run), null, 2));
}

export async function main(argv: string[]): Promise<number> {
  const store = new JsonFileStore({ dir: resolveRunsDir() });
  const [command, subcommand, ...rest] = argv;

  if (command === undefined || command === '--help' || command === '-h') {
    console.log(USAGE);
    return 0;
  }

  if (command !== 'run') {
    console.error(`Unknown command: ${command}\n`);
    console.error(USAGE);
    return 1;
  }

  if (subcommand === 'create') {
    const { values } = parseArgs({
      args: rest,
      options: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        issue: { type: 'string' },
        branch: { type: 'string' },
      },
    });
    const { owner, repo } = values;
    if (owner === undefined || repo === undefined) {
      throw new Error('run create requires --owner and --repo.');
    }
    const issue = values.issue !== undefined ? parseIssueNumber(values.issue) : undefined;
    const run = runCreateCommand(store, owner, repo, { issue, branch: values.branch });
    console.log(`Created run ${run.id} (${run.state}).`);
    printRun(run);
    return 0;
  }

  if (subcommand === 'show') {
    const id = rest[0];
    if (id === undefined) throw new Error('run show requires a run id.');
    printRun(runShowCommand(store, id));
    return 0;
  }

  if (subcommand === 'transition') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { reason: { type: 'string' } },
    });
    const [id, type] = positionals;
    if (id === undefined || type === undefined) {
      throw new Error('run transition requires <id> and <transition>.');
    }
    if (!TRANSITION_TYPES.includes(type as TransitionType)) {
      throw new Error(`Unknown transition "${type}". Valid transitions: ${TRANSITION_TYPES.join(', ')}.`);
    }
    const next = runTransitionCommand(store, id, type as TransitionType, values.reason);
    console.log(`Run ${next.id}: ${next.state}.`);
    printRun(next);
    return 0;
  }

  if (subcommand === 'list') {
    for (const run of runListCommand(store)) {
      console.log(`${run.id}\t${run.state}\t${JSON.stringify(run.target)}`);
    }
    return 0;
  }

  console.error(`Unknown command: run ${subcommand ?? ''}\n`);
  console.error(USAGE);
  return 1;
}

// Run directly (`node dist/cli.js ...` or `node --import tsx src/cli.ts ...`)
// as well as via the `tachiko` bin entry.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    },
  );
}
