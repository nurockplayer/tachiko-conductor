import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { JsonFileOracleReceiptStore } from './receipt-store.js';
import { oracleDigest } from './source-evidence.js';
import { validNativeEvidence } from './native-reviewer.js';
import { validLeadEvidence } from './native-lead.js';
import type { NativeOracleEvidence, NativeReviewIdentity } from './types.js';
import type { Run } from '../domain/types.js';
import type { NativeReviewerHost } from './types.js';
import type { NativeLeadHost } from './native-lead.js';
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
/** Host dependencies are injected by trusted composition, never read from a Run.
 * Binding is only a cache of how to recheck durable evidence, not durable proof. */
export interface NativeCompletionHosts {
  readonly review?: Pick<NativeReviewerHost, 'receipts' | 'authenticate'>;
  readonly lead?: Pick<NativeLeadHost, 'receipts' | 'authenticate'>;
}
const bindings = new WeakMap<NativeCompletionProof, () => boolean>();
export function validCompletionProof(proof: NativeCompletionProof): boolean {
  return !!proof && Object.keys(proof).sort().join(',') === 'digest,file' && /^[0-9a-f]{64}$/.test(proof.digest) && typeof proof.file === 'string' && path.isAbsolute(proof.file);
}
/** Used only by the configured receipt store: the root is its private constructor
 * dependency, and the authenticator is the actual host dependency. Neither is
 * obtained from the proof. Reads always authenticate the exact immutable bytes. */
export function verifyConfiguredCompletion(nativeDirectory: string, authenticate: (e: CompletionEvidence) => boolean,
  identity: NativeReviewIdentity | NativeLeadIdentity, terminalDigest: string | undefined,
  proof: NativeCompletionProof, namespace: 'review' | 'lead'): boolean {
  try {
    if (!validCompletionProof(proof)) return false;
    const file = path.join(nativeDirectory, 'authenticated', `${namespace}.${identity.requestId}.json`);
    if (proof.file !== file) return false;
    const record = readPrivate(file) as AuthenticatedCompletionRecord;
    if (!validCompletionRecord(record) || record.namespace !== namespace || !same(record.request.identity, identity) || oracleDigest(record) !== proof.digest || oracleDigest(record.evidence) !== terminalDigest) return false;
    const directory = namespace === 'lead' ? path.join(nativeDirectory, 'lead') : nativeDirectory;
    return same(readPrivate(path.join(directory, `${record.request.id}.json`)), record.request) &&
      same(readPrivate(path.join(directory, `${record.evidence.id}.json`)), record.evidence) && authenticate(structuredClone(record.evidence)) === true;
  } catch { return false; }
}
/** Store/factory composition must supply the actual hosts. There is no API to
 * stamp a proof with a caller boolean, digest, or serialized root. */
export function authenticateNativeRun(run: Run, contexts: readonly NativeCompletionHosts[], writing = false): void {
  for (const namespace of ['review', 'lead'] as const) {
    const hosts = contexts.map(context => context[namespace]).filter(host => host?.receipts instanceof JsonFileOracleReceiptStore);
    const requests = namespace === 'review' ? run.nativeReview?.requests : run.nativeLead?.requests;
    for (const r of requests ?? []) {
      const proof = r.completionProof;
      if (!proof) continue; // Prior-schema history is readable, never authenticated.
      bindings.delete(proof);
      if (!validCompletionProof(proof)) throw new Error('Invalid native completion proof.');
      if (hosts.length === 0) {
        if (writing) throw new Error('Native completion requires configured host authentication.');
        continue;
      }
      const verify = () => hosts.some(host => JsonFileOracleReceiptStore.prototype.verifyAuthenticatedCompletion.call(host!.receipts, namespace, r.identity, r.terminalDigest, proof,
        e => (host!.authenticate as (e: CompletionEvidence) => boolean)(e)));
      if (!verify()) throw new Error('Invalid configured immutable authenticated completion proof.');
      bindings.set(proof, verify);
    }
  }
  for (const acceptance of run.nativeLead?.acceptances ?? []) {
    const r = run.nativeLead!.requests.find(r => r.identity.requestId === acceptance.requestId);
    if (!r?.completionProof || !bindings.has(r.completionProof)) continue;
    const evidence = authenticatedCompletionEvidence(r.identity, r.terminalDigest, r.completionProof, 'lead');
    if (!evidence || evidence.kind !== 'terminal' || !('disposition' in evidence) || evidence.id !== acceptance.receiptId || !same(evidence.disposition, acceptance.disposition))
      throw new Error('Lead acceptance must match the exact authenticated immutable terminal disposition.');
  }
}
export function hasAuthenticatedCompletion(identity: NativeReviewIdentity | NativeLeadIdentity, terminalDigest: string | undefined,
  proof: NativeCompletionProof | undefined, namespace: 'review' | 'lead'): boolean {
  // Verify the binding's original request as well as the current caller fields.
  try {
    if (!proof || !validCompletionProof(proof) || !bindings.get(proof)?.()) return false;
    const record = readPrivate(proof.file) as AuthenticatedCompletionRecord;
    return record.namespace === namespace && same(record.request.identity, identity) && oracleDigest(record.evidence) === terminalDigest;
  } catch { return false; }
}

/** Reads a terminal only through its already verified configured host binding. */
export function authenticatedCompletionEvidence(identity: NativeReviewIdentity | NativeLeadIdentity, terminalDigest: string | undefined,
  proof: NativeCompletionProof | undefined, namespace: 'review' | 'lead'): CompletionEvidence | null {
  try {
    if (!hasAuthenticatedCompletion(identity, terminalDigest, proof, namespace)) return null;
    const record = readPrivate(proof!.file) as AuthenticatedCompletionRecord;
    return validCompletionRecord(record) && record.namespace === namespace && same(record.request.identity, identity) && oracleDigest(record) === proof!.digest && oracleDigest(record.evidence) === terminalDigest ? record.evidence : null;
  } catch { return null; }
}
