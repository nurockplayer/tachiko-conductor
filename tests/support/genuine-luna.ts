import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { IsolatedLunaAdapter, LUNA_ISOLATED_MODEL, LUNA_ISOLATED_PROVIDER } from '../../src/agents/luna-isolated.js';
import { StandaloneGitBootstrap } from '../../src/workspace/standalone-git-bootstrap.js';
import { createBootstrapGitFixture } from '../bootstrap-fixture.js';

/** A real concrete Luna adapter and exact source-minted standalone guard. */
export async function createGenuineLunaFixture(runId = 'genuine-luna-test', options: { readonly deferPrepare?: boolean } = {}) {
  const gitFixture = createBootstrapGitFixture();
  const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-genuine-luna-'));
  try {
    const home = path.join(root, 'home');
    const bin = path.join(root, 'bin');
    mkdirSync(home); mkdirSync(bin);
    writeFileSync(path.join(home, 'config.toml'), [
      'tachiko_luna_runtime_revision = "luna-qualified-runtime-v1"',
      '[features]', 'plugins = false', 'apps = false', 'mcp_servers = {}', 'web_search = false',
      '[sandbox_workspace_write]', 'network_access = false', '',
    ].join('\n'));
    const codex = path.join(bin, 'codex');
    const events = [
      { type: 'thread.started', thread_id: 'genuine-luna-thread' },
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'genuine-luna-message', type: 'agent_message', text: 'bounded fixture result' } },
      { type: 'turn.completed' },
    ];
    writeFileSync(codex, `#!/bin/sh\n${events.map((event) => `printf '%s\\n' '${JSON.stringify(event)}'`).join('\n')}\n`);
    chmodSync(codex, 0o700);
    symlinkSync('/usr/bin/git', path.join(bin, 'git'));
    const bootstrap = new StandaloneGitBootstrap({ repositoryRoot: gitFixture.source, workspaceRoot: gitFixture.workspaceRoot, runner: gitFixture.runner });
    const target = { kind: 'issue' as const, owner: 'acme', repo: 'widgets', issueNumber: 42 };
    const plan = { runId, target, baseBranch: gitFixture.branch, baseSha: gitFixture.baseSha };
    const identity = await bootstrap.plan(plan);
    if (options.deferPrepare !== true) await bootstrap.prepare({ ...plan, existing: identity });
    const adapter = new IsolatedLunaAdapter({ codexHome: home, timeoutMs: 30_000, path: bin });
    let executionEntries = 0;
    const request = {
      target, baseSha: gitFixture.baseSha, workspacePath: identity.workspacePath,
      branch: identity.branch, ...(options.deferPrepare === true ? {} : { workspaceGuard: bootstrap.guard(identity) }), authority: 'embedded' as const,
      instructions: 'Perform the bounded fixture task.',
      execution: { profile: 'routine' as const, revision: 'profiles-v1', executor: LUNA_ISOLATED_PROVIDER,
        model: LUNA_ISOLATED_MODEL, reasoningEffort: 'high' as const, timeoutMs: 30_000,
        sandboxMode: 'workspace-write' as const, approvalPolicy: 'never' as const },
      runtimeOwnership: { runId, generation: 'genuine-luna-generation' },
      governedPublication: { required: true as const, continuation: false },
      beforeExecution: () => { executionEntries += 1; },
    };
    return { adapter, request, bootstrap, identity, root, get executionEntries() { return executionEntries; }, cleanup() { gitFixture.cleanup(); rmSync(root, { recursive: true, force: true }); } };
  } catch (error) {
    gitFixture.cleanup(); rmSync(root, { recursive: true, force: true }); throw error;
  }
}
