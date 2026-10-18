import assert from 'node:assert/strict';
import { it } from 'node:test';
import { LiveGitHubAdapter } from '../src/github/live-state.js';
import { GhCliTransport, type GitHubWriteTransport, type ProcessRunner } from '../src/github/transport.js';
import { parseDispatchConfiguration } from '../src/dispatch/config.js';
import { resolveNativeMergeHost, type NativeMergePolicy } from '../src/workflow/merge.js';

const head = 'a'.repeat(40), base = 'b'.repeat(40), tree = 'c'.repeat(40), merge = 'd'.repeat(40);
const policy: NativeMergePolicy = { enabled: true, revision: 'merge-v1', releaseId: 'accepted-release', campaign: 'bounded', dispatchRevision: 'dispatch-v1', owner: 'acme', repo: 'widgets', controlIssue: 1, queueCommentId: 2, baseBranch: 'main', method: 'squash', integrationPolicy: 'bootstrap-base-tree-v1', reviewPolicyRevision: 'review-v1', localValidationRevision: 'local-v1', hostedValidationRevision: 'hosted-v1' };
it('uses documented expected-HEAD squash PUT and independent direct commit/default/ancestry read APIs', async () => {
  const calls: unknown[] = [];
  const transport: GitHubWriteTransport = {
    async get(path) {
      calls.push(path);
      if (path.endsWith(`/git/commits/${merge}`)) return { sha: merge, tree: { sha: tree }, parents: [{ sha: base }] };
      if (path.includes('/compare/')) return { status: 'ahead', merge_base_commit: { sha: merge } };
      if (path.endsWith('/commits/main')) return { sha: merge };
      return { default_branch: 'main' };
    }, async getPaginated() { return []; },
    async write(path, method, body) { calls.push({ path, method, body }); return { merged: true, sha: merge }; },
  };
  const github = new LiveGitHubAdapter({ transport });
  await github.squashPullRequest('acme', 'widgets', 7, head);
  assert.deepEqual(calls[0], { path: 'repos/acme/widgets/pulls/7/merge', method: 'PUT', body: { sha: head, merge_method: 'squash' } });
  assert.deepEqual(await github.readDefaultBranch('acme', 'widgets'), { branch: 'main', headSha: merge });
  assert.deepEqual(await github.readCommit('acme', 'widgets', merge), { sha: merge, treeSha: tree, parents: [base] });
  assert.equal(await github.isAncestor('acme', 'widgets', merge, head), true);
  await assert.rejects(github.squashPullRequest('acme', 'widgets', 7, 'branch-name'), /exact/);
});
it('preserves PUT and literal SHA in the ordinary gh write transport', async () => {
  let args: readonly string[] = [];
  const runner: ProcessRunner = { async run(file, supplied) { assert.equal(file, 'gh'); args = supplied; return { exitCode: 0, stdout: '{"merged":true}', stderr: '' }; } };
  await new GhCliTransport({ runner }).write('repos/acme/widgets/pulls/7/merge', 'PUT', { sha: head, merge_method: 'squash' });
  assert.equal(args[args.indexOf('--method') + 1], 'PUT'); assert.ok(args.includes(`sha=${head}`)); assert.ok(args.includes('merge_method=squash'));
});
it('requires an exact descriptor and separate trusted host, snapshots process policy, and rejects contradictory or unknown enabled fields', () => {
  const config = { revision: 'dispatch-v1', owner: 'acme', repo: 'widgets', controlIssue: 1, queueCommentId: 2, leaseDurationMs: 60_000 };
  assert.equal(parseDispatchConfiguration(JSON.stringify(config)).merge, undefined);
  assert.deepEqual(parseDispatchConfiguration(JSON.stringify({ ...config, merge: policy })).merge, policy);
  assert.equal(resolveNativeMergeHost(), undefined);
  for (const mutation of [{ enabled: false }, { method: 'merge' }, { force: true }, { releaseId: '' }, { dispatchRevision: 'foreign' }, { controlIssue: 999 }]) assert.throws(() => parseDispatchConfiguration(JSON.stringify({ ...config, merge: { ...policy, ...mutation } })), /merge/);
  const supplied = { policy: structuredClone(policy), candidate: () => ({ treeSha: tree, baseIsAncestor: true }) };
  const resolved = resolveNativeMergeHost(supplied)!;
  (supplied.policy as { revision: string }).revision = 'mutated';
  assert.equal(resolved.policy.revision, policy.revision); assert.equal(Object.isFrozen(resolved.policy), true);
  assert.equal(resolveNativeMergeHost({ ...supplied, enabled: true } as never), undefined);
});

it('binds one original-namespace token across actor selection changes without exposing it to unrelated commands', async () => {
  const tokenA='synthetic-secret-A', tokenB='synthetic-secret-B';
  const env=Object.freeze({HOME:'/accepted',PATH:'/accepted/bin',GH_CONFIG_DIR:'/accepted/github',GH_TOKEN:'ambient-token',GITHUB_TOKEN:'ambient-other',GH_DEBUG:'api'});
  const privateWasGlobal=process.env.GH_TOKEN===tokenA;let namespace=tokenA;let captures=0;let puts=0;let boundEnv:NodeJS.ProcessEnv|undefined;
  const runner:ProcessRunner={async run(file,args,options){options.beforeSpawn?.();assert.equal(file,'/accepted/gh');assert.equal(args.some(a=>a.includes(tokenA)||a.includes(tokenB)),false);if(args[0]==='auth'){captures++;assert.equal(options.env?.GH_TOKEN===undefined,true);assert.equal(options.env?.GITHUB_TOKEN===undefined,true);assert.equal(options.env?.GH_DEBUG,undefined);assert.deepEqual(args,['auth','token','--hostname','github.com']);return{exitCode:0,stdout:namespace+'\n',stderr:''};}const endpoint=args[args.indexOf('--method')+2];if(endpoint==='user'){boundEnv=options.env;assert.equal(boundEnv?.GH_TOKEN===tokenA,true);assert.equal(Object.isFrozen(boundEnv),true);namespace=tokenB;return{exitCode:0,stdout:'{"id":123}',stderr:''};}if(args.includes('PUT')){puts++;assert.equal(options.env===boundEnv,true);assert.equal(options.env?.GH_TOKEN===tokenA,true);assert.ok(args.includes(`sha=${head}`));return{exitCode:0,stdout:'{"merged":true}',stderr:''};}assert.equal(options.env===env,true);return{exitCode:0,stdout:'{}',stderr:''};}};
  const transport=new GhCliTransport({runner,executable:'/accepted/gh',hostname:'github.com',acceptedActorId:'123',repository:{owner:'acme',repo:'widgets'},env,cwd:'/objects'});
  assert.deepEqual(await transport.write('repos/acme/widgets/pulls/7/merge','PUT',{sha:head,merge_method:'squash'}),{merged:true});
  await transport.get('repos/acme/widgets');assert.equal(captures,1);assert.equal(puts,1);assert.equal(env.GH_TOKEN==='ambient-token',true);assert.equal(process.env.GH_TOKEN===tokenA,privateWasGlobal);
});

it('sanitizes every private binding failure and never reselects or submits after pre-request refusal', async () => {
  const sentinel='synthetic-private-secret-sentinel';
  for(const cut of ['empty','multiline','space','nul','nonzero','capture-throw','actor-json','actor-id','actor-mismatch','actor-nonzero','actor-throw','capture-drift','actor-drift','put-drift','put-revoked','put-throw','put-json'] as const){
    let captures=0,gets=0,puts=0;let live=true;
    const runner:ProcessRunner={async run(_file,args,options){if(args.includes('PUT')&&cut==='put-drift')live=false;options.beforeSpawn?.();if(args[0]==='auth'){captures++;if(cut==='capture-throw')throw Object.assign(new Error(sentinel),{stdout:sentinel,stderr:sentinel});if(cut==='capture-drift')live=false;return{exitCode:cut==='nonzero'?1:0,stdout:cut==='empty'?'':cut==='multiline'?sentinel+'\nextra\n':cut==='space'?sentinel+' x':cut==='nul'?sentinel+'\0':sentinel+'\n',stderr:sentinel};}if(args.includes('GET')){gets++;assert.equal(options.env?.GH_TOKEN===sentinel,true);if(cut==='actor-throw')throw Object.assign(new Error(sentinel),{stdout:sentinel});if(cut==='actor-drift')live=false;return{exitCode:cut==='actor-nonzero'?1:0,stdout:cut==='actor-json'?sentinel:JSON.stringify({id:cut==='actor-id'?sentinel:cut==='actor-mismatch'?999:123}),stderr:sentinel};}puts++;if(cut==='put-throw')throw Object.assign(new Error(sentinel),{stdout:sentinel});return{exitCode:cut==='put-revoked'?1:0,stdout:cut==='put-json'?sentinel:'{}',stderr:sentinel};}};
    const transport=new GhCliTransport({runner,executable:'/accepted/gh',hostname:'github.com',acceptedActorId:'123',env:{GH_CONFIG_DIR:'/accepted/github'},beforeSpawn:()=>{if(!live)throw new Error(sentinel);},beforeMerge:()=>{if(!live)throw new Error(sentinel);}});
    let failure:unknown;try{await transport.write('repos/acme/widgets/pulls/7/merge','PUT',{sha:head,merge_method:'squash'});}catch(error){failure=error;}
    assert.ok(failure instanceof Error,cut);assert.match(failure.message,/Merge actor binding unavailable/,cut);assert.equal(JSON.stringify({...failure,message:failure.message,stack:failure.stack}).includes(sentinel),false,cut);assert.equal('cause' in failure,false,cut);assert.equal(captures,1,cut);assert.equal(puts,cut.startsWith('put-')&&!['put-drift'].includes(cut)?1:0,cut);assert.ok(gets<=1,cut);
  }
});

it('captures separately for subsequent merges and refuses foreign repository scope before credential selection',async()=>{
  let captures=0;const runner:ProcessRunner={async run(_file,args,options){options.beforeSpawn?.();if(args[0]==='auth'){captures++;return{exitCode:0,stdout:`private-${captures}\n`,stderr:''};}assert.equal(options.env?.GH_TOKEN===`private-${captures}`,true);return{exitCode:0,stdout:args.includes('GET')?'{"id":123}':'{}',stderr:''};}};
  const transport=new GhCliTransport({runner,hostname:'github.com',acceptedActorId:'123',repository:{owner:'acme',repo:'widgets'},env:{GH_CONFIG_DIR:'/accepted/github'}});
  for(let i=0;i<2;i++)await transport.write('repos/acme/widgets/pulls/7/merge','PUT',{sha:head});assert.equal(captures,2);
  await assert.rejects(transport.write('repos/foreign/widgets/pulls/7/merge','PUT',{sha:head}),/binding unavailable/);assert.equal(captures,2);
});
