import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chmodSync, cpSync, linkSync, mkdirSync, lstatSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { resolveProductionHost } from '../src/production-host.js';
import Module, { syncBuiltinESMExports } from 'node:module';
import { PRODUCTION_EXECUTION_PROFILE_CONFIG, PRODUCTION_LOCAL_VALIDATION_CONFIG } from '../src/production-policy.js';
import { distributionManifestDigest, workerCommandPath, workerPnpmAlias } from '../src/production-host.js';
import { manifest, installedFixture } from './production-host-fixture.js';
import { buildWorkflowDeps } from '../src/cli.js';
import { NodeProcessRunner } from '../src/github/transport.js';

describe('accepted-release fixed host resolver', () => {
  it('refuses forged production factory context before reading stores or creating adapters',()=>{
    assert.throws(()=>Reflect.apply(buildWorkflowDeps,undefined,[null,undefined,{},undefined,undefined,undefined,undefined,{repositoryRoot:'/candidate/objects',gitRunner:{run(){throw new Error('must not run');}}}]),/Unvalidated production host snapshot/);
  });
  it('constructs the exact frozen merge policy and accepted object root, with typed unavailable Oracle/Sol', async()=>{
    const f=await installedFixture();try {const s=f.resolve();assert.equal(s.installation,'accepted',s.reason);assert.deepEqual(s.nativeMergeHost!.policy,f.policy);assert.equal(s.repositoryRoot,f.objectRoot);assert.equal(Object.isFrozen(s),true);assert.equal(Object.isFrozen(s.nativeMergeHost!.policy),true);assert.equal(s.reviewer.available,false);assert.equal(s.lead.available,false);assert.equal(s.historicalVerification.review.available,false);assert.equal(s.historicalVerification.lead.available,false);assert.equal(Object.keys(s.nativeMergeHost!).sort().join(','),'candidate,policy');}finally{f.cleanup();}
  });
  it('accepts supported simulated Node patch and minor versions while retaining exact executable identity',async()=>{
    const f=await installedFixture();const descriptor=Object.getOwnPropertyDescriptor(process,'version')!;
    try{assert.equal(f.resolve().installation,'accepted');for(const version of ['v24.21.0','v24.21.1','v24.22.0','v24.99.7']){Object.defineProperty(process,'version',{...descriptor,value:version});const accepted=f.resolve();assert.equal(accepted.installation,'accepted',accepted.reason);accepted.assertInstallation();}for(const version of ['v25.0.0','v24.20.9','v23.99.0','malformed','v24.21.0-preview']){Object.defineProperty(process,'version',{...descriptor,value:version});assert.match(f.resolve().reason,/runtime\/loader/);}Object.defineProperty(process,'version',descriptor);const selected=process.execPath;process.execPath=path.join(f.home,'other-node');assert.match(f.resolve().reason,/runtime\/loader/);process.execPath=selected;
    }finally{Object.defineProperty(process,'version',descriptor);f.cleanup();}
  });
  it('refuses noncanonical or unsafe accepted actor identities before exposing merge authority',async()=>{
    const baseline=await installedFixture();try{const accepted=baseline.resolve();assert.equal(accepted.installation,'accepted');assert.ok(accepted.nativeMergeHost);assert.equal(accepted.actorBinding.expectedActorId,'123');}finally{baseline.cleanup();}
    for(const githubActorId of ['', 'abc','0','-1','01','1.0','1e3','9007199254740992','NaN','Infinity','1 ','+1']){const f=await installedFixture(false,false,{}, {githubActorId,expectedRejection:/canonical positive safe integer/});try{const refused=f.resolve();assert.equal(refused.installation,'unavailable');assert.equal(refused.nativeMergeHost,undefined);assert.equal(refused.actorBinding.configured,false);}finally{f.cleanup();}}
    for(const githubActorId of ['1','9007199254740991']){const f=await installedFixture(false,false,{}, {githubActorId});try{assert.ok(f.resolve().nativeMergeHost);}finally{f.cleanup();}}
  });
  it('keeps installation observation separate from missing, malformed, disabled or replaced current opt-in', async()=>{
    const f=await installedFixture();try {for(const raw of [undefined,'{broken',JSON.stringify({schemaVersion:1,revision:'h2',releaseId:'foreign',manifestDigest:f.record.manifestDigest,enabled:false})]){if(raw===undefined)unlinkSync(f.hostPath);else writeFileSync(f.hostPath,raw);const s=f.resolve();assert.equal(s.installation,'accepted',s.reason);assert.equal(s.nativeMergeHost,undefined);s.assertRecoveryScope('acme','widgets');assert.throws(()=>s.assertRecoveryScope('foreign','repo'),/scope/);}f.enable(false);assert.equal(f.resolve().nativeMergeHost,undefined);}finally{f.cleanup();}
  });
  it('cannot hot-enable and permanently latches descriptor drift even after restoration',async()=>{
    const f=await installedFixture();try{f.enable(false);const disabled=f.resolve();f.enable();assert.equal(disabled.nativeMergeHost,undefined);assert.throws(disabled.assertInitiation,/changed/);assert.throws(disabled.assertInitiation,/latched/);const active=f.resolve();const before=readFileSync(f.hostPath);writeFileSync(f.hostPath,'{}');assert.throws(active.assertInitiation,/changed/);writeFileSync(f.hostPath,before);assert.throws(active.assertInitiation,/latched/);active.assertInstallation();}finally{f.cleanup();}
  });
  it('rejects candidate-local copies, forged HOME/data roots and source-entry self authorization',async()=>{
    const f=await installedFixture();try{process.env.HOME='/candidate/home';process.env.TACHIKO_DATA_DIR='/candidate/runs';process.env.TACHIKO_NATIVE_HOST='true';process.chdir(f.objectRoot);const s=f.resolve();assert.equal(s.installation,'accepted',s.reason);assert.equal(s.runsDirectory,path.join(f.accountRoot,'runs'));assert.equal(s.repositoryRoot,f.objectRoot);const launched=process.argv;process.argv=[process.execPath,path.join(f.objectRoot,'candidate.js')];assert.equal(f.resolve().installation,'unavailable');process.argv=launched;const alias=path.join(f.home,'current-entry.js');symlinkSync(new URL(f.entryUrl),alias);process.argv=[process.execPath,alias];assert.equal(f.resolve().installation,'unavailable');process.argv=launched;assert.equal(resolveProductionHost(f.entryUrl).installation,'unavailable','unaccepted source module cannot copy installation authority');}finally{f.cleanup();}
  });
  it('rejects unknown schema, executable fields, relative/traversal paths, incompatible state and release ID reuse',async()=>{
    const f=await installedFixture();try{const original=JSON.stringify(f.record);for(const patch of [{schemaVersion:2},{module:'file:///candidate/provider.js'},{command:'merge'},{releaseId:'../accepted-fixture'},{stateCompatibility:'other-state'},{repository:{...f.record.repository,objectRoot:'relative'}},{repository:{...f.record.repository,objectRoot:path.join(f.release,'dist')}}]){writeFileSync(f.recordPath,JSON.stringify({...f.record,...patch}));const refused=f.resolve();assert.equal(refused.installation,'unavailable',JSON.stringify(patch));assert.match(refused.reason,/shape|identity|canonical|overlaps/);}writeFileSync(f.recordPath,original);writeFileSync(path.join(f.release,'dist/production-entry.js'),'// changed same release id');assert.equal(f.resolve().installation,'unavailable');}finally{f.cleanup();}
  });
  it('rejects runtime/preload, program identity, changed artifacts/dependencies, symlinks and writable ancestry',async()=>{
    const f=await installedFixture();try{const file=path.join(f.release,'node_modules/closed-dependency/package.json');const original=readFileSync(file);writeFileSync(path.join(f.release,'__proto__'),'executable extra bytes');assert.match(f.resolve().reason,/distribution\/dependency identity changed/);unlinkSync(path.join(f.release,'__proto__'));writeFileSync(file,'{"changed":true}');assert.match(f.resolve().reason,/distribution\/dependency identity changed/);writeFileSync(file,original);process.env.NODE_OPTIONS='--import /candidate/preload.js';assert.match(f.resolve().reason,/runtime\/loader/);delete process.env.NODE_OPTIONS;const args=process.execArgv;process.execArgv=['--inspect'];assert.match(f.resolve().reason,/runtime\/loader/);process.execArgv=args;chmodSync(f.release,0o777);assert.match(f.resolve().reason,/permissions/);chmodSync(f.release,0o755);renameSync(file,`${file}.saved`);symlinkSync(`${file}.saved`,file);assert.match(f.resolve().reason,/symlink/);unlinkSync(file);renameSync(`${file}.saved`,file);const record={...f.record,git:{...f.record.git,sha256:'0'.repeat(64)}};writeFileSync(f.recordPath,JSON.stringify(record));assert.match(f.resolve().reason,/program bytes changed/);}finally{f.cleanup();}
  });
  it('removes capability after in-place same-size writes, inode replacement, mode/type changes or added distribution files',async()=>{
    const f=await installedFixture();try{const file=path.join(f.release,'node_modules/closed-dependency/package.json');for(const cut of ['same-size','replace','mode','type','extra'] as const){const active=f.resolve();assert.equal(active.installation,'accepted',active.reason);const original=readFileSync(file);if(cut==='same-size')writeFileSync(file,'[]');if(cut==='replace'){renameSync(file,`${file}.old`);writeFileSync(file,original);}if(cut==='mode')chmodSync(file,0o666);if(cut==='type'){renameSync(file,`${file}.old`);symlinkSync(`${file}.old`,file);}if(cut==='extra')writeFileSync(path.join(f.release,'__proto__'),'extra executable bytes');assert.throws(active.assertInstallation,/changed|permissions|symbolic|type/);assert.throws(active.assertInitiation);assert.throws(active.assertInitiation,/latched/);if(cut==='same-size')writeFileSync(file,original);if(cut==='replace'||cut==='type'){unlinkSync(file);renameSync(`${file}.old`,file);}if(cut==='mode')chmodSync(file,0o644);if(cut==='extra')unlinkSync(path.join(f.release,'__proto__'));}}finally{f.cleanup();}
  });
  it('rejects hardlink aliases of accepted code and acceptance records into candidate mutation paths',async()=>{
    const f=await installedFixture();try{for(const source of [path.join(f.release,'dist/cli.js'),f.recordPath]){const active=f.resolve();assert.equal(active.installation,'accepted',active.reason);const alias=path.join(f.home,'candidate-write-alias');linkSync(source,alias);assert.equal(f.resolve().installation,'unavailable');assert.throws(active.assertInstallation,/hardlink/);assert.throws(active.assertInitiation,/hardlink/);unlinkSync(alias);assert.throws(active.assertInitiation,/latched/);}}finally{f.cleanup();}
  });
  it('rejects same-release-ID artifact/context rewrites even when both protected records are rewritten',async()=>{
    const f=await installedFixture();try{writeFileSync(path.join(f.release,'dist/extra-extensionless'),'changed execution bytes');const files=manifest(f.release);const changed={...f.record,manifest:files,manifestDigest:distributionManifestDigest(files)};writeFileSync(f.recordPath,JSON.stringify(changed));writeFileSync(f.hostPath,JSON.stringify({schemaVersion:1,revision:'h2',enabled:true,releaseId:changed.releaseId,manifestDigest:changed.manifestDigest,merge:changed.mergePolicy}));assert.match(f.resolve().reason,/Release ID/);unlinkSync(path.join(f.release,'dist/extra-extensionless'));writeFileSync(f.recordPath,JSON.stringify({...f.record,github:{...f.record.github,actorId:'999'}}));assert.match(f.resolve().reason,/Release ID/);}finally{f.cleanup();}
  });
  it('rejects missing runtime packages supplied by ancestor or CommonJS global fallback',async()=>{
    const f=await installedFixture();const globals=(Module as unknown as {globalPaths:string[]}).globalPaths;try{const ancestorModules=path.join(f.accountRoot,'node_modules');const sdk=path.join(f.release,'node_modules/@modelcontextprotocol/sdk');mkdirSync(path.join(ancestorModules,'@modelcontextprotocol'),{recursive:true});renameSync(sdk,path.join(ancestorModules,'@modelcontextprotocol/sdk'));assert.match(f.resolve().reason,/ancestor dependency fallback/);renameSync(path.join(ancestorModules,'@modelcontextprotocol/sdk'),sdk);rmSync(ancestorModules,{recursive:true});const external=path.join(f.home,'external-global-modules');mkdirSync(external);globals.push(external);assert.match(f.resolve().reason,/global dependency fallback/);globals.pop();}finally{f.cleanup();}
  });
  it('keeps a compatible installation observable while contradictory v7 executor/model/revisions remove normal initiation',async()=>{
    const wrongModel=structuredClone(PRODUCTION_EXECUTION_PROFILE_CONFIG) as unknown as {profiles:{routine:{model:string}}};wrongModel.profiles.routine.model='gpt-6';
    const patches: Readonly<Record<string,string>>[]=[{TACHIKO_IMPLEMENTATION_AGENT:'codex-cli'},{TACHIKO_EXECUTION_PROFILE_CONFIG:JSON.stringify(wrongModel)},{TACHIKO_LOCAL_VALIDATION_CONFIG:JSON.stringify({...PRODUCTION_LOCAL_VALIDATION_CONFIG,revision:'foreign'})}];
    for(const patch of patches){const f=await installedFixture(false,false,patch);try{const s=f.resolve();assert.equal(s.installation,'accepted',s.reason);assert.equal(s.initiationPolicy.available,false);assert.equal(s.nativeMergeHost,undefined);s.assertInstallation();s.assertRecoveryScope('acme','widgets');assert.throws(s.assertInitiation,/policy unavailable/);}finally{f.cleanup();}}
    const f=await installedFixture();try{const s=f.resolve();assert.throws(()=>s.assertRunInitiation({execution:{profile:'complex',revision:'legacy',executor:'codex-cli',timeoutMs:60000}}),/exact routine-only v7/);}finally{f.cleanup();}
  });
  it('rejects missing and contradictory host qualification/namespace evidence without accepting a label as runtime proof',async()=>{
    const f=await installedFixture();try{for(const github of [{...f.record.github,actorId:''},{...f.record.github,qualification:''},{...f.record.github,configDirectory:'/candidate/gh'},{...f.record.github,qualified:true}]){writeFileSync(f.recordPath,JSON.stringify({...f.record,github}));assert.equal(f.resolve().installation,'unavailable');}}finally{f.cleanup();}
  });
});

describe('accepted production tool closure and placement',()=>{
  it('requires current initiation and the last typed HOLD for a policy-positive disabled-merge preflight',async(t)=>{
    const cuts=['positive','unavailable-initiation','descriptor-probe','artifact-probe','release-probe','missing-probe','malformed-probe','release-fence','missing-fence','malformed-fence'] as const;
    for(const cut of cuts) await t.test(cut,async()=>{
      const f=await installedFixture(true,false,{}, {lunaHome:true,...(cut==='unavailable-initiation'?{workerAlias:'missing' as const}:{})});
      const originalRead=fs.readFileSync;let requests=0;
      try{
        f.enable(false);
        const dependencies=f.record.environment.TACHIKO_PNPM_DEPENDENCY_ARTIFACT!;
        mkdirSync(path.join(dependencies,'store'),{recursive:true,mode:0o700});writeFileSync(path.join(dependencies,'pnpm-lock.yaml.sha256'),'0'.repeat(64),{mode:0o600});
        mkdirSync(f.record.environment.TACHIKO_PLAYWRIGHT_BROWSERS_PATH!,{recursive:true,mode:0o700});
        const runtime=await import(new URL('./operational/runtime-projection.js',f.entryUrl).href) as typeof import('../src/operational/runtime-projection.js');
        const policy=await import(new URL('./production-policy.js',f.entryUrl).href) as typeof import('../src/production-policy.js');
        const cli=await import(new URL('./cli.js',f.entryUrl).href) as typeof import('../src/cli.js');
        const s=f.resolve({async run(){requests++;throw new Error('Preflight must not invoke auth, provider, model or GitHub transport');}});
        assert.equal(s.installation,'accepted',s.reason);
        runtime.setMaintenanceHold(s.runsDirectory,true,'2026-10-18T00:00:00.000Z');
        let nodeProbes=0,gitProbes=0;
        const probe=(afterGit?:()=>void)=>(env:NodeJS.ProcessEnv=s.environment)=>policy.preflightProductionPolicy(env,(program)=>{
          gitProbes++;assert.equal(program,f.record.git.path);afterGit?.();return true;
        },(program)=>{nodeProbes++;assert.equal(program,f.record.node.path);return true;});
        const baseline=cli.productionPreflightReport(s.environment,s,probe());
        assert.deepEqual(baseline.report.preflight,{revision:'issue-104-production-v7',lunaCodexHome:s.environment.TACHIKO_LUNA_CODEX_HOME,checks:['execution-profile','luna-home','playwright-browsers','dependency-artifact','local-validation','hosted-check-policy']});assert.equal(nodeProbes,1);assert.equal(gitProbes,1);
        assert.ok('mergeAvailable' in baseline.report.host);assert.equal(baseline.report.host.mergeAvailable,false,'A valid DISABLED descriptor is supported');
        assert.ok('actorBinding' in baseline.report.host);assert.ok(baseline.report.host.actorBinding);assert.ok(baseline.report.host.reviewer);assert.ok(baseline.report.host.lead);assert.equal(baseline.report.host.actorBinding.state,'not_probed');assert.equal(baseline.report.host.reviewer.available,false);assert.equal(baseline.report.host.lead.available,false);
        if(cut==='unavailable-initiation'){
          assert.equal(baseline.code,78);assert.equal(baseline.report.initiation.available,false);assert.match(baseline.report.initiation.reason,/policy unavailable/);s.assertInstallation();s.assertRecoveryScope('acme','widgets');
        }else{
          assert.equal(baseline.code,0,JSON.stringify(baseline.report));assert.equal(baseline.report.holdStatus,'active');assert.equal(baseline.report.initiation.available,true);
        }
        const holdFile=runtime.operationalRuntimeProjectionPath(s.runsDirectory);
        const change=()=>{
          if(cut==='descriptor-probe')f.enable();
          if(cut==='artifact-probe')writeFileSync(path.join(f.release,'node_modules/closed-dependency/package.json'),'[]');
          if(cut.startsWith('release-'))runtime.setMaintenanceHold(s.runsDirectory,false,'2026-10-18T00:00:01.000Z');
          if(cut.startsWith('missing-'))unlinkSync(holdFile);
          if(cut.startsWith('malformed-'))writeFileSync(holdFile,'{malformed');
        };
        let fenceCuts=0;
        if(cut.endsWith('-fence')){
          Object.defineProperty(fs,'readFileSync',{value:(...args:unknown[])=>{
            const value=Reflect.apply(originalRead,fs,args);
            if(args[0]===f.dispatchPath){fenceCuts++;change();}
            return value;
          }});syncBuiltinESMExports();
        }
        const result=cli.productionPreflightReport(s.environment,s,probe(cut.endsWith('-probe')?change:undefined));
        assert.equal(nodeProbes,2);assert.equal(gitProbes,2);assert.equal(requests,0);
        if(cut==='positive')assert.equal(result.code,0);
        else assert.equal(result.code,78,JSON.stringify(result.report));
        if(cut.endsWith('-fence'))assert.equal(fenceCuts,1,'The change occurs at the actual final descriptor read in the host fence');
        if(cut==='descriptor-probe'||cut==='artifact-probe'){
          assert.equal(result.report.initiation.available,false);assert.match(result.report.initiation.reason,/changed/);assert.equal(result.report.holdStatus,'active');
        }else if(cut.startsWith('release-')||cut.startsWith('missing-')||cut.startsWith('malformed-')){
          assert.equal(result.report.initiation.available,true);assert.equal(result.report.hold,false);
          assert.equal(result.report.holdStatus,cut.startsWith('release-')?'inactive':cut.startsWith('missing-')?'missing':'invalid');
        }
        if(cut==='positive'||cut==='unavailable-initiation'){
          assert.equal(result.report.hold,true);assert.equal(result.report.holdStatus,'active');
        }
        assert.equal(result.report.bindingQualification,'external proof required; preflight is not native acceptance');
      }finally{Object.defineProperty(fs,'readFileSync',{value:originalRead});syncBuiltinESMExports();f.cleanup();}
    });
  });


  it('requires initially valid current descriptors before preflight, worker, dispatch and direct-run initiation',async(t)=>{
    for(const cut of ['enabled','disabled','absent','unreadable','malformed','shape','installation','enabled-value','policy'] as const)await t.test(cut,async()=>{
      const f=await installedFixture(true,false,{}, {lunaHome:true});const originalRead=fs.readFileSync;let requests=0;
      try{
        const dependencies=f.record.environment.TACHIKO_PNPM_DEPENDENCY_ARTIFACT!;
        mkdirSync(path.join(dependencies,'store'),{recursive:true,mode:0o700});writeFileSync(path.join(dependencies,'pnpm-lock.yaml.sha256'),'0'.repeat(64),{mode:0o600});
        mkdirSync(f.record.environment.TACHIKO_PLAYWRIGHT_BROWSERS_PATH!,{recursive:true,mode:0o700});
        const runtime=await import(new URL('./operational/runtime-projection.js',f.entryUrl).href) as typeof import('../src/operational/runtime-projection.js');
        const policy=await import(new URL('./production-policy.js',f.entryUrl).href) as typeof import('../src/production-policy.js');
        const cli=await import(new URL('./cli.js',f.entryUrl).href) as typeof import('../src/cli.js');
        const runner={async run(){requests++;throw new Error('Invalid descriptor must stop before any process transport');}};
        const healthy=f.resolve(runner);assert.equal(healthy.initiationPolicy.available,true,healthy.initiationPolicy.reason);
        runtime.setMaintenanceHold(healthy.runsDirectory,true,'2026-10-18T00:00:00.000Z');
        const probe=(env:NodeJS.ProcessEnv=healthy.environment)=>policy.preflightProductionPolicy(env,()=>true,()=>true);
        const baseline=cli.productionPreflightReport(healthy.environment,healthy,probe);assert.equal(baseline.code,0,JSON.stringify(baseline.report));assert.equal(baseline.report.initiation.available,true);
        const descriptor=JSON.parse(readFileSync(f.hostPath,'utf8')) as Record<string,unknown>;
        if(cut==='disabled')f.enable(false);
        if(cut==='absent')unlinkSync(f.hostPath);
        if(cut==='unreadable'){Object.defineProperty(fs,'readFileSync',{value:(...args:unknown[])=>{if(args[0]===f.hostPath)throw new Error('Controlled descriptor read refusal');return Reflect.apply(originalRead,fs,args);}});syncBuiltinESMExports();}
        if(cut==='malformed')writeFileSync(f.hostPath,'{broken');
        if(cut==='shape')writeFileSync(f.hostPath,JSON.stringify({...descriptor,unexpected:true}));
        if(cut==='installation')writeFileSync(f.hostPath,JSON.stringify({...descriptor,manifestDigest:'0'.repeat(64)}));
        if(cut==='enabled-value')writeFileSync(f.hostPath,JSON.stringify({...descriptor,enabled:'true'}));
        if(cut==='policy')writeFileSync(f.hostPath,JSON.stringify({...descriptor,merge:{...f.policy,baseBranch:'foreign'}}));
        const s=f.resolve(runner);assert.equal(s.installation,'accepted',s.reason);s.assertInstallation();s.assertRecoveryScope('acme','widgets');
        const result=cli.productionPreflightReport(s.environment,s,probe);
        assert.deepEqual(result.report.preflight,baseline.report.preflight,'Full policy checks succeed before descriptor qualification');
        if(cut==='enabled'||cut==='disabled'){
          assert.equal(result.code,0,JSON.stringify(result.report));assert.equal(s.initiationPolicy.available,true);s.assertInitiation();
          assert.equal(s.reviewer.available,false);assert.equal(s.lead.available,false);assert.equal(s.nativeMergeHost!==undefined,cut==='enabled');assert.equal(requests,0);return;
        }
        assert.equal(s.initiationPolicy.available,false);assert.match(s.initiationPolicy.reason,/Current production descriptor unavailable/);assert.equal(s.nativeMergeHost,undefined);
        assert.equal(result.code,78);assert.equal(result.report.initiation.available,false);assert.equal(result.report.holdStatus,'active');assert.match(result.report.initiation.reason,/descriptor unavailable/);
        await assert.rejects(()=>s.workerRunner!.run(s.codexExecutable!,[],{cwd:f.objectRoot,timeoutMs:1000}),/descriptor unavailable|latched/);
        runtime.setMaintenanceHold(s.runsDirectory,false,'2026-10-18T00:00:01.000Z');
        await assert.rejects(()=>f.invoke(['dispatch','once'],{runner}),/descriptor unavailable/);
        await assert.rejects(()=>f.invoke(['run','acme/widgets#42','--execution-profile','routine','--repair-task-shape-authority','{"revision":"task-v1","shape":"bounded"}'],{runner}),/descriptor unavailable/);
        assert.equal(requests,0,'No worker, GitHub, queue or model transport after an initially invalid descriptor');
        const registry=JSON.parse(readFileSync(path.join(f.accountRoot,'mission-admission/registry.json'),'utf8')) as {lanes:unknown[]};assert.equal(registry.lanes.length,0);
        const {JsonFileStore}=await import(new URL('./store/json-file-store.js',f.entryUrl).href) as typeof import('../src/store/json-file-store.js');assert.equal(new JsonFileStore({dir:s.runsDirectory}).list().length,0);
      }finally{Object.defineProperty(fs,'readFileSync',{value:originalRead});syncBuiltinESMExports();f.cleanup();}
    });
  });

  it('validates supported worker shebang and PATH representations',async()=>{
    const node='/protected/node', git='/protected/git/bin/git', bin='/accepted/release/worker-bin';
    assert.equal(workerCommandPath(node,git,bin),bin+':/protected:/protected/git/bin:/usr/bin:/bin');
    const pnpm='/protected/package manager:accepted/pnpm "quoted".cjs';
    assert.ok(workerPnpmAlias(node,pnpm).includes('spawnSync('+JSON.stringify(pnpm)+','));
    for(const unsafe of ['/protected/node dir/bin/node','/protected/node\tname','/protected/node\nname','/protected/node\rname','/protected/node\u0000name','/protected/'+ 'n'.repeat(128)]){
      assert.throws(()=>workerPnpmAlias(unsafe,pnpm),/shebang interpreter representation/);
      assert.throws(()=>workerCommandPath(unsafe,git,bin),/shebang interpreter representation/);
    }
    for(const args of [[node,git,'/accepted/release:alias/worker-bin'],['/protected/node:dir/node',git,bin],[node,'/protected/git:dir/git',bin],[node,git,'/accepted/release\nname/worker-bin']] as const){
      assert.throws(()=>workerCommandPath(args[0],args[1],args[2]),/PATH segment representation/);
    }
    assert.equal(workerCommandPath(node,'/protected/git dir/git','/accepted/release dir/worker-bin'),'/accepted/release dir/worker-bin:/protected:/protected/git dir:/usr/bin:/bin','Spaces in PATH segments remain literal; only the shebang interpreter forbids whitespace');
    for(const options of [{nodeBasename:'node with space',workerAlias:'unsupported' as const},{pathDelimiterInHome:true}]){
      const f=await installedFixture(false,false,{},options);try{
        const s=f.resolve();assert.equal(s.installation,'accepted',s.reason);assert.equal(s.initiationPolicy.available,false);assert.match(s.initiationPolicy.reason,/representation/);assert.equal(s.environment.PATH,'/usr/bin:/bin');assert.equal(s.nativeMergeHost,undefined);s.assertInstallation();s.assertRecoveryScope('acme','widgets');assert.throws(s.assertInitiation,/policy unavailable/);
      }finally{f.cleanup();}
    }
  });

  it('keeps issued observation available when a valid installation lacks the supported worker launcher',async()=>{
    for(const workerAlias of ['missing','unsupported'] as const){const f=await installedFixture(false,false,{}, {workerAlias});try{
      const s=f.resolve();assert.equal(s.installation,'accepted',s.reason);assert.equal(s.initiationPolicy.available,false);assert.equal(s.nativeMergeHost,undefined);s.assertInstallation();s.assertRecoveryScope('acme','widgets');assert.throws(s.assertInitiation,/policy unavailable/);
    }finally{f.cleanup();}}
  });
  it('executes exact accepted bare pnpm in the isolated worker ahead of candidate and ambient shadows',async(t)=>{
    for(const cut of ['loaded-drift','missing-entry','alias-drift','hold'] as const) await t.test(cut,async()=>{
      const jsonl=[{type:'thread.started',thread_id:'pnpm-process-proof'},{type:'turn.started'},{type:'item.completed',item:{id:'message',type:'agent_message',text:'Controlled pnpm selection completed'}},{type:'turn.completed'}].map(v=>JSON.stringify(v)).join('\n');
      const codexRuntime=`const {spawnSync}=require('node:child_process');
if(['GH_TOKEN','GITHUB_TOKEN','GH_CONFIG_DIR','TACHIKO_PNPM_PROGRAM','TACHIKO_DATA_DIR'].some(k=>process.env[k]!==undefined))process.exit(41);
const selected=spawnSync('pnpm',['--version'],{encoding:'utf8',env:process.env});
if(selected.status!==0||selected.stdout!=='10.34.5\\n')process.exit(42);
process.stdout.write(${JSON.stringify(jsonl)});
`;
      const f=await installedFixture(true,false,{}, {lunaHome:true,toolNamespaces:{pnpm:'private-runtime/package manager:accepted'},codexRuntime});
      try{
        assert.equal(path.basename(f.record.pnpm.path),'pnpm.cjs');
        const shadow=path.join(f.objectRoot,'pnpm');const marker=path.join(f.objectRoot,'shadow-executed');
        writeFileSync(shadow,`#!${f.record.node.path} --no-global-search-paths\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'shadow');process.exit(99);\n`,{mode:0o700});
        process.env.PATH=f.objectRoot+path.delimiter+(process.env.PATH??'');
        const actual=new NodeProcessRunner();let codexSpawns=0;
        const s=f.resolve({async run(file,args,options){
          if(file===f.record.codex.path){codexSpawns++;return actual.run(file,args,options);}
          options.beforeSpawn?.();assert.equal(file,f.record.git.path);assert.deepEqual(args.slice(-2),['rev-parse','HEAD']);return{exitCode:0,stdout:'d'.repeat(40)+'\n',stderr:''};
        }});
        assert.equal(s.installation,'accepted',s.reason);
        assert.equal(s.workerTransportSourceOwned,false,'A controlled process proof never grants governed-runtime qualification');
        const luna=await import(new URL('./agents/luna-isolated.js',f.entryUrl).href) as typeof import('../src/agents/luna-isolated.js');
        const adapter=new luna.IsolatedLunaAdapter({production:s,path:f.objectRoot,codexHome:s.environment.TACHIKO_LUNA_CODEX_HOME!,timeoutMs:60000});
        const request={target:{kind:'issue' as const,owner:'acme',repo:'widgets',issueNumber:42},baseSha:'a'.repeat(40),authority:'embedded' as const,instructions:'Controlled executable-only pnpm proof. No model.',workspacePath:f.objectRoot,branch:'candidate',execution:{profile:'routine' as const,revision:'issue-104-production-v7',...PRODUCTION_EXECUTION_PROFILE_CONFIG.profiles.routine}};
        const result=await adapter.run(request);assert.equal(result.exitStatus,'success',JSON.stringify(result));assert.equal(result.headSha,'d'.repeat(40));assert.equal(codexSpawns,1);assert.equal(fs.existsSync(marker),false);
        if(cut==='loaded-drift')writeFileSync(path.join(f.record.pnpm.runtimeDirectory,'runtime.cjs'),'process.exit(98);\n');
        if(cut==='missing-entry')unlinkSync(f.record.pnpm.path);
        if(cut==='alias-drift')writeFileSync(path.join(f.release,'worker-bin/pnpm'),'changed alias bytes');
        if(cut==='hold')f.enable(false);
        await assert.rejects(adapter.run(request),error=>{assert.equal((error as {code?:unknown}).code,'EXECUTION_ADMISSION_REFUSED');return true;});assert.equal(codexSpawns,1,'No subsequent Codex or pnpm process after accepted identity/configuration loss');assert.equal(fs.existsSync(marker),false);
      }finally{f.cleanup();}
    });
  });


  it('executes exact accepted bare node and git ahead of conventional and nonstandard sibling shadows',async(t)=>{
    for(const layout of ['nonstandard','conventional'] as const)await t.test(layout,async()=>{
      const jsonl=[{type:'thread.started',thread_id:'node-git-process-proof'},{type:'turn.started'},{type:'item.completed',item:{id:'message',type:'agent_message',text:'Controlled node/git selection completed'}},{type:'turn.completed'}].map(v=>JSON.stringify(v)).join('\n');
      const f=await installedFixture(true,false,{}, {lunaHome:true,nodeBasename:layout==='nonstandard'?'node24':'node',gitBasename:layout==='nonstandard'?'git-v2':'git',gitNamespace:'private-vcs/bin',controlledGitIdentity:true,codexRuntime:({node,git})=>`const {spawnSync}=require('node:child_process');
const nodeResult=spawnSync('node',['-p','process.execPath'],{encoding:'utf8',env:process.env});if(nodeResult.status!==0||nodeResult.stdout!==${JSON.stringify(node)}+'\\n')process.exit(42);
const gitArgs=['--accepted-identity','space and "quoted" argument'];const gitResult=spawnSync('git',gitArgs,{encoding:'utf8',env:process.env});if(gitResult.status!==0||gitResult.stdout!==JSON.stringify({program:${JSON.stringify(git)},args:gitArgs})+'\\n')process.exit(43);
for(const [command,args] of [['node',['-e','process.exit(23)']],['git',['--exit-23']]])if(spawnSync(command,args,{env:process.env}).status!==23)process.exit(44);
process.stdout.write(${JSON.stringify(jsonl)});
`});
      try{
        const marker=path.join(f.objectRoot,'shadow-executed');
        const shadow=`#!${f.record.node.path} --no-global-search-paths\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'shadow');process.exit(99);\n`;
        for(const name of ['node','git'])writeFileSync(path.join(f.objectRoot,name),shadow,{mode:0o700});
        // These siblings precede the accepted Git directory in production PATH.
        writeFileSync(path.join(path.dirname(f.record.node.path),'git'),shadow,{mode:0o700});
        if(layout==='nonstandard')writeFileSync(path.join(path.dirname(f.record.node.path),'node'),shadow,{mode:0o700});
        process.env.PATH=f.objectRoot+path.delimiter+(process.env.PATH??'');
        const actual=new NodeProcessRunner();let codexSpawns=0;
        const s=f.resolve({async run(file,args,options){if(file===f.record.codex.path){codexSpawns++;return actual.run(file,args,options);}options.beforeSpawn?.();assert.equal(file,f.record.git.path);assert.deepEqual(args.slice(-2),['rev-parse','HEAD']);return{exitCode:0,stdout:'d'.repeat(40)+'\n',stderr:''};}});
        assert.equal(s.initiationPolicy.available,true,s.initiationPolicy.reason);assert.equal(s.workerTransportSourceOwned,false);
        const luna=await import(new URL('./agents/luna-isolated.js',f.entryUrl).href) as typeof import('../src/agents/luna-isolated.js');
        const adapter=new luna.IsolatedLunaAdapter({production:s,path:f.objectRoot,codexHome:s.environment.TACHIKO_LUNA_CODEX_HOME!,timeoutMs:60000});
        const request={target:{kind:'issue' as const,owner:'acme',repo:'widgets',issueNumber:42},baseSha:'a'.repeat(40),authority:'embedded' as const,instructions:'Controlled exact executable proof. No model.',workspacePath:f.objectRoot,branch:'candidate',execution:{profile:'routine' as const,revision:'issue-104-production-v7',...PRODUCTION_EXECUTION_PROFILE_CONFIG.profiles.routine}};
        const result=await adapter.run(request);assert.equal(result.exitStatus,'success',JSON.stringify(result));assert.equal(result.headSha,'d'.repeat(40));assert.equal(codexSpawns,1);assert.equal(fs.existsSync(marker),false);
        if(layout==='nonstandard')unlinkSync(path.join(f.release,'worker-bin/node'));else writeFileSync(path.join(f.release,'worker-bin/git'),'changed exact Git alias');
        await assert.rejects(adapter.run(request),error=>{assert.equal((error as {code?:unknown}).code,'EXECUTION_ADMISSION_REFUSED');return true;});assert.equal(codexSpawns,1);assert.equal(fs.existsSync(marker),false);
      }finally{f.cleanup();}
    });
  });
  it('keeps compatible observation when a node or git alias is initially missing or unsupported',async(t)=>{
    for(const name of ['node','git'] as const)for(const state of ['missing','unsupported'] as const)await t.test(name+'-'+state,async()=>{
      const f=await installedFixture(false,false,{}, {workerCommandAlias:{name,state}});try{
        const s=f.resolve();assert.equal(s.installation,'accepted',s.reason);assert.equal(s.initiationPolicy.available,false);assert.equal(s.nativeMergeHost,undefined);s.assertInstallation();s.assertRecoveryScope('acme','widgets');assert.throws(s.assertInitiation,/policy unavailable/);
      }finally{f.cleanup();}
    });
  });

  it('selects the accepted Codex through the real routine Luna provider without invoking a real model',async()=>{
    const f=await installedFixture(true,false,{}, {lunaHome:true});try{const calls:{file:string;args:readonly string[];env:NodeJS.ProcessEnv|undefined}[]=[];const s=f.resolve({async run(file,args,options){options.beforeSpawn?.();calls.push({file,args,env:options.env});return{exitCode:1,stdout:'',stderr:'controlled no-model stop'};}});assert.equal(s.workerTransportSourceOwned,false,'Controlled transport confers no source-owned governed-runtime qualification');const luna=await import(new URL('./agents/luna-isolated.js',f.entryUrl).href) as typeof import('../src/agents/luna-isolated.js');const unqualified=new luna.IsolatedLunaAdapter({production:s,codexHome:s.environment.TACHIKO_LUNA_CODEX_HOME!,timeoutMs:900000});assert.equal(luna.hasGovernedPublicationConfinement(unqualified),false);const genuine=f.resolve();assert.equal(genuine.workerTransportSourceOwned,true);const qualified=new luna.IsolatedLunaAdapter({production:genuine,codexHome:genuine.environment.TACHIKO_LUNA_CODEX_HOME!,timeoutMs:900000});assert.equal(luna.hasGovernedPublicationConfinement(qualified),true);Object.defineProperty(qualified,'runner',{value:{run(){throw new Error('forged runner');}}});assert.equal(luna.hasGovernedPublicationConfinement(qualified),false);const installedBuild=(await import(new URL('./cli.js',f.entryUrl).href)).buildWorkflowDeps as typeof buildWorkflowDeps;const deps=installedBuild({configureNativeCompletionHosts(){}} as never,undefined,s.environment,s.transport,undefined,s.nativeMergeHost,undefined,s);const execution={profile:'routine' as const,revision:'issue-104-production-v7',...PRODUCTION_EXECUTION_PROFILE_CONFIG.profiles.routine};const result=await deps.implementation.run({target:{kind:'issue',owner:'acme',repo:'widgets',issueNumber:42},baseSha:'a'.repeat(40),authority:'embedded',instructions:'Controlled bounded process-selection proof; do not execute a model.',workspacePath:f.objectRoot,branch:'candidate',execution});assert.equal(result.exitStatus,'failure');assert.equal(calls.length,1);assert.equal(calls[0]!.file,f.record.codex.path);assert.ok(calls[0]!.args.includes('gpt-5.6-luna'));assert.ok(calls[0]!.args.includes('workspace-write'));assert.equal(calls[0]!.env!.CODEX_HOME,s.environment.TACHIKO_LUNA_CODEX_HOME);assert.equal(calls[0]!.env!.PATH!.split(path.delimiter)[0],path.join(f.release,'worker-bin'));const before=calls.length;writeFileSync(path.join(f.record.codex.runtimeDirectory,'runtime.cjs'),'changed loaded code');await assert.rejects(deps.implementation.run({target:{kind:'issue',owner:'acme',repo:'widgets',issueNumber:42},baseSha:'a'.repeat(40),authority:'embedded',instructions:'Bounded no-model stop.',workspacePath:f.objectRoot,branch:'candidate',execution}),error=>{assert.equal((error as {code?:unknown}).code,'EXECUTION_ADMISSION_REFUSED');return true;});assert.equal(calls.length,before);}finally{f.cleanup();}
  });
  it('completes controlled Codex JSONL through the real Luna provider and the exact accepted Git HEAD transport',async()=>{
    const f=await installedFixture(true,false,{}, {lunaHome:true});
    try {
      const calls:{file:string;args:readonly string[];env:NodeJS.ProcessEnv|undefined}[]=[];
      const head='d'.repeat(40);
      const jsonl=[{type:'thread.started',thread_id:'controlled-success'},{type:'turn.started'},{type:'item.completed',item:{id:'message',type:'agent_message',text:'Controlled successful completion'}},{type:'turn.completed'}].map(v=>JSON.stringify(v)).join('\n');
      const s=f.resolve({async run(file,args,options){options.beforeSpawn?.();calls.push({file,args,env:options.env});return{exitCode:0,stdout:file===f.record.codex.path?jsonl:head+'\n',stderr:''};}});
      const installedBuild=(await import(new URL('./cli.js',f.entryUrl).href)).buildWorkflowDeps as typeof buildWorkflowDeps;
      const deps=installedBuild({configureNativeCompletionHosts(){}} as never,undefined,s.environment,s.transport,undefined,s.nativeMergeHost,undefined,s);
      const execution={profile:'routine' as const,revision:'issue-104-production-v7',...PRODUCTION_EXECUTION_PROFILE_CONFIG.profiles.routine};
      const result=await deps.implementation.run({target:{kind:'issue',owner:'acme',repo:'widgets',issueNumber:42},baseSha:'a'.repeat(40),authority:'embedded',instructions:'Controlled successful transport proof without a model.',workspacePath:f.objectRoot,branch:'candidate',execution});
      assert.equal(result.exitStatus,'success',JSON.stringify(result));assert.equal(result.headSha,head);
      assert.equal(calls.length,2);assert.equal(calls[0]!.file,f.record.codex.path);assert.equal(calls[1]!.file,f.record.git.path);
      assert.deepEqual(calls[1]!.args.slice(-2),['rev-parse','HEAD']);assert.equal(calls[1]!.env!.GIT_CONFIG_GLOBAL,'/dev/null');
      await assert.rejects(s.workerHeadReadRunner!.run(f.record.git.path,['push'],{cwd:f.objectRoot,timeoutMs:1000}),/exact Git command/);
      await assert.rejects(s.workerHeadReadRunner!.run('git',['rev-parse','HEAD'],{cwd:f.objectRoot,timeoutMs:1000}),/exact Git command/);assert.equal(calls.length,2);
      const luna=await import(new URL('./agents/luna-isolated.js',f.entryUrl).href) as typeof import('../src/agents/luna-isolated.js');
      for(const field of ['headReadRunner','gitExecutable'] as const){const genuine=f.resolve();const qualified=new luna.IsolatedLunaAdapter({production:genuine,codexHome:genuine.environment.TACHIKO_LUNA_CODEX_HOME!,timeoutMs:900000});assert.equal(luna.hasGovernedPublicationConfinement(qualified),true);Object.defineProperty(qualified,field,{value:field==='gitExecutable'?'git':{run(){throw new Error('forged HEAD reader');}}});assert.equal(luna.hasGovernedPublicationConfinement(qualified),false,field);}
      f.enable(false);await assert.rejects(s.workerHeadReadRunner!.run(f.record.git.path,['rev-parse','HEAD'],{cwd:f.objectRoot,timeoutMs:1000}),/changed/);assert.equal(calls.length,2);
      await s.gitRunner!.run(f.record.git.path,['rev-parse','HEAD'],{cwd:f.objectRoot,timeoutMs:1000});assert.equal(calls.length,3,'Observation-safe Git remains independent of current initiation');
    }finally{f.cleanup();}
  });

  it('retains ordinary Git failures after successful controlled worker output and types the outer production fence',async(t)=>{
    for(const failure of ['nonzero','malformed','throw'] as const)await t.test(failure,async()=>{
      const f=await installedFixture(true,false,{}, {lunaHome:true});try{
        const jsonl=[{type:'thread.started',thread_id:'ordinary-head-failure'},{type:'turn.started'},{type:'item.completed',item:{id:'message',type:'agent_message',text:'Controlled output'}},{type:'turn.completed'}].map(v=>JSON.stringify(v)).join('\n');
        let workers=0,heads=0;
        const s=f.resolve({async run(file,_args,options){options.beforeSpawn?.();if(file===f.record.codex.path){workers++;return{exitCode:0,stdout:jsonl,stderr:''};}heads++;if(failure==='throw')throw new Error('Controlled ordinary Git failure');return{exitCode:failure==='nonzero'?1:0,stdout:'not-a-full-sha',stderr:''};}});
        const installedBuild=(await import(new URL('./cli.js',f.entryUrl).href)).buildWorkflowDeps as typeof buildWorkflowDeps;
        const deps=installedBuild({configureNativeCompletionHosts(){}} as never,undefined,s.environment,s.transport,undefined,s.nativeMergeHost,undefined,s);
        const execution={profile:'routine' as const,revision:'issue-104-production-v7',...PRODUCTION_EXECUTION_PROFILE_CONFIG.profiles.routine};
        const result=await deps.implementation.run({target:{kind:'issue',owner:'acme',repo:'widgets',issueNumber:42},baseSha:'a'.repeat(40),authority:'embedded',instructions:'Controlled HEAD failure proof; no model.',workspacePath:f.objectRoot,branch:'candidate',execution});
        assert.equal(result.exitStatus,'failure');assert.ok(result.diagnostics?.some(v=>v.includes('HEAD_READ_FAILED')));assert.equal(workers,1);assert.equal(heads,1);
        f.enable(false);
        assert.throws(()=>deps.assertNormalInitiation!({execution} as never),error=>{const refusal=error as {code?:unknown;cause?:unknown};assert.equal(refusal.code,'EXECUTION_ADMISSION_REFUSED');assert.ok(refusal.cause instanceof Error);return true;});
      }finally{f.cleanup();}
    });
  });

  it('binds pnpm entry and loaded runtime bytes and refuses changed tools at the validation request fence',async()=>{
    for(const slot of ['pnpm','codex'] as const)for(const part of ['entry','loaded'] as const){const f=await installedFixture();try{const s=f.resolve();assert.equal(s.installation,'accepted',s.reason);const file=part==='entry'?f.record[slot].path:path.join(f.record[slot].runtimeDirectory,'runtime.cjs');const bytes=readFileSync(file);writeFileSync(file,Buffer.from(bytes).fill(88));assert.throws(s.assertInstallation,/changed/);const installedBuild=(await import(new URL('./cli.js',f.entryUrl).href)).buildWorkflowDeps as typeof buildWorkflowDeps;const deps=installedBuild({configureNativeCompletionHosts(){}} as never,undefined,s.environment,s.transport,undefined,s.nativeMergeHost,undefined,s);await assert.rejects(deps.validation!.validate({target:{kind:'issue',owner:'acme',repo:'widgets',issueNumber:42},headSha:'a'.repeat(40),workspacePath:f.objectRoot,beforeExecution:()=>s.assertRunInitiation({execution:{profile:'routine' as const,revision:'issue-104-production-v7',...PRODUCTION_EXECUTION_PROFILE_CONFIG.profiles.routine}})}),/changed/);assert.match(f.resolve().reason,/program bytes changed|runtime\/dependency closure changed/);}finally{f.cleanup();}}
  });
  it('rejects tool wrapper interpreter and ancestor fallback independently of accepted artifact identity',async()=>{
    const f=await installedFixture();try{const before=f.resolve();assert.equal(before.installation,'accepted',before.reason);const outside=path.join(path.dirname(f.record.pnpm.runtimeDirectory),'node_modules');mkdirSync(outside);assert.throws(before.assertInstallation,/ancestor dependency fallback/);assert.match(f.resolve().reason,/ancestor dependency fallback/);rmSync(outside,{recursive:true});}finally{f.cleanup();}
    const invalid=await installedFixture(false,false,{}, {toolInterpreter:'ambient-node',expectedRejection:/exact pinned Node\/no-global-search-paths interpreter/});invalid.cleanup();
  });
  it('accepts the separate GitHub namespace and refuses valid-identity overlapping placements',async()=>{
    const accepted=await installedFixture();try{assert.equal(accepted.resolve().installation,'accepted');}finally{accepted.cleanup();}
    for(const githubNamespace of ['workspaces/candidate/github','repositories/objects/github','releases','runs/github','mission-admission/github','tools/github','']){const f=await installedFixture(false,false,{}, {githubNamespace,expectedRejection:/GitHub namespace overlaps/});f.cleanup();}
  });
  it('rejects both containment directions of actual selected tool and object/GitHub roots with valid content identities',async()=>{
    const baseline=await installedFixture(false,false,{}, {toolNamespaces:{codex:'private-runtime/codex',pnpm:'private-runtime/pnpm'}});try{assert.equal(baseline.resolve().installation,'accepted');}finally{baseline.cleanup();}
    for(const slot of ['codex','pnpm'] as const)for(const surface of ['objectNamespace','githubNamespace'] as const)for(const location of [`private-runtime/${slot}`, 'private-runtime',`private-runtime/${slot}/nested`]){
      const f=await installedFixture(false,false,{}, {toolNamespaces:{[slot]:`private-runtime/${slot}`},[surface]:location,expectedRejection:/tool runtime overlaps the selected object root or GitHub namespace/});f.cleanup();
    }
  });
  it('refuses selected tool overlap before reading any conflicting GitHub namespace content',async()=>{
    const baseline=await installedFixture();try{assert.equal(baseline.resolve().installation,'accepted');}finally{baseline.cleanup();}
    for(const slot of ['codex','pnpm'] as const){const f=await installedFixture(false,false,{}, {toolNamespaces:{[slot]:`private-runtime/${slot}`},githubNamespace:`private-runtime/${slot}/github`,githubFixtureFile:true,expectedRejection:/tool runtime overlaps the selected object root or GitHub namespace/});
      const originalRead=fs.readFileSync;let namespaceReads=0;
      try {
        Object.defineProperty(fs,'readFileSync',{value:(...args:unknown[])=>{const file=args[0];if(typeof file==='string'&&(file===f.record.github.configDirectory||file.startsWith(f.record.github.configDirectory+path.sep))){namespaceReads++;throw new Error('Forbidden controlled namespace content read');}return Reflect.apply(originalRead,fs,args);}});syncBuiltinESMExports();
        const refused=f.resolve();assert.equal(refused.installation,'unavailable');assert.match(refused.reason,/tool runtime overlaps the selected object root or GitHub namespace/);assert.equal(namespaceReads,0,'Production must refuse placement before reading the synthetic namespace file');
      }finally{Object.defineProperty(fs,'readFileSync',{value:originalRead});syncBuiltinESMExports();f.cleanup();}
    }
  });
  it('provisions accepted private copied and emitted permissions for transpile and actual compiled modes',async()=>{
    for(const compiled of [false,true]){const f=await installedFixture(false,compiled);try{assert.equal(f.resolve().installation,'accepted');const assertPrivate=(directory:string)=>{assert.equal(lstatSync(directory).mode&0o077,0,directory);for(const name of readdirSync(directory)){const file=path.join(directory,name);const stat=lstatSync(file);assert.equal(stat.isSymbolicLink(),false,file);assert.equal(stat.mode&0o077,0,file);if(stat.isDirectory())assertPrivate(file);}};assertPrivate(f.home);assert.ok(lstatSync(path.join(f.release,'dist/mission-admission')).isDirectory());assert.ok(lstatSync(path.join(f.release,'dist/oracle/receipt-store.js')).isFile());}finally{f.cleanup();}}
  });

});
