import type { Run } from './types.js';
import type { GitHubLiveSnapshot } from '../adapters/github.js';
import { acceptedScopeFromHandoff, buildImplementationPacket, type ImplementationPacketInput } from '../agents/implementation-packet.js';
import { isRepairTaskShapeAuthority } from './repair-admission.js';
import { oracleDigest } from '../oracle/source-evidence.js';

/** The actual initial worker packet, pinned before its first executable boundary. */
export interface OriginalImplementationAuthority {
  readonly input: ImplementationPacketInput;
  readonly taskShape: NonNullable<Run['repairTaskShapeAuthority']>;
  readonly packetSha256: string;
}
const same = (a: unknown, b: unknown) => a === undefined || b === undefined ? a === b : oracleDigest(a) === oracleDigest(b);
const keys = (v: object, expected: string) => Object.keys(v).sort().join(',') === expected.split(',').sort().join(',');
export function implementationAuthorityCoherent(run: Run): boolean {
  const a = run.implementationAuthority;
  if (a === undefined) return true; // Historical absence never supplies repair authority.
  try {
    const i = a.input;
    const packet = buildImplementationPacket(i);
    return keys(a, 'input,taskShape,packetSha256') && keys(i, 'kind,identity,authority,repair') &&
      keys(i.identity, 'runId,target,workspacePath,branch,baseSha,execution') && keys(i.identity.target, 'kind,owner,repo,issueNumber') && keys(i.authority, 'repository,issue,acceptedScope') &&
      keys(i.authority.repository, 'owner,repo') && Object.keys(i.identity.execution).every(k => ['profile','revision','executor','timeoutMs','model','reasoningEffort','sandboxMode','approvalPolicy'].includes(k)) &&
      i.identity.workspacePath === run.bootstrap?.workspacePath && i.identity.branch === run.bootstrap?.branch && i.identity.baseSha === run.bootstrap?.baseSha &&
      keys(i.authority.issue, 'id,number,updatedAt,title,body') && keys(i.authority.acceptedScope, 'sourceId,sourceScope,sourceUpdatedAt,freshness,text') &&
      i.kind === 'initial' && i.repair === null && i.identity.runId === run.id && same(i.identity.target, run.target) &&
      same(i.identity.execution, run.execution) && isRepairTaskShapeAuthority(a.taskShape) && same(a.taskShape, run.repairTaskShapeAuthority) &&
      packet.kind === 'packet' && oracleDigest(packet.packet) === a.packetSha256;
  } catch { return false; }
}
export function assertImplementationAuthorityProgresses(previous: Run | null, next: Run): void {
  if (!implementationAuthorityCoherent(next)) throw new Error('Original implementation authority is incoherent.');
  if (previous?.implementationAuthority !== undefined && !same(previous.implementationAuthority, next.implementationAuthority))
    throw new Error('Original implementation authority is immutable.');
  if (previous && previous.implementationAuthority === undefined && next.implementationAuthority !== undefined &&
      (previous.state !== 'IMPLEMENTING' || previous.agentResult !== undefined || previous.executor !== undefined || (previous.repairAdmissions?.length ?? 0) !== 0))
    throw new Error('Original implementation authority must be pinned before the initial worker admission.');
}
export function originalImplementationMatches(run: Run, snapshot: GitHubLiveSnapshot): boolean {
  if (!run.implementationAuthority || !implementationAuthorityCoherent(run)) return false;
  const a = run.implementationAuthority.input.authority;
  const scope = acceptedScopeFromHandoff(snapshot.handoff, snapshot.problems, snapshot.pullRequest === null && snapshot.headSha === null);
  const { freshness: _originalFreshness, ...originalScope } = a.acceptedScope;
  const { freshness: _currentFreshness, ...currentScope } = scope ?? {};
  const issue = snapshot.issue;
  return scope !== null && same(originalScope, currentScope) &&
    same(a.repository, { owner: snapshot.repository.owner, repo: snapshot.repository.repo }) &&
    same(a.issue, { id: issue.id, number: issue.number, updatedAt: issue.updatedAt, title: issue.title, body: issue.body });
}
