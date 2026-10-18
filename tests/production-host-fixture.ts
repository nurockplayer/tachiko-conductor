import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, constants, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import Module from 'node:module';
import { PRODUCTION_EXECUTION_PROFILE_CONFIG, PRODUCTION_LOCAL_VALIDATION_CONFIG, PRODUCTION_HOSTED_CHECK_POLICY_CONFIG, PRODUCTION_POLICY_REVISION } from '../src/production-policy.js';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import type { AcceptedRelease, ProductionHostSnapshot } from '../src/production-host.js';
import { distributionManifestDigest, acceptedReleaseId, WORKER_PNPM_ALIAS, WORKER_NODE_ALIAS, WORKER_GIT_ALIAS, workerPnpmAlias, workerNodeAlias, workerGitAlias } from '../src/production-host.js';
import type { ProcessRunner } from '../src/github/transport.js';
import type { NativeCompletionHosts } from '../src/oracle/completion-proof.js';
import type { CliNativeDependencies } from '../src/cli.js';

export const hash = (v: Buffer | string) => createHash('sha256').update(v).digest('hex');
export function manifest(root: string, dir = root): Record<string,string> {
  const result: Record<string,string> = Object.create(null) as Record<string,string>;
  for (const name of readdirSync(dir).sort()) { const file=path.join(dir,name); const rel=path.relative(root,file).split(path.sep).join('/'); if(rel==='accepted-release.json')continue;
    if(lstatSync(file).isDirectory())Object.assign(result,manifest(root,file)); else result[rel]=hash(readFileSync(file));
  } return result;
}
interface SourceEmissionStats {
  readonly cacheHit: boolean;
  readonly sourceFiles: number;
  readonly outputFiles: number;
  readonly transpiledFiles: number;
  readonly inputDigest: string;
  readonly outputDigest: string;
  readonly sourceReadMs: number;
  readonly compilerReadMs: number;
  readonly transpileMs: number;
  readonly writeMs: number;
}
interface SourcePreparation {
  readonly key: string;
  readonly transpile: typeof ts.transpileModule;
  readonly directories: readonly string[];
  readonly files: readonly Readonly<{ relative: string; text: string; sha256: string }>[];
  readonly outputDigest: string;
}
const fixtureCompilerOptions = Object.freeze({ target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 });
let sourcePreparation: SourcePreparation | undefined;
/** Only immutable emitted strings are reused. Every accepted case gets new files and full independent acceptance. */
export function emitSources(source: string, output: string, reuse = true): SourceEmissionStats {
  if (existsSync(output) && readdirSync(output).length !== 0) throw new Error('Fixture source emission requires a fresh empty output directory.');
  const directories: string[] = [];
  const inputs: { relative: string; text: string }[] = [];
  const sourceStarted = performance.now();
  const collect = (directory: string) => {
    directories.push(path.relative(source,directory));
    for (const name of readdirSync(directory).sort()) {
      const file = path.join(directory,name);
      if (lstatSync(file).isDirectory()) collect(file);
      else if (name.endsWith('.ts')) inputs.push({ relative: path.relative(source,file), text: readFileSync(file,'utf8') });
    }
  };
  collect(source);
  const inputDigest = hash(JSON.stringify({ root: realpathSync(source), directories, files: inputs.map(file => [file.relative,hash(file.text)]) }));
  const sourceReadMs = performance.now()-sourceStarted;
  const compilerStarted = performance.now();
  const transpile = ts.transpileModule;
  const compiler = realpathSync(ts.sys.getExecutingFilePath());
  const key = hash(JSON.stringify({ inputDigest, compiler, compilerDigest: hash(readFileSync(compiler)), version: ts.version, node: process.versions.node, platform: process.platform, newLine: ts.sys.newLine, options: fixtureCompilerOptions, transpile: hash(Function.prototype.toString.call(transpile)) }));
  const compilerReadMs = performance.now()-compilerStarted;
  const cacheHit = reuse && sourcePreparation !== undefined && sourcePreparation.key === key && sourcePreparation.transpile === transpile;
  let prepared = cacheHit ? sourcePreparation! : undefined;
  let transpileMs = 0, transpiledFiles = 0;
  if (prepared === undefined) {
    const started = performance.now();
    const files = inputs.map(file => {
      transpiledFiles += 1;
      const text = transpile.call(ts,file.text,{compilerOptions:{...fixtureCompilerOptions}}).outputText;
      return Object.freeze({ relative: file.relative.replace(/\.ts$/,'.js'), text, sha256: hash(text) });
    });
    transpileMs = performance.now()-started;
    prepared = Object.freeze({ key, transpile, directories: Object.freeze([...directories]), files: Object.freeze(files), outputDigest: hash(JSON.stringify(files.map(file => [file.relative,file.sha256]))) });
    if (reuse) sourcePreparation = prepared; // bounded single exact-input preparation; never accepted state
  }
  const writeStarted = performance.now();
  for (const directory of prepared.directories) mkdirSync(path.join(output,directory),{recursive:true});
  for (const file of prepared.files) writeFileSync(path.join(output,file.relative),file.text);
  return Object.freeze({ cacheHit, sourceFiles: inputs.length, outputFiles: prepared.files.length, transpiledFiles, inputDigest, outputDigest: prepared.outputDigest, sourceReadMs, compilerReadMs, transpileMs, writeMs: performance.now()-writeStarted });
}
/** Copy the real installed runtime dependency graph, without executable hydration or links. */
function copyDependency(name: string, from: string, destination: string, copied = new Map<string,string>()): void {
  let search=from; let source: string | undefined;
  for (;;) {
    const candidate=path.join(search,'node_modules',name);
    if(existsSync(path.join(candidate,'package.json'))){source=realpathSync(candidate);break;}
    const parent=path.dirname(search);if(parent===search)throw new Error(`Cannot locate installed dependency ${name}`);search=parent;
  }
  if(copied.get(name)===source)return;
  const target=path.join(destination,name); mkdirSync(path.dirname(target),{recursive:true});
  cpSync(source,target,{recursive:true,dereference:true,filter:p=>path.basename(p)!=='node_modules'}); copied.set(name,source);
  const pkg=JSON.parse(readFileSync(path.join(source,'package.json'),'utf8')) as {dependencies?:Record<string,string>};
  for(const dependency of Object.keys(pkg.dependencies??{}))copyDependency(dependency,source,destination,copied);
}
/** Only the newly created account tree is normalized; shared source/tools are never chmodded. */
function privateFixtureTree(root: string): void {
  const info=lstatSync(root);
  assert.equal(info.isSymbolicLink(),false,'Fixture permission normalization refuses links');
  if(info.isDirectory()) { chmodSync(root,0o700);for(const name of readdirSync(root))privateFixtureTree(path.join(root,name)); }
  else { assert.equal(info.isFile(),true);chmodSync(root,(info.mode&0o111)!==0?0o700:0o600); }
}
/** Same permission specification on independent transpile and real-compiler fixtures. */
export function assertPrivateFixturePermissions(home: string, release: string): void {
  const visit = (directory: string) => {
    assert.equal(lstatSync(directory).mode & 0o077, 0, directory);
    for (const name of readdirSync(directory)) {
      const file = path.join(directory,name), stat = lstatSync(file);
      assert.equal(stat.isSymbolicLink(),false,file);assert.equal(stat.mode & 0o077,0,file);
      if (stat.isDirectory()) visit(file);
    }
  };
  visit(home);
  assert.ok(lstatSync(path.join(release,'dist/mission-admission')).isDirectory());
  assert.ok(lstatSync(path.join(release,'dist/oracle/receipt-store.js')).isFile());
}
export async function installedFixture(fullCli = false, compiled = false, environmentPatch: Readonly<Record<string,string>> = {}, options:{browserFixture?:'manifested'|'global-only';omitEnvironment?:readonly ('TACHIKO_LUNA_CODEX_HOME'|'TACHIKO_PNPM_DEPENDENCY_ARTIFACT'|'TACHIKO_PLAYWRIGHT_BROWSERS_PATH')[];profileLabel?:'held-control'|'command-authority'|'manual-registry'|'manual-recovery'|'merge-settlement';githubActorId?:string;lunaHome?:boolean;nodeBasename?:string;gitBasename?:string;gitNamespace?:string;controlledGitIdentity?:boolean;pathDelimiterInHome?:boolean;githubNamespace?:string;objectNamespace?:string;toolNamespaces?:Partial<Record<'codex'|'pnpm',string>>;toolInterpreter?:'ambient-node';codexRuntime?:string|((programs:{node:string;git:string})=>string);workerAlias?:'missing'|'unsupported';workerCommandAlias?:{name:'node'|'git';state:'missing'|'unsupported'};githubFixtureFile?:boolean;expectedRejection?:RegExp}={}) {
  const timingStart = performance.now();
  let fenceTiming: { calls: number; durationMs: number } | undefined;
  let emission: SourceEmissionStats | undefined;
  let timingReports = 0;
  const reportTiming = (phase: 'fixture-start'|'source-emitted'|'dependencies-copied'|'tools-copied'|'fixture-prepared'|'manifest-sealed'|'initial-resolved'|'fixture-ready'|'command-start'|'command-completed'|'cleanup', sampleMs: number, command = 'none') => {
    if (options.profileLabel === undefined || (timingReports >= 12 && phase !== 'cleanup')) return;
    timingReports += 1;
    const record = { caseLabel: options.profileLabel, phase, command, elapsedMs: performance.now() - timingStart, sampleMs, fenceCalls: fenceTiming?.calls ?? 0, fenceMs: fenceTiming?.durationMs ?? 0, emissionMode: compiled ? 'compiled' : 'transpile', emissionCacheHit: emission?.cacheHit ?? null, emissionSourceFiles: emission?.sourceFiles ?? 0, emissionOutputFiles: emission?.outputFiles ?? 0, emissionTranspiledFiles: emission?.transpiledFiles ?? 0, sourceReadMs: emission?.sourceReadMs ?? 0, compilerReadMs: emission?.compilerReadMs ?? 0, transpileMs: emission?.transpileMs ?? 0, emissionWriteMs: emission?.writeMs ?? 0 };
    assert.ok([record.elapsedMs, record.sampleMs, record.fenceCalls, record.fenceMs, record.emissionSourceFiles, record.emissionOutputFiles, record.emissionTranspiledFiles, record.sourceReadMs, record.compilerReadMs, record.transpileMs, record.emissionWriteMs].every(value => Number.isFinite(value) && value >= 0));
    process.stderr.write('STAGE10_AUTHORITY_TIMING ' + JSON.stringify(record) + '\n');
  };
  reportTiming('fixture-start', 0);
  const home=mkdtempSync(path.join(os.tmpdir(),options.pathDelimiterInHome?'tachiko-accepted-path:':'tachiko-accepted-'));
  const accountRoot=path.join(home,'.tachiko-conductor'); let release=path.join(accountRoot,'releases/accepted-fixture');
  mkdirSync(release,{recursive:true});
  const emissionStarted = performance.now();
  if(compiled){const config=ts.readConfigFile(path.resolve('tsconfig.json'),ts.sys.readFile);const parsed=ts.parseJsonConfigFileContent(config.config,ts.sys,process.cwd(),{outDir:path.join(release,'dist')});const program=ts.createProgram(parsed.fileNames,parsed.options);const result=program.emit();if(result.emitSkipped || ts.getPreEmitDiagnostics(program).length)throw new Error('Actual production TypeScript compilation failed.');}
  else emission = emitSources(path.resolve('src'),path.join(release,'dist'));
  reportTiming('source-emitted',performance.now()-emissionStarted);
  if (options.profileLabel !== undefined) {
    // Test-only measurement of the actual accepted fence. This exact wrapper
    // is sealed into this private fixture's manifest; it never skips authority.
    const file = path.join(release, 'dist/production-host.js');
    const source = readFileSync(file, 'utf8');
    const marker = 'const assertInstallation = () => {';
    assert.equal(source.split(marker).length, 2);
    const start = source.indexOf(marker), end = source.indexOf('const assertInitiation =', start);
    assert.ok(end > start);
    const declaration = source.slice(start, end), close = declaration.lastIndexOf('};');
    assert.ok(close > marker.length);
    const body = declaration.slice(marker.length, close);
    const measured = 'const assertInstallation = () => { const started = performance.now(); try {' + body + '} finally { controlledInstallationTiming.calls += 1; controlledInstallationTiming.durationMs += performance.now() - started; } };\n    ';
    writeFileSync(file, 'export const controlledInstallationTiming = { calls: 0, durationMs: 0 };\n' + source.slice(0, start) + measured + source.slice(end));
  }
  mkdirSync(path.join(release,'scripts'));
  for(const script of ['dispatch-driver.sh','issue-104-deploy.sh'])copyFileSync(path.resolve('scripts',script),path.join(release,'scripts',script));
  writeFileSync(path.join(release,'package.json'),JSON.stringify({type:'module',bin:{tachiko:'dist/production-entry.js'}}));
  const dependencyStarted = performance.now();
  copyDependency('@modelcontextprotocol/sdk',process.cwd(),path.join(release,'node_modules'));
  { mkdirSync(path.join(release,'node_modules/closed-dependency'),{recursive:true});writeFileSync(path.join(release,'node_modules/closed-dependency/package.json'),'{}'); }
  if (options.browserFixture !== undefined) {
    const mcp = path.join(release,'node_modules/@playwright/mcp');mkdirSync(mcp,{recursive:true});
    writeFileSync(path.join(mcp,'package.json'),JSON.stringify({name:'@playwright/mcp',main:'cli.js'}));
    copyFileSync(path.resolve('tests/fixtures/accepted-browser-mcp.cjs'),path.join(mcp,'cli.js'));
    const dependency = options.browserFixture === 'manifested' ? path.join(release,'node_modules/controlled-browser-dependency') : path.join(home,'.node_modules/controlled-browser-dependency');
    mkdirSync(dependency,{recursive:true});writeFileSync(path.join(dependency,'package.json'),JSON.stringify({type:'commonjs',main:'index.js'}));writeFileSync(path.join(dependency,'index.js'),'module.exports = '+JSON.stringify(options.browserFixture)+';\n');
    mkdirSync(path.join(accountRoot,'browsers'),{recursive:true});
  }
  privateFixtureTree(release);
  reportTiming('dependencies-copied',performance.now()-dependencyStarted);
  const admissionDirectory=path.join(accountRoot,'mission-admission');mkdirSync(admissionDirectory,{recursive:true,mode:0o700});writeFileSync(path.join(admissionDirectory,'registry.json'),JSON.stringify({schemaVersion:1,revision:0,config:{schemaVersion:1,revision:'mission-admission-v1',limits:{maxCaptains:1,maxWriters:1,maxHighAutonomy:1}},lanes:[],lastTransition:null}),{mode:0o600});
  const objectRoot=path.join(accountRoot,options.objectNamespace??'repositories/objects'); const configDirectory=path.join(accountRoot,options.githubNamespace??'production/github');
  mkdirSync(objectRoot,{recursive:true});mkdirSync(configDirectory,{recursive:true,mode:0o700});
  if(options.githubFixtureFile)writeFileSync(path.join(configDirectory,'controlled-placeholder.json'),'Controlled noncredential fixture bytes\n',{mode:0o600});
  const toolsStarted = performance.now();
  const actualNode=process.execPath;const tools=path.join(accountRoot,'tools');mkdirSync(tools,{recursive:true});
  const node=path.join(tools,options.nodeBasename??'node');const git=path.join(accountRoot,options.gitNamespace??'tools',options.gitBasename??'git');mkdirSync(path.dirname(git),{recursive:true});copyFileSync(realpathSync(process.execPath),node,constants.COPYFILE_FICLONE);if(options.controlledGitIdentity)writeFileSync(git,`#!${node} --no-global-search-paths\nif(process.argv[2]==='--exit-23')process.exit(23);process.stdout.write(JSON.stringify({program:process.argv[1],args:process.argv.slice(2)})+'\\n');\n`);else copyFileSync(realpathSync('/usr/bin/git'),git,constants.COPYFILE_FICLONE);chmodSync(node,0o755);chmodSync(git,0o755);
  const tool=(name:string)=>{const runtimeDirectory=path.join(accountRoot,options.toolNamespaces?.[name as 'codex'|'pnpm']??`tools/${name}`);mkdirSync(runtimeDirectory,{recursive:true});const file=path.join(runtimeDirectory,name+'.cjs');writeFileSync(file,`#!${options.toolInterpreter==='ambient-node'?'/usr/bin/env node':`${node} --no-global-search-paths`}\nrequire('./runtime.cjs');\n`,{mode:0o755});writeFileSync(path.join(runtimeDirectory,'runtime.cjs'),name==='codex'&&options.codexRuntime!==undefined?(typeof options.codexRuntime==='function'?options.codexRuntime({node,git}):options.codexRuntime):`process.stdout.write('${name==='pnpm'?'10.34.5':'controlled-no-model'}\\n');\n`);privateFixtureTree(runtimeDirectory);const files=manifest(runtimeDirectory);return{path:file,sha256:hash(readFileSync(file)),runtimeDirectory,manifest:files,manifestDigest:distributionManifestDigest(files)};};
  const codex=tool('codex');const pnpm=tool('pnpm');
  mkdirSync(path.dirname(path.join(release, WORKER_PNPM_ALIAS)), { recursive: true, mode: 0o700 });
  if(options.workerAlias!=='missing')writeFileSync(path.join(release, WORKER_PNPM_ALIAS), options.workerAlias==='unsupported'?'#!/bin/sh\nexit 99\n':workerPnpmAlias(node, pnpm.path), { mode: 0o700 });
  for(const name of ['node','git'] as const){const state=options.workerCommandAlias?.name===name?options.workerCommandAlias.state:options.workerAlias==='unsupported'?'unsupported':undefined;if(state!=='missing')writeFileSync(path.join(release,'worker-bin',name),state==='unsupported'?'#!/bin/sh\nexit 99\n':name==='node'?workerNodeAlias(node):workerGitAlias(node,git),{mode:0o700});}
  reportTiming('tools-copied',performance.now()-toolsStarted);
  const policy={enabled:true,revision:'merge-v1',releaseId:'accepted-fixture',campaign:'bounded-v1',dispatchRevision:'dispatch-v1',owner:'acme',repo:'widgets',controlIssue:1,queueCommentId:2,baseBranch:'main',method:'squash',integrationPolicy:'bootstrap-base-tree-v1',reviewPolicyRevision:'independent-unpromoted-v1',localValidationRevision:PRODUCTION_POLICY_REVISION,hostedValidationRevision:PRODUCTION_POLICY_REVISION} as const;
  const record:AcceptedRelease={schemaVersion:1,releaseId:'accepted-fixture',sourceCommit:'a'.repeat(40),sourceTree:'b'.repeat(40),stateCompatibility:'conductor-native-state-v1',runtimePolicyRevision:'issue-104-production-v7',entry:'dist/production-entry.js',manifest:manifest(release),manifestDigest:'',node:{path:node,sha256:hash(readFileSync(node))},git:{path:git,sha256:hash(readFileSync(git))},gh:{path:git,sha256:hash(readFileSync(git))},codex,pnpm,repository:{owner:'acme',repo:'widgets',objectRoot},github:{configDirectory,actorId:options.githubActorId??'123',qualification:'controlled actor evidence only',observationQualification:'controlled readback evidence only',confinementQualification:'controlled fixture boundary only'},mergePolicy:policy,environment:{TACHIKO_NODE_PROGRAM:node,TACHIKO_GIT_PROGRAM:git,TACHIKO_IMPLEMENTATION_AGENT:'luna-isolated',TACHIKO_EXECUTION_PROFILE_CONFIG:JSON.stringify(PRODUCTION_EXECUTION_PROFILE_CONFIG),TACHIKO_LOCAL_VALIDATION_CONFIG:JSON.stringify(PRODUCTION_LOCAL_VALIDATION_CONFIG),TACHIKO_HOSTED_CHECK_POLICY_CONFIG:JSON.stringify(PRODUCTION_HOSTED_CHECK_POLICY_CONFIG),TACHIKO_PNPM_PROGRAM:pnpm.path,TACHIKO_PNPM_DEPENDENCY_ARTIFACT:path.join(accountRoot,'dependencies'),TACHIKO_PLAYWRIGHT_BROWSERS_PATH:path.join(accountRoot,'browsers'),...environmentPatch}};
  if(options.lunaHome!==false){const lunaHome=path.join(accountRoot,'luna');mkdirSync(lunaHome);writeFileSync(path.join(lunaHome,'config.toml'),'tachiko_luna_runtime_revision = \"luna-qualified-runtime-v1\"\nplugins = false\napps = false\nmcp_servers = {}\nweb_search = false\nnetwork_access = false\n');(record.environment as Record<string,string>).TACHIKO_LUNA_CODEX_HOME??=lunaHome;}
  for (const key of options.omitEnvironment ?? []) delete (record.environment as Record<string,string>)[key];
  privateFixtureTree(home);
  reportTiming('fixture-prepared', performance.now()-timingStart);
  const nextId=acceptedReleaseId({...record,manifestDigest:distributionManifestDigest(record.manifest)});
  (record as {releaseId:string}).releaseId=nextId;(policy as {releaseId:string}).releaseId=nextId;
  const acceptedDirectory=path.join(accountRoot,'releases',nextId);renameSync(release,acceptedDirectory);release=acceptedDirectory;
  mkdirSync(path.join(accountRoot,'production'),{recursive:true,mode:0o700});
  const recordPath=path.join(release,'accepted-release.json'); const hostPath=path.join(accountRoot,'production/host.json'); const dispatchPath=path.join(accountRoot,'production/dispatch.json');
  const accept=()=>{const started=performance.now();try{(record as {manifest:Record<string,string>}).manifest=manifest(release);(record as {manifestDigest:string}).manifestDigest=distributionManifestDigest(record.manifest);if(acceptedReleaseId(record)!==record.releaseId)throw new Error('Fixture cannot reuse a release ID for changed installation bytes.');writeFileSync(recordPath,JSON.stringify(record),{mode:0o600});}finally{reportTiming('manifest-sealed',performance.now()-started);}};accept();
  const enable=(enabled=true)=>writeFileSync(hostPath,JSON.stringify({schemaVersion:1,revision:'host-v1',releaseId:record.releaseId,manifestDigest:record.manifestDigest,enabled,...(enabled?{merge:policy}:{})}),{mode:0o600});enable();
  const dispatch={revision:'dispatch-v1',owner:'acme',repo:'widgets',controlIssue:1,queueCommentId:2,leaseDurationMs:60000,merge:policy};writeFileSync(dispatchPath,JSON.stringify(dispatch),{mode:0o600});
  const userInfo=os.userInfo; const execArgv=process.execArgv;const argv=process.argv; const moduleState=Module as unknown as {globalPaths:string[]};const previousGlobalPaths=moduleState.globalPaths; const environment={...process.env}; const cwd=process.cwd();
  os.userInfo=(()=>({...userInfo(),homedir:home})) as typeof os.userInfo;process.execArgv=['--no-global-search-paths'];process.execPath=node;process.argv=[node,path.join(release,'dist/production-entry.js')];moduleState.globalPaths=[];
  delete process.env.NODE_OPTIONS; delete process.env.NODE_PATH;delete process.env.LD_PRELOAD; delete process.env.DYLD_INSERT_LIBRARIES;
  const hostModule=await import(pathToFileURL(path.join(release,'dist/production-host.js')).href) as {resolveProductionHost:(entry:string,runner?:ProcessRunner,historical?:NativeCompletionHosts)=>ProductionHostSnapshot;controlledInstallationTiming?:{calls:number;durationMs:number}};
  fenceTiming = hostModule.controlledInstallationTiming;
  const entryUrl=pathToFileURL(path.join(release,'dist/production-entry.js')).href;
  const resolve=(runner?:ProcessRunner,historical?:NativeCompletionHosts)=>hostModule.resolveProductionHost(entryUrl,runner,historical);
  const invoke=async(argv:string[],dependencies:CliNativeDependencies & {runner?:ProcessRunner}={})=>{
    const mod=await import(entryUrl) as {productionMain:(argv:string[],dependencies?:CliNativeDependencies & {runner?:ProcessRunner})=>Promise<number>};
    const started = performance.now();
    reportTiming('command-start', 0, ['dispatch','run','wait','browser','production'].includes(argv[0]??'') ? argv[0]! : 'other');
    try { return await mod.productionMain(argv,dependencies); }
    finally { reportTiming('command-completed', performance.now()-started, ['dispatch','run','wait','browser','production'].includes(argv[0]??'') ? argv[0]! : 'other'); }
  };
  const cleanup=()=>{const started=performance.now();process.execPath=actualNode;os.userInfo=userInfo;process.execArgv=execArgv;process.argv=argv;moduleState.globalPaths=previousGlobalPaths;for(const k of Object.keys(process.env))delete process.env[k];Object.assign(process.env,environment);process.chdir(cwd);rmSync(home,{recursive:true,force:true});reportTiming('cleanup',performance.now()-started);};
  const acceptanceStarted = performance.now();
  try{const baseline=resolve();if(options.expectedRejection){assert.equal(baseline.installation,'unavailable');assert.match(baseline.reason,options.expectedRejection);}else assert.equal(baseline.installation,'accepted',baseline.reason);}catch(error){cleanup();throw error;}
  reportTiming('initial-resolved', performance.now()-acceptanceStarted);
  reportTiming('fixture-ready', performance.now()-timingStart);
  return {home,accountRoot,release,objectRoot,record,recordPath,hostPath,dispatchPath,dispatch,policy,accept,enable,resolve,invoke,entryUrl,
    cleanup};
}
