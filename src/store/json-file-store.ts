import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { WORKFLOW_STATES, type Run, type WorkflowState } from '../domain/types.js';

/**
 * Durable local storage for runs. Synchronous by design: the conductor is a
 * small single-process CLI and a sync API keeps the store trivial to reason
 * about and test.
 */
export interface RunStore {
  readonly name: string;
  create(run: Run): void;
  read(id: string): Run | null;
  update(run: Run): void;
  list(): Run[];
  delete(id: string): void;
}

export interface JsonFileStoreOptions {
  /** Directory that will hold one `<id>.json` file per run. */
  readonly dir: string;
}

const ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function assertSafeId(id: string): void {
  if (!ID_PATTERN.test(id)) {
    throw new Error(`Invalid run id "${id}": ids may only contain [A-Za-z0-9._-].`);
  }
}

/**
 * Minimal structural guard so a corrupt or incompatible file fails loudly at
 * the storage boundary instead of crashing later in the state machine.
 * The persisted `state` must be a member of the workflow enum.
 */
function isRun(value: unknown): value is Run {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.state === 'string' &&
    WORKFLOW_STATES.includes(v.state as WorkflowState) &&
    typeof v.target === 'object' &&
    v.target !== null &&
    Array.isArray(v.history)
  );
}

/** Write atomically: write to `<path>.tmp`, then rename over the target. */
function writeJsonAtomic(filePath: string, value: unknown): void {
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmpPath, filePath);
}

function readRun(filePath: string, id: string): Run {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`Failed to read run "${id}" from ${filePath}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Run file ${filePath} is not valid JSON (corrupt?): ${(err as Error).message}`);
  }
  if (!isRun(parsed)) {
    throw new Error(
      `Run file ${filePath} is corrupt or incompatible: expected a run with a state from the workflow enum (id/state/target/history).`,
    );
  }
  if (parsed.id !== id) {
    throw new Error(
      `Run file ${filePath} is corrupt or incompatible: persisted run id "${parsed.id}" does not match its file name "${id}".`,
    );
  }
  return parsed;
}

/**
 * JSON-file run store with atomic writes. A crash mid-write never corrupts the
 * committed run file, so a run survives a process restart intact: each write
 * goes to `<id>.json.tmp` and is renamed into place only after it is complete.
 */
export class JsonFileStore implements RunStore {
  readonly name = 'json-file';
  private readonly dir: string;

  constructor(options: JsonFileStoreOptions) {
    this.dir = options.dir;
    mkdirSync(this.dir, { recursive: true });
  }

  private filePathFor(id: string): string {
    assertSafeId(id);
    return path.join(this.dir, `${id}.json`);
  }

  create(run: Run): void {
    const filePath = this.filePathFor(run.id);
    if (existsSync(filePath)) {
      throw new Error(`A run with id "${run.id}" already exists at ${filePath}; refusing to overwrite.`);
    }
    writeJsonAtomic(filePath, run);
  }

  read(id: string): Run | null {
    const filePath = this.filePathFor(id);
    if (!existsSync(filePath)) return null;
    return readRun(filePath, id);
  }

  update(run: Run): void {
    writeJsonAtomic(this.filePathFor(run.id), run);
  }

  list(): Run[] {
    return readdirSync(this.dir)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => readRun(path.join(this.dir, name), name.slice(0, -'.json'.length)));
  }

  delete(id: string): void {
    const filePath = this.filePathFor(id);
    if (!existsSync(filePath)) {
      throw new Error(`No run with id "${id}" exists at ${filePath}; nothing to delete.`);
    }
    unlinkSync(filePath);
  }
}
