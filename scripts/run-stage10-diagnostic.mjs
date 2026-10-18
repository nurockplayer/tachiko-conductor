// Additional finite diagnostic selection. This never substitutes for a normal tier.
// Keep Node's default process isolation: each completed file flushes TAP before a later file can stall.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { tsxInvocation } from './test-tier.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
// Cause-directed H1/H2 checkpoint; no unchanged broad diagnostic rerun.
// Ordinary tier discovery and commands remain untouched.
const selected=['production-host.test.ts','review-loop.test.ts'];
const patterns=[
  'validates supported worker shebang and PATH representations',
  'keeps issued observation available when a valid installation lacks the supported worker launcher',
  'executes exact accepted bare pnpm in the isolated worker ahead of candidate and ambient shadows',
  'strengthens a workspace-less repair lane from the read-only plan before the real preparation fetch',
  'rechecks captured Run and current admission before the immutable-base preparation fetch at',
  'requires the captured Run and both governed callbacks before existing-identity repair preparation at',
  'holds real repair preparation when host workspace admission is',
  'preserves a concurrent durable Run change while the live GitHub snapshot is pending',
  'preserves a concurrent durable Run change while the reviewer is pending',
  'does not persist stale reviewer failure telemetry over a concurrent Run change',
  'rechecks the exact repair handoff after final asynchronous worker preparation',
];
const tsx=tsxInvocation(root);
console.error('STAGE10_DIAGNOSTIC additional focused run; NOT a normal-tier PASS; builtin TAP emits completed failure assertions.');
const result=spawnSync(tsx.command,[...tsx.arguments,'--test','--test-concurrency=1','--test-reporter=tap',`--test-name-pattern=${patterns.join('|')}`,...selected.map(name=>path.join('tests',name))],{cwd:root,stdio:'inherit',timeout:880000,killSignal:'SIGTERM'});
const timedOut=result.error?.code==='ETIMEDOUT';
const code=timedOut?124:result.status??1;
console.error(`STAGE10_DIAGNOSTIC terminal ${JSON.stringify({exit:code,timedOut,signalled:result.signal!==null,spawnFailed:result.error!==undefined})}`);
process.exitCode=code;
