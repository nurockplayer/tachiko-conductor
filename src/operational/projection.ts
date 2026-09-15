import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { Run } from '../domain/types.js';

/**
 * A deliberately small, secret-free read model for operational consumers.
 * The JSON Run remains owned and fully validated by JsonFileStore; consumers
 * must never use this sidecar to reconstruct or validate a Run.
 */
export const OPERATIONAL_RUN_PROJECTION_VERSION = 1;

export interface OperationalRunProjectionV1 {
  readonly schemaVersion: typeof OPERATIONAL_RUN_PROJECTION_VERSION;
  readonly runId: string;
  readonly sourceUpdatedAt: string;
  /** sha256 of the committed raw `<runId>.json` bytes. */
  readonly sourceDigest: string;
  readonly target: {
    readonly owner: string;
    readonly repo: string;
    readonly issueNumber?: number;
  };
  readonly workflowState: string;
  /** True only while a persisted review-repair run is actively implementing. */
  readonly reviewFixActive?: true;
  readonly executor?: { readonly provider: string };
  readonly bootstrap?: {
    readonly workspacePath: string;
    readonly branch: string;
    readonly baseBranch: string;
    readonly baseSha: string;
  };
  readonly headSha?: string;
  readonly pullRequest?: { readonly number: number; readonly headSha: string };
  readonly durationMs?: number;
  readonly createdAt: string;
}

export function operationalProjectionDirectory(runsDir: string): string {
  return path.join(runsDir, '.operational', `v${OPERATIONAL_RUN_PROJECTION_VERSION}`);
}

export function operationalProjectionPath(runsDir: string, runId: string): string {
  return path.join(operationalProjectionDirectory(runsDir), `${runId}.json`);
}

export function sha256(bytes: string): string {
  return createHash('sha256').update(bytes, 'utf8').digest('hex');
}

export function operationalRunProjection(run: Run, committedRunBytes: string): OperationalRunProjectionV1 {
  const issueNumber = run.target.kind === 'issue' ? run.target.issueNumber : undefined;
  const provider = run.executor?.provider ?? run.agentResult?.executor?.provider;
  const reviewFixActive = run.state === 'IMPLEMENTING' && run.history.at(-1)?.type === 'start_fix';
  return {
    schemaVersion: OPERATIONAL_RUN_PROJECTION_VERSION,
    runId: run.id,
    sourceUpdatedAt: run.updatedAt,
    sourceDigest: sha256(committedRunBytes),
    target: {
      owner: run.target.owner,
      repo: run.target.repo,
      ...(issueNumber === undefined ? {} : { issueNumber }),
    },
    workflowState: run.state,
    ...(reviewFixActive ? { reviewFixActive: true as const } : {}),
    ...(provider === undefined ? {} : { executor: { provider } }),
    ...(run.bootstrap === undefined ? {} : {
      bootstrap: {
        workspacePath: run.bootstrap.workspacePath,
        branch: run.bootstrap.branch,
        baseBranch: run.bootstrap.baseBranch,
        baseSha: run.bootstrap.baseSha,
      },
    }),
    ...(run.headSha === undefined ? {} : { headSha: run.headSha }),
    ...(run.pullRequest === undefined ? {} : { pullRequest: run.pullRequest }),
    ...(run.agentResult?.durationMs === undefined ? {} : { durationMs: run.agentResult.durationMs }),
    createdAt: run.createdAt,
  };
}

/** The sidecar write is individually atomic; raw/projection disagreement is fail-closed by its digest. */
export function writeOperationalProjection(runsDir: string, run: Run, committedRunBytes: string): void {
  const directory = operationalProjectionDirectory(runsDir);
  mkdirSync(directory, { recursive: true });
  const filePath = operationalProjectionPath(runsDir, run.id);
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(operationalRunProjection(run, committedRunBytes), null, 2)}\n`, 'utf8');
  renameSync(tmpPath, filePath);
}

export function deleteOperationalProjection(runsDir: string, runId: string): void {
  try {
    unlinkSync(operationalProjectionPath(runsDir, runId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
