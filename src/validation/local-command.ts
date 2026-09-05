import { spawn, spawnSync } from 'node:child_process';

import type { LocalValidationEvidence, LocalValidationCommandEvidence } from '../domain/types.js';
import type { LocalValidationConfiguration, ValidationAdapter, ValidationRequest } from '../adapters/validation.js';

function malformed(commandIndex: number, executable = ''): LocalValidationCommandEvidence {
  return { commandIndex, executable, outcome: 'malformed', exitCode: null, durationMs: 0 };
}

const TERMINATION_GRACE_MS = 1_000;

function ownedWorkspaceMatches(request: ValidationRequest): boolean {
  if (request.workspacePath === undefined || request.workspacePath.trim() === '') return false;
  const invoke = (args: readonly string[]) => spawnSync('git', ['-C', request.workspacePath!, ...args], {
    encoding: 'utf8', shell: false, timeout: TERMINATION_GRACE_MS, maxBuffer: 512,
  });
  const head = invoke(['rev-parse', 'HEAD']);
  const status = invoke(['status', '--porcelain']);
  return head.status === 0 && status.status === 0 && head.stdout.trim() === request.headSha && status.stdout.trim() === '';
}

function workspaceUnavailable(commandIndex: number): LocalValidationCommandEvidence {
  return { commandIndex, executable: 'git', outcome: 'unavailable', exitCode: null, durationMs: 0 };
}

function isCommand(value: unknown): value is { readonly argv: readonly string[]; readonly timeoutMs: number } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const command = value as { argv?: unknown; timeoutMs?: unknown };
  return Array.isArray(command.argv) && command.argv.length > 0 &&
    command.argv.every((part) => typeof part === 'string' && part.trim() !== '') &&
    Number.isSafeInteger(command.timeoutMs) && (command.timeoutMs as number) > 0;
}

async function execute(
  commandIndex: number,
  command: { readonly argv: readonly string[]; readonly timeoutMs: number },
  workspacePath: string,
): Promise<LocalValidationCommandEvidence> {
  const executable = command.argv[0]!;
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    let forceTimer: NodeJS.Timeout | undefined;
    const finish = (outcome: LocalValidationCommandEvidence['outcome'], exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      resolve({ commandIndex, executable, outcome, exitCode, durationMs: Date.now() - startedAt });
    };
    let child;
    try {
      child = spawn(executable, command.argv.slice(1), {
        shell: false, stdio: 'ignore', cwd: workspacePath, detached: process.platform !== 'win32',
      });
    } catch {
      finish('unavailable', null);
      return;
    }
    timer = setTimeout(() => {
      timedOut = true;
      if (process.platform !== 'win32' && child.pid !== undefined) {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
      } else child.kill('SIGTERM');
      forceTimer = setTimeout(() => {
        if (process.platform !== 'win32' && child.pid !== undefined) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        } else child.kill('SIGKILL');
        finish('timed_out', null);
      }, TERMINATION_GRACE_MS);
    }, command.timeoutMs);
    child.once('error', () => finish('unavailable', null));
    child.once('close', (code) => finish(timedOut ? 'timed_out' : code === 0 ? 'passed' : 'failed', code));
  });
}

/** Runs only the explicitly supplied repository/run validation commands. */
export class ConfiguredLocalValidationAdapter implements ValidationAdapter {
  readonly kind = 'validation' as const;
  readonly configRevision: string;
  readonly requiresOwnedWorkspace = true;

  constructor(private readonly configuration: LocalValidationConfiguration) {
    this.configRevision = configuration.revision;
  }

  async validate(_request: ValidationRequest): Promise<LocalValidationEvidence> {
    const revision = typeof this.configuration?.revision === 'string' && this.configuration.revision.trim() !== ''
      ? this.configuration.revision
      : null;
    const configured = this.configuration?.commands;
    if (revision === null || !Array.isArray(configured) || configured.length === 0) {
      return { status: 'unknown', configRevision: revision, commands: [] };
    }
    const evidence: LocalValidationCommandEvidence[] = [];
    if (!ownedWorkspaceMatches(_request)) {
      return { status: 'unknown', configRevision: revision, commands: [workspaceUnavailable(0)] };
    }
    for (let index = 0; index < configured.length; index += 1) {
      const command = configured[index];
      if (!isCommand(command)) {
        evidence.push(malformed(index, Array.isArray((command as { argv?: unknown })?.argv) ? String((command as { argv: unknown[] }).argv[0] ?? '') : ''));
        return { status: 'unknown', configRevision: revision, commands: evidence };
      }
      const result = await execute(index, command, _request.workspacePath!);
      evidence.push(result);
      if (result.outcome === 'failed' || result.outcome === 'timed_out') {
        return { status: 'failed', configRevision: revision, commands: evidence };
      }
      if (result.outcome !== 'passed') return { status: 'unknown', configRevision: revision, commands: evidence };
    }
    if (!ownedWorkspaceMatches(_request)) {
      evidence.push(workspaceUnavailable(evidence.length));
      return { status: 'unknown', configRevision: revision, commands: evidence };
    }
    return { status: 'passed', configRevision: revision, commands: evidence };
  }
}
