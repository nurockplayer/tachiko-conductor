import assert from 'node:assert/strict';

/** Only literal case/cut labels and scalar counters/booleans belong here. */
export function traceCut(test: string, cut: string, phase: 'entered'|'completed'|'early-fulfilled'|'early-rejected'|'finished', facts: Readonly<Record<string,boolean|number>> = {}): void {
  process.stderr.write(`STAGE10_CUT ${JSON.stringify({test,cut,phase,facts})}\n`);
}

/** Never wait for a gate whose workflow already fulfilled or rejected. */
export async function awaitGateEntry(entered: Promise<void>, pending: Promise<unknown>, label: string): Promise<void> {
  traceCut(label,'gate','entered');
  const result = await Promise.race([
    entered.then(()=>({kind:'entered' as const})),
    pending.then(()=>({kind:'fulfilled' as const}),error=>({kind:'rejected' as const,error})),
  ]);
  if(result.kind==='rejected'){traceCut(label,'gate','early-rejected');throw result.error;}
  if(result.kind==='fulfilled')traceCut(label,'gate','early-fulfilled');
  assert.equal(result.kind,'entered',`${label}: workflow completed before the intended gate`);
  traceCut(label,'gate','completed',{entered:true});
}

/** Cleanup cannot strand a deferred operation or replace the primary assertion. */
export async function releaseAndSettle(release:()=>void,pending:Promise<unknown>):Promise<void>{
  release();
  await pending.then(()=>undefined,()=>undefined);
}
