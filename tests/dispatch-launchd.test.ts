import assert from 'node:assert/strict';
import { chmodSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { renderDispatchLaunchdPlist } from '../src/dispatch/launchd.js';
import { PRODUCTION_EXECUTION_PROFILE_CONFIG, PRODUCTION_POLICY_REVISION } from '../src/production-policy.js';
import { installedFixture } from './production-host-fixture.js';

it('pins one physical accepted compiled driver across restarts and refuses release, ancestor, driver and log aliases',async()=>{
  const f=await installedFixture();
  try{
    const dispatch=path.join(f.accountRoot,'dispatch');mkdirSync(dispatch,{mode:0o700});
    const options={program:path.join(f.release,'scripts/dispatch-driver.sh'),nodeProgram:f.record.node.path,pnpmProgram:f.record.pnpm.path,gitProgram:f.record.git.path,dependencyArtifactPath:f.record.environment.TACHIKO_PNPM_DEPENDENCY_ARTIFACT!,lunaCodexHome:path.join(f.accountRoot,'luna'),playwrightBrowsersPath:f.record.environment.TACHIKO_PLAYWRIGHT_BROWSERS_PATH!,workingDirectory:f.release};
    assert.equal(f.resolve().installation,'accepted','The physical positive is a real accepted distribution before negative controls.');
    const plist=renderDispatchLaunchdPlist(options);
    assert.equal(plist,renderDispatchLaunchdPlist({...options}));assert.ok(plist.includes(`<string>${options.program}</string>`));assert.ok(plist.includes(`<key>WorkingDirectory</key><string>${f.release}</string>`));
    for(const kind of ['stdout','stderr'])assert.ok(plist.includes(path.join(dispatch,`io.tachiko.conductor.dispatch-driver.${kind}.log`)));
    for(const name of ['current','arbitrary-alias']){
      const alias=path.join(path.dirname(f.release),name);symlinkSync(f.release,alias);
      assert.throws(()=>renderDispatchLaunchdPlist({...options,program:path.join(alias,'scripts/dispatch-driver.sh'),workingDirectory:alias}),/physical fixed|without aliases/);
      const replacement=path.join(f.accountRoot,'other-physical-release');mkdirSync(replacement);unlinkSync(alias);symlinkSync(replacement,alias);
      assert.throws(()=>renderDispatchLaunchdPlist({...options,program:path.join(alias,'scripts/dispatch-driver.sh'),workingDirectory:alias}));assert.equal(renderDispatchLaunchdPlist(options),plist,'Repointing a refused alias cannot reselect the rendered physical release');unlinkSync(alias);rmSync(replacement,{recursive:true});
    }
    const homeAlias=path.join(f.home,'home-alias');symlinkSync(f.home,homeAlias);
    assert.throws(()=>renderDispatchLaunchdPlist({...options,program:options.program.replace(f.home,homeAlias)}),/physical fixed|without aliases/);unlinkSync(homeAlias);
    renameSync(options.program,options.program+'.saved');symlinkSync(options.program+'.saved',options.program);
    assert.throws(()=>renderDispatchLaunchdPlist(options),/physical fixed|without aliases/);unlinkSync(options.program);renameSync(options.program+'.saved',options.program);
    const scripts=path.dirname(options.program);chmodSync(scripts,0o777);assert.throws(()=>renderDispatchLaunchdPlist(options),/permissions/);chmodSync(scripts,0o700);
    for(const workingDirectory of [f.objectRoot,path.join(f.home,'missing')])assert.throws(()=>renderDispatchLaunchdPlist({...options,workingDirectory}),/selected physical/);
    const cwdAlias=path.join(f.home,'cwd-alias');symlinkSync(f.release,cwdAlias);assert.throws(()=>renderDispatchLaunchdPlist({...options,workingDirectory:cwdAlias}),/selected physical/);unlinkSync(cwdAlias);
    for(const option of ['standardOutPath','standardErrorPath']){
      assert.throws(()=>renderDispatchLaunchdPlist({...options,[option]:path.join(f.release,'driver.log')}),/logs must be outside immutable/);
      const logAlias=path.join(dispatch,'aliased-parent');symlinkSync(f.release,logAlias);assert.throws(()=>renderDispatchLaunchdPlist({...options,[option]:path.join(logAlias,'driver.log')}),/physical spelling/);unlinkSync(logAlias);
      const file=path.join(dispatch,'aliased.log');symlinkSync(path.join(f.release,'dist/production-entry.js'),file);assert.throws(()=>renderDispatchLaunchdPlist({...options,[option]:file}),/Unsafe launchd log file/);unlinkSync(file);
      const logSource=path.join(dispatch,'mutable-log-source');writeFileSync(logSource,'independent mutable log\n',{mode:0o600});linkSync(logSource,file);assert.throws(()=>renderDispatchLaunchdPlist({...options,[option]:file}),/Unsafe launchd log file/);unlinkSync(file);unlinkSync(logSource);
      writeFileSync(file,'existing mutable log\n',{mode:0o600});assert.ok(renderDispatchLaunchdPlist({...options,[option]:file}).includes(file));unlinkSync(file);
    }
    const driver=readFileSync(options.program,'utf8');const deploy=readFileSync(path.join(f.release,'scripts/issue-104-deploy.sh'),'utf8');
    for(const script of [driver,deploy]){assert.match(script,/pwd -P/);assert.match(script,/cd -P -- "\$ROOT"/);assert.match(script,/\[ "\$0" = "\$ROOT\/scripts\//);}
    assert.match(driver,/dist\/production-entry\.js/);assert.doesNotMatch(driver,/src\/cli|node_modules\/tsx|\. "\$ROOT/);assert.match(deploy,/production preflight/);assert.doesNotMatch(deploy,/launchctl kickstart|auth\.json|maintenance release|--accept-current/);
    assert.equal(PRODUCTION_POLICY_REVISION,'issue-104-production-v7');assert.equal(PRODUCTION_EXECUTION_PROFILE_CONFIG.profiles.routine.model,'gpt-5.6-luna');
  }finally{f.cleanup();}
});
