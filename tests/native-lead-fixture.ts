import { ExecutionAdmissionRefusal } from '../src/adapters/agent.js';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { buildWorkflowDeps, runIssueCommand, recoverRunAdmission, resumeCommand } from '../src/cli.js';
import type { GitHubAdapter, GitHubLiveSnapshot } from '../src/adapters/github.js';
import type { Run } from '../src/domain/types.js';
import { applyTransition } from '../src/domain/state-machine.js';
import { dispatchOnceCommand } from '../src/dispatch/command.js';
import { DISPATCH_QUEUE_MARKER, selectDispatchRuntime, type DispatchRuntimeComment } from '../src/dispatch/queue.js';
import { JsonFileStore } from '../src/store/json-file-store.js';
import { JsonFileOracleReceiptStore } from '../src/oracle/receipt-store.js';
import { readNativeSourceManifest, oracleDigest } from '../src/oracle/source-evidence.js';
import { activeNativeLead, acceptedNativeLead, nativeLeadCoherent, unresolvedNativeLead, validLeadEvidence, resolveNativeLead, type NativeLeadHost, type NativeLeadEvidence, type NativeLeadObservation, issuedLeadRecoveryConfiguration, leadPayloadDigest } from '../src/oracle/native-lead.js';
import type { NativeOracleEvidence, NativeReviewerHost } from '../src/oracle/types.js';
import { MissionAdmissionRegistry } from '../src/mission-admission/registry.js';
import { readRunOwnerReceipt, writeRunOwnerReceipt } from '../src/mission-admission/run-owner-receipt.js';
import { StandaloneGitBootstrap } from '../src/workspace/standalone-git-bootstrap.js';
import { IsolatedLunaAdapter } from '../src/agents/luna-isolated.js';
import type { WorkflowDependencies } from '../src/workflow/run.js';
import { createBootstrapGitFixture } from './bootstrap-fixture.js';
import { T0, TARGET, validationPassed, validationFailed } from './helpers.js';
type LeadRequest = Extract<NativeLeadEvidence, {
  kind: 'request';
}>;
type LeadTerminal = Extract<NativeLeadEvidence, {
  kind: 'terminal';
}>;
/** Controlled service/authentication/GitHub/CLI executable boundaries. Real file
* CAS, dispatcher, registry/receipts, standalone Git preparation/publication and
* concrete isolated adapter are exercised. This is ZERO native qualification. */
export function fixture(options: { executionRevision?: string; timeoutMs?: number; localValidationRevision?: string; hostedPolicy?: WorkflowDependencies['hostedCheckPolicy'] } = {}) {
  const git = createBootstrapGitFixture();
  const root = git.root;
  const home = path.join(root, 'luna-home');
  const bin = path.join(root, 'bin');
  mkdirSync(home);
  mkdirSync(bin);
  writeFileSync(path.join(home, 'config.toml'), 'tachiko_luna_runtime_revision = "luna-qualified-runtime-v1"\n[features]\nplugins = false\napps = false\nmcp_servers = {}\nweb_search = false\n[sandbox_workspace_write]\nnetwork_access = false\n');
  const prompts = path.join(root, 'packets.txt');
  const executable = path.join(bin, 'codex');
  writeFileSync(executable, `#!/bin/sh\nfor arg do prompt="$arg"; done\nprintf '%s\\n' "$prompt" >> '${prompts}'\nif test -f implementation.txt; then printf 'bounded repair\\n' > repair.txt; else printf 'implementation\\n' > implementation.txt; fi\ngit add implementation.txt\nif test -f repair.txt; then git add repair.txt; fi\ngit -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm 'bounded fixture change' || exit 1\nprintf '%s\\n' '{"type":"thread.started","thread_id":"fixture-worker"}' '{"type":"turn.started"}' '{"type":"item.completed","item":{"id":"message","type":"agent_message","text":"bounded fixture committed"}}' '{"type":"turn.completed"}'\n`);
  chmodSync(executable, 0o700);
  symlinkSync('/usr/bin/git', path.join(bin, 'git'));
  const execution = { profile: 'routine' as const, revision: options.executionRevision ?? 'isolated-fixture-v1', executor: 'luna-isolated', model: 'gpt-5.6-luna', reasoningEffort: 'high' as const, timeoutMs: options.timeoutMs ?? 30000, sandboxMode: 'workspace-write' as const, approvalPolicy: 'never' as const };
  const shape = { revision: 'bounded-contract-v1', shape: 'bounded' as const };
  const config = { revision: 'dispatch-fixture-v1', owner: 'acme', repo: 'widgets', controlIssue: 1, queueCommentId: 2, leaseDurationMs: 60000 };
  const queue = `${DISPATCH_QUEUE_MARKER}\nready:\n  - issue: 42\n    route: codex\n    profile: routine\n    task-shape-revision: bounded-contract-v1\n    task-shape: bounded\n  - issue: 43\n    route: codex\n    profile: routine\n    task-shape-revision: bounded-contract-v1\n    task-shape: bounded`;
  let clock = Date.parse(T0);
  const now = () => new Date(clock).toISOString();
  let comments: DispatchRuntimeComment[] = [];
  const runtime = { async readQueueComment() { return queue; }, async listRuntimeComments() { return structuredClone(comments); }, async createRuntimeComment(body: string) { const c = { id: 'runtime', body }; comments.push(c); return c; }, async updateRuntimeComment(id: string, body: string) { comments = [{ id, body }]; return { id, body }; } };
  const store = () => new JsonFileStore({ dir: path.join(root, 'runs'), nativeCompletionHosts: { review: reviewer, lead } });
  let registryFault = () => { };
  const registry = () => new MissionAdmissionRegistry({ filePath: path.join(root, 'admission.json'), config: { schemaVersion: 1, revision: 'admission-fixture-v1', limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } }, now, beforePublish: () => registryFault() });
  const receipts = new JsonFileOracleReceiptStore(path.join(root, 'oracle'));
  const receiptPath = path.join(root, 'owner.json');
  const bootstrap = new StandaloneGitBootstrap({ repositoryRoot: git.source, workspaceRoot: git.workspaceRoot, runner: git.runner });
  const implementation = new IsolatedLunaAdapter({ codexHome: home, timeoutMs: options.timeoutMs ?? 30000, path: bin });
  let head: string | null = null;
  let branch = '';
  let pr = false;
  let held = false;
  let observations = 0;
  let leadCalls = 0;
  let reviewCalls = 0;
  let validationCalls = 0;
  let failFirstValidation = false;
  let issueHook = () => { };
  let effectHook = () => { };
  let executionUnavailable = false;
  let boundaries = 0;
  let hook = () => { };
  let liveOverride: ((s: GitHubLiveSnapshot) => GitHubLiveSnapshot) | undefined;
  const snapshot = (): GitHubLiveSnapshot => {
    if (pr)
      head = git.git(git.remote, ['rev-parse', `refs/heads/${branch}`]);
    const result: GitHubLiveSnapshot = { repository: { owner: 'acme', repo: 'widgets', defaultBranch: 'main', defaultBranchHeadSha: git.baseSha }, issue: { id: 'I_42', number: 42, title: 'Bounded fixture', body: 'Create implementation.txt; repair only the original bounded file contract.', state: 'open', url: '', createdAt: T0, updatedAt: T0 }, pullRequest: pr ? { id: 'PR_7', number: 7, title: 'Fixture', url: '', state: 'open', headSha: head!, baseSha: git.baseSha, headRef: branch, baseRef: 'main', headRepository: { owner: 'acme', repo: 'widgets' }, baseRepository: { owner: 'acme', repo: 'widgets' }, isDraft: false, mergeable: true, mergeStateStatus: 'CLEAN', updatedAt: T0 } : null, headSha: head, checks: { availability: 'available', overall: 'passing', checks: [{ id: 'test', name: 'test', state: 'passing', url: null, updatedAt: T0 }] }, reviews: { decision: 'none', latestByAuthor: [], unresolvedThreads: 0 }, conversations: [], handoff: { sourceId: 'scope-fixture', sourceScope: 'issue', sourceUpdatedAt: T0, sections: { scope: 'Create implementation.txt and any bounded repair.txt correction; preserve all other authority.' }, freshness: pr ? 'current' : 'unknown', ...(pr ? { claimedHeadSha: head!, claimedPullRequestNumber: 7 } : {}) }, problems: [], observedAt: now() };
    return liveOverride?.(result) ?? result;
  };
  const github: GitHubAdapter = { kind: 'github', async readIssue(target) { return { target, title: 'Bounded fixture', body: 'fixture', state: 'open' }; }, async readBranch() { throw new Error('unused'); }, async listPullRequests() { return []; }, async readPullRequest() { return snapshot().pullRequest!; }, async readLiveSnapshot() { hook(); return snapshot(); }, async createImplementationPullRequest(r) { branch = r.headBranch; pr = true; head = git.git(git.remote, ['rev-parse', `refs/heads/${branch}`]); return { number: 7, headSha: head, baseSha: git.baseSha, state: 'open' }; } };
  const reviewRequests: Extract<NativeOracleEvidence, {
    kind: 'request';
  }>[] = [];
  const reviewer: NativeReviewerHost = { binding: { bindingId: 'fixture-oracle', contractRevision: 'original-contract', policyRevision: 'independent-unpromoted-v1', scope: 'complete-candidate', model: 'fixture-independent-oracle', supportedEfforts: ['Extra High'], authorActorIds: ['author'], allowTransportReplacement: false }, receipts, source: (b, h) => readNativeSourceManifest(git.source, b, h), authenticate: e => e.authentication.transportReceipt === oracleDigest({ identity: e.identity, result: e.result }), async submit(r) { reviewCalls++; reviewRequests.push(r); const result = { verdict: reviewCalls === 1 ? 'request_changes' as const : 'approve' as const, reviewerName: 'fixture-independent', headSha: r.identity.headSha, findings: reviewCalls === 1 ? [{ severity: 'blocking' as const, summary: 'Repeated summary', detail: 'First original finding.' }, { severity: 'non_blocking' as const, summary: 'Retain informational suggestion' }, { severity: 'blocking' as const, summary: 'Repeated summary', detail: 'Second original finding.' }] : [] }; return { outcome: 'complete', evidence: { id: `${r.identity.requestId}.terminal`, kind: 'terminal', identity: r.identity, result, authentication: { actorId: 'fixture-independent', model: r.identity.requestedModel, effort: r.identity.requestedEffort, transportReceipt: oracleDigest({ identity: r.identity, result }) } } }; } };
  const terminal = (r: LeadRequest, outcome: 'repair' | 'stop' = 'repair'): LeadTerminal => { const disposition = outcome === 'repair' ? { outcome: 'repair' as const, origin: r.identity.origin, authoritySha256: r.identity.authoritySha256, acceptedFindingIds: r.packet.blockingFindingIds, instructions: 'Create repair.txt containing bounded repair. Accept BOTH distinct original blocking findings without changing scope.' } : { outcome: 'stop' as const, reason: 'cannot_safely_repair' as const, evidence: 'Fixture explicit stop; original findings retained.' }; const evidence: LeadTerminal = { id: `${r.identity.requestId}.terminal`, kind: 'terminal', identity: r.identity, disposition, authentication: { actorId: 'fixture-bounded-sol', role: 'bounded-lead', readOnly: true, model: r.identity.requestedModel, effort: r.identity.requestedEffort, transportReceipt: '' } }; return { ...evidence, authentication: { ...evidence.authentication, transportReceipt: leadPayloadDigest(evidence) } }; };
  let leadSubmit: (r: LeadRequest) => Promise<NativeLeadObservation> = async (r) => ({ outcome: 'complete', evidence: terminal(r) });
  let leadObserve: NonNullable<NativeLeadHost['observe']> = async () => ({ outcome: 'pending' });
  const leadRequests: LeadRequest[] = [];
  const lead: NativeLeadHost = { binding: { bindingId: 'fixture-sol', policyRevision: 'bounded-lead-v1', model: 'fixture-sol', effort: 'High', readOnly: true, qualified: true, allowTransportReplacement: true }, receipts, source: reviewer.source, authenticate: e => e.authentication.transportReceipt === (e.kind === 'completion' ? e.terminalSha256 : leadPayloadDigest(e)), async submit(r) { leadCalls++; leadRequests.push(r); return leadSubmit(r); }, async observe(i, url) { observations++; return leadObserve(i, url); }, replacementDisposition: () => 'unavailable' };
  const workflow = (host: NativeLeadHost | undefined = lead, durable = store()): WorkflowDependencies => ({ ...buildWorkflowDeps(durable, undefined, {}, undefined, reviewer, undefined, host), github, implementation, bootstrap, bootstrapForExecution: () => bootstrap, resolveRepairExecutionProfile: () => executionUnavailable ? undefined : execution, validation: { kind: 'validation', configRevision: options.localValidationRevision ?? 'test-config-v1', async validate(r) { validationCalls++; return { ...(failFirstValidation && validationCalls === 1 ? validationFailed(r.headSha) : validationPassed(r.headSha)).local, configRevision: options.localValidationRevision ?? 'test-config-v1' }; } }, hostedCheckPolicy: options.hostedPolicy ?? { revision: 'test-hosted-policy-v1', policy: { mode: 'required' } } });
  const poll = async (host: NativeLeadHost | undefined = lead, durable = store(), maxAttempts = 1) => {
    const wf = workflow(host, durable);
    const admission = registry();
    const invoke = async (ref: string, claimId: string, assertReviewClaim?: (r: Run) => Promise<void>, assertLeadInitiation?: (r: Run) => Promise<void>, observationOnly?: boolean, recovery?: typeof config) => runIssueCommand(wf, ref, { execution, repairTaskShapeAuthority: shape, dispatchClaimId: claimId, admission, runOwnerReceiptPath: receiptPath, now, maxReviewAttempts: maxAttempts, assertReviewClaim, assertLeadInitiation: async (r) => {
        if (held)
          throw new Error('HOLD final issue fence');
        await assertLeadInitiation?.(r);
      }, leadObservationOnly: observationOnly, leadRecoveryConfiguration: recovery, withDispatchAdmissionLock: async (op) => { issueHook(); return op(); }, withNativeEffectBoundary: op => {
        effectHook();
        boundaries++;
        if (held)
          throw new ExecutionAdmissionRefusal('HOLD final process fence', false);
        return op();
      } });
    return dispatchOnceCommand(config, { workflow: wf, runtime, admission, now, maintenanceHold: held, resolveExecutionProfile: () => execution, async runIssue(ref, _e, claimId, _a, _registry, _release, _lock, claim, _merge, initiate, observationOnly, recovery) { return invoke(ref, claimId, claim, initiate, observationOnly, recovery); }, async resumeClaimedRun(run, claimId, _registry, _release, _lock, claim, _merge, initiate, observationOnly, recovery) { return invoke(`acme/widgets#${run.target.kind === 'issue' ? run.target.issueNumber : 0}`, claimId, claim, initiate, observationOnly, recovery); } });
  };
  const run = () => { const runs = store().list(); assert.equal(runs.length, 1); return runs[0]!; };
  return { git, root, execution, shape, config, now, store, registry, receipts, receiptPath, workflow, github, lead, reviewer, terminal, poll, run, reviewRequests, leadRequests, prompts,
    setIssueHook: (fn: () => void) => { issueHook = fn; }, setEffectHook: (fn: () => void) => { effectHook = fn; }, setExecutionUnavailable: () => { executionUnavailable = true; }, setFirstValidationFailure: () => { failFirstValidation = true; }, counts: () => ({ leadCalls, reviewCalls, validationCalls, observations, boundaries }), tick: () => { clock += 31000; }, setLeadSubmit: (fn: typeof leadSubmit) => { leadSubmit = fn; }, setLeadObserve: (fn: typeof leadObserve) => { leadObserve = fn; }, setHold: (v: boolean) => { held = v; }, setSnapshotHook: (fn: () => void) => { hook = fn; }, setLiveOverride: (fn: typeof liveOverride) => { liveOverride = fn; }, setRegistryFault: (fn: () => void) => { registryFault = fn; }, runtime, cleanup: () => git.cleanup() };
}
