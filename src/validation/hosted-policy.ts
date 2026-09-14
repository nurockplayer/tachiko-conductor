/**
 * Pure policy evaluation for the hosted-check portion of validation.
 *
 * The GitHub adapter reports what it observed; this module applies the
 * repository/run policy to that observation.  In particular, an empty check
 * list is not itself evidence of a passing check suite.
 */

/** Hosted aggregate values understood at the validation boundary. */
export type HostedCheckOverall =
  | 'pending'
  | 'passing'
  | 'failing'
  | 'unknown'
  | 'unavailable';

/** Explicit policy for whether hosted checks are part of this run's gate. */
export type HostedCheckPolicy =
  | {
      readonly mode: 'not_required';
    }
  | {
      readonly mode: 'required';
      /** When supplied, every named check must be present in the observation. */
      readonly requiredCheckNames?: readonly string[];
    };

/** Result tag intentionally includes a neutral, non-passing outcome. */
export type HostedCheckPolicyResult =
  | 'passed'
  | 'failed'
  | 'waiting'
  | 'unknown'
  | 'not_required';

export interface HostedCheckPolicyObservation {
  readonly overall?: HostedCheckOverall | null;
  /** Names reported by the provider for the exact PR HEAD. */
  readonly observedCheckNames?: readonly string[] | null;
  /** Missing policy is fail-closed and must not turn an empty response green. */
  readonly policy?: HostedCheckPolicy | null;
}

/**
 * Apply the explicit hosted-check policy to one exact-HEAD observation.
 *
 * A `not_required` policy is neutral for every observation; it yields
 * `not_required` rather than allowing a hosted observation to become a gate.
 * A required
 * policy needs a non-empty, passing observation and (when named checks are
 * configured) all required names.  A missing policy is always unknown so an
 * unconfigured run cannot accidentally accept hosted evidence.
 */
export function evaluateHostedCheckPolicy(
  observation: HostedCheckPolicyObservation,
): HostedCheckPolicyResult {
  const { overall, policy } = observation;
  const observedNames = observation.observedCheckNames ?? [];

  // Provider observations have no authority to supply a missing policy.
  if (policy === undefined || policy === null) return 'unknown';

  if (policy?.mode === 'not_required') {
    // The policy, rather than provider observations, decides that hosted
    // checks are outside this run's gate.
    return 'not_required';
  }

  const requiredNames = policy.requiredCheckNames ?? [];
  if (requiredNames.some((name) => !observedNames.includes(name))) {
    return 'unknown';
  }

  if (overall === 'failing') return 'failed';
  if (overall === 'pending') return 'waiting';

  if (policy.mode !== 'required' || overall !== 'passing' || observedNames.length === 0) {
    return 'unknown';
  }

  return 'passed';
}
