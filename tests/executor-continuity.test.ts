import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { ClaudeProcessRunner } from '../src/agents/claude-code.js';
import { ClaudeCodeAdapter } from '../src/agents/claude-code.js';
import { CodexCliAdapter } from '../src/agents/codex-cli.js';
import type { ImplementationAgent, WorkspaceGuard } from '../src/adapters/agent.js';
import type { ImplementationBootstrapAdapter } from '../src/adapters/bootstrap.js';
import type { GitHubAdapter, GitHubLiveSnapshot } from '../src/adapters/github.js';
import type { ReviewerAdapter, ReviewRequest } from '../src/adapters/reviewer.js';
import { resumeCommand } from '../src/cli.js';
import { createRun } from '../src/domain/run.js';
import { applyTransition } from '../src/domain/state-machine.js';
import type { ImplementationBootstrapIdentity, ReviewResult, Run } from '../src/domain/types.js';
import type { ProcessResult, ProcessRunOptions, ProcessRunner } from '../src/github/transport.js';
import { runReviewLoop } from '../src/reviewers/loop.js';
import { JsonFileStore } from '../src/store/json-file-store.js';
import { runWorkflow } from '../src/workflow/run.js';
import { TARGET, T0, successResult } from './helpers.js';

const HEAD = 'a'.repeat(40);
const HEAD2 = 'b'.repeat(40);
const BASE = 'c'.repeat(40);
const RESUME_WORKSPACE_DECISION = 'Resolve the workspace identity and retry';

type Provider = 'claude-code' | 'codex-cli';

const identity: ImplementationBootstrapIdentity = {
  owner: TARGET.owner,
  repo: TARGET.repo,
  issueNumber: TARGET.issueNumber,
  baseBranch: 'main',
  baseSha: BASE,
  branch: 'tachiko/issue-42-continuity',
  workspacePath: '/tmp/tachiko-continuity-workspace',
};

function result(stdout: string, exitCode = 0): ProcessResult {
  return { stdout, stderr: '', exitCode };
}

function claudeResult(sessionId: string): ProcessResult {
  return result(JSON.stringify({ type: 'result', result: 'completed', is_error: false, session_id: sessionId }));
}

function codexResult(threadId: string): ProcessResult {
  return result([
    JSON.stringify({ type: 'thread.started', thread_id: threadId }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'completed' } }),
    JSON.stringify({ type: 'turn.completed' }),
  ].join('\n'));
}

class ControlledProviderRunner implements ProcessRunner {
  readonly providerCalls: Array<readonly string[]> = [];
  private calls = 0;

  constructor(
    private readonly provider: Provider,
    private readonly sessionId: string,
    private readonly onDurableHead: () => void,
  ) {}

  async run(file: string, args: readonly string[], _options: ProcessRunOptions): Promise<ProcessResult> {
    if (file === 'git') {
      this.onDurableHead();
      return result(`${HEAD2}\n`);
    }
    const expected = this.provider === 'claude-code' ? 'claude' : 'codex';
    assert.equal(file, expected);
    this.providerCalls.push([...args]);
    this.calls += 1;
    return this.provider === 'claude-code' ? claudeResult(this.sessionId) : codexResult(this.sessionId);
  }
}

class PostRunGuard implements WorkspaceGuard {
  private fail = true;

  async assertValid(phase: 'before-execution' | 'after-execution' = 'before-execution'): Promise<void> {
    if (phase === 'after-execution' && this.fail) {
      this.fail = false;
      throw new Error('workspace changed after the provider completed');
    }
  }
}

class ContinuityBootstrap implements ImplementationBootstrapAdapter {
  readonly kind = 'implementation-bootstrap' as const;
  readonly guardForRun = new PostRunGuard();

  async plan(): Promise<ImplementationBootstrapIdentity> { return identity; }
  async prepare(): Promise<ImplementationBootstrapIdentity> { return identity; }
  guard(): WorkspaceGuard { return this.guardForRun; }
  async verifyDurable(request: { expectedHeadSha: string }) {
    assert.equal(request.expectedHeadSha, HEAD2);
    return { headSha: HEAD2, branch: identity.branch };
  }
}

class LiveGithub implements GitHubAdapter {
  readonly kind = 'github' as const;
  constructor(private readonly head: () => string) {}

  async readIssue(): Promise<never> { throw new Error('unused'); }
  async readBranch(): Promise<never> { throw new Error('unused'); }
  async listPullRequests(): Promise<never> { throw new Error('unused'); }
  async readLiveSnapshot(): Promise<GitHubLiveSnapshot> {
    const headSha = this.head();
    return {
      repository: { owner: TARGET.owner, repo: TARGET.repo, defaultBranch: 'main', defaultBranchHeadSha: BASE },
      issue: { id: 'I_42', number: TARGET.issueNumber, title: 'continuity', body: 'fix it', state: 'open', url: '', createdAt: T0, updatedAt: T0 },
      pullRequest: {
        id: 'PR_7', number: 7, title: 'continuity', url: '', state: 'open', isDraft: false,
        mergeable: true, mergeStateStatus: 'CLEAN', updatedAt: T0, headSha, baseSha: BASE,
        headRef: identity.branch, headRepository: { owner: TARGET.owner, repo: TARGET.repo }, baseRef: identity.baseBranch,
      },
      headSha,
      checks: { availability: 'available', overall: 'passing', checks: [] },
      reviews: { decision: 'none', latestByAuthor: [], unresolvedThreads: 0 },
      conversations: [], handoff: null, problems: [], observedAt: T0,
    };
  }
}

class ApprovingReviewer implements ReviewerAdapter {
  readonly kind = 'reviewer' as const;
  async review(request: ReviewRequest): Promise<ReviewResult> {
    return { verdict: 'approve', reviewerName: 'controlled', headSha: request.headSha, findings: [] };
  }
}

function runAtReviewFix(route: 'direct' | 'resumed', id: string): Run {
  let run = createRun(TARGET, T0, id);
  run = applyTransition(run, { type: 'start' }, T0);
  run = applyTransition(run, { type: 'bootstrap_prepared', bootstrap: identity }, T0);
  run = applyTransition(run, {
    type: 'agent_succeeded', agentResult: successResult(HEAD), headSha: HEAD,
    pullRequest: { number: 7, headSha: HEAD },
  }, T0);
  run = applyTransition(run, { type: 'validation_passed' }, T0);
  run = applyTransition(run, {
    type: 'changes_requested',
    reviewResult: { verdict: 'request_changes', reviewerName: 'controlled', headSha: HEAD, findings: [{ severity: 'blocking', summary: 'repair continuity' }] },
  }, T0);
  return route === 'direct' ? run : applyTransition(run, { type: 'start_fix' }, T0);
}

function providerAgent(provider: Provider, runner: ControlledProviderRunner): ImplementationAgent {
  return provider === 'claude-code'
    ? new ClaudeCodeAdapter({ runner: runner as unknown as ClaudeProcessRunner })
    : new CodexCliAdapter({ runner });
}

for (const provider of ['claude-code', 'codex-cli'] as const) {
  describe(`${provider} post-run guard continuity`, () => {
    for (const route of ['direct', 'resumed'] as const) {
      it(`persists its new executor through ${route} guard interruption and resumes the same session after JSON restart`, async () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-executor-continuity-'));
        let liveHead = HEAD;
        const sessionId = provider === 'claude-code' ? 'claude-new-session' : 'codex-new-thread';
        const runner = new ControlledProviderRunner(provider, sessionId, () => { liveHead = HEAD2; });
        const bootstrap = new ContinuityBootstrap();
        const store = new JsonFileStore({ dir });
        const id = `${provider}-${route}`;
        store.create(runAtReviewFix(route, id));
        const deps = {
          store,
          github: new LiveGithub(() => liveHead),
          implementation: providerAgent(provider, runner),
          bootstrap,
          reviewer: new ApprovingReviewer(),
        };
        try {
          const parked = route === 'direct'
            ? await runReviewLoop(deps, id, { maxAttempts: 3, now: () => T0 })
            : await runWorkflow(deps, id, { maxReviewAttempts: 3, now: () => T0 });
          assert.equal(parked.outcome, 'needs_human', JSON.stringify(parked));
          assert.equal(parked.run.state, 'NEEDS_HUMAN');
          assert.deepEqual(parked.run.executor, { provider, sessionId });
          assert.equal(parked.run.headSha, HEAD);
          assert.deepEqual(parked.run.pullRequest, { number: 7, headSha: HEAD });
          assert.equal(runner.providerCalls.length, 1);

          const restarted = new JsonFileStore({ dir });
          assert.deepEqual(restarted.read(id)?.executor, { provider, sessionId });
          assert.equal(restarted.read(id)?.headSha, HEAD);
          assert.deepEqual(restarted.read(id)?.pullRequest, { number: 7, headSha: HEAD });

          const resumed = await resumeCommand({ ...deps, store: restarted }, id, RESUME_WORKSPACE_DECISION, { maxReviewAttempts: 3, now: () => T0 });
          assert.equal(resumed.outcome, 'merge_ready', JSON.stringify(resumed));
          assert.equal(runner.providerCalls.length, 2);
          const resumeArgs = runner.providerCalls[1] ?? [];
          if (provider === 'claude-code') {
            assert.deepEqual(resumeArgs.slice(resumeArgs.indexOf('--resume'), resumeArgs.indexOf('--resume') + 2), ['--resume', sessionId]);
          } else {
            assert.deepEqual(resumeArgs.slice(0, 4), ['exec', 'resume', '--json', sessionId]);
          }
          const finalStore = new JsonFileStore({ dir });
          assert.deepEqual(finalStore.read(id)?.executor, { provider, sessionId });
          assert.equal(finalStore.read(id)?.headSha, HEAD2);
          assert.deepEqual(finalStore.read(id)?.pullRequest, { number: 7, headSha: HEAD2 });
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    }
  });
}
