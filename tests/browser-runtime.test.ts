import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import childProcess, { spawn, execFileSync, spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';

import {
  BROWSER_RUNTIME_ERROR_CODE,
  BrowserRuntimeError,
  ManagedPlaywrightMcpRuntime,
  browserRuntimeCapability,
  buildPlaywrightMcpArgs,
  normalizeBrowserHost,
  parseRuntimeProcessIdentity,
  type BrowserRuntimeHandle,
} from '../src/browser/playwright-mcp-runtime.js';

import { installedFixture } from './production-host-fixture.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE_MCP = fileURLToPath(new URL('./fixtures/fake-playwright-mcp.mjs', import.meta.url));
const RUNTIME_OWNER = fileURLToPath(new URL('./fixtures/browser-runtime-owner.ts', import.meta.url));
const cleanups: Array<() => Promise<void> | void> = [];

async function tcpReadinessProbe(endpoint: string): Promise<boolean> {
  const url = new URL(endpoint);
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: url.hostname, port: Number(url.port) });
    const done = (ready: boolean) => {
      socket.destroy();
      resolve(ready);
    };
    socket.setTimeout(250);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('No TCP port assigned.'));
        return;
      }
      server.close((error) => (error === undefined ? resolve(address.port) : reject(error)));
    });
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function tempRuntime(
  env: NodeJS.ProcessEnv = process.env,
  readinessProbe: (endpoint: string) => Promise<boolean> = tcpReadinessProbe,
): {
  runtime: ManagedPlaywrightMcpRuntime;
  root: string;
  profileRoot: string;
  runtimeRoot: string;
} {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-browser-runtime-'));
  const profileRoot = path.join(root, 'profiles');
  const runtimeRoot = path.join(root, 'runtimes');
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return {
    runtime: new ManagedPlaywrightMcpRuntime({
      profileRoot,
      runtimeRoot,
      repositoryRoot: REPO_ROOT,
      playwrightCliPath: FAKE_MCP,
      env,
      readinessProbe,
    }),
    root,
    profileRoot,
    runtimeRoot,
  };
}

function assertRuntimeError(error: unknown, code: string): boolean {
  assert.ok(error instanceof BrowserRuntimeError);
  assert.equal(error.code, code);
  return true;
}

describe('ManagedPlaywrightMcpRuntime', () => {
  it('binds accepted browser start and bootstrap to selected artifacts and closed child dependency lookup',async(t)=>{
    for(const mode of ['manifested','global-only','missing-binding'] as const)await t.test(mode,async()=>{
      const f=await installedFixture(true,false,{}, {browserFixture:mode==='global-only'?'global-only':'manifested',...(mode==='missing-binding'?{omitEnvironment:['TACHIKO_PLAYWRIGHT_BROWSERS_PATH'] as const}:{})});
      const originalSpawn=childProcess.spawn, originalLog=console.log, originalError=console.error;
      let ownedChild:{kill(signal:'SIGTERM'):boolean}|undefined;
      const spawns:{file:string;args:readonly string[];selected:string|undefined}[]=[];
      const errors:string[]=[];let running:Promise<number>|undefined;
      const report=path.join(f.accountRoot,'controlled-browser.jsonl');
      const records=()=>existsSync(report)?readFileSync(report,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line) as {phase:string;execArgv?:string[];selected?:string;value?:string;code?:string;name?:string}):[];
      const detail=()=>JSON.stringify({mode,children:spawns.length,errors,phases:records().map(record=>record.phase)});
      try{
        execFileSync(f.record.git.path,['init','--quiet',f.objectRoot],{env:{HOME:f.home,PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}});process.chdir(f.objectRoot);f.enable(false);
        const accepted=f.resolve();assert.equal(accepted.installation,'accepted',accepted.reason);accepted.assertRecoveryScope('acme','widgets');
        const selected=f.record.environment.TACHIKO_PLAYWRIGHT_BROWSERS_PATH;
        assert.equal(accepted.environment.PLAYWRIGHT_BROWSERS_PATH,selected);
        childProcess.spawn=((file:string,args:readonly string[],options?:import('node:child_process').SpawnOptions)=>{
          const child=originalSpawn(file,args,options);
          if(args.includes(path.join(f.release,'node_modules/@playwright/mcp/cli.js'))){spawns.push({file,args:[...args],selected:options?.env?.PLAYWRIGHT_BROWSERS_PATH});ownedChild=child;}
          return child;
        }) as typeof originalSpawn;syncBuiltinESMExports();
        console.error=(value?:unknown)=>{try{const parsed=JSON.parse(String(value)) as {error?:{code?:string}};errors.push(parsed.error?.code??'OTHER');}catch{errors.push('NON_JSON');}};
        if(mode==='manifested'){
          for(const command of ['start','bootstrap'] as const){
            const profile='accepted-'+command;let ready!:(snapshot:{runtimeId:string;state:string})=>void;const entered=new Promise<{runtimeId:string;state:string}>(resolve=>{ready=resolve;});
            console.log=(value?:unknown)=>{try{const parsed=JSON.parse(String(value)) as {runtime?:{runtimeId:string;state:string}};if(parsed.runtime?.state==='ready')ready(parsed.runtime);}catch{/* Only controlled ready JSON resolves this gate. */}};
            process.env.PLAYWRIGHT_BROWSERS_PATH='/ambient/unaccepted-browser-cache';
            running=f.invoke(['browser',command,profile]);
            const outcome=await Promise.race([entered.then(snapshot=>({kind:'ready' as const,snapshot})),running.then(code=>({kind:'early' as const,code}))]);
            assert.ok(outcome.kind==='ready',detail());const snapshot=outcome.snapshot;
            const call=spawns.at(-1)!;
            assert.equal(call.file,f.record.node.path);
            assert.deepEqual(call.args.slice(0,3),['--no-global-search-paths','--title=tachiko-browser-runtime-'+snapshot.runtimeId,path.join(f.release,'node_modules/@playwright/mcp/cli.js')]);
            assert.equal(call.args.filter(value=>value==='--no-global-search-paths').length,1);assert.equal(call.selected,selected);
            const latest=records().filter(record=>record.phase==='spawn').at(-1)!;assert.equal(latest.selected,selected);assert.deepEqual(latest.execArgv,call.args.slice(0,2));
            assert.equal(records().filter(record=>record.phase==='dependency-loaded').at(-1)?.value,'manifested');
            if(command==='bootstrap'){assert.ok(records().some(record=>record.phase==='tool'&&record.name==='browser_navigate'));rmSync(selected!,{recursive:true});}
            const stopping=f.invoke(['browser','stop',profile]);void stopping.catch(()=>undefined);assert.equal(await running,0,detail());running=undefined;assert.equal(await stopping,0,detail());
            assert.equal(existsSync(path.join(f.accountRoot,'browser/profiles',profile,'.tachiko-runtime-lock.json')),false);
          }
          assert.equal(spawns.length,2);
          assert.equal(await f.invoke(['browser','start','missing-directory']),1,detail());assert.equal(errors.at(-1),'BROWSER_INVALID_CONFIG');assert.equal(spawns.length,2,'Missing selected directory cannot start a default-cache child');
        }else if(mode==='global-only'){
          const probe=spawnSync(f.record.node.path,['-e',"process.stdout.write(require('controlled-browser-dependency'))"],{cwd:f.objectRoot,env:{HOME:f.home,PATH:'/usr/bin:/bin'},encoding:'utf8',timeout:5000});
          assert.equal(probe.status,0,JSON.stringify({phase:'private-global-control',status:probe.status,signal:probe.signal,spawnFailed:probe.error!==undefined}));assert.equal(probe.stdout,'global-only');
          assert.equal(await f.invoke(['browser','start','global-refused']),1,detail());
          assert.equal(spawns.length,1);assert.equal(spawns[0]!.file,f.record.node.path);assert.equal(spawns[0]!.args[0],'--no-global-search-paths');
          assert.equal(errors.at(-1),'BROWSER_CHILD_EXITED',detail());
          assert.ok(records().some(record=>record.phase==='dependency-refused'&&record.code==='MODULE_NOT_FOUND'));assert.equal(records().some(record=>record.phase==='dependency-loaded'),false);
          assert.equal(existsSync(path.join(f.accountRoot,'browser/profiles/global-refused/.tachiko-runtime-lock.json')),false);
          const failed=JSON.parse(readFileSync(path.join(f.accountRoot,'browser/runtimes/global-refused.json'),'utf8')) as {state:string;exitCode:number};
          assert.equal(failed.state,'failed');assert.equal(failed.exitCode,23);
        }else{
          assert.equal(accepted.initiationPolicy.available,false);process.env.PLAYWRIGHT_BROWSERS_PATH='/ambient/unaccepted-browser-cache';
          assert.equal(await f.invoke(['browser','start','missing-binding']),1,detail());assert.equal(errors.at(-1),'BROWSER_INVALID_CONFIG',detail());assert.equal(spawns.length,0);
          assert.equal(existsSync(path.join(f.accountRoot,'browser/profiles/missing-binding')),false);assert.equal(records().length,0);
          accepted.assertInstallation();accepted.assertRecoveryScope('acme','widgets');
        }
        process.stderr.write('STAGE10_BROWSER_BINDING '+JSON.stringify({mode,children:spawns.length,selectedBinding:mode==='missing-binding'?'unavailable':'accepted',closedLookup:spawns.length===0?null:spawns.every(call=>call.args[0]==='--no-global-search-paths'),dependency:mode==='global-only'?'refused':mode==='manifested'?'manifested':'not-started',locksReleased:true})+'\n');
      }finally{
        ownedChild?.kill('SIGTERM');await running?.catch(()=>undefined);
        childProcess.spawn=originalSpawn;syncBuiltinESMExports();console.log=originalLog;console.error=originalError;f.cleanup();
      }
    });
  });

  it('distinguishes unavailable, unrelated, and matching process command lines', () => {
    assert.equal(parseRuntimeProcessIdentity(' \r\n\t'), undefined);
    assert.equal(parseRuntimeProcessIdentity('node unrelated-worker.js'), null);
    assert.equal(
      parseRuntimeProcessIdentity('node --title=tachiko-browser-runtime-runtime-123 cli.js'),
      'tachiko-browser-runtime-runtime-123',
    );
  });

  it('normalizes bracketed IPv6 hosts before binding while preserving URL-safe formatting', () => {
    assert.equal(normalizeBrowserHost('[::1]'), '::1');
    assert.equal(normalizeBrowserHost('::1'), '::1');
    assert.equal(normalizeBrowserHost('127.0.0.1'), '127.0.0.1');
    assert.throws(
      () => normalizeBrowserHost('[localhost]'),
      (error) => assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.INVALID_CONFIG),
    );
  });

  it('starts on loopback with an argument array, reports health, blocks duplicate profile ownership, and stops', async () => {
    const argsPath = path.join(os.tmpdir(), `tachiko-browser-args-${process.pid}-${Date.now()}.json`);
    cleanups.push(() => rmSync(argsPath, { force: true }));
    const { runtime, profileRoot, runtimeRoot } = tempRuntime({ ...process.env, FAKE_MCP_ARGS_PATH: argsPath });
    const port = await freePort();
    const handle = await runtime.start({ profile: 'github-work', port, headless: true, stopTimeoutMs: 1_234 });
    cleanups.push(async () => {
      await handle.stop().catch(() => undefined);
    });

    assert.equal(handle.snapshot.state, 'ready');
    assert.equal(handle.snapshot.health, 'ready');
    assert.equal(handle.snapshot.endpoint, `http://127.0.0.1:${port}/mcp`);
    assert.equal(handle.snapshot.profile, 'github-work');
    assert.equal(handle.snapshot.headless, true);
    assert.equal(handle.snapshot.stopTimeoutMs, 1_234);
    assert.ok(handle.snapshot.pid > 0);
    assert.deepEqual(browserRuntimeCapability(handle.snapshot), {
      kind: 'mcp-http',
      name: 'tachiko_browser',
      endpoint: `http://127.0.0.1:${port}/mcp`,
    });

    const childArgs = JSON.parse(readFileSync(argsPath, 'utf8')) as string[];
    assert.deepEqual(childArgs, buildPlaywrightMcpArgs({
      host: '127.0.0.1',
      port,
      profileDir: path.join(profileRoot, 'github-work'),
      outputDir: path.join(runtimeRoot, 'github-work-output'),
      headless: true,
    }));

    const status = await runtime.status('github-work');
    assert.equal(status?.health, 'ready');
    await assert.rejects(
      runtime.start({ profile: 'github-work', port: await freePort() }),
      (error) => assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.PROFILE_IN_USE),
    );

    const stopped = await runtime.stop('github-work');
    assert.equal(stopped.state, 'stopped');
    assert.equal(stopped.health, 'stopped');
    assert.ok(stopped.stoppedAt);
  });

  it('rechecks installation after acquiring the browser startup lock and before any new child', async () => {
    const { runtime, profileRoot } = tempRuntime();
    const originalSpawn = childProcess.spawn;
    let starts = 0, lateCut = false;
    childProcess.spawn = ((...args: Parameters<typeof originalSpawn>) => { starts += 1; return originalSpawn(...args); }) as typeof originalSpawn;
    syncBuiltinESMExports();
    let owned: BrowserRuntimeHandle | undefined;
    const lock = path.join(profileRoot, 'refused', '.tachiko-runtime-lock.json');
    const beforeStart = () => {
      if (existsSync(lock)) { lateCut = true; throw new Error('Controlled installation revoked after startup lock.'); }
    };
    try {
      owned = await runtime.start({ profile: 'owned', port: await freePort(), beforeStart });
      assert.equal(owned.snapshot.state, 'ready');
      assert.equal(starts, 1, 'accepted baseline starts the actual controlled MCP child');
      await assert.rejects(runtime.start({ profile: 'refused', port: await freePort(), beforeStart }), error => {
        assert.ok(error instanceof BrowserRuntimeError);
        assert.equal(error.code, BROWSER_RUNTIME_ERROR_CODE.SPAWN_FAILED);
        assert.equal(error.details.cause, 'Controlled installation revoked after startup lock.');
        return true;
      });
      assert.equal(lateCut, true, 'authority is revoked only after the exact new lock exists');
      assert.equal(starts, 1, 'the refused child is never spawned');
      assert.equal(existsSync(lock), false, 'the exact newly acquired lock is released');
      assert.equal((await runtime.status('owned'))?.runtimeId, owned.snapshot.runtimeId);
      assert.equal((await owned.stop()).state, 'stopped', 'original exact-owned cleanup remains available');
      process.stderr.write('STAGE10_BROWSER_FINAL_AUTHORITY ' + JSON.stringify({ lateCut, acceptedChildren: 1, refusedChildren: starts - 1, newLockReleased: !existsSync(lock), originalStopped: true }) + '\n');
    } finally {
      await owned?.stop().catch(() => undefined);
      childProcess.spawn = originalSpawn; syncBuiltinESMExports();
    }
  });

  it('rejects unsafe profiles, in-repository profile roots, and invalid ports before spawning', async () => {
    const { runtime } = tempRuntime();
    await assert.rejects(
      runtime.start({ profile: '../personal' }),
      (error) => assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.INVALID_CONFIG),
    );
    await assert.rejects(
      runtime.start({ profile: 'safe', port: 70_000 }),
      (error) => assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.INVALID_CONFIG),
    );

    const inside = new ManagedPlaywrightMcpRuntime({
      profileRoot: path.join(REPO_ROOT, '.tachiko', 'profiles'),
      runtimeRoot: path.join(REPO_ROOT, '.tachiko', 'runtimes'),
      repositoryRoot: REPO_ROOT,
      playwrightCliPath: FAKE_MCP,
    });
    await assert.rejects(
      inside.start({ profile: 'safe' }),
      (error) => assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.INVALID_CONFIG),
    );

    const symlinkRoot = mkdtempSync(path.join(os.tmpdir(), 'tachiko-browser-symlink-'));
    cleanups.push(() => rmSync(symlinkRoot, { recursive: true, force: true }));
    const linkedProfiles = path.join(symlinkRoot, 'profiles');
    symlinkSync(REPO_ROOT, linkedProfiles, 'dir');
    const symlinked = new ManagedPlaywrightMcpRuntime({
      profileRoot: linkedProfiles,
      runtimeRoot: path.join(symlinkRoot, 'runtimes'),
      repositoryRoot: REPO_ROOT,
      playwrightCliPath: FAKE_MCP,
    });
    await assert.rejects(
      symlinked.start({ profile: 'package.json' }),
      (error) => assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.INVALID_CONFIG),
    );

    const prospectiveRoot = mkdtempSync(path.join(os.tmpdir(), 'tachiko-browser-prospective-symlink-'));
    cleanups.push(() => rmSync(prospectiveRoot, { recursive: true, force: true }));
    const prospectiveRepository = path.join(prospectiveRoot, 'repository');
    const external = path.join(prospectiveRoot, 'external');
    mkdirSync(prospectiveRepository, { recursive: true });
    mkdirSync(external, { recursive: true });
    symlinkSync(prospectiveRepository, path.join(external, 'repository-alias'), 'dir');
    const notYetCreated = path.join(prospectiveRepository, 'must-not-be-created');
    const prospectiveSymlinked = new ManagedPlaywrightMcpRuntime({
      profileRoot: path.join(external, 'repository-alias', 'must-not-be-created'),
      runtimeRoot: path.join(prospectiveRoot, 'runtimes'),
      repositoryRoot: prospectiveRepository,
      playwrightCliPath: FAKE_MCP,
    });
    await assert.rejects(
      prospectiveSymlinked.start({ profile: 'safe', port: await freePort() }),
      (error) => assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.INVALID_CONFIG),
    );
    assert.equal(existsSync(notYetCreated), false, 'invalid storage must be rejected before it is created');

    const statusSymlinkRoot = mkdtempSync(path.join(os.tmpdir(), 'tachiko-browser-status-symlink-'));
    cleanups.push(() => rmSync(statusSymlinkRoot, { recursive: true, force: true }));
    const linkedRuntimes = path.join(statusSymlinkRoot, 'runtimes');
    symlinkSync(REPO_ROOT, linkedRuntimes, 'dir');
    const statusSymlinked = new ManagedPlaywrightMcpRuntime({
      profileRoot: path.join(statusSymlinkRoot, 'profiles'),
      runtimeRoot: linkedRuntimes,
      repositoryRoot: REPO_ROOT,
      playwrightCliPath: FAKE_MCP,
    });
    await assert.rejects(
      statusSymlinked.status('safe'),
      (error) => assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.INVALID_CONFIG),
    );

    const dedicatedRoot = mkdtempSync(path.join(os.tmpdir(), 'tachiko-browser-dedicated-profile-'));
    const unrelatedProfile = mkdtempSync(path.join(os.tmpdir(), 'tachiko-browser-unrelated-profile-'));
    cleanups.push(() => rmSync(dedicatedRoot, { recursive: true, force: true }));
    cleanups.push(() => rmSync(unrelatedProfile, { recursive: true, force: true }));
    const dedicatedProfileRoot = path.join(dedicatedRoot, 'profiles');
    mkdirSync(dedicatedProfileRoot, { recursive: true });
    symlinkSync(unrelatedProfile, path.join(dedicatedProfileRoot, 'personal'), 'dir');
    const escapedProfile = new ManagedPlaywrightMcpRuntime({
      profileRoot: dedicatedProfileRoot,
      runtimeRoot: path.join(dedicatedRoot, 'runtimes'),
      repositoryRoot: REPO_ROOT,
      playwrightCliPath: FAKE_MCP,
    });
    await assert.rejects(
      escapedProfile.start({ profile: 'personal', port: await freePort() }),
      (error) => assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.INVALID_CONFIG),
    );

    const outputEscapeRoot = mkdtempSync(path.join(os.tmpdir(), 'tachiko-browser-output-escape-'));
    const unrelatedOutput = mkdtempSync(path.join(os.tmpdir(), 'tachiko-browser-unrelated-output-'));
    cleanups.push(() => rmSync(outputEscapeRoot, { recursive: true, force: true }));
    cleanups.push(() => rmSync(unrelatedOutput, { recursive: true, force: true }));
    const outputRuntimeRoot = path.join(outputEscapeRoot, 'runtimes');
    mkdirSync(outputRuntimeRoot, { recursive: true });
    symlinkSync(unrelatedOutput, path.join(outputRuntimeRoot, 'escaped-output'), 'dir');
    const escapedOutput = new ManagedPlaywrightMcpRuntime({
      profileRoot: path.join(outputEscapeRoot, 'profiles'),
      runtimeRoot: outputRuntimeRoot,
      repositoryRoot: REPO_ROOT,
      playwrightCliPath: FAKE_MCP,
    });
    await assert.rejects(
      escapedOutput.start({ profile: 'escaped', port: await freePort() }),
      (error) => assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.INVALID_CONFIG),
    );
  });

  it('rejects equal, nested, and canonically overlapping browser storage roots', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-browser-overlapping-roots-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const shared = path.join(root, 'shared');
    const nested = path.join(shared, 'runtimes');
    const linked = path.join(root, 'linked');

    for (const [profileRoot, runtimeRoot] of [
      [shared, shared],
      [shared, nested],
    ] as const) {
      const runtime = new ManagedPlaywrightMcpRuntime({
        profileRoot,
        runtimeRoot,
        repositoryRoot: REPO_ROOT,
        playwrightCliPath: FAKE_MCP,
      });
      await assert.rejects(
        runtime.start({ profile: 'overlap', port: await freePort() }),
        (error) => assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.INVALID_CONFIG),
      );
    }

    mkdirSync(shared, { recursive: true, mode: 0o700 });
    symlinkSync(shared, linked, 'dir');
    const aliased = new ManagedPlaywrightMcpRuntime({
      profileRoot: shared,
      runtimeRoot: linked,
      repositoryRoot: REPO_ROOT,
      playwrightCliPath: FAKE_MCP,
    });
    await assert.rejects(
      aliased.start({ profile: 'alias', port: await freePort() }),
      (error) => assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.INVALID_CONFIG),
    );
  });

  it('reclaims a stale lock when a live PID has a different process identity', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-browser-pid-reuse-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const profileRoot = path.join(root, 'profiles');
    const runtimeRoot = path.join(root, 'runtimes');
    const profileDir = path.join(profileRoot, 'pid-reuse');
    mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      path.join(profileDir, '.tachiko-runtime-lock.json'),
      `${JSON.stringify({ version: 1, runtimeId: 'old-runtime', pid: process.pid, processIdentity: 'old-process' })}\n`,
      { mode: 0o600 },
    );
    const runtime = new ManagedPlaywrightMcpRuntime({
      profileRoot,
      runtimeRoot,
      repositoryRoot: REPO_ROOT,
      playwrightCliPath: FAKE_MCP,
      readinessProbe: tcpReadinessProbe,
    });

    const handle = await runtime.start({ profile: 'pid-reuse', port: await freePort() });
    cleanups.push(async () => {
      await handle.stop().catch(() => undefined);
    });
    assert.equal(handle.snapshot.state, 'ready');
    assert.doesNotThrow(() => process.kill(process.pid, 0));
    await handle.stop();
  });

  it('keeps a live-PID lock when process identity inspection is unavailable', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-browser-identity-unreadable-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const profileRoot = path.join(root, 'profiles');
    const profileDir = path.join(profileRoot, 'unreadable');
    mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      path.join(profileDir, '.tachiko-runtime-lock.json'),
      `${JSON.stringify({ version: 1, runtimeId: 'existing-runtime', pid: process.pid, processIdentity: 'tachiko-browser-runtime-existing-runtime' })}\n`,
      { mode: 0o600 },
    );
    const runtime = new ManagedPlaywrightMcpRuntime({
      profileRoot,
      runtimeRoot: path.join(root, 'runtimes'),
      repositoryRoot: REPO_ROOT,
      playwrightCliPath: FAKE_MCP,
      processIdentityReader: () => undefined,
    });

    await assert.rejects(
      runtime.start({ profile: 'unreadable', port: await freePort() }),
      (error) => assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.PROFILE_IN_USE),
    );
  });

  it('stops the exact child and releases ownership when startup publication fails', async () => {
    for (const phase of ['lock', 'starting', 'ready'] as const) {
      const root = mkdtempSync(path.join(os.tmpdir(), `tachiko-browser-publish-${phase}-`));
      cleanups.push(() => rmSync(root, { recursive: true, force: true }));
      const profileRoot = path.join(root, 'profiles');
      const runtimeRoot = path.join(root, 'runtimes');
      const pidPath = path.join(root, 'child.pid');
      const profile = `publish-${phase}`;
      const port = await freePort();
      const jsonWriter = (file: string, value: unknown): void => {
        const state = (value as { state?: unknown }).state;
        const isFailurePoint =
          (phase === 'lock' && file.endsWith('.tachiko-runtime-lock.json')) ||
          phase === state;
        if (isFailurePoint) throw new Error(`injected ${phase} publication failure`);
        writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      };
      const runtime = new ManagedPlaywrightMcpRuntime({
        profileRoot,
        runtimeRoot,
        repositoryRoot: REPO_ROOT,
        playwrightCliPath: FAKE_MCP,
        readinessProbe: tcpReadinessProbe,
        env: { ...process.env, FAKE_MCP_PID_PATH: pidPath },
        jsonWriter,
      });

      await assert.rejects(
        runtime.start({ profile, port, stopTimeoutMs: 250 }),
        (error) => assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.SPAWN_FAILED),
      );
      const profileDir = path.join(profileRoot, profile);
      assert.equal(existsSync(path.join(profileDir, '.tachiko-runtime-lock.json')), false);
      assert.equal(existsSync(path.join(profileDir, '.tachiko-runtime-lock.guard')), false);
      if (existsSync(pidPath)) {
        const childPid = Number(readFileSync(pidPath, 'utf8').trim());
        await waitUntil(() => !processIsAlive(childPid));
      }

      const retry = new ManagedPlaywrightMcpRuntime({
        profileRoot,
        runtimeRoot,
        repositoryRoot: REPO_ROOT,
        playwrightCliPath: FAKE_MCP,
        readinessProbe: tcpReadinessProbe,
      });
      const handle = await retry.start({ profile, port });
      await handle.stop();
    }
  });

  it('rejects existing browser storage directories that expose data to other local users', async (context) => {
    if (process.platform === 'win32') {
      context.skip('POSIX mode-bit coverage');
      return;
    }
    const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-browser-permissions-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const profileRoot = path.join(root, 'profiles');
    const runtimeRoot = path.join(root, 'runtimes');
    mkdirSync(profileRoot, { mode: 0o755 });
    mkdirSync(runtimeRoot, { mode: 0o700 });
    chmodSync(profileRoot, 0o755);
    const runtime = new ManagedPlaywrightMcpRuntime({
      profileRoot,
      runtimeRoot,
      repositoryRoot: REPO_ROOT,
      playwrightCliPath: FAKE_MCP,
    });

    await assert.rejects(
      runtime.start({ profile: 'private-only', port: await freePort() }),
      (error) => {
        assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.INVALID_CONFIG);
        assert.match((error as Error).message, /permissions to 0700/);
        return true;
      },
    );
    assert.equal(existsSync(path.join(profileRoot, 'private-only')), false);
  });

  it('fails closed when a Windows storage ACL cannot be verified as private', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-browser-windows-acl-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const inspected: string[] = [];
    const runtime = new ManagedPlaywrightMcpRuntime({
      profileRoot: path.join(root, 'profiles'),
      runtimeRoot: path.join(root, 'runtimes'),
      repositoryRoot: REPO_ROOT,
      playwrightCliPath: FAKE_MCP,
      platform: 'win32',
      windowsAclInspector: (directory) => {
        inspected.push(directory);
        return false;
      },
    });

    await assert.rejects(
      runtime.start({ profile: 'acl-check', port: await freePort() }),
      (error) => {
        assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.INVALID_CONFIG);
        assert.match((error as Error).message, /trusted Windows system principals/);
        return true;
      },
    );
    assert.equal(inspected.length, 1);
  });

  it('reports an occupied port with a typed actionable error', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    assert.ok(address !== null && typeof address !== 'string');
    const { runtime } = tempRuntime();

    await assert.rejects(
      runtime.start({ profile: 'occupied', port: address.port }),
      (error) => assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.PORT_IN_USE),
    );
  });

  it('reports automatic-port host binding failures as typed runtime errors', async () => {
    const { runtime } = tempRuntime();
    await assert.rejects(
      runtime.start({ profile: 'invalid-auto-host', host: 'does-not-exist.invalid' }),
      (error) => assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.PORT_IN_USE),
    );
  });

  it('fails actionably while profile ownership is being atomically updated', async () => {
    const { runtime, profileRoot } = tempRuntime();
    const profileDir = path.join(profileRoot, 'guarded');
    mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(profileDir, '.tachiko-runtime-lock.guard'), '{"pid":999999999}\n', { mode: 0o600 });

    await assert.rejects(
      runtime.start({ profile: 'guarded', port: await freePort() }),
      (error) => {
        assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.PROFILE_IN_USE);
        assert.match((error as Error).message, /remove that guard and retry/);
        return true;
      },
    );
  });

  it('requires an MCP handshake rather than treating any accepting socket as ready', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-browser-handshake-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const runtime = new ManagedPlaywrightMcpRuntime({
      profileRoot: path.join(root, 'profiles'),
      runtimeRoot: path.join(root, 'runtimes'),
      repositoryRoot: REPO_ROOT,
      playwrightCliPath: FAKE_MCP,
    });

    await assert.rejects(
      runtime.start({ profile: 'not-mcp', port: await freePort(), startupTimeoutMs: 150 }),
      (error) => assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.STARTUP_TIMEOUT),
    );
  });

  it('reports startup timeout and an unexpected child exit deterministically', async () => {
    const timeoutRuntime = tempRuntime({ ...process.env, FAKE_MCP_MODE: 'hang' }).runtime;
    await assert.rejects(
      timeoutRuntime.start({ profile: 'timeout', port: await freePort(), startupTimeoutMs: 100 }),
      (error) => assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.STARTUP_TIMEOUT),
    );

    const exitRuntime = tempRuntime({ ...process.env, FAKE_MCP_MODE: 'exit' }).runtime;
    await assert.rejects(
      exitRuntime.start({ profile: 'exit', port: await freePort() }),
      (error) => {
        assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.CHILD_EXITED);
        assert.match((error as Error).message, /exit code 23/);
        return true;
      },
    );

    const lateExitRuntime = tempRuntime({ ...process.env, FAKE_MCP_MODE: 'exit-after-ready' }).runtime;
    const handle = await lateExitRuntime.start({ profile: 'late-exit', port: await freePort() });
    const failed = await handle.waitForExit();
    assert.equal(failed.state, 'failed');
    assert.equal(failed.health, 'failed');
    assert.equal(failed.errorCode, BROWSER_RUNTIME_ERROR_CODE.CHILD_EXITED);
    assert.equal(failed.exitCode, 24);
  });

  it('does not release profile ownership until a startup-timeout child has actually exited', async () => {
    const childPidPath = path.join(os.tmpdir(), `tachiko-browser-child-${process.pid}-${Date.now()}.pid`);
    const childSetupPath = path.join(os.tmpdir(), `tachiko-browser-child-${process.pid}-${Date.now()}.setup`);
    cleanups.push(() => rmSync(childPidPath, { force: true }));
    cleanups.push(() => rmSync(childSetupPath, { force: true }));
    let releaseReadiness: () => void;
    const readinessGate = new Promise<void>((resolve) => { releaseReadiness = resolve; });
    const { runtime, profileRoot } = tempRuntime({
      ...process.env,
      FAKE_MCP_MODE: 'hang-ignore-term',
      FAKE_MCP_PID_PATH: childPidPath,
      FAKE_MCP_SETUP_PATH: childSetupPath,
    }, async () => {
      // Do not let fixture setup suspend the runtime's global startup deadline.
      // Once the child has published its PID and installed its signal handler,
      // hold readiness until the test has attached the lifecycle assertion.
      if (!existsSync(childPidPath) || !existsSync(childSetupPath)) return false;
      await readinessGate;
      return false;
    });

    const starting = runtime.start({ profile: 'timeout-cleanup', port: await freePort(), startupTimeoutMs: 500, stopTimeoutMs: 150 });
    const startRejected = assert.rejects(
      starting,
      (error) => assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.STARTUP_TIMEOUT),
    );
    await Promise.race([
      waitUntil(() => existsSync(childSetupPath)).then(() => undefined),
      startRejected.then(() => {
        throw new Error('Startup timed out before the fixture published its child PID.');
      }),
    ]);
    releaseReadiness!();
    await startRejected;

    const childPid = Number(readFileSync(childPidPath, 'utf8').trim());
    assert.equal(processIsAlive(childPid), false);
    assert.equal(existsSync(path.join(profileRoot, 'timeout-cleanup', '.tachiko-runtime-lock.json')), false);
  });

  it('honors an identity-scoped external stop request while readiness is still pending', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-browser-starting-stop-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const profileRoot = path.join(root, 'profiles');
    const runtimeRoot = path.join(root, 'runtimes');
    const runtime = new ManagedPlaywrightMcpRuntime({
      profileRoot,
      runtimeRoot,
      repositoryRoot: REPO_ROOT,
      playwrightCliPath: FAKE_MCP,
      readinessProbe: async () => await new Promise<boolean>(() => undefined),
    });
    const starting = runtime.start({
      profile: 'stop-while-starting',
      port: await freePort(),
      startupTimeoutMs: 5_000,
      stopTimeoutMs: 500,
    });
    const startRejected = assert.rejects(
      starting,
      (error) => assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.NOT_RUNNING),
    );
    await waitUntil(() => existsSync(path.join(runtimeRoot, 'stop-while-starting.json')));

    const stopped = await runtime.stop('stop-while-starting');
    assert.equal(stopped.state, 'stopped');
    await startRejected;
  });

  it('cancels the exact startup attempt through its AbortSignal', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-browser-starting-abort-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const profileRoot = path.join(root, 'profiles');
    const runtimeRoot = path.join(root, 'runtimes');
    const runtime = new ManagedPlaywrightMcpRuntime({
      profileRoot,
      runtimeRoot,
      repositoryRoot: REPO_ROOT,
      playwrightCliPath: FAKE_MCP,
      readinessProbe: async () => await new Promise<boolean>(() => undefined),
    });
    const controller = new AbortController();
    const starting = runtime.start({
      profile: 'abort-while-starting',
      port: await freePort(),
      startupTimeoutMs: 5_000,
      stopTimeoutMs: 500,
      signal: controller.signal,
    });
    const startRejected = assert.rejects(
      starting,
      (error) => assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.NOT_RUNNING),
    );
    await waitUntil(() => existsSync(path.join(runtimeRoot, 'abort-while-starting.json')));

    controller.abort();
    await startRejected;
    assert.equal(existsSync(path.join(profileRoot, 'abort-while-starting', '.tachiko-runtime-lock.json')), false);
    assert.equal((await runtime.status('abort-while-starting'))?.state, 'stopped');
  });

  it('returns null for a profile with no runtime metadata and refuses to stop it', async () => {
    const { runtime } = tempRuntime();
    assert.equal(await runtime.status('missing'), null);
    await assert.rejects(
      runtime.stop('missing'),
      (error) => assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.NOT_RUNNING),
    );
  });

  it('rejects an unsafe persisted runtime identity before deriving sidecar paths', async () => {
    const { runtime, runtimeRoot } = tempRuntime();
    mkdirSync(runtimeRoot, { recursive: true });
    writeFileSync(
      path.join(runtimeRoot, 'unsafe-identity.json'),
      `${JSON.stringify({
        runtimeId: '../../outside-runtime-root',
        profile: 'unsafe-identity',
        endpoint: 'http://127.0.0.1:65534/mcp',
        host: '127.0.0.1',
        port: 65534,
        pid: process.pid,
        ownerPid: process.pid,
        stopTimeoutMs: 5_000,
        headless: true,
        state: 'ready',
        health: 'ready',
        startedAt: '2026-08-29T00:00:00.000Z',
      })}\n`,
      { mode: 0o600 },
    );

    await assert.rejects(
      runtime.status('unsafe-identity'),
      (error) => assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.INVALID_CONFIG),
    );
  });

  it('refuses an external PID-only stop when the recorded owner is gone', async () => {
    const { runtime, runtimeRoot } = tempRuntime();
    mkdirSync(runtimeRoot, { recursive: true });
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    assert.ok(unrelated.pid !== undefined);
    cleanups.push(() => {
      unrelated.kill('SIGKILL');
    });
    writeFileSync(
      path.join(runtimeRoot, 'reused.json'),
      `${JSON.stringify({
        runtimeId: 'stale-runtime',
        profile: 'reused',
        endpoint: 'http://127.0.0.1:65534/mcp',
        host: '127.0.0.1',
        port: 65534,
        pid: unrelated.pid,
        ownerPid: 999_999_999,
        stopTimeoutMs: 5_000,
        headless: true,
        state: 'ready',
        health: 'ready',
        startedAt: '2026-08-29T00:00:00.000Z',
      })}\n`,
      { mode: 0o600 },
    );

    const status = await runtime.status('reused');
    assert.equal(status?.state, 'stopping');
    assert.equal(status?.errorCode, BROWSER_RUNTIME_ERROR_CODE.OWNER_EXITED);
    await assert.rejects(
      runtime.stop('reused'),
      (error) => assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.NOT_RUNNING),
    );
    assert.doesNotThrow(() => process.kill(unrelated.pid!, 0));
  });

  it('cleans up the owned browser child and profile lock after the foreground owner is killed', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-browser-owner-death-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const profileRoot = path.join(root, 'profiles');
    const runtimeRoot = path.join(root, 'runtimes');
    const snapshotPath = path.join(root, 'owner-snapshot.json');
    const childPidPath = path.join(root, 'mcp-child.pid');
    const readinessReleasePath = path.join(root, 'release-readiness');
    const port = await freePort();
    const owner = spawn(
      process.execPath,
      ['--import', 'tsx', RUNTIME_OWNER, profileRoot, runtimeRoot, REPO_ROOT, FAKE_MCP, 'orphan-safe', String(port), snapshotPath, readinessReleasePath],
      { stdio: 'ignore', env: { ...process.env, FAKE_MCP_PID_PATH: childPidPath } },
    );
    cleanups.push(() => {
      owner.kill('SIGKILL');
    });
    await waitUntil(() => existsSync(childPidPath));
    writeFileSync(readinessReleasePath, 'ready\n', { mode: 0o600 });
    await waitUntil(() => existsSync(snapshotPath));
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as { pid: number };
    const mcpPid = Number(readFileSync(childPidPath, 'utf8').trim());
    cleanups.push(() => {
      try { process.kill(snapshot.pid, 'SIGKILL'); } catch {}
      try { process.kill(mcpPid, 'SIGKILL'); } catch {}
    });

    owner.kill('SIGKILL');
    await new Promise<void>((resolve) => owner.once('exit', () => resolve()));
    const observer = new ManagedPlaywrightMcpRuntime({
      profileRoot,
      runtimeRoot,
      repositoryRoot: REPO_ROOT,
      playwrightCliPath: FAKE_MCP,
      readinessProbe: tcpReadinessProbe,
    });
    let terminal = await observer.status('orphan-safe');
    const deadline = Date.now() + 5_000;
    while (terminal?.state !== 'failed' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      terminal = await observer.status('orphan-safe');
    }

    assert.equal(terminal?.state, 'failed');
    assert.equal(terminal?.errorCode, BROWSER_RUNTIME_ERROR_CODE.OWNER_EXITED);
    assert.equal(processIsAlive(snapshot.pid), false);
    assert.equal(processIsAlive(mcpPid), false);

    const restarted = await observer.start({ profile: 'orphan-safe', port: await freePort() });
    await restarted.stop();
    assert.equal(existsSync(path.join(profileRoot, 'orphan-safe', '.tachiko-runtime-lock.json')), false);
  });

  it('never overwrites a newer runtime identity while an older external stop completes', async () => {
    const { runtime, runtimeRoot } = tempRuntime();
    mkdirSync(runtimeRoot, { recursive: true });
    const oldChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    assert.ok(oldChild.pid !== undefined);
    cleanups.push(() => {
      oldChild.kill('SIGKILL');
    });
    const oldSnapshot = {
      runtimeId: 'old-runtime',
      profile: 'restart-race',
      endpoint: 'http://127.0.0.1:65533/mcp',
      host: '127.0.0.1',
      port: 65533,
      pid: oldChild.pid,
      ownerPid: process.pid,
      stopTimeoutMs: 5_000,
      headless: true,
      state: 'ready',
      health: 'ready',
      startedAt: '2026-08-29T00:00:00.000Z',
    } as const;
    const metadataPath = path.join(runtimeRoot, 'restart-race.json');
    writeFileSync(metadataPath, `${JSON.stringify(oldSnapshot)}\n`, { mode: 0o600 });

    const stopping = runtime.stop('restart-race');
    const stopRequestPath = path.join(runtimeRoot, '.tachiko-stop-requests', 'restart-race.old-runtime.json');
    await waitUntil(() => existsSync(stopRequestPath));
    oldChild.kill('SIGTERM');
    await new Promise<void>((resolve) => oldChild.once('exit', () => resolve()));
    const replacement = {
      ...oldSnapshot,
      runtimeId: 'new-runtime',
      pid: process.pid,
      state: 'ready',
      health: 'ready',
      startedAt: '2026-08-29T00:01:00.000Z',
    } as const;
    writeFileSync(metadataPath, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });

    const stopped = await stopping;
    assert.equal(stopped.runtimeId, 'old-runtime');
    const persisted = JSON.parse(readFileSync(metadataPath, 'utf8')) as { runtimeId: string };
    assert.equal(persisted.runtimeId, 'new-runtime');
  });

  it('isolates stop requests from valid profile metadata names', async () => {
    const { runtime } = tempRuntime();
    const first = await runtime.start({ profile: 'work', port: await freePort() });
    let second: BrowserRuntimeHandle | undefined;
    try {
      const collidingProfile = `work.${first.snapshot.runtimeId}.stop`;
      second = await runtime.start({ profile: collidingProfile, port: await freePort() });
      await new Promise((resolve) => setTimeout(resolve, 100));

      assert.equal((await runtime.status('work'))?.health, 'ready');
      assert.equal((await runtime.status(collidingProfile))?.health, 'ready');
    } finally {
      await second?.stop().catch(() => undefined);
      await first.stop().catch(() => undefined);
    }
  });

  it('does not let an awaited status probe overwrite an unexpected child exit', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-browser-status-race-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    let releaseStatusProbe: ((ready: boolean) => void) | undefined;
    let announceStatusProbe: (() => void) | undefined;
    const statusProbeStarted = new Promise<void>((resolve) => {
      announceStatusProbe = resolve;
    });
    let probeCount = 0;
    const runtime = new ManagedPlaywrightMcpRuntime({
      profileRoot: path.join(root, 'profiles'),
      runtimeRoot: path.join(root, 'runtimes'),
      repositoryRoot: REPO_ROOT,
      playwrightCliPath: FAKE_MCP,
      readinessProbe: async () => {
        probeCount += 1;
        if (probeCount === 1) return true;
        announceStatusProbe?.();
        return await new Promise<boolean>((resolve) => {
          releaseStatusProbe = resolve;
        });
      },
    });
    const handle = await runtime.start({ profile: 'status-race', port: await freePort() });
    const pendingStatus = runtime.status('status-race');
    await statusProbeStarted;
    process.kill(handle.snapshot.pid, 'SIGTERM');
    const exited = await handle.waitForExit();
    assert.equal(exited.state, 'failed');
    releaseStatusProbe?.(true);

    const status = await pendingStatus;
    assert.equal(status?.state, 'failed');
    assert.equal(status?.errorCode, BROWSER_RUNTIME_ERROR_CODE.CHILD_EXITED);
  });

  it('finalizes under the ownership guard without overwriting replacement metadata', async () => {
    const { runtime, runtimeRoot, profileRoot } = tempRuntime();
    const handle = await runtime.start({ profile: 'completion-identity', port: await freePort() });
    const replacement = {
      ...handle.snapshot,
      runtimeId: 'replacement-runtime',
      pid: process.pid,
      ownerPid: process.pid,
      endpoint: 'http://127.0.0.1:65532/mcp',
      port: 65532,
      startedAt: '2026-08-29T01:00:00.000Z',
    } as const;
    const metadataPath = path.join(runtimeRoot, 'completion-identity.json');
    const profileDir = path.join(profileRoot, 'completion-identity');
    const lockPath = path.join(profileDir, '.tachiko-runtime-lock.json');
    const guardPath = path.join(profileDir, '.tachiko-runtime-lock.guard');
    writeFileSync(guardPath, `${JSON.stringify({ pid: process.pid })}\n`, { mode: 0o600 });

    process.kill(handle.snapshot.pid, 'SIGTERM');
    await waitUntil(() => !processIsAlive(handle.snapshot.pid));
    writeFileSync(lockPath, `${JSON.stringify({ version: 1, runtimeId: replacement.runtimeId, pid: process.pid })}\n`, { mode: 0o600 });
    writeFileSync(metadataPath, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
    rmSync(guardPath, { force: true });

    const oldFinal = await handle.waitForExit();
    assert.equal(oldFinal.runtimeId, handle.snapshot.runtimeId);
    assert.equal(oldFinal.state, 'failed');
    const persisted = JSON.parse(readFileSync(metadataPath, 'utf8')) as { runtimeId: string };
    assert.equal(persisted.runtimeId, replacement.runtimeId);
    const persistedLock = JSON.parse(readFileSync(lockPath, 'utf8')) as { runtimeId: string };
    assert.equal(persistedLock.runtimeId, replacement.runtimeId);
  });

  it('does not let a stale handle stop a replacement runtime for the same profile', async () => {
    const { runtime } = tempRuntime();
    const oldHandle = await runtime.start({ profile: 'stale-handle', port: await freePort() });
    process.kill(oldHandle.snapshot.pid, 'SIGTERM');
    await oldHandle.waitForExit();

    const replacement = await runtime.start({ profile: 'stale-handle', port: await freePort() });
    cleanups.push(async () => {
      await replacement.stop().catch(() => undefined);
    });
    const oldResult = await oldHandle.stop();

    assert.equal(oldResult.runtimeId, oldHandle.snapshot.runtimeId);
    const replacementStatus = await runtime.status('stale-handle');
    assert.equal(replacementStatus?.runtimeId, replacement.snapshot.runtimeId);
    assert.equal(replacementStatus?.state, 'ready');
    await replacement.stop();
  });

  it('fails promptly and remains retryable when the ownership guard blocks an owned stop', async () => {
    const { runtime, profileRoot } = tempRuntime();
    const handle = await runtime.start({ profile: 'guarded-stop', port: await freePort() });
    cleanups.push(async () => {
      await handle.stop().catch(() => undefined);
    });
    const guardPath = path.join(profileRoot, 'guarded-stop', '.tachiko-runtime-lock.guard');
    writeFileSync(guardPath, `${JSON.stringify({ pid: process.pid })}\n`, { mode: 0o600 });

    await assert.rejects(
      handle.stop(),
      (error) => assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.PROFILE_IN_USE),
    );
    assert.equal(processIsAlive(handle.snapshot.pid), true);

    rmSync(guardPath, { force: true });
    const stopped = await handle.stop();
    assert.equal(stopped.state, 'stopped');
  });
});
