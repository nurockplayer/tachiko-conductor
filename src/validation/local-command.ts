import { spawn, spawnSync } from 'node:child_process';

import type { LocalValidationEvidence, LocalValidationCommandEvidence } from '../domain/types.js';
import type { LocalValidationConfiguration, ValidationAdapter, ValidationRequest } from '../adapters/validation.js';

function malformed(commandIndex: number, executable = ''): LocalValidationCommandEvidence {
  return { commandIndex, executable, outcome: 'malformed', exitCode: null, durationMs: 0 };
}

const TERMINATION_GRACE_MS = 1_000;
const SETTLEMENT_POLL_MS = 25;
/** A validation command must be long enough to make termination observable, but never unattended indefinitely. */
export const MIN_LOCAL_VALIDATION_TIMEOUT_MS = 100;
export const MAX_LOCAL_VALIDATION_TIMEOUT_MS = 60 * 60_000;

function remoteMatchesTarget(remote: string, request: ValidationRequest): boolean {
  const text = remote.trim();
  let host = '';
  let pathname = '';
  try {
    const parsed = new URL(text);
    host = parsed.hostname;
    pathname = parsed.pathname;
  } catch {
    const match = /^(?:[^@\s]+@)?([^:\s]+):([^\s]+)$/.exec(text);
    if (match === null) return false;
    host = match[1] ?? '';
    pathname = match[2] ?? '';
  }
  const [owner, repo, ...rest] = pathname.replace(/^\/+|\/+$/g, '').split('/');
  return rest.length === 0 && host.toLowerCase().replace(/\.$/, '') === 'github.com' &&
    owner?.toLowerCase() === request.target.owner.toLowerCase() &&
    repo?.replace(/\.git$/i, '').toLowerCase() === request.target.repo.toLowerCase();
}

function workspaceMatches(request: ValidationRequest, workspacePath: string, requireRepositoryIdentity: boolean): boolean {
  if (workspacePath.trim() === '') return false;
  const invoke = (args: readonly string[]) => spawnSync('git', ['-C', workspacePath, ...args], {
    encoding: 'utf8', shell: false, timeout: TERMINATION_GRACE_MS, maxBuffer: 512,
  });
  const head = invoke(['rev-parse', 'HEAD']);
  const status = invoke(['status', '--porcelain']);
  if (head.status !== 0 || status.status !== 0 || head.stdout.trim() !== request.headSha || status.stdout.trim() !== '') return false;
  if (!requireRepositoryIdentity) return true;
  const remote = invoke(['remote', 'get-url', 'origin']);
  return remote.status === 0 && remoteMatchesTarget(remote.stdout, request);
}

function workspaceUnavailable(commandIndex: number): LocalValidationCommandEvidence {
  return { commandIndex, executable: 'git', outcome: 'unavailable', exitCode: null, durationMs: 0 };
}

function isCommand(value: unknown): value is { readonly argv: readonly string[]; readonly timeoutMs: number } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const command = value as { argv?: unknown; timeoutMs?: unknown };
  return Array.isArray(command.argv) && command.argv.length > 0 &&
    command.argv.every((part) => typeof part === 'string' && part.trim() !== '') &&
    Number.isSafeInteger(command.timeoutMs) &&
    (command.timeoutMs as number) >= MIN_LOCAL_VALIDATION_TIMEOUT_MS &&
    (command.timeoutMs as number) <= MAX_LOCAL_VALIDATION_TIMEOUT_MS;
}

function terminateProcessGroup(pid: number | undefined, signal: NodeJS.Signals): boolean {
  if (pid === undefined) return false;
  try {
    if (process.platform !== 'win32') process.kill(-pid, signal);
    else process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

function processGroupHasSettled(pid: number | undefined): boolean {
  if (pid === undefined || process.platform === 'win32') return false;
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

async function waitForProcessGroupSettlement(pid: number | undefined): Promise<boolean> {
  if (process.platform === 'win32' || pid === undefined) return false;
  const deadline = Date.now() + TERMINATION_GRACE_MS;
  while (Date.now() <= deadline) {
    if (processGroupHasSettled(pid)) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, SETTLEMENT_POLL_MS));
  }
  return processGroupHasSettled(pid);
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
    let settling = false;
    const finish = (outcome: LocalValidationCommandEvidence['outcome'], exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      resolve({ commandIndex, executable, outcome, exitCode, durationMs: Date.now() - startedAt });
    };
    const settleTimedOutProcess = async (child: ReturnType<typeof spawn>): Promise<void> => {
      if (settling || settled) return;
      settling = true;
      terminateProcessGroup(child.pid, 'SIGKILL');
      // A child `close` event only proves the direct process exited.  For a
      // detached validation command, prove the owned group has no surviving
      // descendants before recording a timeout; otherwise fail closed.
      const groupSettled = await waitForProcessGroupSettlement(child.pid);
      finish(groupSettled ? 'timed_out' : 'unavailable', null);
    };
    let child: ReturnType<typeof spawn>;
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
      if (!terminateProcessGroup(child.pid, 'SIGTERM')) child.kill('SIGTERM');
      forceTimer = setTimeout(() => {
        void settleTimedOutProcess(child);
      }, TERMINATION_GRACE_MS);
    }, command.timeoutMs);
    child.once('error', () => finish('unavailable', null));
    child.once('close', (code) => {
      if (timedOut) {
        void settleTimedOutProcess(child);
        return;
      }
      finish(code === 0 ? 'passed' : 'failed', code);
    });
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

  async validate(request: ValidationRequest): Promise<LocalValidationEvidence> {
    const revision = typeof this.configuration?.revision === 'string' && this.configuration.revision.trim() !== ''
      ? this.configuration.revision
      : null;
    const configured = this.configuration?.commands;
    if (revision === null || !Array.isArray(configured) || configured.length === 0) {
      return { status: 'unknown', configRevision: revision, commands: [malformed(0)] };
    }
    const evidence: LocalValidationCommandEvidence[] = [];
    const configuredWorkspace = this.configuration.workspacePath;
    const workspacePath = request.workspacePath ?? configuredWorkspace;
    const requiresRepositoryIdentity = request.workspacePath === undefined && configuredWorkspace !== undefined;
    if (workspacePath === undefined || !workspaceMatches(request, workspacePath, requiresRepositoryIdentity)) {
      return { status: 'unknown', configRevision: revision, commands: [workspaceUnavailable(0)] };
    }
    for (let index = 0; index < configured.length; index += 1) {
      const command = configured[index];
      if (!isCommand(command)) {
        evidence.push(malformed(index, Array.isArray((command as { argv?: unknown })?.argv) ? String((command as { argv: unknown[] }).argv[0] ?? '') : ''));
        return { status: 'unknown', configRevision: revision, commands: evidence };
      }
      const result = await execute(index, command, workspacePath);
      evidence.push(result);
      if (result.outcome === 'failed' || result.outcome === 'timed_out') {
        return { status: 'failed', configRevision: revision, commands: evidence };
      }
      if (result.outcome !== 'passed') return { status: 'unknown', configRevision: revision, commands: evidence };
    }
    if (!workspaceMatches(request, workspacePath, requiresRepositoryIdentity)) {
      evidence.push(workspaceUnavailable(evidence.length));
      return { status: 'unknown', configRevision: revision, commands: evidence };
    }
    return { status: 'passed', configRevision: revision, commands: evidence };
  }
}
