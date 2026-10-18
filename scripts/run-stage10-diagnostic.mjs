// Additional finite diagnostic selection. This never substitutes for a normal tier.
// Keep Node's default process isolation: each completed file flushes TAP before a later file can stall.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { tsxInvocation } from './test-tier.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
// Cause-directed E1-E4 checkpoint after the previous full selection timed out.
// Ordinary tier discovery and commands remain untouched.
const selected=['production-entry.test.ts'];
const patterns=[
  'preserves the original bounded issue and accepted scope through real adapter',
  'fences captured production drift after final lead claim reads and at repair worker/publication effects',
  'keeps dual dispatch authority, actor attribution and current base gates before zero new merges',
  'rejects foreign transport targets with the typed ordinary scope refusal',
  'parks unclaimed manual execution independently',
  'rejects runtime fake-host injection independently',
  'recovers post-repair lead and inactive review history through the accepted entry',
];
const tsx=tsxInvocation(root);
console.error('STAGE10_DIAGNOSTIC additional focused run; NOT a normal-tier PASS; builtin TAP emits completed failure assertions.');
const result=spawnSync(tsx.command,[...tsx.arguments,'--test','--test-concurrency=1','--test-reporter=tap',`--test-name-pattern=${patterns.join('|')}`,...selected.map(name=>path.join('tests',name))],{cwd:root,stdio:'inherit',timeout:880000,killSignal:'SIGTERM'});
const timedOut=result.error?.code==='ETIMEDOUT';
const code=timedOut?124:result.status??1;
console.error(`STAGE10_DIAGNOSTIC terminal ${JSON.stringify({exit:code,timedOut,signalled:result.signal!==null,spawnFailed:result.error!==undefined})}`);
process.exitCode=code;
