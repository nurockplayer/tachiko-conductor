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
import { commandFixture, directExecutionFixture, commandAuthorityFixture, manualAuthorityFixture } from './production-entry-fixture.js';

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
  it('requires current compatible installation for canonical command authority and preserves safe emergency HOLD', async t => {
    for (const cut of ['checkout', 'missing-record', 'corrupt-record', 'artifact', 'cached-artifact'] as const) await t.test(cut, async () => {
      const f = await commandAuthorityFixture(cut === 'checkout' ? 'command-authority' : undefined);
      const originalWrite = fs.writeFileSync, originalSpawn = childProcess.spawn;
      const log = console.log; console.log = () => {};
      let wakeWrites = 0, childStarts = 0;
      const wake = dispatchWakePath();
      fs.writeFileSync = ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
        if (String(file) === wake) wakeWrites += 1;
        return Reflect.apply(originalWrite, fs, [file, ...args]);
      }) as typeof fs.writeFileSync;
      childProcess.spawn = ((...args: Parameters<typeof originalSpawn>) => { childStarts += 1; return originalSpawn(...args); }) as typeof originalSpawn;
      syncBuiltinESMExports();
      try {
        // Positive first: installation compatibility alone permits release,
        // including valid DISABLED/missing and invalid-initiation descriptors.
        for (const descriptor of (cut === 'checkout' ? ['enabled', 'disabled', 'missing', 'malformed'] as const : ['enabled'] as const)) {
          if (descriptor === 'enabled') f.enable();
          else if (descriptor === 'disabled') f.enable(false);
          else if (descriptor === 'missing') unlinkSync(f.hostPath);
          else writeFileSync(f.hostPath, '{malformed');
          assert.equal(f.resolve().installation, 'accepted');
          assert.equal(await f.invoke(['dispatch', 'maintenance', 'hold']), 0);
          const beforeWake = wakeWrites;
          assert.equal(await f.invoke(['dispatch', 'maintenance', 'release']), 0);
          assert.equal(readOperationalRuntimeProjection(path.join(f.accountRoot, 'runs'))!.maintenanceHold.active, false);
          assert.equal(wakeWrites, beforeWake + 1, 'accepted release wakes exactly once');
          const token = readFileSync(wake, 'utf8');
          assert.equal(await f.invoke(['dispatch', 'maintenance', 'release']), 0);
          assert.equal(wakeWrites, beforeWake + 1);
          assert.equal(readFileSync(wake, 'utf8') === token, true, 'idempotent release retains the wake token');
        }
        const beforeExplicitWake = wakeWrites;
        assert.equal(await f.invoke(['dispatch', 'wake']), 0);
        assert.equal(wakeWrites, beforeExplicitWake + 1);
        f.enable();
        assert.equal(await f.invoke(['dispatch', 'maintenance', 'hold']), 0);
        const captured = f.resolve();
        const cli = await import(new URL('./cli.js', f.entryUrl).href) as typeof import('../src/cli.js');
        if (cut === 'checkout') process.argv[1] = path.join(f.objectRoot, 'dist/production-entry.js');
        else if (cut === 'missing-record') unlinkSync(f.recordPath);
        else if (cut === 'corrupt-record') writeFileSync(f.recordPath, '{corrupt');
        else writeFileSync(path.join(f.record.codex.runtimeDirectory, 'runtime.cjs'), '// changed accepted program\n');
        const before = f.durable(), calls = f.calls(), wakes = wakeWrites, children = childStarts;
        const rejected = (argv: string[]) => cut === 'cached-artifact' ? cli.main(argv, { production: captured }) : f.invoke(argv);
        // Each refusal state independently exercises actual release/wake.
        // One captured-artifact case also represents every distinct mutation family;
        // source classification covers sibling parse forms without a cross-product.
        const commands = [
          ['dispatch', 'maintenance', 'release'], ['dispatch', 'wake'],
          ...(cut === 'cached-artifact' ? [
            ['dispatch', 'manual', 'register'], ['run', 'transition', f.run.id, 'fail'],
            ['run', 'admission', 'recover', f.run.id, '--generation', '1', '--stopped'],
            ['run', 'projections', 'rebuild'], ['wait', 'observe', f.run.id],
            ['dispatch', 'once'], ['browser', 'start', 'authority-proof'],
          ] : []),
        ];
        for (const argv of commands) {
          await assert.rejects(rejected(argv), /Installation unavailable|Accepted artifact\/program filesystem identity changed/i);
          assert.equal(f.durable() === before, true, 'refused ' + argv.slice(0, 3).join('/') + ' preserves every canonical authority byte');
        }
        assert.equal(f.calls(), calls); assert.equal(wakeWrites, wakes); assert.equal(childStarts, children);
        assert.equal(readOperationalRuntimeProjection(path.join(f.accountRoot, 'runs'))!.maintenanceHold.active, true);
        const projection = operationalRuntimeProjectionPath(path.join(f.accountRoot, 'runs'));
        const beforeEmergency = f.durable([projection]);
        // This one narrowly safe unavailable-entry mutation adds only HOLD.
        assert.equal(await f.invoke(['dispatch', 'maintenance', 'hold']), 0);
        assert.equal(f.durable([projection]) === beforeEmergency, true, 'emergency HOLD cannot rewrite other authority');
        assert.equal(readOperationalRuntimeProjection(path.join(f.accountRoot, 'runs'))!.maintenanceHold.active, true);
        assert.equal(wakeWrites, wakes); assert.equal(f.calls(), calls); assert.equal(childStarts, children);
        const diagnosticBytes = f.durable();
        for (const argv of [['--help'], ['run', 'show', f.run.id], ['run', 'inspect', f.run.id], ['run', 'list'], ['dispatch', 'admission', 'status']]) assert.equal(await f.invoke(argv), 0);
        assert.equal(f.durable() === diagnosticBytes, true, 'safe unavailable-entry diagnostics do not write canonical authority');
        process.stderr.write('STAGE10_COMMAND_AUTHORITY ' + JSON.stringify({ cut, refusedActions: commands.length, authorityPreserved: true, held: true, wakeWritesAfterRefusal: wakeWrites - wakes, providerCallsAfterRefusal: f.calls() - calls, childStartsAfterRefusal: childStarts - children }) + '\n');
      } finally {
        fs.writeFileSync = originalWrite; childProcess.spawn = originalSpawn; syncBuiltinESMExports(); console.log = log; f.cleanup();
      }
    });
  });

  it('rechecks compatible installation after a contested registry lock before manual receipts or authority publish', async () => {
    const f = await manualAuthorityFixture('manual-registry');
    const wait = Atomics.wait;
    let held: ReturnType<typeof acquireDispatchInvocationLock> | undefined;
    let waited = false;
    try {
      assert.equal(await f.invoke(['dispatch','manual','register']), 0);
      const active = JSON.parse(readFileSync(f.receipt,'utf8')) as { generation: number; status: string };
      assert.equal(active.status, 'active');
      assert.equal(await f.invoke(['dispatch','manual','park','--stopped']), 0);
      const parked = JSON.parse(readFileSync(f.receipt,'utf8')) as { generation: number; status: string };
      assert.equal(parked.status, 'parked');
      assert.equal(await f.invoke(['dispatch','manual','retire','--stopped','--expected-generation',String(parked.generation)]), 0);
      const before = f.authority(), calls = f.calls();
      held = acquireDispatchInvocationLock({ lockPath: f.registry + '.lock' });
      Atomics.wait = ((...args: Parameters<typeof wait>) => {
        if (!waited) {
          waited = true;
          assert.equal(existsSync(f.registry + '.lock'), true);
          writeFileSync(path.join(f.record.codex.runtimeDirectory,'runtime.cjs'),'// revoked during actual contested registry wait\n');
          held!.release();
          return 'ok';
        }
        return wait(...args);
      }) as typeof wait;
      await assert.rejects(f.invoke(['dispatch','manual','register']), /Accepted artifact\/program filesystem identity changed/);
      assert.equal(waited, true, 'the real registry transaction reaches its lock wait before revocation');
      assert.equal(existsSync(f.registry + '.lock'), false, 'the refusing transaction releases only its acquired lock');
      assert.equal(f.authority() === before, true, 'no receipt, generation, registry, projection or wake publishes');
      assert.equal(f.calls(), calls);
      process.stderr.write('STAGE10_LATE_COMMAND_AUTHORITY ' + JSON.stringify({ cut: 'registry-acquired-lock', waited, authorityPreserved: true, providerCalls: f.calls()-calls, lockReleased: true }) + '\n');
    } finally { Atomics.wait = wait; held?.release(); f.cleanup(); }
  });

  it('rechecks compatible installation after manual recovery input before its authenticated receipt write', async () => {
    const f = await manualAuthorityFixture('manual-recovery');
    const originalRead = fs.readFileSync;
    let input: string | undefined;
    let revoke = false, supplied = 0;
    fs.readFileSync = ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (file === 0) {
        supplied += 1;
        assert.ok(input !== undefined, 'only the valid privately captured recovery receipt is supplied');
        if (revoke) writeFileSync(path.join(f.record.codex.runtimeDirectory,'runtime.cjs'),'// revoked while manual recovery awaits stdin\n');
        return input;
      }
      return Reflect.apply(originalRead, fs, [file,...args]);
    }) as typeof fs.readFileSync;
    syncBuiltinESMExports();
    try {
      assert.equal(await f.invoke(['dispatch','manual','register']), 0);
      input = readFileSync(f.receipt,'utf8');
      f.enable(false);
      unlinkSync(f.receipt);
      assert.equal(await f.invoke(['dispatch','manual','recover','--receipt-stdin']), 0, 'compatible DISABLED installation recovers the exact valid active receipt');
      assert.equal(readFileSync(f.receipt,'utf8') === input, true);
      assert.equal(supplied, 1);
      unlinkSync(f.receipt);
      const before = f.authority(), calls = f.calls();
      revoke = true;
      await assert.rejects(f.invoke(['dispatch','manual','recover','--receipt-stdin']), /Accepted artifact\/program filesystem identity changed/);
      assert.equal(supplied, 2, 'revocation occurs inside the real blocking-input boundary');
      assert.equal(existsSync(f.receipt), false, 'the recovered receipt is not published after authority revocation');
      assert.equal(f.authority() === before, true, 'registry, Run, projection, receipt and wake bytes are retained');
      assert.equal(f.calls(), calls);
      process.stderr.write('STAGE10_LATE_COMMAND_AUTHORITY ' + JSON.stringify({ cut: 'manual-input', validBaseline: true, suppliedInputs: supplied, authorityPreserved: true, providerCalls: f.calls()-calls, receiptAbsent: true }) + '\n');
    } finally { fs.readFileSync = originalRead; syncBuiltinESMExports(); f.cleanup(); }
  });

  it('refuses wait ledger and telemetry writes after an awaited observation loses accepted installation', async () => {
    const f = await commandAuthorityFixture();
    const originalRead = fs.readFileSync, log = console.log, originalStackLimit = Error.stackTraceLimit;
    console.log = () => {}; Error.stackTraceLimit = 64;
    let tripped = false;
    const before = f.durable(), calls = f.calls();
    const runPath = path.join(f.accountRoot, 'runs', f.run.id + '.json');
    fs.readFileSync = ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      const value = Reflect.apply(originalRead, fs, [file, ...args]);
      if (!tripped && String(file) === runPath && (new Error().stack ?? '').includes('RunRuntimeObserver.observe')) {
        tripped = true;
        writeFileSync(path.join(f.record.codex.runtimeDirectory, 'runtime.cjs'), '// revoked while real observation awaits\n');
      }
      return value;
    }) as typeof fs.readFileSync;
    syncBuiltinESMExports();
    try {
      await assert.rejects(f.invoke(['wait', 'observe', f.run.id]), /Accepted artifact\/program filesystem identity changed/);
      assert.equal(tripped, true, 'the actual runtime observer reaches its awaited continuation');
      assert.equal(f.durable() === before, true, 'lost compatibility preserves ledger, Run, receipt, registry, projection and wake bytes');
      assert.equal(f.calls(), calls);
      process.stderr.write('STAGE10_COMMAND_AUTHORITY ' + JSON.stringify({ cut: 'wait-post-await', tripped, authorityPreserved: true, providerCallsAfterRefusal: f.calls() - calls }) + '\n');
    } finally { fs.readFileSync = originalRead; syncBuiltinESMExports(); Error.stackTraceLimit = originalStackLimit; console.log = log; f.cleanup(); }
  });

  it('uses the actual accepted entry for model-free held once/serve and local diagnostics',async()=>{
    const f=await installedFixture(true, false, {}, { profileLabel: 'held-control' });const log=console.log;const output:string[]=[];console.log=(v?:unknown)=>output.push(String(v));try{let calls=0;const runner:ProcessRunner={async run(){calls++;throw new Error('Held entry must not spawn a process');}};process.env.TACHIKO_DATA_DIR='/candidate/empty';assert.equal(await f.invoke(['dispatch','maintenance','hold'],{runner}),0);writeFileSync(f.hostPath,'{malformed');writeFileSync(f.dispatchPath,'{malformed');assert.equal(await f.invoke(['dispatch','once'],{runner}),0);assert.equal(await f.invoke(['dispatch','serve','--max-cycles','1','--idle-poll-ms','1'],{runner}),0);assert.equal(calls,0);assert.equal(await f.invoke(['production','preflight'],{runner}),78);assert.ok(output.some(v=>v.includes('maintenance_hold')));assert.equal(readOperationalRuntimeProjection(path.join(f.accountRoot,'runs'))!.maintenanceHold.active,true);assert.equal(process.env.TACHIKO_DATA_DIR,undefined);}finally{console.log=log;f.cleanup();}
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
        for(const refusal of ['initial-invalid','captured-drift','dispatch-missing','dispatch-malformed','dispatch-schema'] as const){
          f.enable(mode==='once');writeFileSync(f.dispatchPath,JSON.stringify(f.dispatch));let captured=false;
          if(refusal==='initial-invalid')writeFileSync(f.hostPath,'{malformed');
          else if(refusal==='dispatch-missing')unlinkSync(f.dispatchPath);
          else if(refusal==='dispatch-malformed')writeFileSync(f.dispatchPath,'{malformed');
          else if(refusal==='dispatch-schema')writeFileSync(f.dispatchPath,JSON.stringify({...f.dispatch,queueCommentId:0}));
          else{
            fs.readFileSync=((file:fs.PathOrFileDescriptor,...args:unknown[])=>{
              const value=Reflect.apply(originalRead,fs,[file,...args]);
              if(String(file)===f.dispatchPath&&!captured){captured=true;const descriptor=JSON.parse(originalRead(f.hostPath,'utf8'));descriptor.revision='changed-after-capture';writeFileSync(f.hostPath,JSON.stringify(descriptor));}
              return value;
            }) as typeof fs.readFileSync;syncBuiltinESMExports();
          }
          const before=authority(),projectionBefore=originalRead(projection,'utf8'),publicationCount=publications.length;
          try{await assert.rejects(f.invoke(command,{runner}),refusal==='captured-drift'?/descriptor changed/:refusal.startsWith('dispatch-')?/TACHIKO_DISPATCH_CONFIG/:/descriptor|host/i);}
          finally{fs.readFileSync=originalRead;syncBuiltinESMExports();}
          assert.equal(captured,refusal==='captured-drift');
          assert.equal(publications.length,publicationCount,'Refusal cannot advertise a new running scanner');
          assert.equal(originalRead(projection,'utf8')===projectionBefore,true,'Typed projection including HOLD remains unchanged');
          assert.equal(authority()===before,true,'Run, owner, generation and canonical authority bytes remain unchanged');
          assert.equal(apiCalls,positiveCalls);assert.equal(queueReads,positiveQueueReads);
          if(refusal.startsWith('dispatch-'))process.stderr.write('STAGE10_DISPATCH_PREREQUISITES '+JSON.stringify({mode,cut:refusal,authorityPreserved:true,projectionPreserved:true,queueReadsAfterRefusal:queueReads-positiveQueueReads,apiCallsAfterRefusal:apiCalls-positiveCalls,newRunningPublications:publications.length-publicationCount})+'\n');
        }
      }finally{fs.readFileSync=originalRead;fs.renameSync=originalRename;syncBuiltinESMExports();console.log=log;f.cleanup();}
    });
  });

  it('keeps authenticated original history usable while sealed incomplete routine environments refuse ordinary initiation', async t => {
    const original = leadRepairFixture({ executionRevision: PRODUCTION_POLICY_REVISION, timeoutMs: 900000, localValidationRevision: PRODUCTION_POLICY_REVISION, hostedPolicy: { revision: PRODUCTION_POLICY_REVISION, policy: { mode: 'not_required' } }, liveSnapshot: canonicalProducerSnapshot });
    try {
      await original.poll();
      if (original.run().state === 'WAITING_DEPENDENCY') { original.tick(); await original.poll(); }
      const history = original.run();
      assert.equal(history.state, 'MERGE_READY');
      assert.ok(history.nativeReview!.requests.some(request => request.completionProof !== undefined));
      assert.ok(history.nativeLead!.requests.some(request => request.completionProof !== undefined));
      const complete = await installedFixture(true);
      try {
        for (const enabled of [true,false]) {
          complete.enable(enabled);
          const s = complete.resolve();
          assert.equal(s.installation,'accepted',s.reason);assert.equal(s.initiationPolicy.available,true,s.initiationPolicy.reason);
          s.assertInitiation();s.assertRunInitiation(history);
          assert.equal(s.reviewer.available,false);assert.equal(s.lead.available,false);
          assert.equal(s.nativeMergeHost !== undefined,enabled);
        }
      } finally { complete.cleanup(); }
      for (const field of ['TACHIKO_LUNA_CODEX_HOME','TACHIKO_PNPM_DEPENDENCY_ARTIFACT','TACHIKO_PLAYWRIGHT_BROWSERS_PATH'] as const) {
        for (const form of ['missing','blank','relative'] as const) await t.test(field + '/' + form, async () => {
          const patch: Record<string,string> = {};
          if (form !== 'missing') patch[field] = form === 'blank' ? ' \t ' : 'relative-controlled-path';
          const f = await installedFixture(true,false,patch,{ omitEnvironment: form === 'missing' ? [field] : [] });
          const log = console.log;console.log = () => {};
          let calls = 0, reviewChecks = 0, leadChecks = 0;
          const runner: ProcessRunner = { async run() { calls += 1;throw new Error('Incomplete initiation cannot call any API, worker or provider.'); } };
          try {
            const { JsonFileOracleReceiptStore: InstalledReceipts } = await import(new URL('./oracle/receipt-store.js',f.entryUrl).href) as typeof import('../src/oracle/receipt-store.js');
            const { JsonFileStore: InstalledStore } = await import(new URL('./store/json-file-store.js',f.entryUrl).href) as typeof import('../src/store/json-file-store.js');
            // Preserve the original producer's namespace and authenticators;
            // no evidence, Run execution, receipt or history is rewritten.
            const receipts = new InstalledReceipts(path.join(original.root,'oracle'));
            const historical: NativeCompletionHosts = {
              review: { receipts, authenticate(evidence) { reviewChecks += 1;return original.reviewer.authenticate(evidence); } },
              lead: { receipts, authenticate(evidence) { leadChecks += 1;return original.lead.authenticate(evidence); } },
            };
            const s = f.resolve(runner,historical);
            assert.equal(s.installation,'accepted',s.reason);s.assertInstallation();s.assertRecoveryScope('acme','widgets');
            assert.equal(s.initiationPolicy.available,false);assert.match(s.initiationPolicy.reason,new RegExp(field));
            assert.throws(s.assertInitiation,new RegExp(field));assert.equal(s.nativeMergeHost,undefined);
            const sealed = JSON.parse(readFileSync(f.recordPath,'utf8')) as { environment: Record<string,string> };
            assert.equal(Object.hasOwn(sealed.environment,field),form !== 'missing','the incomplete value is sealed before initial acceptance');
            if (form !== 'missing') assert.equal(sealed.environment[field] === patch[field],true);
            const store = new InstalledStore({dir:s.runsDirectory,nativeCompletionHosts:historical});
            store.create(history);
            assert.equal(JSON.stringify(store.read(history.id)) === JSON.stringify(history),true);
            reviewChecks = 0;leadChecks = 0;
            const files = [path.join(s.runsDirectory,history.id+'.json'),path.join(f.accountRoot,'mission-admission/registry.json'),resolveRunOwnerReceiptPath('acme/widgets',history.id),operationalRuntimeProjectionPath(s.runsDirectory),dispatchWakePath()];
            const authority = () => JSON.stringify(files.map(file => [file,existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : 'absent']));
            const before = authority();
            assert.equal(await f.invoke(['run','show',history.id],{runner,historicalCompletionHosts:historical}),0);
            assert.ok(reviewChecks > 0,'actual installed history read invokes the original review authenticator');
            assert.ok(leadChecks > 0,'actual installed history read invokes the original lead authenticator');
            const authenticatedReview = reviewChecks, authenticatedLead = leadChecks;
            for (const command of [['dispatch','once'],['dispatch','serve','--max-cycles','1','--idle-poll-ms','1']]) {
              await assert.rejects(f.invoke(command,{runner,historicalCompletionHosts:historical}),new RegExp(field));
              assert.equal(authority() === before,true,'incomplete initiation cannot publish scanning, rewrite history or alter ownership/HOLD');
            }
            assert.equal(calls,0);
            process.stderr.write('STAGE10_ROUTINE_ENVIRONMENT '+JSON.stringify({field,form,installationAccepted:true,initiationAvailable:false,originalReviewChecks:authenticatedReview,originalLeadChecks:authenticatedLead,authorityPreserved:true,externalCalls:calls})+'\n');
          } finally { console.log = log;f.cleanup(); }
        });
      }
    } finally { original.cleanup(); }
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

});
