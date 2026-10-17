import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { renderDispatchLaunchdPlist } from '../src/dispatch/launchd.js';
import { PRODUCTION_EXECUTION_PROFILE_CONFIG, PRODUCTION_POLICY_REVISION } from '../src/production-policy.js';

it('pins one accepted compiled driver across restarts and rejects checkout/current-release targets',()=>{
  const options={program:'/Users/operator/.tachiko-conductor/releases/release-v1/scripts/dispatch-driver.sh',nodeProgram:'/opt/node/bin/node',pnpmProgram:'/opt/pnpm/bin/pnpm',gitProgram:'/usr/bin/git',dependencyArtifactPath:'/Users/operator/.tachiko-conductor/dependencies/v7',lunaCodexHome:'/Users/operator/.tachiko-conductor/luna',playwrightBrowsersPath:'/Users/operator/.tachiko-conductor/browsers',workingDirectory:'/Users/operator/.tachiko-conductor/releases/release-v1'};
  assert.equal(renderDispatchLaunchdPlist(options),renderDispatchLaunchdPlist({...options}));
  assert.match(renderDispatchLaunchdPlist(options),/<key>StandardOutPath<\/key><string>\/Users\/operator\/\.tachiko-conductor\/dispatch\/io.tachiko.conductor.dispatch-driver.stdout.log<\/string>/);
  assert.match(renderDispatchLaunchdPlist(options),/<key>StandardErrorPath<\/key><string>\/Users\/operator\/\.tachiko-conductor\/dispatch\/io.tachiko.conductor.dispatch-driver.stderr.log<\/string>/);
  for(const option of ['standardOutPath','standardErrorPath'])for(const file of [`${options.workingDirectory}/scripts/driver.log`,'/Users/operator/.tachiko-conductor/dispatch/../releases/other/driver.log'])assert.throws(()=>renderDispatchLaunchdPlist({...options,[option]:file}),/logs must be outside immutable/);
  for(const program of ['/candidate/scripts/dispatch-driver.sh','/Users/operator/.tachiko-conductor/releases/current/scripts/other.sh','/Users/operator/.tachiko-conductor/releases/v1/../v2/scripts/dispatch-driver.sh'])assert.throws(()=>renderDispatchLaunchdPlist({...options,program}),/accepted-release/);
  const driver=readFileSync('scripts/dispatch-driver.sh','utf8');const deploy=readFileSync('scripts/issue-104-deploy.sh','utf8');
  assert.match(driver,/dist\/production-entry\.js/);assert.doesNotMatch(driver,/src\/cli|node_modules\/tsx|\. "\$ROOT/);assert.match(deploy,/production preflight/);assert.doesNotMatch(deploy,/launchctl kickstart|auth\.json|maintenance release|--accept-current/);
  assert.equal(PRODUCTION_POLICY_REVISION,'issue-104-production-v7');assert.equal(PRODUCTION_EXECUTION_PROFILE_CONFIG.profiles.routine.model,'gpt-5.6-luna');
});
