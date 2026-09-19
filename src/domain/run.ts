import { randomUUID } from 'node:crypto';

import type { ResolvedExecutionConfiguration } from '../execution-profiles.js';
import { createRunTelemetry } from './telemetry.js';
import type { Run, Target } from './types.js';

/**
 * Create a new run in `READY`. `now` and `id` are injectable so tests can be
 * fully deterministic.
 */
export function createRun(
  target: Target,
  now: string = new Date().toISOString(),
  id: string = randomUUID(),
  execution?: ResolvedExecutionConfiguration,
  dispatchClaimId?: string,
): Run {
  return {
    id,
    target,
    state: 'READY',
    createdAt: now,
    updatedAt: now,
    history: [],
    telemetry: createRunTelemetry(),
    ...(execution === undefined ? {} : { execution }),
    ...(dispatchClaimId === undefined ? {} : { dispatchClaimId }),
  };
}
