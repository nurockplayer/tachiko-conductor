import assert from 'node:assert/strict';
import type { GitHubLiveSnapshot } from '../src/adapters/github.js';
import { LiveGitHubAdapter } from '../src/github/live-state.js';
import type { GitHubApiTransport } from '../src/github/transport.js';
import { T0, TARGET } from './helpers.js';

/** One controlled original task, represented through REST before admission and after import. */
export const ORIGINAL_ISSUE = Object.freeze({node_id:'I_42',number:42,title:'Bounded fixture',body:'Create implementation.txt; repair only the original bounded file contract.',state:'open',html_url:'https://github.com/acme/widgets/issues/42',created_at:T0,updated_at:T0});
export const ORIGINAL_SCOPE = 'Create implementation.txt and any bounded repair.txt correction; preserve all other authority.';
export function originalHandoffComment(head: string | null) {
  return {node_id:'scope-fixture',id:3,user:{login:'controlled-author'},body:`<!-- agent-handoff:v1 -->\n## Scope\n${ORIGINAL_SCOPE}${head===null?'':`\n## Current state\nHEAD: ${head}\nPR: #7`}`,created_at:T0,updated_at:T0,html_url:'https://github.com/acme/widgets/issues/42#issuecomment-3'};
}

/** Real adapter/parser on a controlled REST boundary; no admitted Run is modified. */
export async function canonicalProducerSnapshot(source: GitHubLiveSnapshot, calls?: string[]): Promise<GitHubLiveSnapshot> {
  const pr=source.pullRequest;
  const prefix='repos/acme/widgets';
  const raw=(endpoint:string):unknown=>{
    calls?.push(endpoint);
    if(endpoint===`${prefix}/issues/42`)return ORIGINAL_ISSUE;
    if(endpoint===`${prefix}/issues/42/timeline`)return pr?[{event:'cross-referenced',source:{issue:{number:7,pull_request:{url:'https://api.github.com/repos/acme/widgets/pulls/7'}}}}]:[];
    if(endpoint===`${prefix}/issues/42/comments`)return[originalHandoffComment(source.headSha)];
    if(endpoint===prefix)return{default_branch:'main'};
    if(endpoint===`${prefix}/commits/main`)return{sha:source.repository.defaultBranchHeadSha??pr?.baseSha};
    if(endpoint===`${prefix}/pulls/7`){assert.ok(pr);return{node_id:'PR_7',number:7,title:pr.title,body:'Closes #42',state:'open',merged:false,draft:false,html_url:'https://github.com/acme/widgets/pull/7',mergeable:true,mergeable_state:'clean',updated_at:T0,head:{sha:pr.headSha,ref:pr.headRef,repo:{name:'widgets',owner:{login:'acme'}}},base:{sha:pr.baseSha,ref:'main',repo:{name:'widgets',owner:{login:'acme'}}}};}
    if(endpoint.endsWith('/status'))return{state:'success',total_count:1,statuses:[{id:1,context:'test',state:'success',target_url:null,updated_at:T0}]};
    if(endpoint.endsWith('/check-runs'))return{total_count:0,check_runs:[]};
    if(endpoint===`${prefix}/issues/7/comments`||endpoint===`${prefix}/pulls/7/reviews`||endpoint===`${prefix}/pulls/7/comments`)return[];
    throw new Error(`Uncontrolled canonical fixture REST path: ${endpoint}`);
  };
  const transport:GitHubApiTransport={async get(endpoint){return raw(endpoint);},async getPaginated(endpoint){const result=raw(endpoint);assert.ok(Array.isArray(result));return result;},async graphql(){return{data:{repository:{pullRequest:{closingIssuesReferences:{nodes:[{number:42,repository:{nameWithOwner:'acme/widgets'}}],pageInfo:{hasNextPage:false,endCursor:null}},reviewThreads:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}}}}}};}};
  return new LiveGitHubAdapter({transport,now:()=>source.observedAt}).readLiveSnapshot(TARGET);
}
