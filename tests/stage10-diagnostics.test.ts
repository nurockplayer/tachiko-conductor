import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { awaitGateEntry, releaseAndSettle } from './stage10-diagnostics.js';

describe('stage10 diagnostic gate lifecycle',()=>{
  it('reports early workflow fulfillment before a never-entered gate',async()=>{
    await assert.rejects(awaitGateEntry(new Promise(()=>{}),Promise.resolve(), 'controlled-early-fulfillment'),/completed before the intended gate/);
  });
  it('reports the original early rejection before a never-entered gate',async()=>{
    const original=new Error('controlled workflow rejection');
    await assert.rejects(awaitGateEntry(new Promise(()=>{}),Promise.reject(original),'controlled-early-rejection'),error=>error===original);
  });
  it('releases and awaits deferred workflow settlement even after a post-entry assertion fails',async()=>{
    let enter!:()=>void;let release!:()=>void;let settled=false;
    const entered=new Promise<void>(resolve=>{enter=resolve;});const barrier=new Promise<void>(resolve=>{release=resolve;});
    const pending=(async()=>{enter();await barrier;settled=true;})();
    const original=new Error('controlled assertion after entry');
    await assert.rejects((async()=>{try{await awaitGateEntry(entered,pending,'controlled-post-entry');throw original;}finally{await releaseAndSettle(release,pending);}})(),error=>error===original);
    assert.equal(settled,true);
  });
});
