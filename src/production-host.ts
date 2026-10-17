import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Run } from './domain/types.js';
import type { NativeCompletionHosts } from './oracle/completion-proof.js';
import { JsonFileOracleReceiptStore } from './oracle/receipt-store.js';
import { fileURLToPath } from 'node:url';
import { assertProductionPolicyConfiguration, PRODUCTION_EXECUTION_PROFILE_CONFIG, PRODUCTION_POLICY_REVISION } from './production-policy.js';
import Module, { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { assertSafeAccountOwnedPath, resolveAccountHomeDirectory } from './account-home.js';
import { GhCliTransport, NodeProcessRunner, type ProcessRunner, type ProcessRunOptions } from './github/transport.js';
import { bindNativeMergeFence, readMergeCandidate, validMergePolicy, type NativeMergeHost, type NativeMergePolicy } from './workflow/merge.js';

export const ACCEPTED_STATE_COMPATIBILITY = 'conductor-native-state-v1';
export const PRODUCTION_ENTRY = 'dist/production-entry.js';
const SHA = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const ENV_KEYS = new Set(['TACHIKO_IMPLEMENTATION_AGENT', 'TACHIKO_EXECUTION_PROFILE_CONFIG', 'TACHIKO_LOCAL_VALIDATION_CONFIG', 'TACHIKO_HOSTED_CHECK_POLICY_CONFIG', 'TACHIKO_LUNA_CODEX_HOME', 'TACHIKO_NODE_PROGRAM', 'TACHIKO_PNPM_PROGRAM', 'TACHIKO_GIT_PROGRAM', 'TACHIKO_PNPM_DEPENDENCY_ARTIFACT', 'TACHIKO_PLAYWRIGHT_BROWSERS_PATH']);
export interface AcceptedProgram { readonly path: string; readonly sha256: string }
export interface AcceptedTool extends AcceptedProgram { readonly runtimeDirectory: string; readonly manifest: Readonly<Record<string,string>>; readonly manifestDigest: string }
/** Host acceptance evidence only. Builds never create this record. No credentials or executable configuration. */
export interface AcceptedRelease {
  readonly schemaVersion: 1;
  readonly releaseId: string;
  readonly sourceCommit: string;
  readonly sourceTree: string;
  readonly stateCompatibility: typeof ACCEPTED_STATE_COMPATIBILITY;
  readonly runtimePolicyRevision: 'issue-104-production-v7';
  readonly entry: typeof PRODUCTION_ENTRY;
  readonly manifest: Readonly<Record<string, string>>;
  readonly manifestDigest: string;
  readonly node: AcceptedProgram;
  readonly git: AcceptedProgram;
  readonly gh: AcceptedProgram;
  readonly codex: AcceptedTool;
  readonly pnpm: AcceptedTool;
  readonly repository: { readonly owner: string; readonly repo: string; readonly objectRoot: string };
  readonly github: { readonly configDirectory: string; readonly actorId: string; readonly qualification: string; readonly observationQualification: string; readonly confinementQualification: string };
  readonly mergePolicy: NativeMergePolicy;
  readonly environment: Readonly<Record<string, string>>;
}
export interface ProductionHostSnapshot {
  readonly installation: 'accepted' | 'unavailable';
  readonly reason: string;
  readonly releaseId?: string;
  readonly manifestDigest?: string;
  readonly initiationPolicy: { readonly available: boolean; readonly reason: string };
  readonly artifactVerification: 'initial-sha256/current-stat-inventory-v1';
  readonly repositoryRoot?: string;
  readonly runsDirectory: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly nativeMergeHost?: NativeMergeHost;
  readonly transport?: GhCliTransport;
  readonly gitRunner?: ProcessRunner;
  readonly codexExecutable?: string;
  readonly gitExecutable?: string;
  readonly workerHeadReadRunner?: ProcessRunner;
  readonly workerRunner?: ProcessRunner;
  readonly workerTransportSourceOwned?: boolean;
  readonly historicalCompletionHosts: readonly NativeCompletionHosts[];
  readonly historicalVerification: Readonly<Record<'review' | 'lead', { readonly available: boolean; readonly reason: string }>>;
  readonly reviewer: { readonly available: false; readonly reason: string };
  readonly lead: { readonly available: false; readonly reason: string };
  readonly assertInstallation: () => void;
  readonly assertInitiation: () => void;
  readonly assertRunInitiation: (run: Pick<Run,'execution'>) => void;
  readonly assertRecoveryScope: (owner: string, repo: string) => void;
}
const snapshots = new WeakSet<object>();
const originalNodeRun=NodeProcessRunner.prototype.run;
export function isProductionHostSnapshot(value: unknown): value is ProductionHostSnapshot { return typeof value === 'object' && value !== null && snapshots.has(value); }
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function distributionManifestDigest(manifest: Readonly<Record<string, string>>): string {
  return digest(JSON.stringify(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b))));
}
/** Content identity only; computing it never accepts or installs a release. */
export function acceptedReleaseId(record: AcceptedRelease): string {
  const { releaseId, mergePolicy, ...identity } = record;
  const normalize = (value: unknown): unknown => {
    if (typeof value === 'string') return value.replaceAll(`/releases/${releaseId}/`, '/releases/<release>/');
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,v])=>[key,normalize(v)]));
    return value;
  };
  return `release-${digest(JSON.stringify(normalize({...identity,mergePolicy:{...mergePolicy,releaseId:'<release>'}})))}`;
}
function assertClosedNodeResolution(root: string): void {
  // Node's ESM ancestor lookup and CommonJS global fallback must not supply
  // unmanifested code when an installed dependency is missing.
  assertNoAncestorDependencies(root);
  for (const global of (Module as unknown as {globalPaths: readonly string[]}).globalPaths) if (existsSync(global)) throw new Error('CommonJS global dependency fallback is outside the accepted distribution.');
  const required=createRequire(path.join(root,'package.json')).resolve('@modelcontextprotocol/sdk/client/index.js');
  if (!inside(path.join(root,'node_modules'),realpathSync(required))) throw new Error('Required runtime dependency resolves outside the accepted distribution.');
}
function assertNoAncestorDependencies(root: string): void {
  for (let ancestor=path.dirname(root);;ancestor=path.dirname(ancestor)) {
    if (existsSync(path.join(ancestor,'node_modules'))) throw new Error('Node ancestor dependency fallback is outside the accepted distribution.');
    if (path.dirname(ancestor)===ancestor) break;
  }
}

function exact(value: unknown, keys: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== keys.split(',').sort().join(',')) throw new Error('Unsupported accepted-release record shape.');
}
function nonempty(value: unknown): asserts value is string { if (typeof value !== 'string' || !value.trim()) throw new Error('Missing accepted host evidence.'); }
function inside(parent: string, child: string): boolean { const r = path.relative(parent, child); return r === '' || r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r); }
function protectedPath(home: string, target: string, type: 'file' | 'directory'): void {
  if (!path.isAbsolute(target) || path.normalize(target) !== target || !inside(path.join(home, '.tachiko-conductor'), target)) throw new Error('Accepted host paths must be canonical account-owned conductor paths.');
  assertSafeAccountOwnedPath(home, target, type);
  const s = lstatSync(target);
  if (type === 'file' && s.nlink !== 1) throw new Error('Accepted files must not have hardlink aliases.');
  if (realpathSync(target) !== target || (type === 'file' ? !s.isFile() : !s.isDirectory())) throw new Error('Accepted host path is missing or not a regular physical object.');
}
function program(home: string, p: AcceptedProgram): void {
  exact(p, 'path,sha256');
  if (!SHA.test(p.sha256)) throw new Error('Invalid accepted program digest.');
  // Pinned programs may be OS-owned outside the conductor root; inspect every ancestor.
  if (!path.isAbsolute(p.path) || path.normalize(p.path) !== p.path || realpathSync(p.path) !== p.path) throw new Error('Accepted program must use its physical absolute path.');
  if (inside(path.join(home,'.tachiko-conductor'),p.path)) { protectedPath(home,p.path,'file'); }
  let current = p.path;
  for (;;) {
    const s = lstatSync(current);
    if (inside(path.join(home,'.tachiko-conductor'),p.path)) break;
    if (s.isSymbolicLink() || s.uid !== 0 && s.uid !== process.getuid?.() || (s.mode & 0o022) !== 0 || (s.mode & 0o7000) !== 0) throw new Error(`Unsafe accepted program ancestry: ${current}; uid=${s.uid}; mode=${(s.mode&0o7777).toString(8)}.`);
    if (current === p.path && (!s.isFile() || (s.mode & 0o111) === 0)) throw new Error('Accepted program is not executable.');
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
  if(!lstatSync(p.path).isFile()||(lstatSync(p.path).mode&0o111)===0)throw new Error('Accepted program is not executable.');
  if (digest(readFileSync(p.path)) !== p.sha256) throw new Error('Accepted program bytes changed.');
}
function manifestFiles(home: string, root: string, directory = root, excludeRecord = true): Record<string, string> {
  protectedPath(home, directory, 'directory');
  const result: Record<string, string> = Object.create(null) as Record<string,string>;
  for (const name of readdirSync(directory).sort()) {
    const full = path.join(directory, name); const relative = path.relative(root, full).split(path.sep).join('/');
    if (excludeRecord && relative === 'accepted-release.json') continue;
    const s = lstatSync(full);
    if (s.isDirectory()) Object.assign(result, manifestFiles(home, root, full, excludeRecord));
    else { protectedPath(home, full, 'file'); result[relative] = digest(readFileSync(full)); }
  }
  return result;
}
function validateTool(home: string, tool: AcceptedTool, node: AcceptedProgram): void {
  exact(tool,'path,sha256,runtimeDirectory,manifest,manifestDigest');
  protectedPath(home,tool.runtimeDirectory,'directory');
  if (!inside(tool.runtimeDirectory,tool.path) || tool.path===tool.runtimeDirectory) throw new Error('Accepted tool executable escapes its complete runtime directory.');
  for(const surface of ['releases','production','repositories','workspaces','runs','dispatch','mission-admission']) {
    const forbidden=path.join(home,'.tachiko-conductor',surface);
    if(inside(forbidden,tool.runtimeDirectory)||inside(tool.runtimeDirectory,forbidden))throw new Error('Accepted tool runtime overlaps a mutable or authority surface.');
  }
  program(home,{path:tool.path,sha256:tool.sha256});
  const bytes=readFileSync(tool.path);const magic=bytes.subarray(0,4).toString('hex');
  const native=['7f454c46','cffaedfe','cefaedfe','feedfacf','feedface','cafebabe'].includes(magic);
  if(!native&&!bytes.toString('utf8').startsWith(`#!${node.path} --no-global-search-paths\n`))throw new Error('Accepted tool must be a native program or a script with the exact pinned Node/no-global-search-paths interpreter.');
  assertNoAncestorDependencies(tool.runtimeDirectory);
  const files=manifestFiles(home,tool.runtimeDirectory,tool.runtimeDirectory,false);
  if(distributionManifestDigest(files)!==tool.manifestDigest||distributionManifestDigest(tool.manifest)!==tool.manifestDigest)throw new Error('Accepted executable runtime/dependency closure changed.');
}
function installationInventory(home: string, root: string, r: AcceptedRelease): string {
  protectedPath(home,root,'directory'); protectedPath(home,r.repository.objectRoot,'directory'); protectedPath(home,r.github.configDirectory,'directory');
  const entries: unknown[] = [];
  const inspect = (file: string, immutable: boolean) => {
    const s=lstatSync(file,{bigint:true});
    entries.push([file,s.dev.toString(),s.ino.toString(),s.mode.toString(),s.uid.toString(),s.gid.toString(),...(immutable?[s.nlink.toString(),s.size.toString(),s.mtimeNs.toString(),s.ctimeNs.toString()]:[])]);
    return s;
  };
  const walk=(directory:string)=>{inspect(directory,true);for(const name of readdirSync(directory).sort()){const file=path.join(directory,name);const s=inspect(file,true);if(s.isFile()&&s.nlink!==1n)throw new Error('Installed distribution has a hardlink alias.');if(s.isSymbolicLink()||!s.isFile()&&!s.isDirectory())throw new Error('Installed distribution filesystem type changed.');if(s.isDirectory())walk(file);}};
  walk(root);
  for(const tool of [r.codex,r.pnpm]) { protectedPath(home,tool.runtimeDirectory,'directory');walk(tool.runtimeDirectory);assertNoAncestorDependencies(tool.runtimeDirectory); }
  for(const p of [r.node,r.git,r.gh,r.codex,r.pnpm]){inspect(p.path,true);for(let parent=path.dirname(p.path);;parent=path.dirname(parent)){inspect(parent,false);if(path.dirname(parent)===parent)break;}}
  inspect(r.repository.objectRoot,false);inspect(r.github.configDirectory,false);
  return digest(JSON.stringify(entries));
}
function assertRuntime(record: AcceptedRelease, entry: string): void {
  if (process.argv[1] !== entry || realpathSync(process.argv[1]) !== entry) throw new Error('Actual launched entry is outside the accepted distribution.');
  if (process.execPath !== record.node.path || process.version !== 'v24.21.0' || process.execArgv.length !== 1 || process.execArgv[0] !== '--no-global-search-paths' || process.env.NODE_OPTIONS || process.env.NODE_PATH || process.env.LD_PRELOAD || process.env.DYLD_INSERT_LIBRARIES) throw new Error('Unsupported production runtime/loader context.');
}
function readProtected(home: string, file: string): string { protectedPath(home, file, 'file'); return readFileSync(file, 'utf8'); }
function validateRelease(home: string, root: string, entry: string, raw: string): AcceptedRelease {
  const r = JSON.parse(raw) as AcceptedRelease;
  exact(r, 'schemaVersion,releaseId,sourceCommit,sourceTree,stateCompatibility,runtimePolicyRevision,entry,manifest,manifestDigest,node,git,gh,codex,pnpm,repository,github,mergePolicy,environment');
  if (r.schemaVersion !== 1 || !COMPONENT.test(r.releaseId) || r.releaseId === '.' || r.releaseId === '..' || !COMMIT.test(r.sourceCommit) || !COMMIT.test(r.sourceTree) || r.stateCompatibility !== ACCEPTED_STATE_COMPATIBILITY || r.runtimePolicyRevision !== 'issue-104-production-v7' || r.entry !== PRODUCTION_ENTRY || root !== path.join(home, '.tachiko-conductor', 'releases', r.releaseId) || entry !== path.join(root, PRODUCTION_ENTRY)) throw new Error('Installation identity or state compatibility is unavailable.');
  exact(r.repository, 'owner,repo,objectRoot'); exact(r.github, 'configDirectory,actorId,qualification,observationQualification,confinementQualification');
  for (const v of Object.values(r.github)) nonempty(v);
  if (!validMergePolicy(r.mergePolicy) || r.mergePolicy.releaseId !== r.releaseId || r.mergePolicy.owner !== r.repository.owner || r.mergePolicy.repo !== r.repository.repo) throw new Error('Accepted merge policy does not bind the installed repository.');
  protectedPath(home, r.repository.objectRoot, 'directory'); protectedPath(home, r.github.configDirectory, 'directory');
  for (const location of [root, path.join(home, '.tachiko-conductor', 'production'), path.join(home, '.tachiko-conductor', 'runs'), path.join(home, '.tachiko-conductor', 'mission-admission'), path.join(home, '.tachiko-conductor', 'workspaces')]) {
    if (inside(location, r.repository.objectRoot) || inside(r.repository.objectRoot, location)) throw new Error('Accepted object root overlaps an authority or candidate mutation surface.');
  }
  for(const location of [r.repository.objectRoot,...['releases','repositories','workspaces','runs','dispatch','mission-admission','tools'].map(name=>path.join(home,'.tachiko-conductor',name))]) { if(inside(location,r.github.configDirectory)||inside(r.github.configDirectory,location))throw new Error('Accepted GitHub namespace overlaps a candidate, immutable release or authority surface.'); }
  if (!r.environment || typeof r.environment !== 'object' || Array.isArray(r.environment) || Object.entries(r.environment).some(([k, v]) => !ENV_KEYS.has(k) || typeof v !== 'string' || v.includes('\0'))) throw new Error('Unsupported accepted environment field.');
  if (r.environment.TACHIKO_NODE_PROGRAM !== r.node.path || r.environment.TACHIKO_GIT_PROGRAM !== r.git.path || r.environment.TACHIKO_PNPM_PROGRAM !== r.pnpm.path) throw new Error('Accepted runtime policy programs disagree.');
  // Reject selected physical overlap before reading any executable or tool
  // manifest: an invalid tool tree must not cause GitHub namespace contents to
  // be read merely to decide whether that tree is acceptable.
  for(const tool of [r.codex,r.pnpm]) {
    protectedPath(home,tool.runtimeDirectory,'directory');
    for(const location of [r.repository.objectRoot,r.github.configDirectory]) {
      if(inside(location,tool.runtimeDirectory)||inside(tool.runtimeDirectory,location))throw new Error('Accepted tool runtime overlaps the selected object root or GitHub namespace.');
    }
  }
  for (const p of [r.node, r.git, r.gh]) program(home, p);
  for(const tool of [r.codex,r.pnpm]) validateTool(home,tool,r.node);
  assertRuntime(r,entry);
  if (!r.manifest || typeof r.manifest !== 'object' || Array.isArray(r.manifest) || Object.entries(r.manifest).some(([k,v]) => k === 'accepted-release.json' || k.startsWith('/') || k.split('/').some(p => !p || p === '.' || p === '..') || !SHA.test(v))) throw new Error('Invalid distribution manifest.');
  if (!r.manifest['package.json'] || !r.manifest[PRODUCTION_ENTRY] || !r.manifest['dist/production-host.js'] || !Object.keys(r.manifest).some(k => k.startsWith('node_modules/'))) throw new Error('Distribution/dependency closure is incomplete.');
  if (r.releaseId !== acceptedReleaseId(r)) throw new Error('Release ID does not bind the complete immutable installation identity.');
  assertClosedNodeResolution(root);
  const packageRecord = JSON.parse(readProtected(home,path.join(root,'package.json'))) as {type?:unknown;bin?:{tachiko?:unknown}};
  if (packageRecord.type !== 'module' || packageRecord.bin?.tachiko !== PRODUCTION_ENTRY) throw new Error('Accepted package does not select the fixed production entry.');
  const files = manifestFiles(home, root);
  if (distributionManifestDigest(files) !== r.manifestDigest || distributionManifestDigest(r.manifest) !== r.manifestDigest) throw new Error('Accepted distribution/dependency identity changed.');
  return r;
}
/** Statically linked resolver. The actual module and entry must both be in the same protected release. */
export function resolveProductionHost(entryUrl: string, runner: ProcessRunner = new NodeProcessRunner(), historical?: NativeCompletionHosts | readonly NativeCompletionHosts[]): ProductionHostSnapshot {
  const configured = historical === undefined ? [] : Array.isArray(historical) ? historical : [historical];
  const historicalCompletionHosts: readonly NativeCompletionHosts[] = Object.freeze(configured.map(context => Object.freeze(Object.fromEntries((['review','lead'] as const).flatMap(role => { const verifier = context[role]; return verifier?.receipts instanceof JsonFileOracleReceiptStore && typeof verifier.authenticate === 'function' ? [[role,Object.freeze({receipts:verifier.receipts,authenticate:verifier.authenticate.bind(verifier)})]] : []; })))));
  const historicalVerification = Object.freeze(Object.fromEntries((['review','lead'] as const).map(role => { const available=historicalCompletionHosts.some(context=>context[role]!==undefined); return [role,Object.freeze({available,reason:available ? 'Configured original receipt-store/authenticator; every retained proof still requires verification.' : `Supported historical ${role} verifier contract unavailable.`})]; }))) as ProductionHostSnapshot['historicalVerification'];
  const home = resolveAccountHomeDirectory();
  const accountRoot = path.join(home, '.tachiko-conductor');
  const runsDirectory = path.join(accountRoot, 'runs');
  const unavailable = (reason: string): ProductionHostSnapshot => {
    const refuse = () => { throw new Error(reason); };
    const s: ProductionHostSnapshot = Object.freeze({ installation: 'unavailable', reason, runsDirectory, initiationPolicy:Object.freeze({available:false,reason}), artifactVerification:'initial-sha256/current-stat-inventory-v1' as const, historicalCompletionHosts, historicalVerification, environment: Object.freeze({ HOME: home }), reviewer: Object.freeze({available:false as const, reason:'Oracle service contract unavailable.'}), lead:Object.freeze({available:false as const,reason:'Sol service contract unavailable.'}), assertInstallation:refuse, assertInitiation:refuse, assertRunInitiation:refuse, assertRecoveryScope:refuse }); snapshots.add(s); return s;
  };
  try {
    const moduleFile = fileURLToPath(import.meta.url); const entry = fileURLToPath(entryUrl); const root = path.dirname(path.dirname(moduleFile));
    if (moduleFile !== path.join(root, 'dist/production-host.js')) throw new Error('Source/development entry has no accepted installation.');
    const recordPath = path.join(root, 'accepted-release.json');
    const recordRaw = readProtected(home, recordPath); const r = validateRelease(home, root, entry, recordRaw);
    const inventory=installationInventory(home,root,r);
    let policyReason: string | undefined;
    try { assertProductionPolicyConfiguration(r.environment); if(r.environment.TACHIKO_IMPLEMENTATION_AGENT!=='luna-isolated'||r.mergePolicy.localValidationRevision!==PRODUCTION_POLICY_REVISION||r.mergePolicy.hostedValidationRevision!==PRODUCTION_POLICY_REVISION)throw new Error('Accepted initiation policy contradicts the unchanged routine-only v7 Luna contract.'); }
    catch(error){policyReason=error instanceof Error?error.message:String(error);}
    const initiationPolicy=Object.freeze({available:policyReason===undefined,reason:policyReason??'Exact routine-only v7 production configuration; held runtime/host qualification remains separate.'});
    const configFile = path.join(accountRoot, 'production/host.json'); const dispatchFile = path.join(accountRoot, 'production/dispatch.json');
    const readOptional = (file: string) => { try { return readProtected(home, file); } catch { return undefined; } };
    const hostRaw = readOptional(configFile); const dispatchRaw = readOptional(dispatchFile);
    let revoked = false;
    const assertInstallation = () => { if (readProtected(home, recordPath) !== recordRaw) throw new Error('Accepted installation changed; compatible accepted restart required.'); assertRuntime(r,entry);assertClosedNodeResolution(root);if(installationInventory(home,root,r)!==inventory)throw new Error('Accepted artifact/program filesystem identity changed; restart/requalification required.'); };
    const assertInitiation = () => {
      if (revoked) throw new Error('Production configuration drift latched; held restart/requalification required.');
      try { assertInstallation(); if(policyReason!==undefined)throw new Error(`Production initiation policy unavailable: ${policyReason}`); if (readOptional(configFile) !== hostRaw || readOptional(dispatchFile) !== dispatchRaw) throw new Error('Current production descriptor changed.'); }
      catch (e) { revoked = true; throw e; }
    };
    const assertRunInitiation=(run:Pick<Run,'execution'>)=>{assertInitiation();if(!isDeepStrictEqual(run.execution,{profile:'routine',revision:PRODUCTION_POLICY_REVISION,...PRODUCTION_EXECUTION_PROFILE_CONFIG.profiles.routine}))throw new Error('Run execution is not the current exact routine-only v7 Luna snapshot; new native initiation is unavailable.');};
    let nativeMergeHost: NativeMergeHost | undefined; let reason = 'Merge opt-in absent or disabled.';
    try {
      const h = JSON.parse(hostRaw ?? 'null') as Record<string, unknown>;
      exact(h, h?.enabled === false ? 'schemaVersion,revision,releaseId,manifestDigest,enabled' : 'schemaVersion,revision,releaseId,manifestDigest,enabled,merge');
      if (h.schemaVersion !== 1 || typeof h.revision !== 'string' || !h.revision.trim() || h.releaseId !== r.releaseId || h.manifestDigest !== r.manifestDigest) throw new Error('Current descriptor does not bind this installation.');
      if (h.enabled !== false) {
        if(policyReason!==undefined)throw new Error(`Production initiation policy unavailable: ${policyReason}`);
        if (h.enabled !== true || !validMergePolicy(h.merge) || !isDeepStrictEqual(h.merge, r.mergePolicy)) throw new Error('Current merge policy differs from accepted installation.');
        nativeMergeHost = bindNativeMergeFence(Object.freeze({ policy: Object.freeze(structuredClone(r.mergePolicy)), candidate: (base: string, head: string) => { assertInitiation(); return readMergeCandidate(r.repository.objectRoot, base, head, r.git.path, hostEnv); } }), assertInitiation);
        reason = 'Accepted merge constructor configured; actual host/service qualification remains external.';
      }
    } catch (e) { reason = `Merge unavailable: ${e instanceof Error ? e.message : String(e)}`; }
    const hostEnv: NodeJS.ProcessEnv = Object.freeze({ HOME: home, PATH: `${path.dirname(r.node.path)}:${path.dirname(r.git.path)}:/usr/bin:/bin`, LANG:'C', LC_ALL:'C', GH_CONFIG_DIR:r.github.configDirectory, GH_HOST:'github.com', GH_PROMPT_DISABLED:'1', GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:'/dev/null', GIT_CONFIG_COUNT:'0', GIT_TERMINAL_PROMPT:'0', GIT_NO_REPLACE_OBJECTS:'1' });
    const environment = Object.freeze({ ...hostEnv, ...r.environment, ...(dispatchRaw === undefined ? {} : { TACHIKO_DISPATCH_CONFIG: dispatchRaw }) });
    // Validate dispatch only on the ordinary CLI route. Malformed/absent current config must not suppress issued readback.
    const gitRunner: ProcessRunner = Object.freeze({ run: async (_file: string, args: readonly string[], options: ProcessRunOptions) => { assertInstallation(); return runner.run(r.git.path, ['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','core.attributesFile=/dev/null','-c','core.useReplaceRefs=false',...args], { ...options, env:hostEnv, beforeSpawn: () => { assertInstallation(); options.beforeSpawn?.(); } }); } });
    const sourceOwnedRunner=Object.getPrototypeOf(runner)===NodeProcessRunner.prototype&&!Object.hasOwn(runner,'run')&&NodeProcessRunner.prototype.run===originalNodeRun;
    const workerRunner:ProcessRunner=Object.freeze({run:async(file:string,args:readonly string[],options:ProcessRunOptions)=>{assertInitiation();if(sourceOwnedRunner&&(Object.getPrototypeOf(runner)!==NodeProcessRunner.prototype||Object.hasOwn(runner,'run')||NodeProcessRunner.prototype.run!==originalNodeRun))throw new Error('Accepted worker process transport changed.');if(file!==r.codex.path)throw new Error('Worker executable differs from accepted Codex.');return runner.run(file,args,{...options,beforeSpawn:()=>{assertInitiation();options.beforeSpawn?.();}});}});
    // This is deliberately narrower than the observation-safe shared Git runner.
    const workerHeadReadRunner:ProcessRunner=Object.freeze({run:async(file:string,args:readonly string[],options:ProcessRunOptions)=>{
      assertInitiation();
      if(sourceOwnedRunner&&(Object.getPrototypeOf(runner)!==NodeProcessRunner.prototype||Object.hasOwn(runner,'run')||NodeProcessRunner.prototype.run!==originalNodeRun))throw new Error('Accepted worker HEAD-read transport changed.');
      if(file!==r.git.path||args.length!==2||args[0]!=='rev-parse'||args[1]!=='HEAD')throw new Error('Worker HEAD read differs from the accepted exact Git command.');
      return gitRunner.run(file,args,{...options,beforeSpawn:()=>{assertInitiation();options.beforeSpawn?.();}});
    }});
    const transport = new GhCliTransport({ runner, executable:r.gh.path, hostname:'github.com', acceptedActorId:r.github.actorId, cwd:r.repository.objectRoot, env:hostEnv, beforeSpawn:assertInstallation, beforeMerge:assertInitiation, repository:{owner:r.repository.owner,repo:r.repository.repo} });
    const snapshot: ProductionHostSnapshot = Object.freeze({ installation:'accepted', reason, artifactVerification:'initial-sha256/current-stat-inventory-v1' as const, releaseId:r.releaseId, manifestDigest:r.manifestDigest, repositoryRoot:r.repository.objectRoot, codexExecutable:r.codex.path, gitExecutable:r.git.path, workerHeadReadRunner, workerRunner, workerTransportSourceOwned:sourceOwnedRunner, runsDirectory, initiationPolicy, environment, nativeMergeHost, transport, gitRunner, historicalCompletionHosts, historicalVerification,
      reviewer:Object.freeze({available:false as const,reason:'Oracle service contract unavailable.'}), lead:Object.freeze({available:false as const,reason:'Sol service contract unavailable.'}), assertInstallation, assertInitiation, assertRunInitiation,
      assertRecoveryScope: (owner: string, repo: string) => { assertInstallation(); if (owner !== r.repository.owner || repo !== r.repository.repo) throw new Error('Issued recovery scope differs from the compatible accepted installation.'); },
    }); snapshots.add(snapshot); return snapshot;
  } catch(e) { return unavailable(`Installation unavailable: ${e instanceof Error ? e.message : String(e)}`); }
}
