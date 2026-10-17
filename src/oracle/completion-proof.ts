import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { oracleDigest } from './source-evidence.js';
import { validNativeEvidence } from './native-reviewer.js';
import { validLeadEvidence } from './native-lead.js';
import type { NativeOracleEvidence, NativeReviewIdentity } from './types.js';
import type { NativeLeadEvidence, NativeLeadIdentity } from './native-lead.js';

export interface NativeCompletionProof {
  readonly file: string;
  readonly digest: string;
}
export type CompletionEvidence = Exclude<NativeOracleEvidence | NativeLeadEvidence, { kind: 'request' }>;
export interface AuthenticatedCompletionRecord {
  readonly version: 'native-authenticated-completion/v1';
  readonly namespace: 'review' | 'lead';
  readonly request: Extract<NativeOracleEvidence | NativeLeadEvidence, { kind: 'request' }>;
  readonly evidence: CompletionEvidence;
}
const same = (a: unknown, b: unknown) => oracleDigest(a) === oracleDigest(b);
export function validCompletionRecord(r: AuthenticatedCompletionRecord): boolean {
  try {
    return Object.keys(r).sort().join(',') === 'evidence,namespace,request,version' && r.version === 'native-authenticated-completion/v1' &&
      r.request.kind === 'request' && r.evidence.kind !== ('request' as string) && same(r.request.identity, r.evidence.identity) &&
      (r.namespace === 'review' ? validNativeEvidence(r.request as NativeOracleEvidence) && validNativeEvidence(r.evidence as NativeOracleEvidence) :
        r.namespace === 'lead' && validLeadEvidence(r.request as NativeLeadEvidence) && validLeadEvidence(r.evidence as NativeLeadEvidence));
  } catch { return false; }
}
function readPrivate(file: string): unknown {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || realpathSync(file) !== file)
    throw new Error('Native completion proof must be an exact private immutable receipt.');
  return JSON.parse(readFileSync(file, 'utf8'));
}
/** The file is published only by the host-authenticating receipt-store method.
 * A digest/status in a Run is never an authentication or completion assertion. */
export function hasAuthenticatedCompletion(identity: NativeReviewIdentity | NativeLeadIdentity, terminalDigest: string | undefined,
  proof: NativeCompletionProof | undefined, namespace: 'review' | 'lead'): boolean {
  try {
    if (!proof || Object.keys(proof).sort().join(',') !== 'digest,file' || !/^[0-9a-f]{64}$/.test(proof.digest) || typeof proof.file !== 'string' || !path.isAbsolute(proof.file)) return false;
    const file = path.resolve(proof.file);
    if (path.basename(file) !== `${namespace}.${identity.requestId}.json` || path.basename(path.dirname(file)) !== 'authenticated' || path.basename(path.dirname(path.dirname(file))) !== 'native') return false;
    const record = readPrivate(file) as AuthenticatedCompletionRecord;
    if (!validCompletionRecord(record) || record.namespace !== namespace || !same(record.request.identity, identity) || oracleDigest(record) !== proof.digest || oracleDigest(record.evidence) !== terminalDigest) return false;
    const native = path.dirname(path.dirname(file));
    const directory = namespace === 'lead' ? path.join(native, 'lead') : native;
    return same(readPrivate(path.join(directory, `${record.request.id}.json`)), record.request) &&
      same(readPrivate(path.join(directory, `${record.evidence.id}.json`)), record.evidence);
  } catch { return false; }
}
