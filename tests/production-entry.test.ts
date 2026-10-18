import assert from 'node:assert/strict';
import childProcess, { execFileSync, spawnSync } from 'node:child_process';
import fs, { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { traceCut } from './stage10-diagnostics.js';
import { NodeProcessRunner } from '../src/github/transport.js';
import type { ProcessRunner, ProcessResult } from '../src/github/transport.js';
import type { NativeOracleEvidence, NativeReviewerHost } from '../src/oracle/types.js';
import { readNativeSourceManifest, oracleDigest } from '../src/oracle/source-evidence.js';
import { JsonFileOracleReceiptStore } from '../src/oracle/receipt-store.js';
import { JsonFileStore } from '../src/store/json-file-store.js';
import { createRun } from '../src/domain/run.js';
import { applyTransition } from '../src/domain/state-machine.js';
import { DISPATCH_QUEUE_MARKER, renderDispatchRuntime, selectDispatchRuntime } from '../src/dispatch/queue.js';
import { readRunOwnerReceipt } from '../src/mission-admission/run-owner-receipt.js';
import { createHostAdmissionRegistry, resolveRunOwnerReceiptPath } from '../src/mission-admission/host-registry.js';
import { operationalRuntimeProjectionPath, readOperationalRuntimeProjection, setMaintenanceHold } from '../src/operational/runtime-projection.js';
import { pathToFileURL } from 'node:url';
import { acquireDispatchInvocationLock } from '../src/dispatch/invocation-lock.js';
import { hasAuthenticatedCompletion, type NativeCompletionHosts } from '../src/oracle/completion-proof.js';
import { PRODUCTION_POLICY_REVISION } from '../src/production-policy.js';
import type { Run } from '../src/domain/types.js';
import { dispatchOnceCommand } from '../src/dispatch/command.js';
import { runIssueCommand } from '../src/cli.js';
import { fixture as leadRepairFixture } from './native-lead-fixture.js';
import { installedFixture } from './production-host-fixture.js';
import { TARGET, T0, approval, successResult, validationPassed } from './helpers.js';
import type { GitHubLiveSnapshot } from '../src/adapters/github.js';
import { ORIGINAL_ISSUE, ORIGINAL_SCOPE, originalHandoffComment, canonicalProducerSnapshot } from './production-entry-authority.js';
import { originalImplementationMatches } from '../src/domain/implementation-authority.js';
import { acceptedScopeFromHandoff, buildImplementationPacket } from '../src/agents/implementation-packet.js';

interface ImportedHistory { run: Run; objectRepository: string; receiptRoot: string; reviewer: NativeReviewerHost; lead: NonNullable<NativeCompletionHosts['lead']>; registry: object; ownerReceipt: Buffer; claimBody: string }
async function commandFixture(imported?: ImportedHistory) {
  const f=await installedFixture(true);f.enable(false);
  const RealDate=Date; let clock=RealDate.parse(T0);
  try {
  globalThis.Date = class extends RealDate { constructor(value?: string | number) { super(value ?? clock); } static override now() { return clock; } } as DateConstructor;
  const InstalledStore = (await import(pathToFileURL(path.join(f.release,'dist/store/json-file-store.js')).href) as typeof import('../src/store/json-file-store.js')).JsonFileStore;
  const InstalledReceipts = (await import(pathToFileURL(path.join(f.release,'dist/oracle/receipt-store.js')).href) as typeof import('../src/oracle/receipt-store.js')).JsonFileOracleReceiptStore;
  const git=(...args:string[])=>execFileSync(f.record.git.path,['-c','user.name=Controlled fixture','-c','user.email=fixture@example.invalid',...args],{cwd:f.objectRoot,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  if(imported)cpSync(imported.objectRepository,f.objectRoot,{recursive:true});
  else{git('init','--quiet','--initial-branch=main');writeFileSync(path.join(f.objectRoot,'README.md'),'base\n');git('add','.');git('commit','--quiet','-m','base');}
  const base=imported?.run.bootstrap?.baseSha??git('rev-parse','HEAD');
  if(!imported){writeFileSync(path.join(f.objectRoot,'README.md'),'candidate\n');git('commit','--quiet','-am','candidate');}
  const head=imported?.run.headSha??git('rev-parse','HEAD');const tree=git('rev-parse',`${head}^{tree}`);const squash=git('commit-tree',tree,'-p',base,'-m','actual controlled squash');
  const runId=imported?.run.id??'run-native';const branch=imported?.run.bootstrap?.publicationBranch??imported?.run.bootstrap?.branch??'candidate';
  const calls:{method:string;path:string;args:readonly string[]}[]=[];let modelCalls=0;let observationUnavailable=false;let squashes=0;let queueReads=0;let merged=false;let lostAck=false;let actorId='123';const tokenA='synthetic-private-actor-A',tokenB='synthetic-private-actor-B';let namespaceToken=tokenA;let captures=0;let boundActorGets=0;let boundPuts=0;let captureFailure:ProcessResult|Error|undefined;let actorResponse:unknown;let afterActor:(()=>void)|undefined;let beforePut:(()=>void)|undefined;let baseDrift=false;let validationCalls=0;let submissions=0;
  let processHook:((endpoint:string)=>void)|undefined;let validationHook:(()=>Promise<void>)|undefined;
  let runtime=[{id:9,body:renderDispatchRuntime({issue:42,claimId:'claim-native',runId:'run-native',profile:'routine',repairTaskShapeAuthority:{revision:'task-v1',shape:'bounded'},state:'running',claimedAt:T0,heartbeatAt:T0,leaseUntil:T0})}];
  if(imported)runtime=[{id:9,body:imported.claimBody}];
  const pr=()=>({node_id:'PR_7',number:7,title:imported?'Fixture':'native candidate',body:'Closes #42',state:merged?'closed':'open',merged,draft:false,html_url:'https://github.com/acme/widgets/pull/7',mergeable:true,mergeable_state:'clean',updated_at:T0,merged_at:merged?T0:null,merge_commit_sha:merged?squash:null,head:{sha:head,ref:branch,repo:{name:'widgets',owner:{login:'acme'}}},base:{sha:baseDrift?'f'.repeat(40):base,ref:'main',repo:{name:'widgets',owner:{login:'acme'}}}});
  const runner:ProcessRunner={async run(file,args,options){if(args.includes('PUT')&&args.some(a=>/\/pulls\/[0-9]+\/merge$/.test(a)))beforePut?.();options.beforeSpawn?.();assert.equal(file,f.record.gh.path);assert.equal(options.cwd,f.objectRoot);assert.equal(options.env?.GH_CONFIG_DIR,f.record.github.configDirectory);if(args[0]==='auth'){assert.deepEqual(args,['auth','token','--hostname','github.com']);assert.equal(options.env?.GH_TOKEN===undefined,true);captures++;processHook?.('auth-token');if(captureFailure instanceof Error)throw captureFailure;return captureFailure??{exitCode:0,stdout:namespaceToken+'\n',stderr:''};}assert.equal(args[1],'--hostname');assert.equal(args[2],'github.com');const methodIndex=args.indexOf('--method');const method=methodIndex<0?'GET':args[methodIndex+1]!;const endpoint=args[0]==='api'&&args.includes('graphql')?'graphql':args[methodIndex+2]!;calls.push({method,path:endpoint,args});const privateToken=options.env?.GH_TOKEN;const selected=privateToken||namespaceToken;const selectedActor=selected===tokenA?'123':selected===tokenB?'999':'invalid';if(endpoint==='user'||method==='PUT'){assert.ok(typeof privateToken==='string'&&privateToken.length>0,'Merge actor/PUT must use private captured token');assert.equal(Object.isFrozen(options.env),true);if(endpoint==='user')boundActorGets++;else boundPuts++;}else assert.equal(privateToken===undefined,true,'Unrelated commands must not inherit merge token');processHook?.(endpoint);if(observationUnavailable)return{exitCode:1,stdout:'',stderr:'HTTP 401: authentication required'};const fields=Object.fromEntries(args.filter((_,i)=>args[i-1]==='-f'||args[i-1]==='-F').map(s=>{const i=s.indexOf('=');return[s.slice(0,i),s.slice(i+1)];}));let result:unknown;
    if(endpoint==='user'){result=actorResponse??{id:Number(selectedActor)};afterActor?.();}
    else if(endpoint==='graphql')result={data:{repository:{pullRequest:{closingIssuesReferences:{nodes:[{number:42,repository:{nameWithOwner:'acme/widgets'}}],pageInfo:{hasNextPage:false,endCursor:null}},reviewThreads:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}}}}}};
    else if(endpoint==='repos/acme/widgets/issues/1/comments'){if(method==='GET')result=runtime;else {runtime=[{id:9,body:fields.body!}];result=runtime[0];}}
    else if(endpoint==='repos/acme/widgets/issues/comments/9'){runtime=[{id:9,body:fields.body!}];result=runtime[0];}
    else if(endpoint==='repos/acme/widgets/issues/comments/2'){queueReads++;result={id:2,body:`${DISPATCH_QUEUE_MARKER}\nready:\n  - issue: 42\n    route: codex\n    profile: ${imported?.run.execution?.profile??'routine'}\n    task-shape-revision: ${imported?.run.repairTaskShapeAuthority?.revision??'task-v1'}\n    task-shape: ${imported?.run.repairTaskShapeAuthority?.shape??'bounded'}\n  - issue: 43\n    route: codex\n    profile: ${imported?.run.execution?.profile??'routine'}\n    task-shape-revision: ${imported?.run.repairTaskShapeAuthority?.revision??'task-v1'}\n    task-shape: ${imported?.run.repairTaskShapeAuthority?.shape??'bounded'}`};}
    else if(endpoint==='repos/acme/widgets/issues/42')result=imported?{...ORIGINAL_ISSUE,state:merged?'closed':'open'}:{node_id:'I_42',number:42,title:'native slice',body:'controlled specification',state:merged?'closed':'open',html_url:'https://github.com/acme/widgets/issues/42',created_at:T0,updated_at:T0};
    else if(endpoint==='repos/acme/widgets/issues/42/comments'&&imported)result=[originalHandoffComment(head)];
    else if(endpoint.endsWith('/issues/42/timeline'))result=[{event:'cross-referenced',source:{issue:{number:7,pull_request:{url:'https://api.github.com/repos/acme/widgets/pulls/7'}}}}];
    else if(endpoint==='repos/acme/widgets/pulls/7/merge'){assert.equal(method,'PUT');assert.equal(fields.sha,head);assert.equal(fields.merge_method,'squash');assert.equal(selectedActor,'123','PUT authenticates with verified captured A despite namespace changes');squashes++;if(lostAck)throw new Error('Controlled lost acknowledgement');merged=true;result={merged:true,sha:squash};}
    else if(endpoint==='repos/acme/widgets/pulls/7')result=pr();
    else if(endpoint==='repos/acme/widgets')result={default_branch:'main'};
    else if(endpoint==='repos/acme/widgets/commits/main')result={sha:merged?squash:baseDrift?'f'.repeat(40):base};
    else if(endpoint===`repos/acme/widgets/git/commits/${squash}`)result={sha:squash,tree:{sha:tree},parents:[{sha:base}]};
    else if(endpoint.startsWith('repos/acme/widgets/compare/'))result={status:'identical',merge_base_commit:{sha:squash}};
    else if(endpoint.endsWith('/status'))result={state:'success',total_count:1,statuses:[{id:1,context:'test',state:'success',target_url:null,updated_at:T0}]};
    else if(endpoint.endsWith('/check-runs'))result={total_count:0,check_runs:[]};
    else if(endpoint.endsWith('/comments')||endpoint.endsWith('/reviews'))result=[];
    else throw new Error(`Uncontrolled request ${method} ${endpoint}`);
    return{stdout:JSON.stringify(args.includes('--slurp')?[result]:result),stderr:'',exitCode:0};
  }};
  const reviewer:NativeReviewerHost={binding:{bindingId:'controlled-release-binding',contractRevision:'host-contract-v1',policyRevision:f.policy.reviewPolicyRevision,scope:'complete-candidate',model:'controlled-latest-oracle',supportedEfforts:['Medium','High','Extra High'],authorActorIds:['author'],allowTransportReplacement:true},receipts:new InstalledReceipts(path.join(f.accountRoot,'oracle')),source:(b,h)=>readNativeSourceManifest(f.objectRoot,b,h),async submit(request){submissions++;const result=approval('controlled reviewer',head);const evidence:Extract<NativeOracleEvidence,{kind:'terminal'}>={id:`${request.identity.requestId}.terminal`,kind:'terminal',identity:request.identity,result,authentication:{actorId:'independent-reviewer',model:request.identity.requestedModel,effort:request.identity.requestedEffort,transportReceipt:oracleDigest({identity:request.identity,result,actor:'independent-reviewer'})}};return{outcome:'complete',evidence};},async observe(){throw new Error('No fresh reviewer work during issued recovery');},authenticate(e){return e.authentication.transportReceipt===oracleDigest({identity:e.identity,result:e.result,actor:e.authentication.actorId});}};
  const originalReceipts=imported?new InstalledReceipts(imported.receiptRoot):reviewer.receipts;
  const selectedReviewer:NativeReviewerHost=imported?{...imported.reviewer,receipts:originalReceipts,source:(b,h)=>readNativeSourceManifest(f.objectRoot,b,h),submit:imported.reviewer.submit,async observe(){throw new Error('Imported qualified review must not observe');}}:reviewer;
  const historical:NativeCompletionHosts={review:{receipts:originalReceipts,authenticate:selectedReviewer.authenticate},...(imported?{lead:{receipts:originalReceipts,authenticate:imported.lead.authenticate}}:{})};
  const store=()=>new InstalledStore({dir:path.join(f.accountRoot,'runs'),nativeCompletionHosts:historical});
  let run=createRun(TARGET,T0,'run-native',{profile:'routine',revision:PRODUCTION_POLICY_REVISION,executor:'luna-isolated',model:'gpt-5.6-luna',reasoningEffort:'high',timeoutMs:900000,sandboxMode:'workspace-write',approvalPolicy:'never'},'claim-native',{revision:'task-v1',shape:'bounded'});
  run=applyTransition(run,{type:'start'},T0);run=applyTransition(run,{type:'agent_succeeded',agentResult:successResult(head),headSha:head,pullRequest:{number:7,headSha:head}},T0);run={...run,bootstrap:{bootstrapKind:'linked-worktree',owner:'acme',repo:'widgets',issueNumber:42,baseBranch:'main',baseSha:base,branch:'candidate',workspacePath:f.objectRoot}};if(imported){run=imported.run;const registry={...imported.registry,config:{schemaVersion:1,revision:'mission-admission-v1',limits:{maxCaptains:1,maxWriters:1,maxHighAutonomy:1}}};writeFileSync(path.join(f.accountRoot,'mission-admission/registry.json'),JSON.stringify(registry));const receiptPath=resolveRunOwnerReceiptPath('acme/widgets',run.id);mkdirSync(path.dirname(receiptPath),{recursive:true,mode:0o700});writeFileSync(receiptPath,imported.ownerReceipt,{mode:0o600});}store().create(run);if(imported)assert.deepEqual(store().read(run.id),imported.run,'Import preserves the complete original producer Run');
  const invoke=async(argv:string[],withServices=true,verification:NativeCompletionHosts|'absent'=historical)=>{
    traceCut('installed-cli',argv.slice(0,2).join('/'),'entered');const printed:string[]=[];const log=console.log;console.log=(v?:unknown)=>printed.push(String(v));try{const code=await f.invoke(argv,{runner,implementation:{kind:'implementation-agent',async run(){modelCalls++;throw new Error('Controlled command must not invoke implementation');}},...(verification==='absent'?{}:{historicalCompletionHosts:verification}),...(withServices?{nativeReviewerHost:selectedReviewer,validation:{kind:'validation' as const,configRevision:PRODUCTION_POLICY_REVISION,async validate(request){await validationHook?.();request.beforeExecution?.();validationCalls++;return{...validationPassed(request.headSha).local,configRevision:PRODUCTION_POLICY_REVISION};}}}:{})});traceCut('installed-cli',argv.slice(0,2).join('/'),'completed',{code,squashes,submissions,validationCalls,captures});return{code,printed};}finally{console.log=log;}
  };
  const review=async()=>{const result=await invoke(['dispatch','once']);assert.equal(result.code,0);const ready=store().read('run-native')!;assert.equal(ready.state,'MERGE_READY',JSON.stringify({ready,result}));assert.ok(ready.nativeReview?.accepted);await invoke(['dispatch','maintenance','hold']);f.enable();await invoke(['dispatch','once']);await invoke(['dispatch','maintenance','release']);};
  return{...f,cleanup:()=>{globalThis.Date=RealDate;f.cleanup();},tick:()=>{clock+=31000;},base,head,tree,squash,runner,reviewer:selectedReviewer,store,invoke,review,calls,InstalledStore,InstalledReceipts,historical,runId,setProcessHook:(hook:typeof processHook)=>{processHook=hook;},setValidationHook:(hook:typeof validationHook)=>{validationHook=hook;},stats:()=>({squashes,queueReads,submissions,validationCalls,modelCalls,captures,boundActorGets,boundPuts}),setObservationUnavailable:(value=true)=>{observationUnavailable=value;},setLostAck:()=>{lostAck=true;},setMerged:()=>{merged=true;},setActor:(v:string)=>{actorId=v;namespaceToken=v==='123'?tokenA:tokenB;},setCaptureFailure:(value:ProcessResult|Error|undefined)=>{captureFailure=value;},setActorResponse:(value:unknown)=>{actorResponse=value;},afterActor:(fn:()=>void)=>{afterActor=fn;},beforePut:(fn:()=>void)=>{beforePut=fn;},setBaseDrift:()=>{baseDrift=true;},claim:()=>selectDispatchRuntime(runtime.map(r=>({id:String(r.id),body:r.body})))?.claim};
  } catch(error) { globalThis.Date=RealDate;try{f.cleanup();}catch{/* Preserve the original setup assertion. */}throw error; }
}


/** Actual installed direct admission with real private Git and a no-model concrete Luna. */
async function directExecutionFixture(options:{productionWorker?:boolean;commitWorker?:boolean}={}) {
  const jsonl=[{type:'thread.started',thread_id:'direct-hold-proof'},{type:'turn.started'},{type:'item.completed',item:{id:'message',type:'agent_message',text:'Controlled execution completed without a model'}},{type:'turn.completed'}].map(v=>JSON.stringify(v)).join('\n');
  const commit=options.commitWorker?"fs.writeFileSync('controlled-worker.txt','controlled no-model commit\\n');require('node:child_process').execFileSync('git',['add','controlled-worker.txt']);require('node:child_process').execFileSync('git',['-c','user.name=Controlled fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','controlled worker commit']);":"";
  const codexRuntime="const fs=require('node:fs'),path=require('node:path');const counter=path.resolve(__dirname,'../../controlled-worker-count');fs.writeFileSync(counter,String(Number(fs.existsSync(counter)?fs.readFileSync(counter,'utf8'):'0')+1));"+commit+"process.stdout.write("+JSON.stringify(jsonl)+");\n";
  const f=await installedFixture(true,false,{}, {lunaHome:true,codexRuntime});
  try {
    const git=(cwd:string,args:readonly string[])=>execFileSync(f.record.git.path,['-c','user.name=Controlled fixture','-c','user.email=fixture@example.invalid',...args],{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
    const remote=path.join(f.accountRoot,'controlled-remote.git');git(f.objectRoot,['init','--bare',remote]);git(f.objectRoot,['init','--initial-branch','main']);
    writeFileSync(path.join(f.objectRoot,'README.md'),'base\n');git(f.objectRoot,['add','.']);git(f.objectRoot,['commit','--quiet','-m','base']);git(f.objectRoot,['remote','add','origin','file://'+remote]);git(f.objectRoot,['push','--quiet','origin','main']);const base=git(f.objectRoot,['rev-parse','HEAD']);
    let gitCalls=0,apiCalls=0;let onGit:((args:readonly string[])=>void)|undefined;
    let runtimeComments:{id:number;body:string}[]=[];let gitStage='none';let gitExit:number|undefined;
    const actual=new NodeProcessRunner();
    const runner:ProcessRunner={async run(file,args,options){
      options.beforeSpawn?.();
      if(args[0]!=='api'){
        onGit?.(args);options.beforeSpawn?.();gitCalls++;
        if(args.includes('get-url'))return{exitCode:0,stdout:'git@github.com:acme/widgets.git\n',stderr:''};
        gitStage=args.includes('fetch')?'fetch':args.includes('get-url')?'remote-url':args.includes('ls-remote')?'ls-remote':args.includes('check-ref-format')?'check-ref-format':args.includes('init')?'init':args.includes('checkout')?'checkout':args.includes('switch')?'switch':args.includes('status')?'status':args.includes('rev-parse')?'head':'other';const result=await actual.run(file,args,options);gitExit=result.exitCode;return result;
      }
      apiCalls++;const methodIndex=args.indexOf('--method');const method=args[methodIndex+1]!;const endpoint=args[methodIndex+2]!;const fields=Object.fromEntries(args.filter((_,i)=>args[i-1]==='-f'||args[i-1]==='-F').map(value=>{const i=value.indexOf('=');return[value.slice(0,i),value.slice(i+1)];}));let result:unknown;
      if(endpoint==='repos/acme/widgets/issues/1/comments'){if(method==='GET')result=runtimeComments;else{runtimeComments=[{id:9,body:fields.body!}];result=runtimeComments[0];}}
      else if(endpoint==='repos/acme/widgets/issues/comments/9'){runtimeComments=[{id:9,body:fields.body!}];result=runtimeComments[0];}
      else if(endpoint==='repos/acme/widgets/issues/comments/2')result={id:2,body:DISPATCH_QUEUE_MARKER+'\nready:\n  - issue: 42\n    route: codex\n    profile: routine\n    task-shape-revision: task-v1\n    task-shape: bounded'};
      else if(endpoint==='repos/acme/widgets/issues/42')result=ORIGINAL_ISSUE;
      else if(endpoint==='repos/acme/widgets/issues/42/comments')result=[originalHandoffComment(null)];
      else if(endpoint==='repos/acme/widgets/issues/42/timeline')result=[];
      else if(endpoint==='repos/acme/widgets')result={default_branch:'main'};
      else if(endpoint==='repos/acme/widgets/commits/main')result={sha:base};
      else throw new Error('Uncontrolled direct-entry request '+endpoint);
      return{exitCode:0,stdout:JSON.stringify(args.includes('--slurp')?[result]:result),stderr:''};
    }};
    const snapshot=f.resolve(runner);assert.equal(snapshot.installation,'accepted',snapshot.reason);assert.equal(snapshot.initiationPolicy.available,true);
    const {IsolatedLunaAdapter,hasGovernedPublicationConfinement}=await import(new URL('./agents/luna-isolated.js',f.entryUrl).href) as typeof import('../src/agents/luna-isolated.js');
    // The internal implementation seam selects an actual concrete, original
    // process transport, not a fake qualification flag or replacement runner.
    const implementation=new IsolatedLunaAdapter({codexHome:snapshot.environment.TACHIKO_LUNA_CODEX_HOME!,timeoutMs:900000,path:snapshot.environment.PATH!,executable:f.record.codex.path,gitExecutable:f.record.git.path,...(options.productionWorker?{production:f.resolve()}:{} )});
    assert.equal(hasGovernedPublicationConfinement(implementation),true);
    const {JsonFileStore:InstalledStore}=await import(new URL('./store/json-file-store.js',f.entryUrl).href) as typeof import('../src/store/json-file-store.js');
    const runtime=await import(new URL('./operational/runtime-projection.js',f.entryUrl).href) as typeof import('../src/operational/runtime-projection.js');
    const {JsonFileOracleReceiptStore:InstalledReceipts}=await import(new URL('./oracle/receipt-store.js',f.entryUrl).href) as typeof import('../src/oracle/receipt-store.js');
    const reviewer:NativeReviewerHost={binding:{bindingId:'controlled-direct-hold-reviewer',contractRevision:'host-contract-v1',policyRevision:f.policy.reviewPolicyRevision,scope:'complete-candidate',model:'controlled-latest-oracle',supportedEfforts:['Medium','High','Extra High'],authorActorIds:['author'],allowTransportReplacement:true},receipts:new InstalledReceipts(path.join(f.accountRoot,'oracle')),source:(base,head)=>readNativeSourceManifest(f.objectRoot,base,head),async submit(){throw new Error('No review submission expected before the unchanged-HEAD bootstrap park');},authenticate(){return false;}};
    const {resolveNativeReviewer}=await import(new URL('./oracle/native-reviewer.js',f.entryUrl).href) as typeof import('../src/oracle/native-reviewer.js');assert.equal(resolveNativeReviewer(reviewer).native!.available(),true,'The controlled claimed route has a usable reviewer binding');
    const store=()=>new InstalledStore({dir:snapshot.runsDirectory});
    const counter=path.join(f.accountRoot,'controlled-worker-count');
    const workers=()=>existsSync(counter)?Number(readFileSync(counter,'utf8')):0;
    const invoke=async(argv:string[],claimed=false)=>{const log=console.log;console.log=()=>{};try{return await f.invoke(argv,{runner,implementation,...(claimed?{nativeReviewerHost:reviewer}:{})});}finally{console.log=log;if(argv[0]==='dispatch')facts('dispatch-invoke-finally');}};
    const facts=(cut:string)=>{const run=store().list()[0];const reason=run?.interrupt?.reason;const bootstrapCode=['INVALID_REQUEST','COMMAND_FAILED','BASE_DRIFT','COLLISION','STALE_IDENTITY','HEAD_MISMATCH','DIRTY_WORKSPACE','REPOSITORY_MISMATCH'].find(code=>reason?.startsWith('Implementation bootstrap failed ('+code+'):'))??'absent';process.stderr.write('STAGE10_DIRECT_HOLD '+JSON.stringify({cut,state:run?.state??'absent',interruptedFrom:run?.interruptedFrom??'absent',reviewWait:run?.nativeReview?.wait?.kind??'absent',reason:reason==='Native review unavailable: no accepted trusted host reviewer binding; implementation and repair are waiting.'?'native-binding':reason?.includes('Maintenance HOLD')?'maintenance-hold':reason?.includes('Worker result did not advance the authorized HEAD')?'unchanged-head-bootstrap':reason?.startsWith('Implementation bootstrap failed')?'bootstrap-other':reason?.includes('Governed implementation')?'governed-runtime':'other',bootstrapCode,hasClaim:run?.dispatchClaimId!==undefined,claimState:selectDispatchRuntime(runtimeComments.map(v=>({id:String(v.id),body:v.body})))?.claim.state??'absent',gitStage,gitExit:gitExit??-1,gitCalls,apiCalls,workers:workers()})+'\n');};
    return{...f,runner,snapshot,runtime,store,invoke,workers,facts,stats:()=>({gitCalls,apiCalls,workers:workers()}),claim:()=>selectDispatchRuntime(runtimeComments.map(v=>({id:String(v.id),body:v.body})))?.claim,onGit:(hook:typeof onGit)=>{onGit=hook;}};
  } catch(error){f.cleanup();throw error;}
}

describe('fixed production entry through real parser and canonical dispatcher',()=>{
  beforeEach(t=>traceCut(t.name,'case','entered'));
  afterEach(t=>traceCut(t.name,'case','finished'));
  it('preserves the original bounded issue and accepted scope through real adapter admission and later PR views',async()=>{
    const base='a'.repeat(40),head='b'.repeat(40);const calls:string[]=[];
    const source:GitHubLiveSnapshot={repository:{owner:'acme',repo:'widgets',defaultBranch:'main',defaultBranchHeadSha:base},issue:{id:'I_42',number:42,title:ORIGINAL_ISSUE.title,body:ORIGINAL_ISSUE.body,state:'open',url:ORIGINAL_ISSUE.html_url,createdAt:T0,updatedAt:T0},pullRequest:null,headSha:null,checks:{availability:'unavailable',overall:'unavailable',checks:[]},reviews:{decision:'none',latestByAuthor:[],unresolvedThreads:null},conversations:[],handoff:null,problems:[],observedAt:T0};
    const initial=await canonicalProducerSnapshot(source,calls);assert.ok(calls.includes('repos/acme/widgets/issues/42/comments'));assert.equal(initial.conversations[0]!.id,'scope-fixture');assert.equal(initial.handoff!.freshness,'unknown');
    const scope=acceptedScopeFromHandoff(initial.handoff,initial.problems,true);assert.ok(scope);assert.equal(scope.text,ORIGINAL_SCOPE);
    const execution={profile:'routine' as const,revision:PRODUCTION_POLICY_REVISION,executor:'luna-isolated',model:'gpt-5.6-luna',reasoningEffort:'high' as const,timeoutMs:900000,sandboxMode:'workspace-write' as const,approvalPolicy:'never' as const};const shape={revision:'bounded-contract-v1',shape:'bounded' as const};
    const identity={runId:'canonical-original',target:TARGET,workspacePath:'/controlled/workspace',branch:'candidate',baseSha:base,execution};
    const input={kind:'initial' as const,identity,authority:{repository:{owner:'acme',repo:'widgets'},issue:{id:initial.issue.id,number:42,updatedAt:initial.issue.updatedAt,title:initial.issue.title,body:initial.issue.body},acceptedScope:scope},repair:null};const packet=buildImplementationPacket(input);assert.equal(packet.kind,'packet');if(packet.kind!=='packet')throw new Error('Canonical fixture must be admissible');
    const run:Run={...createRun(TARGET,T0,identity.runId,execution,'original-claim',shape),bootstrap:{bootstrapKind:'linked-worktree',owner:'acme',repo:'widgets',issueNumber:42,workspacePath:identity.workspacePath,branch:identity.branch,baseBranch:'main',baseSha:base},implementationAuthority:{input,taskShape:shape,packetSha256:oracleDigest(packet.packet)}};
    const original=JSON.stringify(run);assert.equal(originalImplementationMatches(run,initial),true);
    const current=await canonicalProducerSnapshot({...source,headSha:head,pullRequest:{id:'PR_7',number:7,title:'Fixture',url:'https://github.com/acme/widgets/pull/7',state:'open',headSha:head,baseSha:base,headRef:'candidate',baseRef:'main',headRepository:{owner:'acme',repo:'widgets'},baseRepository:{owner:'acme',repo:'widgets'},isDraft:false,mergeable:true,mergeStateStatus:'CLEAN',updatedAt:T0}},calls);
    assert.equal(current.handoff!.freshness,'current');assert.equal(originalImplementationMatches(run,current),true);
    for(const issue of [{...current.issue,title:'native slice'},{...current.issue,body:'controlled specification'}])assert.equal(originalImplementationMatches(run,{...current,issue}),false);
    assert.equal(originalImplementationMatches(run,{...current,handoff:{...current.handoff!,sections:{...current.handoff!.sections,Scope:'foreign replacement scope'}}}),false);
    assert.equal(JSON.stringify(run),original,'Live-view comparison never rewrites original authority');
  });
  it('uses the actual accepted entry for model-free held once/serve and local diagnostics',async()=>{
    const f=await installedFixture(true);const log=console.log;const output:string[]=[];console.log=(v?:unknown)=>output.push(String(v));try{let calls=0;const runner:ProcessRunner={async run(){calls++;throw new Error('Held entry must not spawn a process');}};process.env.TACHIKO_DATA_DIR='/candidate/empty';assert.equal(await f.invoke(['dispatch','maintenance','hold'],{runner}),0);writeFileSync(f.hostPath,'{malformed');writeFileSync(f.dispatchPath,'{malformed');assert.equal(await f.invoke(['dispatch','once'],{runner}),0);assert.equal(await f.invoke(['dispatch','serve','--max-cycles','1','--idle-poll-ms','1'],{runner}),0);assert.equal(calls,0);assert.equal(await f.invoke(['production','preflight'],{runner}),78);assert.ok(output.some(v=>v.includes('maintenance_hold')));assert.equal(readOperationalRuntimeProjection(path.join(f.accountRoot,'runs'))!.maintenanceHold.active,true);assert.equal(process.env.TACHIKO_DATA_DIR,undefined);}finally{console.log=log;f.cleanup();}
  });


  it('checks ordinary initiation before scanner publication in installed once and bounded serve',async(t)=>{
    for(const mode of ['once','serve'] as const)await t.test(mode,async()=>{
      const f=await installedFixture(true,false,{}, {lunaHome:true});
      const originalRead=fs.readFileSync,originalRename=fs.renameSync,log=console.log;
      const runs=path.join(f.accountRoot,'runs'),projection=operationalRuntimeProjectionPath(runs);
      const command=mode==='once'?['dispatch','once']:['dispatch','serve','--max-cycles','1','--idle-poll-ms','1'];
      const publications:{stage:string;supervisor:string}[]=[];let queueReads=0,apiCalls=0;
      const runner:ProcessRunner={async run(_file,args,options){
        options.beforeSpawn?.();apiCalls++;
        assert.equal(args[0],'api','Scanner must not start a model, Git, or actor capture');
        const i=args.indexOf('--method'),method=args[i+1],endpoint=args[i+2];
        assert.equal(method,'GET','Empty queue cannot create or change a claim');
        let value:unknown;
        if(endpoint==='repos/acme/widgets/issues/comments/2'){
          queueReads++;const current=readOperationalRuntimeProjection(runs)!;
          assert.equal(current.stage,'scanning');assert.equal(current.supervisor,'running');
          value={id:2,body:DISPATCH_QUEUE_MARKER+'\nready:'};
        }else if(endpoint==='repos/acme/widgets/issues/1/comments')value=[];
        else throw new Error('Uncontrolled scanner endpoint');
        return{exitCode:0,stdout:JSON.stringify(args.includes('--slurp')?[value]:value),stderr:''};
      }};
      const authority=()=>{
        const files:string[]=[];
        const walk=(directory:string)=>{if(!existsSync(directory))return;for(const name of readdirSync(directory).sort()){const file=path.join(directory,name);if(lstatSync(file).isDirectory())walk(file);else files.push(file);}};
        walk(runs);walk(path.join(f.accountRoot,'mission-admission'));
        return JSON.stringify(files.map(file=>[path.relative(f.accountRoot,file),originalRead(file,'utf8')]));
      };
      console.log=()=>{};
      try{
        // A real direct admission supplies an existing Run/owner to preserve. Its
        // mandatory native-claim park precedes all Git/model/API effects.
        assert.equal(await f.invoke(['run','acme/widgets#42','--execution-profile','routine','--repair-task-shape-authority','{"revision":"task-v1","shape":"bounded"}'],{runner}),0);
        const {JsonFileStore:InstalledStore}=await import(new URL('./store/json-file-store.js',f.entryUrl).href) as typeof import('../src/store/json-file-store.js');
        const parked=new InstalledStore({dir:runs}).list()[0]!;
        assert.equal(parked.state,'WAITING_DEPENDENCY');assert.equal(parked.interruptedFrom,'READY');assert.equal(parked.nativeReview!.wait!.kind,'binding');assert.equal(apiCalls,0);
        f.enable(mode==='once');setMaintenanceHold(runs,false,T0);
        fs.renameSync=((from:fs.PathLike,to:fs.PathLike)=>{
          if(String(to)===projection){const value=JSON.parse(originalRead(from,'utf8')) as {stage:string;supervisor:string};publications.push({stage:value.stage,supervisor:value.supervisor});}
          return originalRename(from,to);
        }) as typeof fs.renameSync;syncBuiltinESMExports();
        assert.equal(await f.invoke(command,{runner}),0);
        assert.ok(queueReads>0,'Positive must cross the actual queue-read boundary');
        assert.ok(publications.some(p=>p.stage==='scanning'&&p.supervisor==='running'));
        assert.notEqual(readOperationalRuntimeProjection(runs)!.supervisor,'running','Completed scanner settles truthfully');
        assert.equal(readOperationalRuntimeProjection(runs)!.maintenanceHold.active,false);
        const positiveCalls=apiCalls,positiveQueueReads=queueReads;
        for(const refusal of ['initial-invalid','captured-drift'] as const){
          f.enable(mode==='once');let captured=false;
          if(refusal==='initial-invalid')writeFileSync(f.hostPath,'{malformed');
          else{
            fs.readFileSync=((file:fs.PathOrFileDescriptor,...args:unknown[])=>{
              const value=Reflect.apply(originalRead,fs,[file,...args]);
              if(String(file)===f.dispatchPath&&!captured){captured=true;const descriptor=JSON.parse(originalRead(f.hostPath,'utf8'));descriptor.revision='changed-after-capture';writeFileSync(f.hostPath,JSON.stringify(descriptor));}
              return value;
            }) as typeof fs.readFileSync;syncBuiltinESMExports();
          }
          const before=authority(),projectionBefore=originalRead(projection,'utf8'),publicationCount=publications.length;
          try{await assert.rejects(f.invoke(command,{runner}),refusal==='captured-drift'?/descriptor changed/:/descriptor|host/i);}
          finally{fs.readFileSync=originalRead;syncBuiltinESMExports();}
          assert.equal(captured,refusal==='captured-drift');
          assert.equal(publications.length,publicationCount,'Refusal cannot advertise a new running scanner');
          assert.equal(originalRead(projection,'utf8')===projectionBefore,true,'Typed projection including HOLD remains unchanged');
          assert.equal(authority()===before,true,'Run, owner, generation and canonical authority bytes remain unchanged');
          assert.equal(apiCalls,positiveCalls);assert.equal(queueReads,positiveQueueReads);
        }
      }finally{fs.readFileSync=originalRead;fs.renameSync=originalRename;syncBuiltinESMExports();console.log=log;f.cleanup();}
    });
  });

  it('holds direct durable admission and native-binding resume before owner or transition changes',async(t)=>{
    for(const entry of ['issue','resume'] as const)await t.test(entry,async()=>{
      const f=await directExecutionFixture();const originalRead=fs.readFileSync;
      const issue=['run','acme/widgets#42','--execution-profile','routine','--repair-task-shape-authority','{"revision":"task-v1","shape":"bounded"}'];
      const registryFile=path.join(f.accountRoot,'mission-admission/registry.json');
      const bindingReason='Native review unavailable: no accepted trusted host reviewer binding; implementation and repair are waiting.';
      try{
        f.runtime.setMaintenanceHold(f.snapshot.runsDirectory,false,T0);
        const initialRegistry=readFileSync(registryFile,'utf8');
        assert.equal(await f.invoke(issue),0);f.facts('direct-admission-baseline');
        let parked=f.store().list()[0]!;assert.equal(parked.state,'WAITING_DEPENDENCY');assert.equal(parked.interruptedFrom,'READY');assert.equal(parked.interrupt!.reason,bindingReason);assert.equal(parked.nativeReview!.wait!.kind,'binding');assert.equal((parked.interrupt!.choices??[]).length,0);assert.equal(f.workers(),0);
        assert.notEqual(readFileSync(registryFile,'utf8'),initialRegistry,'The inactive direct baseline genuinely admits and parks an owner');
        const receiptPath=resolveRunOwnerReceiptPath('acme/widgets',parked.id);const receipt=readRunOwnerReceipt(receiptPath)!;assert.equal(receipt.phase,'parked');
        const previous=parked;const generation=receipt.generation;
        // Without an offered Cancel choice this literal is an ordinary resume,
        // not cancellation. Inactive HOLD proves its real admission/re-park path.
        assert.equal(await f.invoke(['run','resume',parked.id,'--decision','Cancel the run']),0);f.facts('no-choice-literal-cancel-inactive');
        parked=f.store().read(parked.id)!;assert.equal(parked.state,'WAITING_DEPENDENCY');assert.equal(parked.interruptedFrom,'READY');assert.equal(parked.interrupt!.reason,bindingReason);assert.equal((parked.interrupt!.choices??[]).length,0);assert.ok(parked.history.length>previous.history.length);assert.ok(readRunOwnerReceipt(receiptPath)!.generation>generation);assert.equal(f.workers(),0);
        const cleanupOwned=async()=>{const owner=readRunOwnerReceipt(receiptPath)!;assert.equal(f.workers(),0,'This controlled binding wait never started a child');assert.equal(await f.invoke(['run','admission','recover',parked.id,'--generation',String(owner.generation),'--stopped']),0);assert.equal(await f.invoke(['run','transition',parked.id,'fail','--reason','Controlled owned cleanup']),0);assert.equal(f.store().read(parked.id)!.state,'FAILED');};
        if(entry==='issue')await cleanupOwned();
        const projection=f.runtime.operationalRuntimeProjectionPath(f.snapshot.runsDirectory);
        const durable=()=>{const result:Record<string,string>={};const walk=(directory:string)=>{if(!existsSync(directory))return;for(const name of readdirSync(directory).sort()){const file=path.join(directory,name),stat=lstatSync(file);if(stat.isDirectory())walk(file);else{assert.equal(stat.isFile(),true);result[path.relative(f.accountRoot,file)]=createHash('sha256').update(Reflect.apply(originalRead,fs,[file])).digest('hex');}}};for(const directory of [f.snapshot.runsDirectory,path.join(f.accountRoot,'mission-admission'),path.join(f.accountRoot,'workspaces'),f.objectRoot])walk(directory);return result;};
        for(const cut of ['hold','malformed','unreadable'] as const){
          f.runtime.setMaintenanceHold(f.snapshot.runsDirectory,cut==='hold',T0);if(cut==='malformed')writeFileSync(projection,'{broken');
          const before=durable(),effects=f.stats();
          if(cut==='unreadable'){Object.defineProperty(fs,'readFileSync',{value:(...args:unknown[])=>{if(args[0]===projection)throw new Error('Controlled projection read refusal');return Reflect.apply(originalRead,fs,args);}});syncBuiltinESMExports();}
          try{
            const decisions=entry==='issue'?['issue']:['Retry original admission','Cancel the run'];
            for(const decision of decisions){const command=entry==='issue'?issue:['run','resume',parked.id,'--decision',decision];await assert.rejects(()=>f.invoke(command),error=>{assert.equal((error as {code?:string}).code,'EXECUTION_ADMISSION_REFUSED');assert.match(String(error),cut==='hold'?/Maintenance HOLD/:/unreadable or malformed/);return true;});}
          }finally{Object.defineProperty(fs,'readFileSync',{value:originalRead});syncBuiltinESMExports();}
          assert.deepEqual(f.stats(),effects);assert.deepEqual(durable(),before,'No Run/history, receipt, registry generation, workspace or object change at '+cut);if(cut==='hold')assert.equal(f.runtime.readOperationalRuntimeProjection(f.snapshot.runsDirectory)!.maintenanceHold.active,true);
        }
        f.runtime.setMaintenanceHold(f.snapshot.runsDirectory,true,T0);
        if(entry==='resume'){const effects=f.stats();await cleanupOwned();assert.deepEqual(f.stats(),effects);}
        assert.equal(f.runtime.readOperationalRuntimeProjection(f.snapshot.runsDirectory)!.maintenanceHold.active,true);
      }finally{Object.defineProperty(fs,'readFileSync',{value:originalRead});syncBuiltinESMExports();f.cleanup();}
    });
  });

  it('uses actual dispatch claims for the normal worker baseline, offered cancellation and awaited HOLD fence',async(t)=>{
    for(const cut of ['positive-cancel','prepare-hold'] as const)await t.test(cut,async()=>{
      const f=await directExecutionFixture();try{
        f.runtime.setMaintenanceHold(f.snapshot.runsDirectory,false,T0);
        let remoteReads=0,fetches=0,tripped=false;
        if(cut==='prepare-hold')f.onGit(args=>{if(args.includes('get-url')&&++remoteReads===3){tripped=true;f.runtime.setMaintenanceHold(f.snapshot.runsDirectory,true,T0);}if(args.includes('fetch'))fetches++;});
        assert.equal(await f.invoke(['dispatch','once'],true),0);f.facts('claimed-'+cut);
        const parked=f.store().list()[0]!;assert.ok(parked.dispatchClaimId);assert.equal(f.claim()!.claimId,parked.dispatchClaimId);assert.equal(parked.state,'NEEDS_HUMAN');assert.equal(parked.interruptedFrom,'IMPLEMENTING');
        if(cut==='positive-cancel'){
          assert.equal(f.workers(),1,'Genuine dispatcher claim, prepared workspace and concrete no-model runtime must reach the worker');assert.match(parked.interrupt!.reason,/Worker result did not advance the authorized HEAD/);assert.ok(parked.interrupt!.choices!.includes('Cancel the run'));
          f.runtime.setMaintenanceHold(f.snapshot.runsDirectory,true,T0);const effects=f.stats();
          assert.equal(await f.invoke(['run','resume',parked.id,'--decision','Cancel the run'],true),1);f.facts('offered-cancel-under-hold');
          assert.equal(f.store().read(parked.id)!.state,'FAILED');assert.equal(f.workers(),1);assert.equal(f.stats().gitCalls,effects.gitCalls);assert.ok(f.stats().apiCalls>effects.apiCalls,'Canonical claim reads/settlement are permitted cleanup');assert.equal(f.claim()!.state,'failed');
        }else{
          assert.equal(tripped,true,'HOLD reaches the awaited first preparation remote-identity read after the two planning URL reads');assert.equal(fetches,0,'The actual beforeMutation callback prevents the first immutable-base fetch');assert.equal(f.workers(),0);assert.match(parked.interrupt!.reason,/Maintenance HOLD/);
        }
        assert.equal(f.runtime.readOperationalRuntimeProjection(f.snapshot.runsDirectory)!.maintenanceHold.active,true);
      }finally{f.cleanup();}
    });
  });



  it('preserves typed worker and selected HEAD refusals through genuinely claimed installed execution',async(t)=>{
    for(const cut of ['positive','worker-entry','worker-spawn','head-entry','head-spawn'] as const)for(const drift of (cut==='positive'?['descriptor']:['descriptor','artifact']) as ('descriptor'|'artifact')[])await t.test(cut+'-'+drift,async()=>{
      const headCut=cut.startsWith('head'),f=await directExecutionFixture({productionWorker:true,commitWorker:headCut});
      const originalRead=fs.readFileSync,originalExec=childProcess.execFile,originalStackLimit=Error.stackTraceLimit;
      let tripped=false,headEntered=false,workerChildren=0,headChildren=0,spawnCutObserved=false,finalizationRefused=false;
      let originRun:Run|undefined,originOwner:ReturnType<typeof readRunOwnerReceipt> = null,originClaim:ReturnType<typeof f.claim>;
      try{
        // Bounded observer only: the worker final callback has more than the
        // default ten synchronous frames. Restore this global in finally.
        Error.stackTraceLimit=64;
        f.runtime.setMaintenanceHold(f.snapshot.runsDirectory,false,T0);
        fs.readFileSync=((file:fs.PathOrFileDescriptor,...args:unknown[])=>{
          if(String(file)===f.recordPath){
            const stack=new Error().stack??'',inHead=stack.includes('assertHead'),inWorker=stack.includes('assertWorkerAccess'),atSpawn=/\bat createChild\b/.test(stack);
            if(inHead)headEntered=true;
            const selected=headCut?inHead:inWorker;
            if(cut!=='positive'&&!tripped&&selected&&(cut.endsWith('spawn')?atSpawn:!atSpawn)){
              originRun=f.store().list()[0]!;
              originOwner=readRunOwnerReceipt(resolveRunOwnerReceiptPath('acme/widgets',originRun.id));originClaim=f.claim();
              assert.ok(originClaim);assert.equal(originClaim.runId,null,'The newly running remote claim has not yet received the durable Run ID');
              assert.equal(originClaim.state,'running');assert.equal(originRun.dispatchClaimId,originClaim.claimId);
              assert.equal(f.store().list().filter(candidate=>candidate.dispatchClaimId===originClaim!.claimId).length,1,'Exactly one canonical Run owns the immutable claim ID');
              assert.ok(originOwner);assert.equal(originOwner.runId,originRun.id);assert.equal(originOwner.claimId,originClaim.claimId);
              spawnCutObserved=atSpawn;tripped=true;
              if(drift==='descriptor')f.enable(false);
              else writeFileSync(path.join(f.record.codex.runtimeDirectory,'runtime.cjs'),'revoked controlled runtime bytes');
            }
          }
          return Reflect.apply(originalRead,fs,[file,...args]);
        }) as typeof fs.readFileSync;
        // Scope HEAD counting to Codex's selected adapter call, not later
        // bootstrap/workspace reads; delegate every actual child unchanged.
        childProcess.execFile=((...args:unknown[])=>{
          if(args[0]===f.record.codex.path)workerChildren++;
          const argv=args[1] as readonly string[]|undefined,selectedHead=/\bat CodexCliAdapter\.readHead\b/.test(new Error().stack??'');
          if(selectedHead&&args[0]===f.record.git.path&&argv?.slice(-2).join('/')==='rev-parse/HEAD')headChildren++;
          return Reflect.apply(originalExec,childProcess,args);
        }) as typeof childProcess.execFile;syncBuiltinESMExports();
        let code:number|undefined;
        try{code=await f.invoke(['dispatch','once'],true);}
        catch(error){
          const failure=error as {code?:unknown;details?:{path?:unknown};cause?:unknown};
          const expected=drift==='artifact'&&tripped&&error instanceof Error&&failure.code==='GH_TRANSPORT_FAILED'&&failure.details?.path==='repos/acme/widgets/issues/1/comments'&&failure.cause instanceof Error&&failure.cause.message==='Accepted artifact/program filesystem identity changed; restart/requalification required.';
          if(!expected)throw error;
          finalizationRefused=true;
        }
        f.facts('typed-'+cut+'-'+drift);
        const run=f.store().list()[0]!,claim=f.claim()!;
        const owner=readRunOwnerReceipt(resolveRunOwnerReceiptPath('acme/widgets',run.id))!;
        const lane=createHostAdmissionRegistry().readLane(owner.laneId)!;
        process.stderr.write('STAGE10_TYPED_FINALIZATION '+JSON.stringify({cut,drift,finalizationRefused,spawnCutObserved,state:run.state,ownerPhase:owner.phase,laneState:lane.status,claimState:claim.state,workerChildren,headChildren})+'\n');
        assert.ok(run.dispatchClaimId);assert.equal(claim.claimId,run.dispatchClaimId);
        assert.equal(f.store().list().filter(candidate=>candidate.dispatchClaimId===claim.claimId).length,1,'The retained claim resolves to exactly this canonical Run');
        assert.equal(owner.runId,run.id);assert.equal(owner.claimId,claim.claimId);
        assert.equal(owner.missionId,lane.missionId);assert.equal(owner.laneId,lane.laneId);assert.equal(owner.generation,lane.generation);
        assert.equal(owner.phase,'parked');assert.equal(owner.token,undefined);assert.equal(lane.status,'parked');
        assert.equal(run.state,'NEEDS_HUMAN');assert.equal(run.interruptedFrom,'IMPLEMENTING');
        assert.equal(run.history.some(h=>h.type==='agent_failed'),false,'An admission refusal is not a provider failure');
        if(cut==='positive'){
          assert.equal(code,0);assert.equal(finalizationRefused,false);assert.equal(tripped,false);assert.equal(workerChildren,1);assert.equal(f.workers(),1);
          assert.ok(headEntered);assert.equal(headChildren,1);assert.match(run.interrupt!.reason,/Worker result did not advance the authorized HEAD/);assert.equal(claim.state,'needs_human');assert.equal(claim.runId,run.id);
        }else{
          assert.equal(tripped,true,'The selected concrete authority cut must execute');
          assert.equal(spawnCutObserved,cut.endsWith('spawn'),'Final-spawn cases must observe the real synchronous createChild frame');
          assert.ok(originRun);assert.ok(originOwner);assert.ok(originClaim);
          assert.equal(run.id,originRun.id);assert.equal(JSON.stringify(run.target)===JSON.stringify(originRun.target),true);
          assert.equal(JSON.stringify(run.execution)===JSON.stringify(originRun.execution),true);assert.equal(JSON.stringify(run.bootstrap)===JSON.stringify(originRun.bootstrap),true);
          assert.equal(JSON.stringify(run.implementationAuthority)===JSON.stringify(originRun.implementationAuthority),true);
          for(const key of ['missionId','laneId','runId','claimId'] as const)assert.equal(owner[key],originOwner[key]);
          assert.equal(claim.claimId,originClaim.claimId);assert.equal(originClaim.runId,null);assert.equal(run.dispatchClaimId,originClaim.claimId);
          assert.match(run.interrupt!.reason,/Implementation execution was refused at the current host admission boundary/);
          assert.equal(run.agentResult,undefined,'Refusal cannot manufacture provider completion');
          assert.equal(workerChildren,headCut?1:0);assert.equal(f.workers(),headCut?1:0);assert.equal(headChildren,0);
          if(drift==='artifact'){
            assert.equal(finalizationRefused,true);assert.equal(code,undefined);assert.equal(claim.state,'running','Invalid installation cannot settle the remote claim');assert.equal(claim.runId,null);
            assert.equal(JSON.stringify(claim)===JSON.stringify(originClaim),true,'The original remote claim remains truthfully unsettled');
          }else{assert.equal(finalizationRefused,false);assert.equal(code,0);assert.equal(claim.state,'needs_human');assert.equal(claim.runId,run.id);}
          if(headCut){
            const workspace=run.bootstrap!.workspacePath;
            assert.equal(existsSync(path.join(workspace,'controlled-worker.txt')),true);
            assert.equal(execFileSync(f.record.git.path,['log','-1','--format=%s'],{cwd:workspace,encoding:'utf8'}).trim(),'controlled worker commit');
            assert.notEqual(execFileSync(f.record.git.path,['rev-parse','HEAD'],{cwd:workspace,encoding:'utf8'}).trim(),run.bootstrap!.baseSha,'Actual successful worker commit remains in its private workspace');
          }
        }
      }finally{Error.stackTraceLimit=originalStackLimit;fs.readFileSync=originalRead;childProcess.execFile=originalExec;syncBuiltinESMExports();f.cleanup();}
    });
  });

  it('reports installed actor binding as not probed without an authentication or user request',async()=>{
    const f=await installedFixture(true);const original=console.log;const output:string[]=[];console.log=(v?:unknown)=>output.push(String(v));let calls=0;
    try{const runner:ProcessRunner={async run(){calls++;throw new Error('Preflight must not probe authentication');}};const snapshot=f.resolve(runner);assert.equal(snapshot.installation,'accepted',snapshot.reason);assert.equal(snapshot.actorBinding.state,'not_probed');assert.equal(snapshot.actorBinding.expectedActorId,'123');assert.equal('GH_TOKEN' in snapshot.environment,false);await f.invoke(['production','preflight'],{runner});const report=JSON.parse(output.at(-1)!);assert.equal(report.host.actorBinding.state,'not_probed');assert.equal(report.host.actorBinding.expectedActorId,'123');assert.match(report.host.mergeAvailabilityMeaning,/not probed/);assert.equal(calls,0);}finally{console.log=original;f.cleanup();}
  });

  it('executes installed binding code with token precedence and refuses HOLD set during actor verification',async()=>{
    for(const hold of [false,true]){const f=await installedFixture(true);const original=console.log;console.log=()=>{};let captures=0,puts=0;const token='controlled-private-installed-token';let namespace=token;let selectedEnv:NodeJS.ProcessEnv|undefined;
      try{const runner:ProcessRunner={async run(file,args,options){options.beforeSpawn?.();assert.equal(file,f.record.gh.path);assert.equal(options.cwd,f.objectRoot);if(args[0]==='auth'){captures++;assert.equal(options.env?.GH_TOKEN===undefined,true);return{exitCode:0,stdout:namespace+'\n',stderr:''};}if(args.includes('GET')){selectedEnv=options.env;assert.equal(selectedEnv?.GH_TOKEN===token,true);namespace='controlled-replacement-token';if(hold)await f.invoke(['dispatch','maintenance','hold'],{runner});return{exitCode:0,stdout:'{"id":123}',stderr:''};}puts++;assert.equal(options.env===selectedEnv,true);assert.equal(options.env?.GH_TOKEN===token,true);return{exitCode:0,stdout:'{"merged":true}',stderr:''};}};
        const snapshot=f.resolve(runner);const operation=snapshot.transport!.write!('repos/acme/widgets/pulls/7/merge','PUT',{sha:'a'.repeat(40),merge_method:'squash'});if(hold)await assert.rejects(operation,/final installation or current merge authority/);else assert.deepEqual(await operation,{merged:true});assert.equal(captures,1);assert.equal(puts,hold?0:1);assert.equal(JSON.stringify(snapshot).includes(token),false);assert.equal(snapshot.environment.GH_TOKEN===undefined,true);assert.equal(process.env.GH_TOKEN===token,false);
      }finally{console.log=original;f.cleanup();}
    }
  });

  it('retains active and unknown local invocation locks before current configuration or host requests',async()=>{
    const f=await installedFixture(true);const log=console.log;const printed:string[]=[];console.log=(v?:unknown)=>printed.push(String(v));const lock=acquireDispatchInvocationLock({lockPath:path.join(f.accountRoot,'dispatch/once.lock')});const lockPath=path.join(f.accountRoot,'dispatch/once.lock');const bytes=readFileSync(lockPath);try{let calls=0;const runner:ProcessRunner={async run(){calls++;throw new Error('No host requests behind a live/unknown local owner');}};writeFileSync(f.hostPath,'{broken');writeFileSync(f.dispatchPath,'{broken');for(const state of ['active','unknown']){if(state==='unknown')writeFileSync(lockPath,'{unknown-process-owner');assert.equal(await f.invoke(['dispatch','once'],{runner}),0);assert.ok(printed.at(-1)!.includes('already_running'));}assert.equal(calls,0);}finally{writeFileSync(lockPath,bytes);lock.release();console.log=log;f.cleanup();}
  });
  it('rechecks production drift at real review preparation/marker/request and validation caller boundaries',async()=>{
    for(const cut of ['review-prepared','review-marker','review-final-claim','validation'] as const)for(const revoke of [false,true]){
      traceCut('review-validation-drift',cut,'entered',{revoke});
      const f=await commandFixture();const prototype=f.InstalledStore.prototype;const update=prototype.updateIfUnchanged;let tripped=false;const original=readFileSync(f.hostPath,'utf8');
      const atCut=()=>{if(tripped)return;tripped=true;if(revoke){const changed={...JSON.parse(original),revision:'host-drift-at-final-cut'};writeFileSync(f.hostPath,JSON.stringify(changed));assert.equal(readFileSync(f.hostPath,'utf8')!==original,true,'The selected cut must change captured descriptor bytes.');}};
      try{
        if(cut==='validation')f.setValidationHook(async()=>{await Promise.resolve();atCut();});
        else if(cut==='review-final-claim')f.setProcessHook(endpoint=>{if(endpoint==='repos/acme/widgets/issues/1/comments'&&f.store().read('run-native')?.nativeReview?.requests.at(-1)?.submissionPossible)atCut();});
        else prototype.updateIfUnchanged=function(expected,next){const won=update.call(this,expected,next);const before=expected.nativeReview?.requests.at(-1);const after=next.nativeReview?.requests.at(-1);if(won&&after&&(cut==='review-prepared'?!before:before?.submissionPossible===false&&after.submissionPossible))atCut();return won;};
        try{await f.invoke(['dispatch','once']);}catch(error){if(!revoke)throw error;assert.match(String(error),/changed|latched|configuration|restart|admission/);}
        assert.equal(tripped,true,cut);assert.equal(readFileSync(f.hostPath,'utf8')!==original,revoke,cut);
        assert.equal(f.stats().submissions,revoke?0:1,cut);
        if(cut==='validation')assert.equal(f.stats().validationCalls,revoke?0:1);
        if(!revoke)assert.equal(f.store().read('run-native')!.state,'MERGE_READY');
        traceCut('review-validation-drift',cut,'completed',{revoke,bytesChanged:readFileSync(f.hostPath,'utf8')!==original,submissions:f.stats().submissions,validationCalls:f.stats().validationCalls});
      }finally{prototype.updateIfUnchanged=update;f.cleanup();}
    }
  });
  it('fences captured production drift after final lead claim reads and at repair worker/publication effects',async(t)=>{
    for(const cut of ['positive','lead-final-claim','repair-consumption','repair-bootstrap-mutation','repair-worker','repair-publication'] as const)await t.test(cut,async()=>{
      traceCut('production-entry',cut,'entered');
      const original=leadRepairFixture({executionRevision:PRODUCTION_POLICY_REVISION,timeoutMs:900000,localValidationRevision:PRODUCTION_POLICY_REVISION,hostedPolicy:{revision:PRODUCTION_POLICY_REVISION,policy:{mode:'not_required'}}});
      const installed=await installedFixture();
      try{
        const captured=installed.resolve();assert.equal(captured.installation,'accepted',captured.reason);captured.assertInitiation();
        const initialDescriptor=readFileSync(installed.hostPath);
        const workflow={...original.workflow(),assertNormalInitiation:captured.assertRunInitiation};const admission=original.registry();
        let tripped=false,effects=0,consumptionBoundary=false,consumptionClaimReads=0,bootstrapMutationChildren=0;
        let leadBudgetAtDrift:number|undefined;
        const revoke=()=>{if(!tripped){if(cut==='lead-final-claim')assert.equal(original.counts().leadCalls,0,'Durable marked request has not been submitted');leadBudgetAtDrift=original.store().list()[0]?.nativeLead?.requests.length;tripped=true;installed.enable(false);assert.notDeepEqual(readFileSync(installed.hostPath),initialDescriptor,'Actual captured descriptor bytes changed');}};
        const originalGit=original.git.runner.run.bind(original.git.runner);
        if(cut==='repair-bootstrap-mutation')original.git.runner.run=async(file,args,options)=>{if(!tripped&&args.includes('fetch')&&original.store().list()[0]?.history.some(h=>h.type==='start_fix')){await Promise.resolve();revoke();options.beforeSpawn?.();bootstrapMutationChildren++;}return originalGit(file,args,options);};
        const invoke=async(ref:string,claimId:string,claim:((r:Run)=>Promise<void>)|undefined,initiate:((r:Run)=>Promise<void>)|undefined)=>runIssueCommand(workflow,ref,{
          execution:original.execution,repairTaskShapeAuthority:original.shape,dispatchClaimId:claimId,admission,runOwnerReceiptPath:original.receiptPath,now:original.now,maxReviewAttempts:1,
          assertReviewClaim:async r=>{await claim?.(r);const durable=original.store().read(r.id)!;
            if(cut==='lead-final-claim'&&durable.nativeLead?.requests.at(-1)?.submissionPossible)revoke();
            if(cut==='repair-consumption'&&consumptionBoundary&&durable.nativeLead?.requests.at(-1)?.status==='qualified_complete'){consumptionClaimReads++;revoke();}},
          assertLeadInitiation:async r=>{await initiate?.(r);captured.assertRunInitiation(r);},
          withDispatchAdmissionLock:async op=>{if(cut==='repair-consumption'&&original.store().list()[0]?.nativeLead?.requests.at(-1)?.status==='qualified_complete')consumptionBoundary=true;return op();},
          withNativeEffectBoundary:op=>{effects++;if(cut==='repair-worker'||cut==='repair-publication'&&effects===2)revoke();return op();},
        });
        const dispatch=()=>dispatchOnceCommand(original.config,{workflow,runtime:original.runtime,admission,now:original.now,resolveExecutionProfile:()=>original.execution,
          runIssue:async(ref,_execution,claimId,_shape,_registry,_release,_lock,claim,_merge,initiate)=>invoke(ref,claimId,claim,initiate),
          resumeClaimedRun:async(run,claimId,_registry,_release,_lock,claim,_merge,initiate)=>invoke(`acme/widgets#${run.target.kind==='issue'?run.target.issueNumber:0}`,claimId,claim,initiate),
        });
        let outcome:Awaited<ReturnType<typeof dispatchOnceCommand>>|undefined;
        try{outcome=await dispatch();}catch(error){if(cut==='positive')throw error;assert.match(String(error),/changed|latched|admission|configuration/);}
        const run=original.run();const packets=readFileSync(original.prompts,'utf8').split('Packet: tachiko.implementation-packet.v1').length-1;
        if(cut==='positive'){
          const text=(value:unknown)=>typeof value==='string'?value.slice(0,700):undefined;
          process.stderr.write(`STAGE10_LEAD_POSITIVE ${JSON.stringify({outcome:outcome?.outcome,executionState:outcome?.outcome==='dispatched'?outcome.execution.state:undefined,reason:outcome&&'reason' in outcome?text(outcome.reason):undefined,state:run.state,interruptedFrom:run.interruptedFrom,waitReason:text(run.interrupt?.reason),reviewWait:run.nativeReview?.wait?.kind,leadWait:run.nativeLead?.wait?.kind,requests:{review:run.nativeReview?.requests.map(r=>({status:r.status,submissionPossible:r.submissionPossible,observations:r.observations})),lead:run.nativeLead?.requests.map(r=>({status:r.status,submissionPossible:r.submissionPossible,observations:r.observations}))},repairAdmissions:run.repairAdmissions?.length??0,startFixes:run.history.filter(h=>h.type==='start_fix').length,effects,packets,counters:original.counts(),accepted:captured.installation,descriptorUnchanged:readFileSync(installed.hostPath).equals(initialDescriptor)})}\n`);
          captured.assertRunInitiation(run);assert.equal(tripped,false);assert.equal(run.state,'WAITING_DEPENDENCY');assert.equal(run.interruptedFrom,'REVIEWING');assert.equal(run.nativeReview?.wait?.kind,'binding');
          assert.equal(run.interrupt?.reason,'Native review original retired from active review after candidate movement; remote cancellation is unknown and its evidence remains retained.');
          assert.equal(run.nativeReview!.requests.length,1);assert.equal(run.nativeReview!.activeRequestId,undefined);const retired=run.nativeReview!.requests[0]!;assert.equal(retired.status,'retired');assert.equal(retired.submissionPossible,true);assert.ok(retired.completionProof);assert.ok(hasAuthenticatedCompletion(retired.identity,retired.terminalDigest,retired.completionProof,'review'));
          assert.notEqual(retired.identity.headSha,run.headSha);const nativeRoot=path.dirname(path.dirname(retired.completionProof.file));const receiptFiles=[retired.completionProof.file,path.join(nativeRoot,`${retired.identity.requestId}.request.json`),path.join(nativeRoot,`${retired.identity.requestId}.terminal.json`)];const receiptBytes=receiptFiles.map(file=>readFileSync(file));
          const retiredSnapshot=structuredClone(retired);const counts=original.counts();assert.equal(counts.leadCalls,1);assert.equal(counts.reviewCalls,1);assert.equal(counts.validationCalls,2);assert.equal(run.repairAdmissions?.length,1);assert.equal(run.history.filter(h=>h.type==='start_fix').length,1);assert.equal(effects,2);assert.equal(packets,2);
          const claim=selectDispatchRuntime(await original.runtime.listRuntimeComments())!.claim;const owner=readRunOwnerReceipt(original.receiptPath)!;assert.equal(claim.claimId,run.dispatchClaimId);assert.equal(claim.runId,run.id);
          const due=run.nativeReview!.wait!.nextAttemptAt;assert.ok(Date.parse(due)>Date.parse(original.now()));original.advanceTo(due);assert.equal(original.now(),due);captured.assertRunInitiation(run);
          // Exactly one ordinary due-time reentry; no old request resend or additional repair effect.
          const continued=await dispatch();const ready=original.run();assert.equal(continued.outcome,'dispatched');if(continued.outcome==='dispatched')assert.equal(continued.execution.state,'MERGE_READY');assert.equal(ready.state,'MERGE_READY');
          assert.equal(ready.nativeReview!.requests.length,2);assert.deepEqual(ready.nativeReview!.requests[0],retiredSnapshot);const fresh=ready.nativeReview!.requests[1]!;assert.notEqual(fresh.identity.requestId,retired.identity.requestId);assert.equal(fresh.identity.headSha,ready.headSha);assert.equal(ready.nativeReview!.accepted!.requestId,fresh.identity.requestId);assert.equal(ready.nativeReview!.activeRequestId,fresh.identity.requestId);assert.ok(hasAuthenticatedCompletion(fresh.identity,fresh.terminalDigest,fresh.completionProof,'review'));
          for(const [index,file] of receiptFiles.entries())assert.deepEqual(readFileSync(file),receiptBytes[index],'Original completed request/receipt bytes are immutable');
          assert.deepEqual(ready.history.slice(0,run.history.length),run.history);assert.deepEqual(ready.execution,run.execution);assert.deepEqual(ready.implementationAuthority,run.implementationAuthority);assert.deepEqual(ready.repairAdmissions,run.repairAdmissions);assert.deepEqual(ready.nativeLead!.requests,run.nativeLead!.requests);assert.equal(ready.history.filter(h=>h.type==='start_fix').length,1);
          const after=original.counts();assert.equal(after.reviewCalls,2);for(const key of ['leadCalls','validationCalls','observations','boundaries'] as const)assert.equal(after[key],counts[key]);assert.equal(effects,2);assert.equal(readFileSync(original.prompts,'utf8').split('Packet: tachiko.implementation-packet.v1').length-1,2);assert.deepEqual(original.reviewRequests.map(r=>r.identity.requestId),[retired.identity.requestId,fresh.identity.requestId]);
          const retained=readRunOwnerReceipt(original.receiptPath)!;for(const key of ['missionId','laneId','runId','claimId'] as const)assert.equal(retained[key],owner[key]);assert.equal(selectDispatchRuntime(await original.runtime.listRuntimeComments())!.claim.claimId,claim.claimId);assert.deepEqual(readFileSync(installed.hostPath),initialDescriptor);captured.assertRunInitiation(ready);return;}

        assert.equal(tripped,true,cut);assert.equal(original.counts().leadCalls,cut==='lead-final-claim'?0:1);assert.notEqual(run.state,'MERGE_READY');assert.equal(run.nativeLead?.requests.length,leadBudgetAtDrift,'No new lead request after revocation');
        if(cut==='lead-final-claim'){assert.equal(run.nativeLead!.requests.length,1);assert.equal(run.nativeLead!.requests[0]!.submissionPossible,true);assert.equal(run.repairAdmissions?.length??0,0);}
        if(cut==='repair-bootstrap-mutation'){assert.equal(bootstrapMutationChildren,0,'Actual bootstrap Git beforeSpawn refuses the child');assert.equal(run.history.filter(h=>h.type==='start_fix').length,1);}
        if(cut==='repair-consumption'){assert.equal(run.history.filter(h=>h.type==='start_fix').length,0);assert.equal(run.repairAdmissions?.length??0,0);assert.ok(run.nativeLead?.acceptances.length);assert.equal(consumptionClaimReads,1,'Drift occurs during final claim read inside serialized consumption boundary');}
        assert.equal(packets,cut==='repair-publication'?2:1,cut);assert.throws(captured.assertInitiation,/latched/);
      }finally{installed.cleanup();original.cleanup();traceCut('production-entry',cut,'finished');}
    });
  });
  it('authenticates original retained proof before explicit merged recovery changes Run, owner receipt or registry',async(t)=>{
    for(const cut of ['absent','revoked-after-read','original'] as const)await t.test(cut,async()=>{
      traceCut('production-entry',cut,'entered');const f=await commandFixture();
      try{
        await f.review();f.setLostAck();await f.invoke(['dispatch','once']);assert.equal(f.stats().squashes,1);assert.equal(f.store().read(f.runId)!.mergeAttempt?.submissionPossible,true);
        await f.invoke(['dispatch','maintenance','hold']);f.enable(false);f.setMerged();
        let authorized=true,validReads=0,rejectedReads=0,revocations=0;
        const verifier:NativeCompletionHosts={review:{receipts:f.reviewer.receipts,authenticate:e=>{const valid=authorized&&f.reviewer.authenticate(e);if(valid)validReads++;else rejectedReads++;return valid;}}};
        const runPath=path.join(f.accountRoot,'runs','run-native.json');const ownerPath=resolveRunOwnerReceiptPath('acme/widgets','run-native');const registryPath=path.join(f.accountRoot,'mission-admission/registry.json');
        const paths=[runPath,ownerPath,registryPath];const before=paths.map(file=>readFileSync(file));
        const checked=new f.InstalledStore({dir:path.join(f.accountRoot,'runs'),nativeCompletionHosts:verifier});assert.ok(checked.read('run-native'));assert.ok(validReads>0,'Initial read actually authenticates original proof');
        if(cut==='revoked-after-read')f.setProcessHook(endpoint=>{if(endpoint.startsWith('repos/acme/widgets/compare/')){authorized=false;revocations++;}});
        if(cut==='original'){await f.invoke(['run','transition','run-native','merged'],false,verifier);assert.equal(f.store().read('run-native')!.state,'MERGED');assert.equal(readRunOwnerReceipt(ownerPath)!.phase,'released');}
        else{
          await assert.rejects(f.invoke(['run','transition','run-native','merged'],false,cut==='absent'?'absent':verifier),/auth|completion|proof/i);
          if(cut==='revoked-after-read'){assert.ok(revocations>0,'Actual merged comparison reached the revocation hook');assert.ok(rejectedReads>0,'Final write authenticates again after revocation');}
          for(const [index,file] of paths.entries())assert.deepEqual(readFileSync(file),before[index],`${cut}: durable authority bytes unchanged`);
        }
        assert.equal(f.stats().squashes,1);assert.equal(f.stats().modelCalls,0);assert.equal(readOperationalRuntimeProjection(path.join(f.accountRoot,'runs'))!.maintenanceHold.active,true);
      }finally{f.cleanup();traceCut('production-entry',cut,'finished');}
    });
  });

  it('refuses malformed or unreadable final merge HOLD at capture, actor and PUT cuts without resubmission',async(t)=>{
    for(const cut of ['positive','capture','actor','put'] as const)for(const failure of (cut==='positive'?['malformed']:['malformed','unreadable']) as ('malformed'|'unreadable')[])await t.test(cut+'-'+failure,async()=>{
      const f=await commandFixture();const originalRead=fs.readFileSync;let invalidated=false;
      const projection=operationalRuntimeProjectionPath(path.join(f.accountRoot,'runs'));
      try{
        await f.review();const projectionBytes=originalRead(projection);
        const ownerPath=resolveRunOwnerReceiptPath('acme/widgets',f.runId),owner=readRunOwnerReceipt(ownerPath)!;
        const invalidate=()=>{invalidated=true;if(failure==='malformed')writeFileSync(projection,'{invalid-runtime-projection');};
        if(cut==='capture')f.setProcessHook(endpoint=>{if(endpoint==='auth-token')invalidate();});
        if(cut==='actor')f.afterActor(invalidate);if(cut==='put')f.beforePut(invalidate);
        fs.readFileSync=((file:fs.PathOrFileDescriptor,...args:unknown[])=>{
          if(invalidated&&failure==='unreadable'&&String(file)===projection)throw Object.assign(new Error('Controlled projection unavailable'),{code:'EACCES'});
          return Reflect.apply(originalRead,fs,[file,...args]);
        }) as typeof fs.readFileSync;syncBuiltinESMExports();
        let printed:string[]=[];try{printed=(await f.invoke(['dispatch','once'])).printed;}catch(error){assert.match(String(error),/runtime projection|actor binding|merge authority/i);}
        const current=f.store().read(f.runId)!;
        if(cut==='positive'){
          assert.equal(invalidated,false);assert.equal(f.stats().squashes,1);assert.equal(f.stats().captures,1);assert.equal(f.stats().boundActorGets,1);assert.equal(f.stats().boundPuts,1);
          assert.equal(current.state,'MERGE_READY');assert.equal(current.mergeAttempt!.submissionPossible,true);assert.ok(current.mergeAttempt!.qualification);
          assert.equal(current.mergeAttempt!.identity.treeSha,f.tree);const issuedIdentity=structuredClone(current.mergeAttempt!.identity);
          assert.equal(f.claim()!.claimId,current.dispatchClaimId);assert.equal(f.claim()!.runId,current.id);
          // Qualification is durable issuance evidence. The existing original-
          // attempt dispatcher reconciliation settles it on the following poll.
          await f.invoke(['dispatch','maintenance','hold']);await f.invoke(['dispatch','once'],false);
          const settled=f.store().read(f.runId)!,released=readRunOwnerReceipt(ownerPath)!,settledClaim=f.claim()!;
          assert.equal(settled.state,'MERGED');assert.deepEqual(settled.mergeAttempt!.identity,issuedIdentity);assert.deepEqual(settled.mergeAttempt!.qualification,current.mergeAttempt!.qualification);
          assert.equal(released.phase,'released');assert.equal(released.token,undefined);for(const key of ['missionId','laneId','runId','claimId'] as const)assert.equal(released[key],owner[key]);
          assert.equal(settledClaim.claimId,settled.dispatchClaimId);assert.equal(settledClaim.runId,settled.id);assert.equal(settledClaim.state,'merge_ready','HOLD retains the settled original queue fence in the existing protocol');
          assert.equal(f.stats().squashes,1);assert.equal(f.stats().captures,1);assert.equal(f.stats().boundActorGets,1);assert.equal(f.stats().boundPuts,1);assert.equal(f.store().list().length,1);
          assert.equal(readOperationalRuntimeProjection(path.join(f.accountRoot,'runs'))!.maintenanceHold.active,true);
        }else{
          assert.equal(invalidated,true);assert.equal(f.stats().squashes,0);assert.equal(f.stats().boundPuts,0);assert.equal(f.stats().captures,1);
          assert.equal(current.mergeAttempt?.submissionPossible,true,'Late refusal retains the monotonic possible-submission marker');
          assert.match(current.mergeAttempt!.reason!,/Merge actor binding unavailable/);
          const retained=readRunOwnerReceipt(ownerPath)!;for(const key of ['missionId','laneId','runId','claimId'] as const)assert.equal(retained[key],owner[key]);
          assert.equal(f.store().list().length,1);
          const safe=JSON.stringify({printed,reason:current.mergeAttempt!.reason});
          for(const token of ['synthetic-private-actor-A','synthetic-private-actor-B'])assert.equal(safe.includes(token),false);
          // Restore only the controlled projection fault, then use the original
          // issued observation path under HOLD with current merge disabled.
          fs.readFileSync=originalRead;syncBuiltinESMExports();invalidated=false;writeFileSync(projection,projectionBytes);
          await f.invoke(['dispatch','maintenance','hold']);f.enable(false);f.tick();const before=f.stats();
          await f.invoke(['dispatch','once'],false);
          assert.equal(f.stats().captures,before.captures);assert.equal(f.stats().boundPuts,0);assert.equal(f.stats().squashes,0);
          assert.equal(f.store().read(f.runId)!.mergeAttempt!.submissionPossible,true);
          assert.equal(readOperationalRuntimeProjection(path.join(f.accountRoot,'runs'))!.maintenanceHold.active,true);
        }
      }finally{fs.readFileSync=originalRead;syncBuiltinESMExports();f.cleanup();}
    });
  });

  it('reports sanitized merge-binding refusal through actual entry and stores without resubmission',async()=>{
    const sentinel='synthetic-secret-sentinel';
    for(const cut of ['unsupported','empty','multiline','throw','malformed-actor','mismatch','capture-drift','actor-drift','put-drift'] as const){traceCut('production-entry',cut,'entered');const f=await commandFixture();try{await f.review();if(cut==='unsupported')f.setCaptureFailure({exitCode:1,stdout:sentinel,stderr:sentinel});if(cut==='empty')f.setCaptureFailure({exitCode:0,stdout:'',stderr:''});if(cut==='multiline')f.setCaptureFailure({exitCode:0,stdout:sentinel+'\nextra\n',stderr:''});if(cut==='throw')f.setCaptureFailure(Object.assign(new Error(sentinel),{stdout:sentinel,stderr:sentinel}));if(cut==='malformed-actor')f.setActorResponse({id:sentinel});if(cut==='mismatch')f.setActor('999');if(cut==='capture-drift')f.setProcessHook(endpoint=>{if(endpoint==='auth-token')f.enable(false);});if(cut==='actor-drift')f.afterActor(()=>f.enable(false));if(cut==='put-drift')f.beforePut(()=>f.enable(false));
      const result=await f.invoke(['dispatch','once']);assert.equal(f.stats().squashes,0,cut);const marked=f.store().read(f.runId)!;assert.equal(marked.mergeAttempt?.submissionPossible,true);assert.match(marked.mergeAttempt!.reason!,/Merge actor binding unavailable/);assert.ok(result.printed.some(v=>v.includes('Merge actor binding unavailable')));const serialized=JSON.stringify({result,marked});assert.equal(serialized.includes(sentinel),false);assert.equal(readFileSync(path.join(f.accountRoot,'runs',f.runId+'.json'),'utf8').includes(sentinel),false);const before=f.stats();await f.invoke(['dispatch','maintenance','hold']);f.tick();await f.invoke(['dispatch','once'],false);assert.equal(f.stats().captures,before.captures);assert.equal(f.stats().squashes,0);assert.equal(f.store().list().length,1);assert.equal(readOperationalRuntimeProjection(path.join(f.accountRoot,'runs'))!.maintenanceHold.active,true);
    }finally{f.cleanup();traceCut('production-entry',cut,'finished');}}
  });
  it('constructs the resolver host in once/serve, issues one expected-HEAD squash and qualifies/settles the original Run',async()=>{
    const f=await commandFixture();try{await f.review();f.afterActor(()=>f.setActor('999'));const s=f.resolve(f.runner);assert.equal(s.repositoryRoot,f.objectRoot);assert.deepEqual(s.nativeMergeHost!.candidate(f.base,f.head),{treeSha:f.tree,baseIsAncestor:true});await f.invoke(['dispatch','serve','--max-cycles','1','--idle-poll-ms','1']);let run=f.store().read('run-native')!;assert.ok(run.mergeAttempt?.qualification);assert.equal(run.mergeAttempt.identity.treeSha,f.tree);assert.equal(f.stats().squashes,1);assert.equal(f.stats().captures,1);assert.equal(f.stats().boundActorGets,1);assert.equal(f.stats().boundPuts,1);await f.invoke(['dispatch','maintenance','hold']);await f.invoke(['dispatch','once']);run=f.store().read('run-native')!;assert.equal(run.state,'MERGED');assert.equal(f.store().list().length,1);assert.equal(f.stats().squashes,1);assert.equal(readRunOwnerReceipt(resolveRunOwnerReceiptPath('acme/widgets','run-native'))!.phase,'released');assert.equal(readOperationalRuntimeProjection(path.join(f.accountRoot,'runs'))!.maintenanceHold.active,true);}finally{f.cleanup();}
  });
  for(const descriptor of ['absent','malformed','disabled','replaced','dispatch-malformed'] as const)it(`recovers only the issued attempt under HOLD with ${descriptor} current configuration and unavailable reasoning`,async()=>{
    traceCut('issued-recovery',descriptor,'entered');const f=await commandFixture();try{await f.review();f.setLostAck();await f.invoke(['dispatch','once']);const issued=f.store().read('run-native')!;assert.equal(issued.mergeAttempt?.submissionPossible,true);assert.equal(f.stats().squashes,1);await f.invoke(['dispatch','maintenance','hold']);if(descriptor==='absent')unlinkSync(f.hostPath);else if(descriptor==='malformed')writeFileSync(f.hostPath,'{broken');else if(descriptor==='disabled')f.enable(false);else if(descriptor==='replaced')writeFileSync(f.hostPath,'{"schemaVersion":1,"enabled":false,"releaseId":"other","revision":"h2","manifestDigest":"other"}');else writeFileSync(f.dispatchPath,'{broken');
      const compatible=f.resolve();assert.equal(compatible.installation,'accepted');compatible.assertRecoveryScope('acme','widgets');if(descriptor==='absent'||descriptor==='malformed'||descriptor==='replaced'){assert.equal(compatible.initiationPolicy.available,false);assert.throws(compatible.assertInitiation,/descriptor unavailable/);}else assert.equal(compatible.initiationPolicy.available,true);
      f.tick();f.setMerged();const before=f.stats();const start=f.calls.length;await f.invoke(['dispatch','once'],false);const qualified=f.store().read('run-native')!;assert.ok(qualified.mergeAttempt?.qualification,JSON.stringify(qualified));assert.equal(f.stats().captures,before.captures,'Issued-only observation never captures a merge credential');assert.equal(f.stats().squashes,before.squashes);assert.equal(f.stats().queueReads,before.queueReads);assert.equal(f.stats().submissions,before.submissions);assert.equal(f.stats().validationCalls,before.validationCalls);assert.equal(f.store().list().length,1);assert.ok(f.calls.slice(start).every(c=>!c.path.endsWith('/merge')&&!c.path.endsWith('/issues/comments/2')));assert.equal(readOperationalRuntimeProjection(path.join(f.accountRoot,'runs'))!.maintenanceHold.active,true);await f.invoke(['dispatch','once'],false);assert.equal(f.store().read('run-native')!.state,'MERGED');assert.equal(f.store().list().length,1);}finally{f.cleanup();traceCut('issued-recovery',descriptor,'finished');}
  });
  it('fences descriptor drift after preparation, before the marker and before the external request',async()=>{
    for(const cut of ['before-preparation','before-marker','before-request'] as const){traceCut('production-entry',cut,'entered');const f=await commandFixture();let restore=()=>{};try{await f.review();let tripped=false;const revoke=()=>{if(!tripped){tripped=true;f.enable(false);}};if(cut==='before-preparation')f.setProcessHook(endpoint=>{if(endpoint==='repos/acme/widgets/commits/main')revoke();});else{const prototype=f.InstalledStore.prototype;const update=prototype.updateIfUnchanged;prototype.updateIfUnchanged=function(expected,next){const won=update.call(this,expected,next);if(won&&(cut==='before-marker'?!expected.mergeAttempt&&!!next.mergeAttempt:expected.mergeAttempt?.submissionPossible===false&&next.mergeAttempt?.submissionPossible===true))revoke();return won;};restore=()=>{prototype.updateIfUnchanged=update;};}try{await f.invoke(['dispatch','once']);}catch(error){assert.match(String(error),/changed|latched|configuration|restart/);}assert.equal(tripped,true,cut);assert.equal(f.stats().squashes,0,cut);const run=f.store().read('run-native')!;assert.equal(run.mergeAttempt?.submissionPossible,cut==='before-request'?true:cut==='before-marker'?false:undefined);assert.equal(f.store().list().length,1);}finally{restore();f.cleanup();traceCut('production-entry',cut,'finished');}}
  });
  it('keeps dual dispatch authority, actor attribution and current base gates before zero new merges',async(t)=>{
    for(const cut of ['descriptor','actor','base','manual','direct','objects'] as const)await t.test(cut,async()=>{
      traceCut('production-entry',cut,'entered');const f=await commandFixture();
      try{
        await f.review();const initial=f.store().read(f.runId)!;assert.equal(initial.state,'MERGE_READY');assert.equal(initial.mergeAttempt,undefined);
        const ownerPath=resolveRunOwnerReceiptPath('acme/widgets',f.runId);const owner=readRunOwnerReceipt(ownerPath)!;const claim=f.claim();assert.ok(claim);const counters=f.stats();
        const paths=[path.join(f.accountRoot,'runs',f.runId+'.json'),ownerPath,path.join(f.accountRoot,'mission-admission/registry.json')];const before=paths.map(file=>readFileSync(file));
        if(cut==='descriptor'){
          const {hasAuthenticatedCompletion}=await import(new URL('./oracle/completion-proof.js',f.entryUrl).href) as typeof import('../src/oracle/completion-proof.js');
          const {unresolvedNativeReview}=await import(new URL('./oracle/native-reviewer.js',f.entryUrl).href) as typeof import('../src/oracle/native-reviewer.js');const {unresolvedNativeLead}=await import(new URL('./oracle/native-lead.js',f.entryUrl).href) as typeof import('../src/oracle/native-lead.js');
          assert.ok(initial.nativeReview?.accepted);for(const request of initial.nativeReview.requests)assert.ok(hasAuthenticatedCompletion(request.identity,request.terminalDigest,request.completionProof,'review'));assert.equal(unresolvedNativeReview(initial),false);assert.equal(unresolvedNativeLead(initial),false);
          const readLane=()=>{const state=JSON.parse(readFileSync(paths[2]!,'utf8')) as {lanes:{laneId:string;generation:number;status:string;token:string|null}[]};const lane=state.lanes.find(l=>l.laneId===owner.laneId);assert.ok(lane);return lane;};const initialLane=readLane();assert.equal(initialLane.status,'parked');assert.equal(initialLane.generation,owner.generation);assert.equal(initialLane.token===null,true);
          const {MissionAdmissionRegistry}=await import(new URL('./mission-admission/registry.js',f.entryUrl).href) as typeof import('../src/mission-admission/registry.js');const prototype=MissionAdmissionRegistry.prototype;const release=prototype.release;let releasedFrom:number|undefined;let releaseCalls=0;
          prototype.release=function(token,stopped,...callbacks){const active=readLane();const receipt=readRunOwnerReceipt(ownerPath)!;releaseCalls++;assert.equal(stopped,true);assert.equal(active.status,'active');assert.equal(active.generation,token.generation);assert.ok(active.generation>initialLane.generation);assert.equal(active.token===token.token,true);assert.equal(receipt.token?.token===token.token,true);assert.equal(receipt.generation,active.generation);assert.equal(receipt.phase,'pre_execution');releasedFrom=active.generation;return release.call(this,token,stopped,...callbacks);};
          const {merge,...disabled}=f.dispatch;writeFileSync(f.dispatchPath,JSON.stringify(disabled));const calls=f.calls.length;
          const {DispatchProtocolError}=await import(new URL('./dispatch/queue.js',f.entryUrl).href) as typeof import('../src/dispatch/queue.js');
          try{await assert.rejects(f.invoke(['dispatch','once']),(error:unknown)=>{assert.ok(error instanceof DispatchProtocolError);assert.equal(error.message,'Claim claim-native was retained but execution could not start safely: Native merge lacks identical accepted-release and current dispatch scope authority.');return true;});}finally{prototype.release=release;}
          assert.equal(releaseCalls,1);assert.ok(releasedFrom!==undefined);const released=readLane();const receipt=readRunOwnerReceipt(ownerPath)!;assert.equal(released.status,'released');assert.equal(released.generation,releasedFrom+1);assert.equal(released.token===null,true);assert.equal(receipt.phase,'released');assert.equal(receipt.generation,released.generation);assert.equal(receipt.token===undefined,true);
          for(const key of ['squashes','submissions','validationCalls','modelCalls','captures','boundActorGets','boundPuts'] as const)assert.equal(f.stats()[key],counters[key],'No new credential/model/review/validation/merge effect');assert.ok(f.calls.slice(calls).every(call=>call.method==='GET'||call.path==='repos/acme/widgets/issues/comments/9'),'Only machine-owned retained-claim bookkeeping may write');
        }else if(cut==='actor'){f.setActor('999');const result=await f.invoke(['dispatch','once']);assert.ok(result.printed.some(v=>v.includes('Merge actor binding unavailable')));}
        else if(cut==='base'){
          const {LiveGitHubAdapter}=await import(new URL('./github/live-state.js',f.entryUrl).href) as typeof import('../src/github/live-state.js');
          const github=new LiveGitHubAdapter({transport:f.resolve(f.runner).transport!,now:()=>T0});
          const valid=await github.readLiveSnapshot(TARGET);assert.equal(valid.pullRequest!.baseSha,initial.nativeReview!.accepted!.identity.baseSha);assert.equal(valid.headSha,initial.headSha);
          f.setBaseDrift();const drifted=await github.readLiveSnapshot(TARGET);assert.notEqual(drifted.pullRequest!.baseSha,initial.nativeReview!.accepted!.identity.baseSha);assert.equal(drifted.headSha,initial.headSha);
          const result=await f.invoke(['dispatch','once']);assert.equal(result.code,0);
        }else if(cut==='manual'){
          const calls=f.calls.length;
          await assert.rejects(f.invoke(['run','resume',f.runId,'--decision','merge']),/^Error: Dispatch runtime claim for Run "run-native" is missing, stale, replaced, or differently bound; refusing human resume\.$/);
          for(const [index,file] of paths.entries())assert.deepEqual(readFileSync(file),before[index],'Canonical refusal precedes every local authority write');
          assert.deepEqual(f.stats(),counters);assert.ok(f.calls.slice(calls).every(call=>call.method==='GET'));
        }else if(cut==='direct')await assert.rejects(f.invoke(['run','acme/widgets#42']),/not bound to dispatch claim/);
        else{
          const candidate=f.resolve(f.runner).nativeMergeHost!.candidate;
          assert.deepEqual(candidate(f.base,f.head),{treeSha:f.tree,baseIsAncestor:true});assert.ok(f.reviewer.source(f.base,f.head));
          unlinkSync(path.join(f.objectRoot,'.git/objects',f.head.slice(0,2),f.head.slice(2)));
          const missingObject=(error:unknown)=>{const e=error as Error&{status?:number;stderr?:Buffer};assert.equal(e.status,128);assert.ok(e.message.includes(`cat-file -t ${f.head}`));assert.match(String(e.stderr),/could not get object info|Not a valid object name|bad object/i);return true;};
          assert.throws(()=>candidate(f.base,f.head),missingObject);
          assert.throws(()=>f.reviewer.source(f.base,f.head),missingObject,'The exact accepted review source object is unavailable');
          const result=await f.invoke(['dispatch','once']);assert.equal(result.code,0);
        }
        const after=f.store().read(f.runId)!;assert.equal(f.stats().squashes,0,cut);assert.equal(f.stats().boundPuts,0);assert.equal(f.stats().modelCalls,0);assert.equal(after.dispatchClaimId,initial.dispatchClaimId);assert.equal(f.claim()!.claimId,claim.claimId);
        const retained=readRunOwnerReceipt(ownerPath)!;for(const key of ['missionId','laneId','repository','runId','claimId'] as const)assert.equal(retained[key],owner[key],'Original owner identity remains retained');if(cut==='descriptor')assert.equal(retained.phase,'released');else assert.notEqual(retained.phase,'released');
        if(cut==='actor'){assert.equal(after.mergeAttempt?.submissionPossible,true);assert.equal(f.stats().captures,counters.captures+1);assert.equal(f.stats().boundActorGets,counters.boundActorGets+1);}
        else{assert.equal(after.mergeAttempt,undefined);assert.equal(f.stats().captures,counters.captures);}
        if(cut==='base'||cut==='objects'){
          process.stderr.write(`STAGE10_MATRIX_PARK ${JSON.stringify({cut,state:after.state,interruptedFrom:after.interruptedFrom,reason:after.interrupt?.reason.slice(0,700),reviewWait:after.nativeReview?.wait?.kind,counters:f.stats()})}\n`);
          assert.equal(after.state,'WAITING_DEPENDENCY');assert.equal(after.interruptedFrom,'FINAL_GATE');assert.equal(after.nativeReview?.wait?.kind,'qualification');assert.equal(after.interrupt?.reason,'Final gate requires authenticated immutable native review evidence under current host authority.');
        }else assert.equal(after.state,'MERGE_READY');
        assert.deepEqual(after.execution,initial.execution);assert.deepEqual(after.nativeReview?.accepted,initial.nativeReview?.accepted);assert.deepEqual(after.nativeReview?.requests,initial.nativeReview?.requests);assert.deepEqual(after.repairAdmissions,initial.repairAdmissions);
        if(cut==='descriptor'){for(const key of ['target','execution','bootstrap','headSha','pullRequest','validationResult','reviewResult','nativeReview','nativeLead','repairAdmissions','implementationAuthority'] as const)assert.deepEqual(after[key],initial[key]);assert.deepEqual(after.history.slice(0,initial.history.length),initial.history);assert.deepEqual(after.history.slice(initial.history.length).map(h=>h.type),['recheck_readiness','final_gate_verified']);}
        if(cut==='manual'||cut==='direct')assert.deepEqual(after,initial,'Manual refusal precedes Run mutation');
      }finally{f.cleanup();traceCut('production-entry',cut,'finished');}
    });
  });
  it('rejects foreign transport targets with the typed ordinary scope refusal before any runner request',async()=>{
    const f=await installedFixture(true);let calls=0;try{
      const runner:ProcessRunner={async run(){calls++;throw new Error('Foreign scope must refuse before the runner');}};const s=f.resolve(runner);assert.equal(s.installation,'accepted',s.reason);
      const {GitHubLiveStateError}=await import(new URL('./github/errors.js',f.entryUrl).href) as typeof import('../src/github/errors.js');
      const endpoint='repos/foreign/repository/issues/42';
      await assert.rejects(s.transport!.get(endpoint),(error:unknown)=>{assert.ok(error instanceof GitHubLiveStateError);assert.equal(error.code,'GH_TRANSPORT_FAILED');assert.equal(error.details.path,endpoint);assert.equal(error.message,`Failed to run GitHub CLI while reading ${endpoint}.`);assert.ok(error.cause instanceof Error);assert.equal(error.cause.message,'GitHub target is outside the accepted installation repository.');return true;});
      assert.equal(calls,0);
    }finally{f.cleanup();}
  });
  it('parks unclaimed manual execution independently before any host request',async()=>{
    const f=await commandFixture();try{
      const s=f.resolve(f.runner);assert.equal(s.installation,'accepted',s.reason);const before=f.calls.length;const counters=f.stats();
      const result=await f.invoke(['run','foreign/repository#42','--execution-profile','routine','--repair-task-shape-authority','{"revision":"task-v1","shape":"bounded"}']);
      assert.equal(result.code,0);assert.ok(result.printed.some(v=>v.includes('WAITING_DEPENDENCY')&&v.includes('Native review unavailable')));
      assert.equal(f.calls.length,before);assert.deepEqual(f.stats(),counters);
      const manual=f.store().list().find(r=>r.target.owner==='foreign');assert.ok(manual);assert.equal(manual.state,'WAITING_DEPENDENCY');assert.equal(manual.dispatchClaimId,undefined);assert.equal(manual.mergeAttempt,undefined);
    }finally{f.cleanup();}
  });
  it('rejects runtime fake-host injection independently before any host request',async()=>{
    const f=await installedFixture(true);let calls=0;try{
      const runner:ProcessRunner={async run(){calls++;throw new Error('Fake-host refusal must precede any request');}};const s=f.resolve(runner);assert.equal(s.installation,'accepted',s.reason);assert.ok(s.nativeMergeHost);
      // Drain the fixed entry's ordinary import/startup before removing its private tree.
      const log=console.log;console.log=()=>{};try{assert.equal(await f.invoke(['--help'],{runner}),0);}finally{console.log=log;}
      const entry=await import(f.entryUrl) as {productionMain:(argv:string[],services:unknown)=>Promise<number>};
      await assert.rejects(entry.productionMain(['--help'],{runner,nativeMergeHost:{policy:f.policy,candidate:()=>({treeSha:'a'.repeat(40),baseIsAncestor:true})}}),/^Error: Unsupported internal production service dependency\.$/);assert.equal(calls,0);
    }finally{f.cleanup();}
  });
  it('reports missing/invalid historical review verification without mutating issued Run evidence or budgets',async()=>{
    for(const cut of ['absent','wrong-root','foreign-proof','altered-evidence','false','throw','revoked-after-read'] as const){traceCut('production-entry',cut,'entered');const f=await commandFixture();try{await f.review();f.setLostAck();await f.invoke(['dispatch','once']);await f.invoke(['dispatch','maintenance','hold']);f.enable(false);f.tick();const run=f.store().read('run-native')!;let verifier:NativeCompletionHosts|'absent'=f.historical;let authorized=true;
      if(cut==='absent')verifier='absent';
      if(cut==='wrong-root')verifier={review:{receipts:new f.InstalledReceipts(path.join(f.accountRoot,'wrong-oracle')),authenticate:f.reviewer.authenticate}};
      if(cut==='false'||cut==='throw'||cut==='revoked-after-read'){verifier={review:{receipts:f.reviewer.receipts,authenticate:e=>{if(cut==='throw')throw new Error('Controlled historical auth unavailable');return authorized&&cut!=='false'&&f.reviewer.authenticate(e);}}};if(cut==='revoked-after-read'){const checked=new f.InstalledStore({dir:path.join(f.accountRoot,'runs'),nativeCompletionHosts:verifier});assert.ok(checked.read(run.id));authorized=false;}}
      if(cut==='altered-evidence'){const proof=run.nativeReview!.requests.find(r=>r.completionProof)!.completionProof!;writeFileSync(proof.file,'{"altered":true}');}
      if(cut==='foreign-proof'){const file=path.join(f.accountRoot,'runs',`${run.id}.json`);const raw=JSON.parse(readFileSync(file,'utf8')) as Run;const request=raw.nativeReview!.requests.find(r=>r.completionProof)!;(request.completionProof as {file:string}).file=path.join(f.accountRoot,'foreign-proof.json');writeFileSync(file,JSON.stringify(raw));}
      const runPath=path.join(f.accountRoot,'runs',`${run.id}.json`);const before=readFileSync(runPath);const ownerPath=resolveRunOwnerReceiptPath('acme/widgets',run.id);const owner=readFileSync(ownerPath);const beforeCalls=f.calls.length;try{const outcome=await f.invoke(['dispatch','once'],false,verifier);if(cut==='absent')assert.ok(outcome.printed.some(v=>v.includes('Historical completion verification unavailable')));}catch(error){assert.match(String(error),/completion|proof|corrupt|incompatible|auth/i);}assert.deepEqual(readFileSync(runPath),before);assert.deepEqual(readFileSync(ownerPath),owner);assert.equal(f.calls.length,beforeCalls);assert.equal(f.stats().squashes,1);assert.equal(f.stats().modelCalls,0);assert.equal(readOperationalRuntimeProjection(path.join(f.accountRoot,'runs'))!.maintenanceHold.active,true);}finally{f.cleanup();traceCut('production-entry',cut,'finished');}}
  });
  it('recovers post-repair lead and inactive review history through the accepted entry using verification-only dependencies',async()=>{
    const original=leadRepairFixture({executionRevision:PRODUCTION_POLICY_REVISION,timeoutMs:900000,localValidationRevision:PRODUCTION_POLICY_REVISION,hostedPolicy:{revision:PRODUCTION_POLICY_REVISION,policy:{mode:'not_required'}},liveSnapshot:canonicalProducerSnapshot});let f:Awaited<ReturnType<typeof commandFixture>>|undefined;try{await original.poll();if(original.run().state==='WAITING_DEPENDENCY'){original.tick();await original.poll();}const repaired=original.run();assert.equal(repaired.state,'MERGE_READY');assert.equal(repaired.repairAdmissions?.length,1);assert.ok(repaired.nativeLead!.requests.some(r=>r.completionProof));assert.ok(repaired.nativeReview!.requests.length>=2);const claim=(await original.runtime.listRuntimeComments())[0]!.body;const registry=JSON.parse(readFileSync(path.join(original.root,'admission.json'),'utf8')) as object;
      f=await commandFixture({run:repaired,objectRepository:original.git.source,receiptRoot:path.join(original.root,'oracle'),reviewer:original.reviewer,lead:original.lead,registry,ownerReceipt:readFileSync(original.receiptPath),claimBody:claim});await f.invoke(['dispatch','maintenance','hold']);f.enable();await f.invoke(['dispatch','maintenance','release']);const baseline=f.resolve(f.runner,f.historical);assert.equal(baseline.installation,'accepted',baseline.reason);baseline.assertRunInitiation(repaired);assert.equal(baseline.initiationPolicy.available,true);
      const {LiveGitHubAdapter}=await import(new URL('./github/live-state.js',f.entryUrl).href) as typeof import('../src/github/live-state.js');const installedView=await new LiveGitHubAdapter({transport:baseline.transport!,now:()=>T0}).readLiveSnapshot(TARGET);assert.equal(originalImplementationMatches(repaired,installedView),true,'Canonical REST issue/conversation/handoff must match original immutable authority before installed issuance');
      const baselineOwner=readRunOwnerReceipt(resolveRunOwnerReceiptPath('acme/widgets',f.runId))!;assert.equal(baselineOwner.runId,repaired.id);assert.equal(baselineOwner.claimId,repaired.dispatchClaimId);assert.equal(f.claim()!.claimId,repaired.dispatchClaimId);
      f.setLostAck();const firstOutcome=await f.invoke(['dispatch','once']);const firstRun=f.store().read(f.runId)!;
      // This whitelist is controlled fixture state, never environment, token, receipt payload or a broad Run dump.
      const text=(v:unknown)=>typeof v==='string'?v.slice(0,700):undefined;
      const printed=firstOutcome.printed.slice(0,4).map(value=>{try{const result=JSON.parse(value) as Record<string,unknown>;const execution=result.execution as Record<string,unknown>|undefined;return{outcome:text(result.outcome),reason:text(result.reason),waitKind:text(result.waitKind),executionState:text(execution?.state),executionReason:text(execution?.reason)};}catch{return{typedPark:value.includes('WAITING_DEPENDENCY'),typedHuman:value.includes('NEEDS_HUMAN')};}});
      const owner=readRunOwnerReceipt(resolveRunOwnerReceiptPath('acme/widgets',f.runId))!;
      const currentRegistry=JSON.parse(readFileSync(path.join(f.accountRoot,'mission-admission/registry.json'),'utf8')) as {config:{revision:string};lanes:{laneId:string;status:string;generation:number}[]};
      const lane=currentRegistry.lanes.find(value=>value.laneId===owner.laneId);
      process.stderr.write(`STAGE10_IMPORTED_PREISSUANCE ${JSON.stringify({code:firstOutcome.code,printed,state:firstRun.state,interruptedFrom:firstRun.interruptedFrom,waitReason:text(firstRun.interrupt?.reason),reviewWait:firstRun.nativeReview?.wait?.kind,leadWait:firstRun.nativeLead?.wait?.kind,claim:{id:f.claim()?.claimId,state:f.claim()?.state,profile:f.claim()?.profile},revisions:{execution:firstRun.execution?.revision,reviewRecovery:firstRun.nativeReview?.recoveryConfiguration?.revision,leadRecovery:firstRun.nativeLead?.recoveryConfiguration?.revision,currentDispatch:f.dispatch.revision,mergeDispatch:f.policy.dispatchRevision,registry:currentRegistry.config.revision},accepted:baseline.installation,currentInitiation:baseline.initiationPolicy.available,owner:{phase:owner.phase,generation:owner.generation,laneStatus:lane?.status,laneGeneration:lane?.generation},marker:firstRun.mergeAttempt?.submissionPossible??false,counters:f.stats()})}\n`);
      assert.equal(f.stats().squashes,1);const issued=f.store().read(f.runId)!;assert.equal(issued.mergeAttempt?.submissionPossible,true);await f.invoke(['dispatch','maintenance','hold']);f.enable(false);writeFileSync(f.dispatchPath,'{broken');f.tick();const retainedPath=path.join(f.accountRoot,'runs',`${f.runId}.json`);const retainedBytes=readFileSync(retainedPath);const retainedCalls=f.calls.length;const missingLead=await f.invoke(['dispatch','once'],false,{review:f.historical.review});assert.ok(missingLead.printed.some(v=>v.includes('Historical completion verification unavailable for lead')));assert.deepEqual(readFileSync(retainedPath),retainedBytes);assert.equal(f.calls.length,retainedCalls);f.setMerged();const inactive=f.store().read(f.runId)!.nativeReview!.requests.find(r=>r.identity.requestId!==f!.store().read(f!.runId)!.nativeReview!.activeRequestId&&r.completionProof)!;assert.ok(inactive);const paths=[retainedPath,resolveRunOwnerReceiptPath('acme/widgets',f.runId),path.join(f.accountRoot,'mission-admission/registry.json')];const unchanged=paths.map(p=>readFileSync(p));for(const verification of [{review:f.historical.review},{...f.historical,review:{receipts:f.historical.review!.receipts,authenticate:(e:Parameters<NonNullable<NativeCompletionHosts['review']>['authenticate']>[0])=>e.identity.requestId!==inactive.identity.requestId&&f!.historical.review!.authenticate(e)}}]){await assert.rejects(f.invoke(['run','transition',f.runId,'merged'],false,verification),/auth|completion|proof/i);for(const [i,p] of paths.entries())assert.deepEqual(readFileSync(p),unchanged[i]);}const before=f.stats();const calls=f.calls.length;const outcome=await f.invoke(['dispatch','serve','--max-cycles','1','--idle-poll-ms','1'],false);assert.equal(outcome.code,0);assert.ok(f.store().read(f.runId)!.mergeAttempt?.qualification);await f.invoke(['run','transition',f.runId,'merged'],false);assert.equal(f.store().read(f.runId)!.state,'MERGED');assert.equal(f.stats().squashes,before.squashes);assert.equal(f.stats().queueReads,before.queueReads);assert.equal(f.stats().modelCalls,0);assert.equal(f.store().list().length,1);assert.ok(f.calls.slice(calls).every(c=>!c.path.endsWith('/merge')&&!c.path.endsWith('/issues/comments/2')));assert.equal(readOperationalRuntimeProjection(path.join(f.accountRoot,'runs'))!.maintenanceHold.active,true);assert.deepEqual(f.store().read(f.runId)!.repairAdmissions,repaired.repairAdmissions);
    }finally{f?.cleanup();original.cleanup();}
  });
  it('refuses multiple coherent issued attempts before any observation or queue request',async()=>{
    const f=await commandFixture();try{await f.review();f.setLostAck();await f.invoke(['dispatch','once']);const issued=f.store().read('run-native')!;const identity=issued.mergeAttempt!.identity;const other={...issued,id:'run-other',target:{...issued.target,kind:'issue' as const,issueNumber:43},dispatchClaimId:'claim-other',nativeReview:undefined,nativeLead:undefined,bootstrap:{...issued.bootstrap!,issueNumber:43},mergeAttempt:{...issued.mergeAttempt!,identity:{...identity,attemptId:'other-attempt',runId:'run-other',claimId:'claim-other',missionId:'other-mission',laneId:'run:run-other'}}};f.store().create(other);const before=f.calls.length;await assert.rejects(f.invoke(['dispatch','once'],false),/Multiple issued/);assert.equal(f.calls.length,before);assert.equal(f.store().list().length,2);assert.equal(f.stats().squashes,1);assert.equal(f.stats().modelCalls,0);}finally{f.cleanup();}
  });
  it('retains issued ownership when supported observation auth is absent or the original receipt is foreign',async()=>{
    for(const cut of ['auth','receipt'] as const){traceCut('production-entry',cut,'entered');const f=await commandFixture();try{await f.review();f.setLostAck();await f.invoke(['dispatch','once']);await f.invoke(['dispatch','maintenance','hold']);f.tick();const receiptPath=resolveRunOwnerReceiptPath('acme/widgets','run-native');if(cut==='receipt'){const receipt=readRunOwnerReceipt(receiptPath)!;writeFileSync(receiptPath,JSON.stringify({...receipt,claimId:'foreign-claim'}));}else f.setObservationUnavailable();const before=f.stats();const receiptBytes=readFileSync(receiptPath);try{await f.invoke(['dispatch','once'],false);}catch(error){assert.match(String(error),/authentication|receipt|claim|GitHub|owner/);}assert.equal(f.stats().squashes,before.squashes);assert.equal(f.stats().queueReads,before.queueReads);assert.equal(f.stats().modelCalls,0);assert.equal(f.store().list().length,1);assert.equal(f.store().read('run-native')!.mergeAttempt!.qualification,undefined);assert.deepEqual(readFileSync(receiptPath),receiptBytes);assert.equal(readOperationalRuntimeProjection(path.join(f.accountRoot,'runs'))!.maintenanceHold.active,true);}finally{f.cleanup();traceCut('production-entry',cut,'finished');}}
  });
  it('preserves exhausted issued uncertainty and unavailable observation without resubmit or new queue work',async()=>{const f=await commandFixture();try{await f.review();f.setLostAck();await f.invoke(['dispatch','once']);await f.invoke(['dispatch','maintenance','hold']);const run=f.store().read('run-native')!;f.store().update({...run,mergeAttempt:{...run.mergeAttempt!,observations:3}});f.enable(false);const before=f.stats();await f.invoke(['dispatch','once'],false);assert.equal(f.store().read('run-native')!.mergeAttempt!.qualification,undefined);assert.equal(f.stats().squashes,before.squashes);assert.equal(f.stats().queueReads,before.queueReads);writeFileSync(f.recordPath,'{untrusted');await assert.rejects(f.invoke(['dispatch','once'],false),/Installation unavailable/);assert.equal(f.store().list().length,1);assert.equal(readOperationalRuntimeProjection(path.join(f.accountRoot,'runs'))!.maintenanceHold.active,true);}finally{f.cleanup();}});
  it('smokes the actual tsc-compiled package entry with uninstalled and disabled defaults in an isolated account',async()=>{
    const f=await installedFixture(true,true);try{f.enable(false);const output:string[]=[];const originalLog=console.log;console.log=(v?:unknown)=>output.push(String(v));try{assert.equal(await f.invoke(['production','preflight']),78);}finally{console.log=originalLog;}const disabledReport=JSON.parse(output.at(-1)!);assert.equal(disabledReport.host.installation,'accepted',disabledReport.host.reason);assert.equal(disabledReport.host.mergeAvailable,false);const preload=path.resolve('tests/fixtures/account-home-preload.mjs');const entry=path.join(f.release,'dist/production-entry.js');const env={PATH:'/usr/bin:/bin',HOME:f.home,TACHIKO_DATA_DIR:'/candidate/hidden-store',TACHIKO_NATIVE_HOST:'true',TACHIKO_IMPLEMENTATION_AGENT:'claude-code'};
      // The explicit account preload makes the installed runtime unavailable; it is a real-loader negative.
      for(const record of ['present','absent']){if(record==='absent')unlinkSync(f.recordPath);const result=spawnSync(process.execPath,['--import',preload,entry,'production','preflight'],{env,encoding:'utf8',timeout:30000});assert.equal(result.status,78,result.stderr);const report=JSON.parse(result.stdout);assert.equal(report.host.installation,'unavailable');assert.equal(report.host.mergeAvailable,false);assert.equal(report.host.historicalVerification.review.available,false);assert.equal(report.host.historicalVerification.lead.available,false);assert.equal(report.ok,false);assert.equal(report.host.runsDirectory,path.join(f.accountRoot,'runs'));}
      assert.equal(JSON.parse(readFileSync('package.json','utf8')).bin.tachiko,'dist/production-entry.js');
    }finally{f.cleanup();}
  });
});
