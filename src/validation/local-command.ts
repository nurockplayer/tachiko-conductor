import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, statSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { LocalValidationEvidence, LocalValidationCommandEvidence } from '../domain/types.js';
import type { LocalValidationConfiguration, ValidationAdapter, ValidationRequest } from '../adapters/validation.js';

function malformed(commandIndex: number, executable = ''): LocalValidationCommandEvidence {
  return { commandIndex, executable, outcome: 'malformed', exitCode: null, durationMs: 0 };
}

const TERMINATION_GRACE_MS = 1_000;
// Snapshot materialization is part of the validation authority boundary, not
// the validation command itself. Keep it independently bounded so a valid
// short command budget cannot make ordinary repository reconstruction
// impossible.
const RECONSTRUCTION_TIMEOUT_MS = 30_000;
const DEPENDENCY_STORE_COPY_TIMEOUT_MS = 30_000;
const PRIVATE_TREE_CLEANUP_TIMEOUT_MS = 30_000;
const IGNORED_MANIFEST_TIMEOUT_MS = 30_000;
const IGNORED_MANIFEST_MAX_ENTRIES = 50_000;
const IGNORED_MANIFEST_MAX_DEPTH = 64;
const IGNORED_MANIFEST_MAX_FILE_BYTES = 256 * 1024 * 1024;
const IGNORED_MANIFEST_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const IGNORED_MANIFEST_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const SETTLEMENT_POLL_MS = 25;
// `git status --ignored --untracked-files=all` can legitimately enumerate a
// large trusted dependency baseline. Keep this bounded, but well above the
// small default intended for compact command output.
const GIT_STATUS_MAX_BUFFER = 8 * 1024 * 1024;
const TOOL_VERSION_TIMEOUT_MS = 5_000;
const REQUIRED_PNPM_PACKAGE_MANAGER = 'pnpm@10.34.5';
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

type GitInvoke = (args: readonly string[], timeoutMs?: number) => SpawnSyncReturns<string>;

export interface GitAuthority {
  readonly path: string;
  readonly gitDir: string;
}

function boundedRegularMetadata(pathname: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(pathname, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 4_096) return null;
    const buffer = Buffer.alloc(4_097);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return read <= 4_096 ? buffer.subarray(0, read).toString('utf8') : null;
  } catch { return null; }
  finally { if (fd !== undefined) try { closeSync(fd); } catch { /* fail closed above */ } }
}

function gitArguments(authority: GitAuthority, args: readonly string[]): string[] {
  return [
    `--git-dir=${authority.gitDir}`, `--work-tree=${authority.path}`,
    '-c', `core.hooksPath=${os.devNull}`, '-c', 'core.fsmonitor=false',
    '-c', `core.attributesFile=${os.devNull}`, '-c', 'core.bare=false',
    '-c', 'core.ignoreStat=false', '-c', 'core.checkStat=default',
    '-c', 'core.trustctime=true', '-c', 'core.filemode=true',
    '-c', 'core.sparseCheckout=false', '-c', 'index.sparse=false', ...args,
  ];
}

function directGitAuthority(workspacePath: string): GitAuthority | null {
  try {
    const root = realpathSync(workspacePath);
    const metadata = path.join(root, '.git');
    const stat = lstatSync(metadata);
    if (stat.isSymbolicLink()) return null;
    let gitDir: string;
    if (stat.isDirectory()) gitDir = realpathSync(metadata);
    else if (stat.isFile() && stat.size <= 4_096) {
      const contents = boundedRegularMetadata(metadata);
      const match = contents === null ? null : /^gitdir:\s*([^\r\n]+)\s*$/.exec(contents);
      if (match?.[1] === undefined || match[1].includes('\0')) return null;
      const pointed = path.resolve(root, match[1]);
      if (lstatSync(pointed).isSymbolicLink()) return null;
      gitDir = realpathSync(pointed);
    } else return null;
    if (!lstatSync(gitDir).isDirectory()) return null;
    return { path: root, gitDir };
  } catch { return null; }
}

/**
 * Git is validator infrastructure, rather than candidate validation code.
 * Give every validator-owned Git invocation the same small, host-defined
 * environment: it is deliberately not a filtered copy of the dispatcher
 * environment.  In particular, no provider token, SSH agent, credential
 * helper override, or unrelated dispatcher secret can cross this boundary.
 *
 * Git's installed exec path is discovered by the configured executable; the
 * fixed PATH is only enough for an explicitly configured wrapper's shebang
 * and for the platform Git executable when no wrapper is configured.
 */
function validatorGitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    // Windows cannot locate a qualified Git executable or its DLLs without
    // the OS PATH. Select that one operational value explicitly; do not copy
    // any other dispatcher environment entry.
    PATH: process.platform === 'win32'
      ? process.env.Path ?? process.env.PATH ?? 'C:\\Windows\\System32'
      : '/usr/bin:/bin',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
  };
  if (process.platform === 'win32') {
    // Windows process creation requires these OS-owned values.  Select them
    // individually rather than propagating the dispatcher's environment.
    environment.SystemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    environment.COMSPEC = process.env.COMSPEC ?? 'C:\\Windows\\System32\\cmd.exe';
    environment.PATHEXT = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
  }
  return environment;
}

const SUPPORTED_PRODUCTION_GIT_EXEC_PATH = '/Library/Developer/CommandLineTools/usr/libexec/git-core';

function supportedProductionGitExecPath(gitProgram: string, environment = validatorGitEnvironment()): string | null {
  if (!path.isAbsolute(gitProgram)) return null;
  try {
    const probe = spawnSync(gitProgram, ['--exec-path'], {
      encoding: 'utf8', shell: false, timeout: TOOL_VERSION_TIMEOUT_MS, env: environment,
    });
    if (probe.status !== 0 || probe.signal !== null || probe.stdout.trim() === '') return null;
    return realpathSync(probe.stdout.trim()) === SUPPORTED_PRODUCTION_GIT_EXEC_PATH ? SUPPORTED_PRODUCTION_GIT_EXEC_PATH : null;
  } catch { return null; }
}

/** Only the CLT runtime has a qualified, closed set of sandbox dependencies. */
export function hasSupportedProductionGitRuntime(gitProgram: string): boolean {
  return supportedProductionGitExecPath(gitProgram) !== null;
}

export interface IgnoredManifestLimits {
  readonly timeoutMs?: number;
  readonly maxEntries?: number;
  readonly maxDepth?: number;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxOutputBytes?: number;
  readonly nodeProgram?: string;
}

// Fixed, credential-free verifier. It performs untracked/ignored Git listing
// and every ignored tree walk in its own process. It rejects symlinked
// ancestors, fingerprints leaf links themselves, and streams file bytes.
const IGNORED_MANIFEST_PROGRAM = String.raw`const fs=require('node:fs'),p=require('node:path'),c=require('node:crypto'),cp=require('node:child_process');
const [git,dir,root,result,raw]=process.argv.slice(1),lim=JSON.parse(raw),env={PATH:process.platform==='win32'?(process.env.Path||process.env.PATH||'C:\\Windows\\System32'):'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:require('node:os').devNull,GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1',GIT_OPTIONAL_LOCKS:'0'};if(process.platform==='win32'){env.SystemRoot=process.env.SystemRoot||'C:\\Windows';env.COMSPEC=process.env.COMSPEC||'C:\\Windows\\System32\\cmd.exe';env.PATHEXT=process.env.PATHEXT||'.COM;.EXE;.BAT;.CMD'};
let count=0,total=0,out=0; const fail=()=>{try{fs.writeFileSync(result,JSON.stringify({ok:false}))}catch{}}; const under=(x)=>x===root||x.startsWith(root+p.sep); const add=(s)=>{out+=Buffer.byteLength(s)+1;if(out>lim.maxOutputBytes)throw Error('output');return s};
async function hashFile(file,size){if(size>lim.maxFileBytes||total+size>lim.maxTotalBytes)throw Error('size'); const h=c.createHash('sha256');let read=0;await new Promise((yes,no)=>{const s=fs.createReadStream(file);s.on('data',b=>{read+=b.length;total+=b.length;if(read>lim.maxFileBytes||total>lim.maxTotalBytes){s.destroy(Error('size'))}else h.update(b)});s.on('error',no);s.on('end',yes)});if(read!==size)throw Error('changed');return h.digest('hex')}
async function walk(rel,depth){if(++count>lim.maxEntries||depth>lim.maxDepth||rel.includes(String.fromCharCode(0)))throw Error('entries');let parent=root;const parts=rel.split(/[\\/]/);for(const part of parts.slice(0,-1)){if(part===''||part==='.'||part==='..')throw Error('path');parent=p.resolve(parent,part);if(!under(parent))throw Error('escape');const ancestor=await fs.promises.lstat(parent);if(!ancestor.isDirectory()||ancestor.isSymbolicLink())throw Error('ancestor')}const target=p.resolve(root,rel);if(!under(target))throw Error('escape');const st=await fs.promises.lstat(target),mode=st.mode.toString(8);if(st.isSymbolicLink())return add('link '+rel+' '+mode+' '+c.createHash('sha256').update(await fs.promises.readlink(target)).digest('hex'));if(st.isFile())return add('file '+rel+' '+mode+' '+await hashFile(target,st.size));if(!st.isDirectory())throw Error('special');const names=[];const handle=await fs.promises.opendir(target);try{for await(const entry of handle){if(++count>lim.maxEntries)throw Error('entries');names.push(entry.name)}}finally{await handle.close().catch(()=>{})}names.sort();const nested=[];for(const n of names){if(n==='.'||n==='..')throw Error('name');nested.push(await walk(p.join(rel,n),depth+1))}return add('directory '+rel+' '+mode+' '+c.createHash('sha256').update(nested.join(String.fromCharCode(10))).digest('hex'))}
(async()=>{try{const base=['--git-dir='+dir,'--work-tree='+root,'-c','core.hooksPath='+require('node:os').devNull,'-c','core.fsmonitor=false','-c','core.attributesFile='+require('node:os').devNull,'-c','core.bare=false','-c','core.ignoreStat=false','-c','core.checkStat=default','-c','core.trustctime=true','-c','core.filemode=true','-c','core.sparseCheckout=false','-c','index.sparse=false'];const status=cp.spawnSync(git,base.concat(['status','--porcelain=v1','-z','--untracked-files=all','--ignored']),{encoding:'utf8',shell:false,env,maxBuffer:lim.maxOutputBytes});if(status.status!==0||status.signal)throw Error('status');const records=status.stdout.split(String.fromCharCode(0)).filter(Boolean),visible=records.filter(x=>!x.startsWith('!! '));if(visible.length)throw Error('visible');const manifest=[];for(const x of records)if(x.startsWith('!! ')){const rel=x.slice(3);manifest.push(await walk(rel,rel.split(/[\\/]/).length-1))}manifest.sort();const json=JSON.stringify({ok:true,manifest});if(Buffer.byteLength(json)>lim.maxOutputBytes)throw Error('output');fs.writeFileSync(result,json)}catch{fail()}})();`;

export async function ignoredManifest(
  authority: GitAuthority,
  gitProgram = 'git',
  options: IgnoredManifestLimits = {},
): Promise<string[] | null> {
  const limits = {
    timeoutMs: options.timeoutMs ?? IGNORED_MANIFEST_TIMEOUT_MS,
    maxEntries: options.maxEntries ?? IGNORED_MANIFEST_MAX_ENTRIES,
    maxDepth: options.maxDepth ?? IGNORED_MANIFEST_MAX_DEPTH,
    maxFileBytes: options.maxFileBytes ?? IGNORED_MANIFEST_MAX_FILE_BYTES,
    maxTotalBytes: options.maxTotalBytes ?? IGNORED_MANIFEST_MAX_TOTAL_BYTES,
    maxOutputBytes: options.maxOutputBytes ?? IGNORED_MANIFEST_MAX_OUTPUT_BYTES,
  };
  const nodeProgram = options.nodeProgram ?? process.execPath;
  if (!path.isAbsolute(authority.path) || !path.isAbsolute(authority.gitDir) || !path.isAbsolute(nodeProgram) ||
    !Object.values(limits).every((value) => Number.isSafeInteger(value) && value > 0)) return null;
  let temporary: string;
  try { temporary = mkdtempSync(path.join(os.tmpdir(), 'tcv-manifest-')); } catch { return null; }
  const result = path.join(temporary, 'result.json');
  let manifest: string[] | null = null;
  try {
    const execution = await execute(-1, { argv: [nodeProgram, '-e', IGNORED_MANIFEST_PROGRAM, gitProgram, authority.gitDir, authority.path, result, JSON.stringify(limits)], timeoutMs: limits.timeoutMs }, temporary, validatorGitEnvironment(), undefined);
    if (execution.outcome !== 'passed') return null;
    if (statSync(result).size > limits.maxOutputBytes) return null;
    const raw = readFileSync(result, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && (parsed as { ok?: unknown }).ok === true && Array.isArray((parsed as { manifest?: unknown }).manifest) &&
      (parsed as { manifest: unknown[] }).manifest.every((entry) => typeof entry === 'string')) manifest = (parsed as { manifest: string[] }).manifest;
  } catch { manifest = null; }
  finally { if (!(await disposePrivateTrees([temporary]))) manifest = null; }
  return manifest;
}

function hasHiddenIndexFlags(invoke: GitInvoke): boolean | null {
  const entries = invoke(['ls-files', '-v', '-z']);
  if (entries.status !== 0) return null;
  // `git ls-files -v` uses lowercase tags for assume-unchanged entries and
  // `S` for skip-worktree entries.  Both can conceal tracked-byte changes
  // from status, so neither is admissible evidence of a clean workspace.
  return entries.stdout.split('\0').some((entry) => /^[a-zS] /.test(entry));
}

async function workspaceMatches(
  request: ValidationRequest,
  workspacePath: string,
  requireRepositoryIdentity: boolean,
  trustedIgnoredBaselinePath?: string,
  gitProgram = 'git',
  environment = validatorGitEnvironment(),
): Promise<string[] | null> {
  const authority = directGitAuthority(workspacePath);
  if (authority === null) return null;
  // This verification reads candidate Git metadata.  A candidate-controlled
  // core.fsmonitor program must never gain execution authority merely because
  // the host is proving the candidate clean.
  const invoke: GitInvoke = (args, timeoutMs = TERMINATION_GRACE_MS) => spawnSync(gitProgram, gitArguments(authority, args), {
    encoding: 'utf8', shell: false, timeout: timeoutMs, maxBuffer: GIT_STATUS_MAX_BUFFER, env: environment,
  }) as SpawnSyncReturns<string>;
  const head = invoke(['rev-parse', 'HEAD']);
  // Do not content-compare through worker metadata/config: use a no-local
  // private bare clone and private index below as the settlement authority.
  const comparison = await baselineWorkspace(workspacePath, disposePrivateTrees, request.headSha, gitProgram, environment);
  if (comparison === null) return null;
  const comparisonInvoke: GitInvoke = (args, timeoutMs = TERMINATION_GRACE_MS) => spawnSync(gitProgram, gitArguments(comparison, args), { encoding: 'utf8', shell: false, timeout: timeoutMs, maxBuffer: GIT_STATUS_MAX_BUFFER, env: environment }) as SpawnSyncReturns<string>;
  const tracked = comparisonInvoke(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--quiet', '--exit-code', 'HEAD', '--']);
  const manifest = await ignoredManifest(comparison, gitProgram);
  const hiddenIndexFlags = hasHiddenIndexFlags(invoke);
  if (head.status !== 0 || head.stdout.trim() !== request.headSha || tracked.status !== 0 || manifest === null || hiddenIndexFlags !== false) { await disposePrivateTrees([comparison.privateRoot]); return null; }
  if (trustedIgnoredBaselinePath !== undefined) {
    // A configured baseline becomes the command cwd, even when both ignored
    // manifests are empty.  Prove it is a separate, clean checkout of this
    // exact implementation before it gains any execution authority.
    let baselinePath: string;
    let workerPath: string;
    try {
      baselinePath = realpathSync(trustedIgnoredBaselinePath);
      workerPath = realpathSync(workspacePath);
    } catch { await disposePrivateTrees([comparison.privateRoot]); return null; }
    if (baselinePath === workerPath || baselinePath.startsWith(`${workerPath}${path.sep}`) || workerPath.startsWith(`${baselinePath}${path.sep}`)) { await disposePrivateTrees([comparison.privateRoot]); return null; }
    const baselineAuthority = await baselineWorkspace(baselinePath, disposePrivateTrees, request.headSha, gitProgram, environment);
    if (baselineAuthority === null) { await disposePrivateTrees([comparison.privateRoot]); return null; }
    const baselineInvoke: GitInvoke = (args, timeoutMs = TERMINATION_GRACE_MS) => spawnSync(gitProgram, gitArguments(baselineAuthority, args), {
      encoding: 'utf8', shell: false, timeout: timeoutMs, maxBuffer: GIT_STATUS_MAX_BUFFER, env: environment,
    }) as SpawnSyncReturns<string>;
    const baselineHead = baselineInvoke(['rev-parse', 'HEAD']);
    const baselineTracked = baselineInvoke(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--quiet', '--exit-code', 'HEAD', '--']);
    const baselineManifest = await ignoredManifest(baselineAuthority, gitProgram);
    const baselineHiddenIndexFlags = hasHiddenIndexFlags(baselineInvoke);
    const baselineValid = baselineHead.status === 0 && baselineHead.stdout.trim() === request.headSha && baselineTracked.status === 0 && baselineManifest !== null && baselineManifest.join('\n') === manifest.join('\n') && baselineHiddenIndexFlags === false;
    const baselineCleaned = await disposePrivateTrees([baselineAuthority.privateRoot]);
    if (!baselineCleaned) { await disposePrivateTrees([comparison.privateRoot]); return null; }
    if (!baselineValid) { await disposePrivateTrees([comparison.privateRoot]); return null; }
  } else if (manifest.length > 0) {
    // Never globally ignore ignored paths. They are admissible only when a
    // separate host-owned clean checkout at this exact HEAD proves identical
    // bytes existed before the worker could have written its workspace.
    await disposePrivateTrees([comparison.privateRoot]); return null;
  }
  if (!(await disposePrivateTrees([comparison.privateRoot]))) return null;
  if (!requireRepositoryIdentity) return manifest;
  const remote = invoke(['remote', 'get-url', 'origin']);
  return remote.status === 0 && remoteMatchesTarget(remote.stdout, request) ? manifest : null;
}

/** The reconstructed checkout has no remote by design.  Bind command evidence
 * to its immutable exact commit and reject any tracked/index mutation. */
async function commandWorkspaceManifest(authority: GitAuthority, headSha: string, gitProgram = 'git', environment = validatorGitEnvironment()): Promise<string[] | null> {
  // The reconstructed checkout contains candidate history.  Every trusted
  // host-side probe pins fsmonitor off so a copied or otherwise planted local
  // config cannot execute while evidence is being verified.
  const invoke: GitInvoke = (args, timeoutMs = TERMINATION_GRACE_MS) => spawnSync(gitProgram, gitArguments(authority, args), {
    encoding: 'utf8', shell: false, timeout: timeoutMs, maxBuffer: GIT_STATUS_MAX_BUFFER, env: environment,
  }) as SpawnSyncReturns<string>;
  const head = invoke(['rev-parse', 'HEAD']);
  const tracked = invoke(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--quiet', '--exit-code', 'HEAD', '--']);
  const hiddenIndexFlags = hasHiddenIndexFlags(invoke);
  if (head.status !== 0 || head.stdout.trim() !== headSha || tracked.status !== 0 || hiddenIndexFlags !== false) return null;
  return ignoredManifest(authority, gitProgram);
}

async function commandWorkspaceMatches(authority: GitAuthority, headSha: string, expectedIgnored: readonly string[] = [], gitProgram = 'git', environment = validatorGitEnvironment()): Promise<boolean> {
  const manifest = await commandWorkspaceManifest(authority, headSha, gitProgram, environment);
  return manifest !== null && manifest.join('\n') === expectedIgnored.join('\n');
}

function lockfileBoundDependencyArtifact(workspacePath: string, artifactPath: string | undefined): string | null {
  if (artifactPath === undefined || !path.isAbsolute(artifactPath)) return null;
  try {
    // Keep the configured spelling for the child environment.  On macOS,
    // `/tmp` resolves to `/private/tmp`; both name the same host-owned store,
    // but a real pnpm invocation (and its configuration) must receive the
    // configured store path rather than a rewritten one.  Validate through
    // the canonical path below so this does not admit a symlinked artifact.
    const configuredArtifact = path.resolve(artifactPath);
    const artifact = realpathSync(artifactPath);
    const stat = lstatSync(artifact);
    const store = path.join(artifact, 'store');
    const metadata = path.join(artifact, 'pnpm-lock.yaml.sha256');
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0 ||
      !lstatSync(store).isDirectory() || lstatSync(store).isSymbolicLink() ||
      !lstatSync(metadata).isFile() || lstatSync(metadata).isSymbolicLink() || (lstatSync(metadata).mode & 0o022) !== 0) return null;
    const expected = readFileSync(metadata, 'utf8').trim();
    const actual = createHash('sha256').update(readFileSync(path.join(workspacePath, 'pnpm-lock.yaml'))).digest('hex');
    return /^[a-f0-9]{64}$/i.test(expected) && expected === actual ? path.join(configuredArtifact, 'store') : null;
  } catch { return null; }
}

function isHydratedDependencyManifest(manifest: readonly string[], roots: readonly string[]): boolean {
  // `git status --ignored --untracked-files=all` may report either the
  // ignored directory itself or its individual contents.  Admit only a
  // nonempty manifest wholly rooted in host-authorized node_modules trees, then freeze those exact
  // fingerprints for every subsequent command and final settlement.
  return manifest.length > 0 && manifest.every((entry) => {
    const relative = ignoredManifestEntryPath(entry);
    return relative !== null && roots.some((root) => relative === root || relative.startsWith(`${root}/`));
  });
}

function ignoredManifestEntryPath(entry: string): string | null {
  const match = /^(?:file|link|directory) (.+) [0-7]+ [a-f0-9]{64}$/i.exec(entry);
  return match?.[1] ?? null;
}

/** Canonical workspace-relative output roots shared by CLI and direct adapters. */
export function normalizeTerminalGeneratedIgnoredRoots(roots: readonly string[]): string[] | null {
  if (!Array.isArray(roots)) return null;
  const normalizedRoots: string[] = [];
  for (const value of roots) {
    if (typeof value !== 'string') return null;
    const raw = value.trim();
    const normalized = path.normalize(raw).split(path.sep).join('/').replace(/\/+$/, '');
    if (raw === '' || raw.includes('\0') || path.isAbsolute(raw) || normalized === '' ||
      normalized === '.' || normalized === '..' || normalized.startsWith('../')) return null;
    normalizedRoots.push(normalized);
  }
  return new Set(normalizedRoots).size === normalizedRoots.length ? normalizedRoots : null;
}

function terminalGeneratedManifestMatches(
  manifest: readonly string[],
  frozenManifest: readonly string[],
  allowedRoots: readonly string[],
): boolean {
  const frozen = new Set(frozenManifest);
  if (!frozenManifest.every((entry) => manifest.includes(entry))) return false;
  return manifest.every((entry) => {
    if (frozen.has(entry)) return true;
    const relative = ignoredManifestEntryPath(entry);
    return relative !== null && allowedRoots.some((root) => relative === root || relative.startsWith(`${root}/`));
  });
}

function workspaceUnavailable(commandIndex: number): LocalValidationCommandEvidence {
  return { commandIndex, executable: 'git', outcome: 'unavailable', exitCode: null, durationMs: 0 };
}

interface ValidationWorkspace {
  readonly path: string;
  readonly gitDir: string;
  readonly privateRoot: string;
  readonly protectedGitDir?: readonly string[];
}

function containsGitlinks(workspacePath: string, invoke: (args: readonly string[]) => SpawnSyncReturns<string>): boolean | null {
  const entries = invoke(['ls-files', '--stage', '-z']);
  if (entries.status !== 0) return null;
  return entries.stdout.split('\0').some((entry) => entry.startsWith('160000 '));
}

function declaresFilterAttribute(contents: string): boolean {
  return contents.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    return trimmed !== '' && !trimmed.startsWith('#') && /(?:^|\s)[!-]?filter(?:=|\s|$)/.test(trimmed);
  });
}

function hasTrackedFilterAttributes(
  workspacePath: string,
  headSha: string,
  invoke: (args: readonly string[]) => SpawnSyncReturns<string>,
): boolean | null {
  const entries = invoke(['ls-tree', '-r', '-z', headSha]);
  if (entries.status !== 0) return null;
  for (const entry of entries.stdout.split('\0')) {
    const separator = entry.indexOf('\t');
    if (separator === -1 || path.posix.basename(entry.slice(separator + 1)) !== '.gitattributes') continue;
    const [mode, type, objectId] = entry.slice(0, separator).split(' ');
    if (mode === undefined || type !== 'blob' || objectId === undefined || !/^[0-9a-f]{40,64}$/i.test(objectId)) return null;
    const contents = invoke(['cat-file', 'blob', objectId]);
    if (contents.status !== 0) return null;
    if (declaresFilterAttribute(contents.stdout)) return true;
  }
  return false;
}

/**
 * Materialize command input outside the worker checkout.  In particular, a
 * clean exact HEAD does not authorize files under that checkout's .git
 * directory: Git status deliberately does not report them, but a tracked
 * validation script can still load them.  A no-local clone gives commands a
 * newly-created Git directory containing only host-created clone metadata and
 * the cryptographically addressed exact commit.
 */
async function reconstructedWorkspace(
  sourcePath: string,
  headSha: string,
  cleanPrivateTrees: PrivateTreeCleaner,
  gitProgram = 'git',
  environment = validatorGitEnvironment(),
): Promise<ValidationWorkspace | null> {
  let snapshot: string;
  try { snapshot = mkdtempSync(path.join(os.tmpdir(), 'tachiko-validation-snapshot-')); }
  catch { return null; }
  const workspace = path.join(snapshot, 'workspace');
  const gitDir = path.join(snapshot, 'git');
  const authority: GitAuthority = { path: workspace, gitDir };
  const invoke = (args: readonly string[]) => spawnSync(gitProgram, [
    '-c', `core.hooksPath=${os.devNull}`,
    '-c', 'core.fsmonitor=false',
    '-c', `core.attributesFile=${os.devNull}`,
    ...args,
  ], {
    encoding: 'utf8', shell: false, timeout: RECONSTRUCTION_TIMEOUT_MS, maxBuffer: GIT_STATUS_MAX_BUFFER,
    env: environment,
  });
  try {
    const cloned = invoke(['clone', '--no-local', '--no-checkout', `--separate-git-dir=${gitDir}`, sourcePath, workspace]);
    // `clone` records the source path as origin. That path is worker-owned for
    // isolated executions, so discard it before a validator can discover and
    // read worker-controlled `.git` state through the reconstructed checkout.
    const disconnected = cloned.status === 0
      ? invoke(gitArguments(authority, ['remote', 'remove', 'origin']))
      : undefined;
    // A tracked attributes file is part of the candidate tree.  Inspect it
    // through immutable blobs before checkout: otherwise an ambient filter
    // configuration could execute a smudge command while materializing the
    // validation snapshot.
    const trackedFilters = disconnected?.status === 0
      ? hasTrackedFilterAttributes(workspace, headSha, (args) => invoke(gitArguments(authority, args)))
      : null;
    const checkedOut = trackedFilters === false
      ? invoke(gitArguments(authority, ['checkout', '--detach', '--force', headSha]))
      : undefined;
    // A plain detached checkout deliberately does not populate gitlinks. Do
    // not misreport an incomplete tree as a validator failure; submodule
    // provenance needs its own host-qualified reconstruction boundary.
    const gitlinks = checkedOut?.status === 0 ? containsGitlinks(workspace, (args) => invoke(gitArguments(authority, args))) : null;
    if (cloned.status !== 0 || disconnected?.status !== 0 || trackedFilters !== false || checkedOut?.status !== 0 || gitlinks !== false) {
      try { await cleanPrivateTrees([snapshot]); } catch { /* fail closed below */ }
      return null;
    }
    return { path: workspace, gitDir, privateRoot: snapshot };
  } catch {
    try { await cleanPrivateTrees([snapshot]); } catch { /* fail closed below */ }
    return null;
  }
}

/** Create private, immutable settlement metadata while retaining the trusted
 * baseline directory as the candidate cwd. Its original metadata remains
 * protected by the command sandbox and is never removed by validator cleanup. */
async function baselineWorkspace(
  baselinePath: string,
  cleanPrivateTrees: PrivateTreeCleaner,
  expectedHead: string,
  gitProgram = 'git',
  environment = validatorGitEnvironment(),
): Promise<ValidationWorkspace | null> {
  const protectedAuthority = directGitAuthority(baselinePath);
  if (protectedAuthority === null) return null;
  let privateRoot: string;
  try { privateRoot = mkdtempSync(path.join(os.tmpdir(), 'tachiko-validation-baseline-')); } catch { return null; }
  const gitDir = path.join(privateRoot, 'git');
  try {
    const clone = spawnSync(gitProgram, ['-c', `core.hooksPath=${os.devNull}`, '-c', 'core.fsmonitor=false', '-c', `core.attributesFile=${os.devNull}`, 'clone', '--no-local', '--bare', baselinePath, gitDir], {
      encoding: 'utf8', shell: false, timeout: RECONSTRUCTION_TIMEOUT_MS, maxBuffer: GIT_STATUS_MAX_BUFFER, env: environment,
    });
    if (clone.status !== 0 || clone.signal !== null) throw Error('clone');
    const metadata = realpathSync(gitDir);
    const disconnected = spawnSync(gitProgram, gitArguments({ path: protectedAuthority.path, gitDir: metadata }, ['remote', 'remove', 'origin']), { encoding: 'utf8', shell: false, timeout: RECONSTRUCTION_TIMEOUT_MS, maxBuffer: GIT_STATUS_MAX_BUFFER, env: environment });
    if (disconnected.status !== 0 || disconnected.signal !== null) throw Error('remote');
    // A bare clone has no index. Populate its private index before the
    // candidate can run so later diff/status probes never consult baseline
    // metadata or create a lock in the protected settlement authority.
    const privateAuthority = { path: protectedAuthority.path, gitDir: metadata };
    const privateInvoke: GitInvoke = (args, timeoutMs = TERMINATION_GRACE_MS) => spawnSync(gitProgram, gitArguments(privateAuthority, args), { encoding: 'utf8', shell: false, timeout: timeoutMs, maxBuffer: GIT_STATUS_MAX_BUFFER, env: environment }) as SpawnSyncReturns<string>;
    // Inspect immutable blobs before any status/diff can consult worktree attributes.
    if (hasTrackedFilterAttributes(protectedAuthority.path, expectedHead, privateInvoke) !== false) throw Error('filter');
    const indexed = spawnSync(gitProgram, gitArguments(privateAuthority, ['read-tree', expectedHead]), {
      encoding: 'utf8', shell: false, timeout: RECONSTRUCTION_TIMEOUT_MS, maxBuffer: GIT_STATUS_MAX_BUFFER, env: environment,
    });
    const verified = spawnSync(gitProgram, gitArguments({ path: protectedAuthority.path, gitDir: metadata }, ['rev-parse', 'HEAD']), { encoding: 'utf8', shell: false, timeout: RECONSTRUCTION_TIMEOUT_MS, maxBuffer: GIT_STATUS_MAX_BUFFER, env: environment });
    if (indexed.status !== 0 || indexed.signal !== null || verified.status !== 0 || verified.signal !== null || verified.stdout.trim() !== expectedHead) throw Error('index');
    const pointer = path.join(protectedAuthority.path, '.git');
    const protectedPaths = [pointer, protectedAuthority.gitDir];
    const commonPath = path.join(protectedAuthority.gitDir, 'commondir');
    let hasCommon = false;
    try { lstatSync(commonPath); hasCommon = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (hasCommon) {
      const common = boundedRegularMetadata(commonPath);
      if (common === null || common.trim() === '' || common.includes('\0')) throw Error('commondir');
      const resolvedCommon = realpathSync(path.resolve(protectedAuthority.gitDir, common.trim()));
      if (!lstatSync(resolvedCommon).isDirectory()) throw Error('commondir');
      protectedPaths.push(resolvedCommon);
    }
    return { path: protectedAuthority.path, gitDir: metadata, privateRoot, protectedGitDir: [...new Set(protectedPaths)] };
  } catch {
    try { await cleanPrivateTrees([privateRoot]); } catch { /* fail closed */ }
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
  environment: NodeJS.ProcessEnv,
  sandboxProfile?: string,
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
      child = sandboxProfile === undefined
        ? spawn(executable, command.argv.slice(1), {
          shell: false, stdio: 'ignore', cwd: workspacePath, env: environment, detached: process.platform !== 'win32',
        })
        : spawn('/usr/bin/sandbox-exec', ['-p', sandboxProfile, executable, ...command.argv.slice(1)], {
        shell: false, stdio: 'ignore', cwd: workspacePath, env: environment, detached: process.platform !== 'win32',
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

// This source is fixed validator infrastructure.  It is intentionally run in
// a separate credential-free Node process: synchronous filesystem traversal
// must never block the dispatcher event loop or outlive its own deadline.
const DEPENDENCY_STORE_COPY_PROGRAM = "const { cpSync } = require('node:fs'); const [source, destination] = process.argv.slice(1); cpSync(source, destination, { recursive: true, verbatimSymlinks: true });";
const PRIVATE_TREE_CLEANUP_PROGRAM = "const { rmSync } = require('node:fs'); for (const target of process.argv.slice(1)) rmSync(target, { recursive: true, force: true, maxRetries: 0 });";
type PrivateTreeCleaner = (paths: readonly string[]) => Promise<boolean>;

/**
 * Materialize a private pnpm store before any candidate command can start.
 * The optional overrides are an internal test seam; production callers use
 * the fixed current Node runtime and the host-defined deadline.
 */
export async function copyDependencyStore(
  source: string,
  destination: string,
  options: { readonly timeoutMs?: number; readonly nodeProgram?: string } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? DEPENDENCY_STORE_COPY_TIMEOUT_MS;
  const nodeProgram = options.nodeProgram ?? process.execPath;
  if (!path.isAbsolute(source) || !path.isAbsolute(destination) || !path.isAbsolute(nodeProgram) ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs < MIN_LOCAL_VALIDATION_TIMEOUT_MS || timeoutMs > MAX_LOCAL_VALIDATION_TIMEOUT_MS) return false;
  const result = await execute(-1, {
    argv: [nodeProgram, '-e', DEPENDENCY_STORE_COPY_PROGRAM, source, destination], timeoutMs,
  }, path.dirname(destination), {}, undefined);
  return result.outcome === 'passed';
}

function isOwnedPrivateTreePath(value: string): boolean {
  return path.isAbsolute(value) && !value.includes('\0') && path.resolve(value) !== path.parse(path.resolve(value)).root;
}

/** Host-side cleanup seam; candidate configuration cannot select its inputs or deadline. */
export async function disposePrivateTrees(
  paths: readonly string[],
  options: { readonly timeoutMs?: number; readonly nodeProgram?: string } = {},
): Promise<boolean> {
  if (paths.length === 0 || !paths.every(isOwnedPrivateTreePath)) return false;
  const timeoutMs = options.timeoutMs ?? PRIVATE_TREE_CLEANUP_TIMEOUT_MS;
  const nodeProgram = options.nodeProgram ?? process.execPath;
  if (!path.isAbsolute(nodeProgram) || !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < MIN_LOCAL_VALIDATION_TIMEOUT_MS || timeoutMs > MAX_LOCAL_VALIDATION_TIMEOUT_MS) return false;
  const result = await execute(-1, {
    argv: [nodeProgram, '-e', PRIVATE_TREE_CLEANUP_PROGRAM, ...paths], timeoutMs,
  }, path.parse(path.resolve(paths[0]!)).root, {}, undefined);
  return result.outcome === 'passed';
}

function sandboxLiteral(value: string): string { return JSON.stringify(value); }

/**
 * Build a host-side seatbelt profile. This is intentionally not an environment
 * convention: default filesystem and all networking are denied by the kernel.
 * The only broad system reads are macOS's loader/library roots; host-provided
 * toolchain executables and their immediate dependency directories are named
 * absolutely, and candidate code receives no other host paths.
 */
function macosValidationSandboxProfile(
  workspacePath: string,
  runtimeRoot: string,
  gitMetadataPath: string,
  protectedGitMetadataPath: readonly string[] | undefined,
  browserArtifacts: string | undefined,
  dependencyArtifactPath: string | undefined,
  nodeProgram: string,
  pnpmProgram: string,
  gitProgram?: string,
  gitEnvironment = validatorGitEnvironment(),
): string | null {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) return null;
  let workspace: string; let metadata: string; let protectedMetadata: string[]; let node: string; let pnpm: string; let git: string | undefined; let gitExecPath: string | undefined;
  let configuredToolPaths: string[];
  try {
    workspace = realpathSync(workspacePath);
    metadata = realpathSync(gitMetadataPath);
    protectedMetadata = protectedGitMetadataPath === undefined ? [] : protectedGitMetadataPath.map((entry) => realpathSync(entry));
    node = realpathSync(nodeProgram);
    pnpm = realpathSync(pnpmProgram);
    // Preserve the final configured symlink as well as its resolved target.
    // Darwin canonicalizes parent aliases such as /var -> /private/var before
    // applying seatbelt rules to the configured launcher itself.
    configuredToolPaths = [nodeProgram, pnpmProgram, ...(gitProgram === undefined ? [] : [gitProgram])]
      .map((program) => path.join(realpathSync(path.dirname(program)), path.basename(program)));
    if (gitProgram !== undefined) {
      git = realpathSync(gitProgram);
      const supportedExecPath = supportedProductionGitExecPath(gitProgram, gitEnvironment);
      if (supportedExecPath === null) return null;
      gitExecPath = supportedExecPath;
    }
  } catch { return null; }
  if (!path.isAbsolute(node) || !path.isAbsolute(pnpm) || !existsSync(node) || !existsSync(pnpm) ||
    (gitProgram !== undefined && (git === undefined || gitExecPath === undefined || !path.isAbsolute(git) || !existsSync(git)))) return null;
  const reads = [
    workspace, metadata, ...protectedMetadata, runtimeRoot, node, pnpm, ...configuredToolPaths, path.dirname(node), path.dirname(path.dirname(node)), path.dirname(pnpm), path.dirname(path.dirname(pnpm)),
    // pnpm launchers commonly use env/sh before entering the pinned Node
    // runtime. These are fixed macOS executables, not PATH-discovered tools.
    '/usr/bin', '/bin', '/usr/lib', '/System/Library', '/usr/share',
    // Small fixed OS metadata/device set required by real Node startup. These
    // are not user homes, caches, credentials, or configuration directories.
    '/dev/null', '/dev/urandom', '/var/db/timezone', '/private/var/db/timezone', '/private/var/select/sh',
  ];
  if (git !== undefined && gitExecPath !== undefined && gitProgram !== undefined) reads.push(git, gitProgram, gitExecPath);
  if (browserArtifacts !== undefined) {
    try { reads.push(realpathSync(browserArtifacts)); } catch { return null; }
  }
  if (dependencyArtifactPath !== undefined) {
    try { reads.push(realpathSync(dependencyArtifactPath)); } catch { return null; }
  }
  const clauses = reads.map((entry) => `(allow file-read* (subpath ${sandboxLiteral(entry)}))\n(allow file-read-metadata (path-ancestors ${sandboxLiteral(entry)}))`).join('\n');
  // dyld checks the root directory itself; Node queries its page size and OS
  // identity. Neither permission grants recursive reads of the host home.
  const sysctls = ['hw.pagesize_compat', 'hw.logicalcpu', 'kern.ostype', 'kern.osrelease', 'kern.version', 'kern.hostname', 'hw.machine']
    .map((name) => `(sysctl-name ${sandboxLiteral(name)})`).join(' ');
  // Apple's /usr/bin/git launcher may be configured directly or used by
  // nested repository tools. Its credential-free exec-path probe must prove
  // the CLT installation before admitting that installation's backing binary.
  const usesCltGit = gitExecPath === '/Library/Developer/CommandLineTools/usr/libexec/git-core';
  const appleGitLauncher = usesCltGit
    ? `(allow file-read-metadata (subpath "/Library/Developer/CommandLineTools"))
(allow file-read* (literal "/Library/Developer/CommandLineTools") (literal "/Library/Developer/CommandLineTools/usr/bin/git") (literal "/Library/Developer/CommandLineTools/usr/lib/libxcrun.dylib") (literal "/private/var/db/xcode_select_link") (literal "/var/db/xcode_select_link"))`
    : '';
  return `(version 1)
(deny default)
(deny network*)
(allow process*)
(allow signal (target same-sandbox))
(allow file-read* file-test-existence (literal "/"))
(allow file-read-metadata (literal "/tmp") (literal "/var"))
(allow sysctl-read ${sysctls})
${clauses}
${appleGitLauncher}
(allow file-write-data (literal "/dev/null"))
(allow file-write* (subpath ${sandboxLiteral(workspace)}))
(allow file-write* (subpath ${sandboxLiteral(runtimeRoot)}))
; Settlement metadata is host authority, including baseline's original metadata.
(deny file-write* (subpath ${sandboxLiteral(metadata)}))
${protectedMetadata.map((entry) => `(deny file-write* (subpath ${sandboxLiteral(entry)}))`).join('\n')}
; Host-established command aliases must survive every candidate command intact.
(deny file-write* (subpath ${sandboxLiteral(path.join(runtimeRoot, 'bin'))}))
; tsx uses private IPC. No IP sockets or sockets outside this run are admitted.
(allow system-socket (socket-domain AF_UNIX))
(allow network-bind (local unix-socket (subpath ${sandboxLiteral(runtimeRoot)})))
(allow network-outbound (remote unix-socket (subpath ${sandboxLiteral(runtimeRoot)})))`;
}

/**
 * Validation commands are candidate-controlled code and must not receive the
 * dispatcher's credentials.  Keep only command resolution and a fresh,
 * host-created home/cache root; notably no GitHub, SSH, ChatGPT/Codex/Luna,
 * npm, Git, or generic inherited secret variables cross this boundary.
 */
function credentialFreeValidationEnvironment(runtimeRoot: string, playwrightBrowsersPath?: string, nodeProgram?: string, pnpmProgram?: string, gitProgram?: string, dependencyStore?: string): NodeJS.ProcessEnv | null {
  const home = path.join(runtimeRoot, 'home');
  const cache = path.join(runtimeRoot, 'cache');
  const config = path.join(runtimeRoot, 'config');
  const temp = path.join(runtimeRoot, 'tmp');
  const gitTemplate = path.join(runtimeRoot, 'git-template');
  // These are host-created directories, not a dispatcher-owned HOME where
  // pnpm/npm configuration or auth could reside.
  for (const directory of [home, cache, config, temp, gitTemplate]) {
    try { mkdirSync(directory, { recursive: true, mode: 0o700 }); } catch { /* handled by command failure */ }
  }
  const toolBin = path.join(runtimeRoot, 'bin');
  if (nodeProgram !== undefined && pnpmProgram !== undefined) {
    try {
      mkdirSync(toolBin, { mode: 0o700 });
      // Arbitrary configured executable filenames must still establish the
      // bare names used by package scripts and launcher shebangs. Seatbelt
      // denies writes to this directory, including renames and link removal.
      for (const [name, program] of [['node', nodeProgram], ['pnpm', pnpmProgram], ['git', gitProgram]] as const) {
        if (program !== undefined) symlinkSync(program, path.join(toolBin, name));
      }
    } catch { return null; }
  }
  const environment: NodeJS.ProcessEnv = {
    PATH: nodeProgram === undefined || pnpmProgram === undefined
      ? process.env.PATH ?? (process.platform === 'win32' ? process.env.Path : undefined)
      : [toolBin, ...(gitProgram === undefined ? [] : [path.dirname(gitProgram)]), path.dirname(pnpmProgram), path.dirname(nodeProgram), '/usr/bin', '/bin'].filter((entry, index, all) => all.indexOf(entry) === index).join(path.delimiter),
    HOME: home,
    XDG_CACHE_HOME: cache,
    XDG_CONFIG_HOME: config,
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_TERMINAL_PROMPT: '0',
    GIT_TEMPLATE_DIR: gitTemplate,
    // Avoid an interactive prompt in the isolated pnpm invocation.
    CI: 'true',
  };
  if (process.platform === 'win32') {
    environment.USERPROFILE = home;
    if (process.env.SystemRoot !== undefined) environment.SystemRoot = process.env.SystemRoot;
    if (process.env.COMSPEC !== undefined) environment.COMSPEC = process.env.COMSPEC;
    if (process.env.PATHEXT !== undefined) environment.PATHEXT = process.env.PATHEXT;
  }
  if (playwrightBrowsersPath !== undefined) environment.PLAYWRIGHT_BROWSERS_PATH = playwrightBrowsersPath;
  if (dependencyStore !== undefined) {
    environment.npm_config_store_dir = dependencyStore;
    environment.npm_config_offline = 'true';
  }
  return environment;
}

/**
 * The configured pnpm path is host-provisioned, but its authority still comes
 * from the immutable candidate package manifest.  Prove both sides before any
 * candidate validation command can run; a missing, altered, or unverifiable
 * version has no fallback to PATH or an ambient package-manager selection.
 */
export function hasPinnedPnpmAuthority(workspacePath: string, pnpmProgram: string, environment: NodeJS.ProcessEnv): boolean {
  try {
    const manifest = JSON.parse(readFileSync(path.join(workspacePath, 'package.json'), 'utf8')) as { packageManager?: unknown };
    if (manifest === null || typeof manifest !== 'object' || manifest.packageManager !== REQUIRED_PNPM_PACKAGE_MANAGER) return false;
    const version = spawnSync(pnpmProgram, ['--version'], {
      encoding: 'utf8', shell: false, cwd: path.dirname(workspacePath), env: environment, timeout: TOOL_VERSION_TIMEOUT_MS,
    });
    return version.status === 0 && version.signal === null && version.stdout.trim() === REQUIRED_PNPM_PACKAGE_MANAGER.slice('pnpm@'.length);
  } catch {
    return false;
  }
}

function validHostBrowserArtifacts(directory: string | undefined): directory is string {
  if (directory === undefined || !path.isAbsolute(directory)) return directory === undefined;
  try {
    const stat = lstatSync(directory);
    return stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

/** Runs only the explicitly supplied repository/run validation commands. */
export class ConfiguredLocalValidationAdapter implements ValidationAdapter {
  readonly kind = 'validation' as const;
  readonly configRevision: string;
  readonly requiresOwnedWorkspace = true;

  constructor(
    private readonly configuration: LocalValidationConfiguration,
    // Internal test seam. It is not configuration or environment-driven, so
    // candidate code cannot select the copier or its deadline.
    private readonly copyStore: typeof copyDependencyStore = copyDependencyStore,
    // Internal host test seam for bounded cleanup outcomes.
    private readonly cleanPrivateTrees: PrivateTreeCleaner = disposePrivateTrees,
  ) {
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
    const terminalGeneratedIgnoredRoots = normalizeTerminalGeneratedIgnoredRoots(this.configuration.terminalGeneratedIgnoredRoots ?? []);
    if (terminalGeneratedIgnoredRoots === null) {
      return { status: 'unknown', configRevision: revision, commands: [malformed(0)] };
    }
    const hydratedRoots = this.configuration.hydratedDependencyRoots ?? ['node_modules'];
    if (!Array.isArray(hydratedRoots) || hydratedRoots.length === 0 || new Set(hydratedRoots).size !== hydratedRoots.length ||
      hydratedRoots.some((root) => typeof root !== 'string' || /\s|\\|\0/.test(root) || path.posix.isAbsolute(root) ||
        root.split('/').some((part) => part === '' || part === '.' || part === '..') || root.split('/').at(-1) !== 'node_modules')) {
      return { status: 'unknown', configRevision: revision, commands: [malformed(0)] };
    }
    const evidence: LocalValidationCommandEvidence[] = [];
    const configuredWorkspace = this.configuration.workspacePath;
    const workspacePath = request.workspacePath ?? configuredWorkspace;
    // Only a configured pre-existing workspace must prove its GitHub target.
    // An explicitly supplied workspace is bootstrap-owned; its exact HEAD,
    // clean state, hidden-index state, and ignored manifest are instead bound
    // to the detached command reconstruction at creation and final settlement.
    const requiresRepositoryIdentity = request.workspacePath === undefined && configuredWorkspace !== undefined;
    if (workspacePath === undefined) {
      return { status: 'unknown', configRevision: revision, commands: [workspaceUnavailable(0)] };
    }
    const gitEnvironment = validatorGitEnvironment();
    const admittedIgnoredManifest = await workspaceMatches(request, workspacePath, requiresRepositoryIdentity, this.configuration.trustedIgnoredBaselinePath, this.configuration.gitProgram, gitEnvironment);
    if (admittedIgnoredManifest === null) return { status: 'unknown', configRevision: revision, commands: [workspaceUnavailable(0)] };
    // A configured baseline is host-owned and already proved byte-identical
    // for every ignored dependency.  It is therefore the only place those
    // dependencies may be executed.  Otherwise reconstruct fresh command
    // input so worker-controlled .git bytes have no validation authority.
    const baseline = this.configuration.trustedIgnoredBaselinePath;
    const commandWorkspace = baseline === undefined
      ? await reconstructedWorkspace(workspacePath, request.headSha, this.cleanPrivateTrees, this.configuration.gitProgram, gitEnvironment)
      : await baselineWorkspace(baseline, this.cleanPrivateTrees, request.headSha, this.configuration.gitProgram, gitEnvironment);
    if (commandWorkspace === null) {
      return { status: 'unknown', configRevision: revision, commands: [workspaceUnavailable(0)] };
    }
    let runtimeRoot: string | undefined;
    try {
      if (!validHostBrowserArtifacts(this.configuration.playwrightBrowsersPath)) {
        return { status: 'unknown', configRevision: revision, commands: [workspaceUnavailable(0)] };
      }
      const dependencyStore = lockfileBoundDependencyArtifact(commandWorkspace.path, this.configuration.dependencyArtifactPath);
      if (this.configuration.dependencyArtifactPath !== undefined && dependencyStore === null) {
        return { status: 'unknown', configRevision: revision, commands: [workspaceUnavailable(0)] };
      }
      // Keep the prefix short for Darwin's sockaddr_un path limit, including
      // nested validation probes. Only this private mkdtemp directory enters
      // the sandbox, and the canonical path admits its real metadata ancestors.
      try {
        // Retain the created spelling until canonicalization succeeds so the
        // finally block also owns a rare realpath failure after mkdtemp.
        runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'tcv-'));
        runtimeRoot = realpathSync(runtimeRoot);
      }
      catch { return { status: 'unknown', configRevision: revision, commands: [workspaceUnavailable(0)] }; }
      const configuredToolchain = this.configuration.nodeProgram !== undefined || this.configuration.pnpmProgram !== undefined;
      // pnpm writes project metadata even during offline hydration. Give each
      // command sequence a private copy, preserving the host artifact's bytes.
      const privateStore = dependencyStore === null ? undefined : path.join(runtimeRoot, 'store');
      if (dependencyStore !== null && privateStore !== undefined) {
        if (!(await this.copyStore(dependencyStore, privateStore))) {
          return { status: 'unknown', configRevision: revision, commands: [workspaceUnavailable(0)] };
        }
      }
      const environment = credentialFreeValidationEnvironment(runtimeRoot, this.configuration.playwrightBrowsersPath ?? undefined, this.configuration.nodeProgram, this.configuration.pnpmProgram, this.configuration.gitProgram, privateStore);
      if (environment === null) return { status: 'unknown', configRevision: revision, commands: [workspaceUnavailable(0)] };
      // A production plan has one host-provisioned pnpm authority.  Reject a
      // substituted executable before probing a tool or starting validation.
      if (this.configuration.pnpmProgram !== undefined && configured.some((command) => !isCommand(command) || command.argv[0] !== this.configuration.pnpmProgram)) {
        return { status: 'unknown', configRevision: revision, commands: [malformed(0)] };
      }
      if (this.configuration.pnpmProgram !== undefined && !hasPinnedPnpmAuthority(commandWorkspace.path, this.configuration.pnpmProgram, environment)) {
        return { status: 'unknown', configRevision: revision, commands: [malformed(0, this.configuration.pnpmProgram)] };
      }
      const sandboxProfile = configuredToolchain && this.configuration.nodeProgram !== undefined && this.configuration.pnpmProgram !== undefined
        ? macosValidationSandboxProfile(commandWorkspace.path, runtimeRoot, commandWorkspace.gitDir, commandWorkspace.protectedGitDir, this.configuration.playwrightBrowsersPath ?? undefined, this.configuration.dependencyArtifactPath, this.configuration.nodeProgram, this.configuration.pnpmProgram, this.configuration.gitProgram, gitEnvironment) ?? undefined
        : undefined;
      // The production lane is meaningful only with a real macOS kernel
      // boundary. Do not silently degrade to environment scrubbing.
      if (configuredToolchain && (sandboxProfile === null || sandboxProfile === undefined)) return { status: 'unknown', configRevision: revision, commands: [workspaceUnavailable(0)] };
      // A nonempty ignored manifest is executable only when the separate
      // trusted baseline just proved those exact bytes.  The worker workspace
      // itself never grants this authority, and later checks pin this same
      // manifest (or the separately captured cold-hydration manifest).
      const initialIgnoredManifest = baseline === undefined ? [] : admittedIgnoredManifest;
      if (!(await commandWorkspaceMatches(commandWorkspace, request.headSha, initialIgnoredManifest, this.configuration.gitProgram, gitEnvironment))) return { status: 'unknown', configRevision: revision, commands: [workspaceUnavailable(0)] };
      let hydratedManifest: readonly string[] = initialIgnoredManifest;
      let settledManifest: readonly string[] = initialIgnoredManifest;
      for (let index = 0; index < configured.length; index += 1) {
        const command = configured[index];
        if (!isCommand(command)) {
          evidence.push(malformed(index, Array.isArray((command as { argv?: unknown })?.argv) ? String((command as { argv: unknown[] }).argv[0] ?? '') : ''));
          return { status: 'unknown', configRevision: revision, commands: evidence };
        }
        const result = await execute(index, command, commandWorkspace.path, environment, sandboxProfile);
        evidence.push(result);
        if (result.outcome === 'failed' || result.outcome === 'timed_out') {
          return { status: 'failed', configRevision: revision, commands: evidence };
        }
        if (result.outcome !== 'passed') return { status: 'unknown', configRevision: revision, commands: evidence };
        const manifest = await commandWorkspaceManifest(commandWorkspace, request.headSha, this.configuration.gitProgram, gitEnvironment);
        const isHydration = index === 0 && this.configuration.dependencyArtifactPath !== undefined;
        const isFinal = index === configured.length - 1;
        const manifestAdmitted = manifest !== null && (
          isHydration
            ? isHydratedDependencyManifest(manifest, hydratedRoots)
            : isFinal && terminalGeneratedIgnoredRoots.length > 0
              ? terminalGeneratedManifestMatches(manifest, hydratedManifest, terminalGeneratedIgnoredRoots)
              : manifest.join('\n') === hydratedManifest.join('\n')
        );
        if (!manifestAdmitted || manifest === null) {
          evidence.push(workspaceUnavailable(evidence.length));
          return { status: 'unknown', configRevision: revision, commands: evidence };
        }
        if (isHydration) hydratedManifest = manifest;
        settledManifest = manifest;
      }
      if (!(await commandWorkspaceMatches(commandWorkspace, request.headSha, settledManifest, this.configuration.gitProgram, gitEnvironment))) {
        evidence.push(workspaceUnavailable(evidence.length));
        return { status: 'unknown', configRevision: revision, commands: evidence };
      }
      if ((await workspaceMatches(request, workspacePath, requiresRepositoryIdentity, this.configuration.trustedIgnoredBaselinePath, this.configuration.gitProgram, gitEnvironment)) === null) {
        evidence.push(workspaceUnavailable(evidence.length));
        return { status: 'unknown', configRevision: revision, commands: evidence };
      }
      return { status: 'passed', configRevision: revision, commands: evidence };
    } finally {
      const privateTrees = [
        ...(runtimeRoot === undefined ? [] : [runtimeRoot]),
        commandWorkspace.privateRoot,
      ];
      let cleaned = privateTrees.length === 0;
      try { cleaned = cleaned || await this.cleanPrivateTrees(privateTrees); } catch { cleaned = false; }
      if (!cleaned) {
        return { status: 'unknown', configRevision: revision, commands: [...evidence, workspaceUnavailable(evidence.length)] };
      }
    }
  }
}
