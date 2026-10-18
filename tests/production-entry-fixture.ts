import assert from 'node:assert/strict';
import childProcess, { execFileSync, spawnSync } from 'node:child_process';
import fs, { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
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
import { createHostAdmissionRegistry, resolveRunOwnerReceiptPath, resolveManualOwnerReceiptPath, resolveHostAdmissionPath } from '../src/mission-admission/host-registry.js';
import { operationalRuntimeProjectionPath, readOperationalRuntimeProjection, setMaintenanceHold } from '../src/operational/runtime-projection.js';
import { pathToFileURL } from 'node:url';
import { acquireDispatchInvocationLock } from '../src/dispatch/invocation-lock.js';
import { hasAuthenticatedCompletion, type NativeCompletionHosts } from '../src/oracle/completion-proof.js';
import { PRODUCTION_POLICY_REVISION } from '../src/production-policy.js';
import type { Run } from '../src/domain/types.js';
import { dispatchOnceCommand } from '../src/dispatch/command.js';
import { runIssueCommand, resolveWaitLedgerFile } from '../src/cli.js';
import { dispatchWakePath } from '../src/dispatch/wake.js';
import { fixture as leadRepairFixture } from './native-lead-fixture.js';
import { installedFixture } from './production-host-fixture.js';
import { TARGET, T0, approval, successResult, validationPassed } from './helpers.js';
import type { GitHubLiveSnapshot } from '../src/adapters/github.js';
import { ORIGINAL_ISSUE, ORIGINAL_SCOPE, originalHandoffComment, canonicalProducerSnapshot } from './production-entry-authority.js';
import { originalImplementationMatches } from '../src/domain/implementation-authority.js';
import { acceptedScopeFromHandoff, buildImplementationPacket } from '../src/agents/implementation-packet.js';

interface ImportedHistory { run: Run; objectRepository: string; receiptRoot: string; reviewer: NativeReviewerHost; lead: NonNullable<NativeCompletionHosts['lead']>; registry: object; ownerReceipt: Buffer; claimBody: string }
export async function commandFixture(imported?: ImportedHistory, profileLabel?: 'merge-settlement') {
  const f=await installedFixture(true, false, {}, { profileLabel });f.enable(false);
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
export async function directExecutionFixture(options:{productionWorker?:boolean;commitWorker?:boolean}={}) {
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


export async function commandAuthorityFixture(profileLabel?: 'command-authority') {
  const f = await installedFixture(true, false, {}, { lunaHome: true, profileLabel });
  let calls = 0;
  const runner: ProcessRunner = { async run() { calls += 1; throw new Error('Command authority proof cannot call a provider or tool runner.'); } };
  const invoke = async (argv: string[]) => {
    const log = console.log; console.log = () => {};
    try { return await f.invoke(argv, { runner }); } finally { console.log = log; }
  };
  try {
    assert.equal(await invoke(['run', 'acme/widgets#42', '--execution-profile', 'routine', '--repair-task-shape-authority', '{"revision":"task-v1","shape":"bounded"}']), 0);
    const store = new JsonFileStore({ dir: path.join(f.accountRoot, 'runs') });
    const run = store.list()[0]!;
    assert.equal(run.state, 'WAITING_DEPENDENCY');
    assert.equal(run.nativeReview?.wait?.kind, 'binding');
    assert.equal(run.interrupt?.reason, 'Native review unavailable: no accepted trusted host reviewer binding; implementation and repair are waiting.');
    assert.ok(readRunOwnerReceipt(resolveRunOwnerReceiptPath('acme/widgets', run.id)));
    assert.equal(calls, 0);
    assert.equal(await invoke(['wait', 'observe', run.id]), 0);
    const ledger = resolveWaitLedgerFile(run.id);
    assert.equal(existsSync(ledger), true, 'the accepted baseline actually writes the canonical wait ledger');
    assert.equal(await invoke(['dispatch', 'maintenance', 'hold']), 0);
    const roots = [path.join(f.accountRoot, 'runs'), path.join(f.accountRoot, 'mission-admission'), path.join(f.accountRoot, 'dispatch'), path.dirname(ledger)];
    const durable = (excluded: readonly string[] = []) => {
      const result: Record<string, string> = {};
      const walk = (file: string) => {
        if (excluded.includes(file)) return;
        if (!existsSync(file)) { result[file] = 'absent'; return; }
        const stat = lstatSync(file);
        if (stat.isDirectory()) {
          result[file] = 'directory';
          for (const entry of readdirSync(file).sort()) walk(path.join(file, entry));
        } else if (stat.isFile()) result[file] = createHash('sha256').update(readFileSync(file)).digest('hex');
        else throw new Error('Unexpected authority fixture object type.');
      };
      for (const root of roots) walk(root);
      return JSON.stringify(result);
    };
    return { ...f, invoke, run, ledger, store, durable, calls: () => calls };
  } catch (error) { f.cleanup(); throw error; }
}

export async function manualAuthorityFixture(profileLabel: 'manual-registry'|'manual-recovery') {
  const f = await installedFixture(true, false, {}, { profileLabel });
  let calls = 0;
  const runner: ProcessRunner = { async run() { calls += 1; throw new Error('Manual authority proof cannot call a provider.'); } };
  const invoke = async (argv: string[]) => {
    const log = console.log; console.log = () => {};
    try { return await f.invoke(argv, { runner }); } finally { console.log = log; }
  };
  try {
    const git = (...args: string[]) => execFileSync(f.record.git.path, ['-c','user.name=Controlled manual','-c','user.email=manual@example.invalid',...args], { cwd: f.objectRoot, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
    git('init','--quiet','--initial-branch=main');
    git('remote','add','origin','https://github.com/acme/widgets.git');
    git('commit','--quiet','--allow-empty','-m','controlled manual base');
    process.chdir(f.objectRoot);
    const receipt = resolveManualOwnerReceiptPath('acme/widgets', f.objectRoot);
    const registry = resolveHostAdmissionPath();
    const authority = () => {
      const values: Record<string,string> = Object.create(null) as Record<string,string>;
      const walk = (file: string) => {
        if (!existsSync(file)) { values[file] = 'absent'; return; }
        if (lstatSync(file).isDirectory()) { values[file] = 'directory'; for (const name of readdirSync(file).sort()) walk(path.join(file,name)); }
        else values[file] = createHash('sha256').update(readFileSync(file)).digest('hex');
      };
      for (const name of ['runs','mission-admission','dispatch']) walk(path.join(f.accountRoot,name));
      return JSON.stringify(values);
    };
    return { ...f, invoke, receipt, registry, authority, calls: () => calls };
  } catch (error) { f.cleanup(); throw error; }
}

