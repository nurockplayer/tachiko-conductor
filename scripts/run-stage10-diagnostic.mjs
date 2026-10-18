// Additional finite diagnostic selection. This never substitutes for a normal tier.
// Keep Node's default process isolation: each completed file flushes TAP before a later file can stall.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { tsxInvocation } from './test-tier.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const selected=['bootstrap-workflow.test.ts','dispatch-launchd.test.ts','native-lead-lifecycle.test.ts','production-entry.test.ts','stage10-diagnostics.test.ts','workflow.test.ts'];
const patterns=[
  'bootstrap actual-spawn admission fences',
  'pins one physical accepted compiled driver',
  'starts no writer on a losing start_fix CAS',
  'fixed production entry through real parser and canonical dispatcher',
  'stage10 diagnostic gate lifecycle',
  'captured production normal effect fence',
  'captured production repair bootstrap fence',
  'initial planning before physical workspace admission',
  'rechecks the exact Run handoff after final asynchronous worker preparation',
  'preserves an unknown tagged refusal when strict Run CAS disappears at the final callback',
  'preserves a concurrent Run change made while the FINAL_GATE live read is pending',
  'does not proceed to a worker when the Run changes during awaited bootstrap (planning|preparation)',
  'does not record recovered durable output when the Run changes during awaited recovery verification',
];
const tsx=tsxInvocation(root);
console.error('STAGE10_DIAGNOSTIC additional focused run; NOT a normal-tier PASS; builtin TAP emits completed failure assertions.');
const result=spawnSync(tsx.command,[...tsx.arguments,'--test','--test-concurrency=1','--test-reporter=tap',`--test-name-pattern=${patterns.join('|')}`,...selected.map(name=>path.join('tests',name))],{cwd:root,stdio:'inherit',timeout:880000,killSignal:'SIGTERM'});
const timedOut=result.error?.code==='ETIMEDOUT';
const code=timedOut?124:result.status??1;
console.error(`STAGE10_DIAGNOSTIC terminal ${JSON.stringify({exit:code,timedOut,signalled:result.signal!==null,spawnFailed:result.error!==undefined})}`);
process.exitCode=code;
