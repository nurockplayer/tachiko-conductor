import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import Module from 'node:module';
import { PRODUCTION_EXECUTION_PROFILE_CONFIG, PRODUCTION_LOCAL_VALIDATION_CONFIG, PRODUCTION_HOSTED_CHECK_POLICY_CONFIG, PRODUCTION_POLICY_REVISION } from '../src/production-policy.js';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import type { AcceptedRelease, ProductionHostSnapshot } from '../src/production-host.js';
import { distributionManifestDigest, acceptedReleaseId } from '../src/production-host.js';
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
function emitSources(source: string, output: string): void {
  mkdirSync(output,{recursive:true});
  for(const n of readdirSync(source)) { const file=path.join(source,n); if(lstatSync(file).isDirectory())emitSources(file,path.join(output,n));
    else if(n.endsWith('.ts'))writeFileSync(path.join(output,n.replace(/\.ts$/,'.js')),ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText);
  }
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
export async function installedFixture(fullCli = false, compiled = false, environmentPatch: Readonly<Record<string,string>> = {}) {
  const home=mkdtempSync(path.join(os.tmpdir(),'tachiko-accepted-'));
  const accountRoot=path.join(home,'.tachiko-conductor'); let release=path.join(accountRoot,'releases/accepted-fixture');
  mkdirSync(release,{recursive:true});
  if(compiled){const config=ts.readConfigFile(path.resolve('tsconfig.json'),ts.sys.readFile);const parsed=ts.parseJsonConfigFileContent(config.config,ts.sys,process.cwd(),{outDir:path.join(release,'dist')});const program=ts.createProgram(parsed.fileNames,parsed.options);const result=program.emit();if(result.emitSkipped || ts.getPreEmitDiagnostics(program).length)throw new Error('Actual production TypeScript compilation failed.');}
  else emitSources(path.resolve('src'),path.join(release,'dist'));
  writeFileSync(path.join(release,'package.json'),JSON.stringify({type:'module',bin:{tachiko:'dist/production-entry.js'}}));
  copyDependency('@modelcontextprotocol/sdk',process.cwd(),path.join(release,'node_modules'));
  { mkdirSync(path.join(release,'node_modules/closed-dependency'),{recursive:true});writeFileSync(path.join(release,'node_modules/closed-dependency/package.json'),'{}'); }
  const admissionDirectory=path.join(accountRoot,'mission-admission');mkdirSync(admissionDirectory,{recursive:true,mode:0o700});writeFileSync(path.join(admissionDirectory,'registry.json'),JSON.stringify({schemaVersion:1,revision:0,config:{schemaVersion:1,revision:'mission-admission-v1',limits:{maxCaptains:1,maxWriters:1,maxHighAutonomy:1}},lanes:[],lastTransition:null}),{mode:0o600});
  const objectRoot=path.join(accountRoot,'repositories/objects'); const configDirectory=path.join(accountRoot,'production/github');
  mkdirSync(objectRoot,{recursive:true});mkdirSync(configDirectory,{recursive:true});
  const node=realpathSync(process.execPath); const git=realpathSync('/usr/bin/git');
  const policy={enabled:true,revision:'merge-v1',releaseId:'accepted-fixture',campaign:'bounded-v1',dispatchRevision:'dispatch-v1',owner:'acme',repo:'widgets',controlIssue:1,queueCommentId:2,baseBranch:'main',method:'squash',integrationPolicy:'bootstrap-base-tree-v1',reviewPolicyRevision:'independent-unpromoted-v1',localValidationRevision:PRODUCTION_POLICY_REVISION,hostedValidationRevision:PRODUCTION_POLICY_REVISION} as const;
  const record:AcceptedRelease={schemaVersion:1,releaseId:'accepted-fixture',sourceCommit:'a'.repeat(40),sourceTree:'b'.repeat(40),stateCompatibility:'conductor-native-state-v1',runtimePolicyRevision:'issue-104-production-v7',entry:'dist/production-entry.js',manifest:manifest(release),manifestDigest:'',node:{path:node,sha256:hash(readFileSync(node))},git:{path:git,sha256:hash(readFileSync(git))},gh:{path:git,sha256:hash(readFileSync(git))},repository:{owner:'acme',repo:'widgets',objectRoot},github:{configDirectory,actorId:'123',qualification:'controlled actor evidence only',observationQualification:'controlled readback evidence only',confinementQualification:'controlled fixture boundary only'},mergePolicy:policy,environment:{TACHIKO_NODE_PROGRAM:node,TACHIKO_GIT_PROGRAM:git,TACHIKO_IMPLEMENTATION_AGENT:'luna-isolated',TACHIKO_EXECUTION_PROFILE_CONFIG:JSON.stringify(PRODUCTION_EXECUTION_PROFILE_CONFIG),TACHIKO_LOCAL_VALIDATION_CONFIG:JSON.stringify(PRODUCTION_LOCAL_VALIDATION_CONFIG),TACHIKO_HOSTED_CHECK_POLICY_CONFIG:JSON.stringify(PRODUCTION_HOSTED_CHECK_POLICY_CONFIG),TACHIKO_PNPM_PROGRAM:node,TACHIKO_PNPM_DEPENDENCY_ARTIFACT:path.join(accountRoot,'dependencies'),TACHIKO_PLAYWRIGHT_BROWSERS_PATH:path.join(accountRoot,'browsers'),...environmentPatch}};
  const nextId=acceptedReleaseId({...record,manifestDigest:distributionManifestDigest(record.manifest)});
  (record as {releaseId:string}).releaseId=nextId;(policy as {releaseId:string}).releaseId=nextId;
  const acceptedDirectory=path.join(accountRoot,'releases',nextId);renameSync(release,acceptedDirectory);release=acceptedDirectory;
  const recordPath=path.join(release,'accepted-release.json'); const hostPath=path.join(accountRoot,'production/host.json'); const dispatchPath=path.join(accountRoot,'production/dispatch.json');
  const accept=()=>{(record as {manifest:Record<string,string>}).manifest=manifest(release);(record as {manifestDigest:string}).manifestDigest=distributionManifestDigest(record.manifest);if(acceptedReleaseId(record)!==record.releaseId)throw new Error('Fixture cannot reuse a release ID for changed installation bytes.');writeFileSync(recordPath,JSON.stringify(record));};accept();
  const enable=(enabled=true)=>writeFileSync(hostPath,JSON.stringify({schemaVersion:1,revision:'host-v1',releaseId:record.releaseId,manifestDigest:record.manifestDigest,enabled,...(enabled?{merge:policy}:{})}));enable();
  const dispatch={revision:'dispatch-v1',owner:'acme',repo:'widgets',controlIssue:1,queueCommentId:2,leaseDurationMs:60000,merge:policy};writeFileSync(dispatchPath,JSON.stringify(dispatch));
  const userInfo=os.userInfo; const execArgv=process.execArgv;const argv=process.argv; const moduleState=Module as unknown as {globalPaths:string[]};const previousGlobalPaths=moduleState.globalPaths; const environment={...process.env}; const cwd=process.cwd();
  os.userInfo=(()=>({...userInfo(),homedir:home})) as typeof os.userInfo;process.execArgv=['--no-global-search-paths'];process.argv=[process.execPath,path.join(release,'dist/production-entry.js')];moduleState.globalPaths=[];
  delete process.env.NODE_OPTIONS; delete process.env.NODE_PATH;delete process.env.LD_PRELOAD; delete process.env.DYLD_INSERT_LIBRARIES;
  const hostModule=await import(pathToFileURL(path.join(release,'dist/production-host.js')).href) as {resolveProductionHost:(entry:string,runner?:ProcessRunner,historical?:NativeCompletionHosts)=>ProductionHostSnapshot};
  const entryUrl=pathToFileURL(path.join(release,'dist/production-entry.js')).href;
  const resolve=(runner?:ProcessRunner,historical?:NativeCompletionHosts)=>hostModule.resolveProductionHost(entryUrl,runner,historical);
  const invoke=async(argv:string[],dependencies:CliNativeDependencies & {runner?:ProcessRunner}={})=>{
    const mod=await import(entryUrl) as {productionMain:(argv:string[],dependencies?:CliNativeDependencies & {runner?:ProcessRunner})=>Promise<number>};
    return mod.productionMain(argv,dependencies);
  };
  return {home,accountRoot,release,objectRoot,record,recordPath,hostPath,dispatchPath,dispatch,policy,accept,enable,resolve,invoke,entryUrl,
    cleanup:()=>{os.userInfo=userInfo;process.execArgv=execArgv;process.argv=argv;moduleState.globalPaths=previousGlobalPaths;for(const k of Object.keys(process.env))delete process.env[k];Object.assign(process.env,environment);process.chdir(cwd);rmSync(home,{recursive:true,force:true});}};
}
