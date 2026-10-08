import type { HostedValidationEvidence, LocalValidationEvidence, ValidationResult, ValidationStatus } from './types.js';
import { isToolOutputEnvelope, TOOL_OUTPUT_POLICY_MAXIMA } from '../evidence/tool-output.js';

function isCommandOutcome(value: unknown): value is 'passed' | 'failed' | 'timed_out' | 'unavailable' | 'malformed' {
  return value === 'passed' || value === 'failed' || value === 'timed_out' || value === 'unavailable' || value === 'malformed';
}

function isCommandOutputCoherent(command: Record<string, unknown>): boolean {
  if (command.captureStatus !== undefined && !['complete', 'partial', 'unavailable'].includes(command.captureStatus as string)) return false;
  if (command.capturePreview !== undefined) {
    if (command.captureStatus === undefined || command.captureStatus === 'complete' ||
        typeof command.capturePreview !== 'object' || command.capturePreview === null) return false;
    const preview = command.capturePreview as Record<string, unknown>;
    const streamValid = (value: unknown): boolean => {
      if (typeof value !== 'object' || value === null) return false;
      const stream = value as Record<string, unknown>;
      if (!Number.isSafeInteger(stream.bytes) || (stream.bytes as number) < 0 || typeof stream.preview !== 'string' ||
          !Number.isSafeInteger(stream.previewBytes) || (stream.previewBytes as number) < 0 ||
          (stream.previewBytes as number) > TOOL_OUTPUT_POLICY_MAXIMA.previewBytes ||
          (stream.previewBytes as number) > (stream.bytes as number) ||
          stream.preview.length > TOOL_OUTPUT_POLICY_MAXIMA.previewBytes || typeof stream.truncated !== 'boolean') return false;
      return Buffer.byteLength(stream.preview, 'utf8') === stream.previewBytes;
    };
    if (!streamValid(preview.stdout) || !streamValid(preview.stderr) || !Array.isArray(preview.diagnostics) ||
        preview.diagnostics.length > TOOL_OUTPUT_POLICY_MAXIMA.maxDiagnostics ||
        typeof preview.diagnosticsTruncated !== 'boolean') return false;
    let diagnosticBytes = 0;
    for (let index = 0; index < preview.diagnostics.length; index += 1) {
      const line = preview.diagnostics[index];
      if (typeof line !== 'string') return false;
      const separatorBytes = index === 0 ? 0 : 1;
      if (diagnosticBytes + line.length + separatorBytes > TOOL_OUTPUT_POLICY_MAXIMA.diagnosticBytes) return false;
      diagnosticBytes += Buffer.byteLength(line, 'utf8') + separatorBytes;
      if (diagnosticBytes > TOOL_OUTPUT_POLICY_MAXIMA.diagnosticBytes) return false;
    }
  }
  if (command.output === undefined) return command.captureStatus !== 'complete';
  if (command.capturePreview !== undefined) return false;
  if (command.captureStatus !== undefined && command.captureStatus !== 'complete') return false;
  if (!isToolOutputEnvelope(command.output)) return false;
  const expected = command.outcome === 'passed' ? 'passed'
    : command.outcome === 'failed' ? 'failed'
      : command.outcome === 'timed_out' ? 'timed_out' : 'unknown';
  return command.output.outcome === expected && command.output.exitCode === command.exitCode;
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
    typeof command.durationMs === 'number' && Number.isSafeInteger(command.durationMs) && command.durationMs >= 0 &&
    isCommandOutputCoherent(command),
  )) return false;
  const final = commands.at(-1);
  if (evidence.status === 'passed') return commands.length > 0 && commands.every((command) => command.outcome === 'passed' && command.exitCode === 0);
  if (evidence.status === 'failed') {
    return final !== undefined &&
      (final.outcome === 'timed_out' || (final.outcome === 'failed' && final.exitCode !== 0));
  }
  return (evidence.configRevision === null && commands.length === 0) ||
    (final !== undefined && (final.outcome === 'unavailable' || final.outcome === 'malformed'));
}

function isHostedEvidence(value: unknown): value is HostedValidationEvidence {
  if (typeof value !== 'object' || value === null) return false;
  const hosted = value as Record<string, unknown>;
  if (!['passed', 'failed', 'waiting', 'unknown', 'not_required'].includes(hosted.status as string) ||
      typeof hosted.observedAt !== 'string' || hosted.observedAt.trim() === '' ||
      (hosted.pullRequestNumber !== null && (!Number.isSafeInteger(hosted.pullRequestNumber) || (hosted.pullRequestNumber as number) < 1)) ||
      (hosted.availability !== 'available' && hosted.availability !== 'unavailable') ||
      !['pending', 'passing', 'failing', 'unknown', 'unavailable'].includes(hosted.overall as string) ||
      (hosted.policyRevision !== null && (typeof hosted.policyRevision !== 'string' || hosted.policyRevision.trim() === '')) ||
      !['required', 'not_required', 'unconfigured'].includes(hosted.policyMode as string) ||
      !Array.isArray(hosted.requiredCheckNames) || !hosted.requiredCheckNames.every((name) => typeof name === 'string' && name.trim() !== '') ||
      !Array.isArray(hosted.observedCheckNames) || !hosted.observedCheckNames.every((name) => typeof name === 'string' && name.trim() !== '')) return false;
  if (hosted.policyMode !== 'required' && hosted.requiredCheckNames.length > 0) return false;
  const observedCheckNames = hosted.observedCheckNames as string[];
  const requiredCheckNames = hosted.requiredCheckNames as string[];
  const expected = hosted.availability !== 'available'
    ? 'unknown'
    : hosted.overall === 'passing' ? 'passed'
      : hosted.overall === 'failing' ? 'failed'
        : hosted.overall === 'pending' ? 'waiting' : 'unknown';
  if (hosted.status === 'not_required') {
    return hosted.policyMode === 'not_required';
  }
  if (hosted.policyMode === 'not_required') return false;
  if (hosted.policyMode === 'unconfigured') {
    return hosted.status === 'unknown';
  }
  // A named required policy is fail-closed until every required provider
  // observation is present.  For an unnamed required policy, an empty
  // *passing* observation is likewise not proof, but a provider-reported
  // pending/failing result remains meaningful transport evidence.
  if (hosted.policyMode === 'required' &&
    (requiredCheckNames.some((name) => !observedCheckNames.includes(name)) ||
      (hosted.overall === 'passing' && observedCheckNames.length === 0))) {
    return hosted.status === 'unknown';
  }
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
