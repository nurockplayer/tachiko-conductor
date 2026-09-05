import type { HostedValidationEvidence, LocalValidationEvidence, ValidationResult, ValidationStatus } from './types.js';

function isCommandOutcome(value: unknown): value is 'passed' | 'failed' | 'timed_out' | 'unavailable' | 'malformed' {
  return value === 'passed' || value === 'failed' || value === 'timed_out' || value === 'unavailable' || value === 'malformed';
}

function isLocalEvidence(value: unknown): value is LocalValidationEvidence {
  if (typeof value !== 'object' || value === null) return false;
  const evidence = value as Record<string, unknown>;
  if (!['passed', 'failed', 'unknown'].includes(evidence.status as string) ||
      (evidence.configRevision !== null && (typeof evidence.configRevision !== 'string' || evidence.configRevision.trim() === '')) ||
      !Array.isArray(evidence.commands)) return false;
  const commands = evidence.commands as Array<Record<string, unknown>>;
  if (!commands.every((command, index) =>
    typeof command === 'object' && command !== null && command.commandIndex === index &&
    typeof command.executable === 'string' &&
    (command.executable.trim() !== '' || command.outcome === 'malformed') && isCommandOutcome(command.outcome) &&
    (command.exitCode === null || typeof command.exitCode === 'number') &&
    typeof command.durationMs === 'number' && Number.isSafeInteger(command.durationMs) && command.durationMs >= 0,
  )) return false;
  const final = commands.at(-1);
  if (evidence.status === 'passed') return commands.length > 0 && commands.every((command) => command.outcome === 'passed' && command.exitCode === 0);
  if (evidence.status === 'failed') return final !== undefined && (final.outcome === 'failed' || final.outcome === 'timed_out');
  return (evidence.configRevision === null && commands.length === 0) ||
    (final !== undefined && (final.outcome === 'unavailable' || final.outcome === 'malformed'));
}

function isHostedEvidence(value: unknown): value is HostedValidationEvidence {
  if (typeof value !== 'object' || value === null) return false;
  const hosted = value as Record<string, unknown>;
  if (!['passed', 'failed', 'waiting', 'unknown'].includes(hosted.status as string) ||
      typeof hosted.observedAt !== 'string' || hosted.observedAt.trim() === '' ||
      (hosted.pullRequestNumber !== null && (!Number.isSafeInteger(hosted.pullRequestNumber) || (hosted.pullRequestNumber as number) < 1)) ||
      (hosted.availability !== 'available' && hosted.availability !== 'unavailable') ||
      !['pending', 'passing', 'failing', 'unknown', 'unavailable'].includes(hosted.overall as string)) return false;
  const expected = hosted.availability !== 'available'
    ? 'unknown'
    : hosted.overall === 'passing' ? 'passed'
      : hosted.overall === 'failing' ? 'failed'
        : hosted.overall === 'pending' ? 'waiting' : 'unknown';
  return hosted.status === expected;
}

/** True only for compact evidence whose source fields and aggregate agree. */
export function isValidationResultCoherent(value: unknown): value is ValidationResult {
  if (typeof value !== 'object' || value === null) return false;
  const result = value as Record<string, unknown>;
  if (typeof result.headSha !== 'string' || result.headSha.trim() === '' ||
      !['passed', 'failed', 'waiting', 'unknown'].includes(result.status as string) ||
      !isLocalEvidence(result.local) || !isHostedEvidence(result.hosted)) return false;
  const local = result.local;
  const hosted = result.hosted;
  const expected: ValidationStatus = local.status === 'failed' || hosted.status === 'failed'
    ? 'failed'
    : local.status === 'unknown' || hosted.status === 'unknown'
      ? 'unknown'
      : hosted.status === 'waiting' ? 'waiting' : 'passed';
  return result.status === expected;
}
