import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { LocalValidationEvidence, LocalValidationCommandEvidence } from '../domain/types.js';
import type { LocalValidationConfiguration, ValidationAdapter, ValidationRequest } from '../adapters/validation.js';

function malformed(commandIndex: number, executable = ''): LocalValidationCommandEvidence {
  return { commandIndex, executable, outcome: 'malformed', exitCode: null, durationMs: 0 };
}

const TERMINATION_GRACE_MS = 1_000;
const SETTLEMENT_POLL_MS = 25;
// `git status --ignored --untracked-files=all` can legitimately enumerate a
// large trusted dependency baseline. Keep this bounded, but well above the
// small default intended for compact command output.
const GIT_STATUS_MAX_BUFFER = 8 * 1024 * 1024;
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

type GitInvoke = (args: readonly string[]) => SpawnSyncReturns<string>;

function ignoredManifest(workspacePath: string, invoke: GitInvoke): string[] | null {
  const status = invoke(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored']);
  if (status.status !== 0) return null;
  const ignored = status.stdout.split('\0').filter((entry) => entry.startsWith('!! ')).map((entry) => entry.slice(3));
  const visible = status.stdout.split('\0').filter((entry) => entry !== '' && !entry.startsWith('!! '));
  if (visible.length > 0) return null;
  const root = path.resolve(workspacePath);
  const fingerprint = (relative: string): string | null => {
    const target = path.resolve(root, relative);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) return null;
    let stat;
    try { stat = lstatSync(target); } catch { return null; }
    const mode = stat.mode.toString(8);
    if (stat.isSymbolicLink()) {
      try { return `link ${relative} ${mode} ${createHash('sha256').update(readlinkSync(target)).digest('hex')}`; } catch { return null; }
    }
    if (stat.isFile()) {
      try { return `file ${relative} ${mode} ${createHash('sha256').update(readFileSync(target)).digest('hex')}`; } catch { return null; }
    }
    if (!stat.isDirectory()) return null;
    let children: readonly string[];
    try { children = readdirSync(target).sort(); } catch { return null; }
    const nested = children.map((name) => fingerprint(path.join(relative, name)));
    if (nested.some((entry) => entry === null)) return null;
    return `directory ${relative} ${mode} ${createHash('sha256').update(nested.join('\n')).digest('hex')}`;
  };
  const entries = ignored.map(fingerprint);
  return entries.some((entry) => entry === null) ? null : entries.filter((entry): entry is string => entry !== null).sort();
}

function workspaceMatches(
  request: ValidationRequest,
  workspacePath: string,
  requireRepositoryIdentity: boolean,
  trustedIgnoredBaselinePath?: string,
): boolean {
  if (workspacePath.trim() === '') return false;
  const invoke: GitInvoke = (args) => spawnSync('git', ['-C', workspacePath, ...args], {
    encoding: 'utf8', shell: false, timeout: TERMINATION_GRACE_MS, maxBuffer: GIT_STATUS_MAX_BUFFER,
  }) as SpawnSyncReturns<string>;
  const head = invoke(['rev-parse', 'HEAD']);
  const manifest = ignoredManifest(workspacePath, invoke);
  if (head.status !== 0 || head.stdout.trim() !== request.headSha || manifest === null) return false;
  if (manifest.length > 0) {
    // Never globally ignore ignored paths.  They are admissible only when a
    // separate host-owned clean checkout at this exact HEAD proves identical
    // bytes existed before the worker could have written its workspace.
    if (trustedIgnoredBaselinePath === undefined) return false;
    let baselinePath: string;
    let workerPath: string;
    try {
      baselinePath = realpathSync(trustedIgnoredBaselinePath);
      workerPath = realpathSync(workspacePath);
    } catch { return false; }
    if (baselinePath === workerPath || baselinePath.startsWith(`${workerPath}${path.sep}`) || workerPath.startsWith(`${baselinePath}${path.sep}`)) return false;
    const baselineInvoke: GitInvoke = (args) => spawnSync('git', ['-C', baselinePath, ...args], {
      encoding: 'utf8', shell: false, timeout: TERMINATION_GRACE_MS, maxBuffer: GIT_STATUS_MAX_BUFFER,
    }) as SpawnSyncReturns<string>;
    const baselineHead = baselineInvoke(['rev-parse', 'HEAD']);
    const baselineManifest = ignoredManifest(baselinePath, baselineInvoke);
    if (baselineHead.status !== 0 || baselineHead.stdout.trim() !== request.headSha || baselineManifest === null ||
      baselineManifest.length === 0 || baselineManifest.join('\n') !== manifest.join('\n')) return false;
  }
  if (!requireRepositoryIdentity) return true;
  const remote = invoke(['remote', 'get-url', 'origin']);
  return remote.status === 0 && remoteMatchesTarget(remote.stdout, request);
}

function workspaceUnavailable(commandIndex: number): LocalValidationCommandEvidence {
  return { commandIndex, executable: 'git', outcome: 'unavailable', exitCode: null, durationMs: 0 };
}

interface ValidationWorkspace {
  readonly path: string;
  dispose(): void;
}

/**
 * Materialize command input outside the worker checkout.  In particular, a
 * clean exact HEAD does not authorize files under that checkout's .git
 * directory: Git status deliberately does not report them, but a tracked
 * validation script can still load them.  A no-local clone gives commands a
 * newly-created Git directory containing only host-created clone metadata and
 * the cryptographically addressed exact commit.
 */
function reconstructedWorkspace(sourcePath: string, headSha: string): ValidationWorkspace | null {
  const snapshot = mkdtempSync(path.join(os.tmpdir(), 'tachiko-validation-snapshot-'));
  const invoke = (args: readonly string[]) => spawnSync('git', args, {
    encoding: 'utf8', shell: false, timeout: TERMINATION_GRACE_MS, maxBuffer: GIT_STATUS_MAX_BUFFER,
  });
  try {
    const cloned = invoke(['clone', '--no-local', '--no-checkout', sourcePath, snapshot]);
    const checkedOut = cloned.status === 0
      ? invoke(['-C', snapshot, 'checkout', '--detach', '--force', headSha])
      : undefined;
    if (checkedOut?.status !== 0) {
      rmSync(snapshot, { recursive: true, force: true });
      return null;
    }
    return { path: snapshot, dispose: () => rmSync(snapshot, { recursive: true, force: true }) };
  } catch {
    rmSync(snapshot, { recursive: true, force: true });
    return null;
  }
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

async function terminateWindowsProcessTree(pid: number | undefined): Promise<boolean> {
  if (pid === undefined) return false;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const taskkill = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
      shell: false, stdio: 'ignore', windowsHide: true,
    });
    const timer = setTimeout(() => finish(false), TERMINATION_GRACE_MS);
    taskkill.once('error', () => finish(false));
    taskkill.once('close', (code) => finish(code === 0));
  });
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
      if (process.platform === 'win32') {
        finish((await terminateWindowsProcessTree(child.pid)) ? 'timed_out' : 'unavailable', null);
        return;
      }
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
      if (process.platform === 'win32') {
        void settleTimedOutProcess(child);
        return;
      }
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
    if (workspacePath === undefined || !workspaceMatches(request, workspacePath, requiresRepositoryIdentity, this.configuration.trustedIgnoredBaselinePath)) {
      return { status: 'unknown', configRevision: revision, commands: [workspaceUnavailable(0)] };
    }
    // A configured baseline is host-owned and already proved byte-identical
    // for every ignored dependency.  It is therefore the only place those
    // dependencies may be executed.  Otherwise reconstruct fresh command
    // input so worker-controlled .git bytes have no validation authority.
    const baseline = this.configuration.trustedIgnoredBaselinePath;
    const commandWorkspace = baseline === undefined
      ? reconstructedWorkspace(workspacePath, request.headSha)
      : { path: baseline, dispose: () => {} };
    if (commandWorkspace === null) {
      return { status: 'unknown', configRevision: revision, commands: [workspaceUnavailable(0)] };
    }
    try {
      for (let index = 0; index < configured.length; index += 1) {
        const command = configured[index];
        if (!isCommand(command)) {
          evidence.push(malformed(index, Array.isArray((command as { argv?: unknown })?.argv) ? String((command as { argv: unknown[] }).argv[0] ?? '') : ''));
          return { status: 'unknown', configRevision: revision, commands: evidence };
        }
        const result = await execute(index, command, commandWorkspace.path);
        evidence.push(result);
        if (result.outcome === 'failed' || result.outcome === 'timed_out') {
          return { status: 'failed', configRevision: revision, commands: evidence };
        }
        if (result.outcome !== 'passed') return { status: 'unknown', configRevision: revision, commands: evidence };
      }
      if (!workspaceMatches(request, workspacePath, requiresRepositoryIdentity, this.configuration.trustedIgnoredBaselinePath)) {
        evidence.push(workspaceUnavailable(evidence.length));
        return { status: 'unknown', configRevision: revision, commands: evidence };
      }
      return { status: 'passed', configRevision: revision, commands: evidence };
    } finally {
      commandWorkspace.dispose();
    }
  }
}
