import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const admission = require('../.github/scripts/issue-admission.cjs');
const workflow = readFileSync(new URL('../.github/workflows/issue-admission.yml', import.meta.url), 'utf8');

function workflowScript(): string {
  const lines = workflow.split(/\r?\n/);
  const start = lines.findIndex((line) => line === '          script: |');
  assert.notEqual(start, -1, 'workflow github-script block exists');
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && !line.startsWith('            ')) break;
    body.push(line.startsWith('            ') ? line.slice(12) : '');
  }
  return body.join('\n');
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => Function;

test('workflow applies targeted managed label changes and preserves concurrent unrelated labels', async () => {
  const script = workflowScript();
  const labels = new Set([
    'priority:high',
    'kind:implementation',
    'shape:interacting',
    'profile:complex',
    'dispatch:ready',
  ]);
  const labelDefinitions = new Set(Object.keys(admission.LABEL_DEFINITIONS));
  const comments = [{
    id: 9,
    html_url: 'https://github.com/nurockplayer/tachiko-conductor/issues/1#issuecomment-9',
    user: { login: 'github-actions[bot]' },
    body: `${admission.ADMISSION_MARKER}\nold projection`,
  }];
  const counts = { addLabels: 0, removeLabel: 0, setLabels: 0, createComment: 0, updateComment: 0 };
  const issue = {
    author_association: 'OWNER',
    state: 'open',
    body: [
      '### Kind', 'implementation', '',
      '### Task shape', 'bounded', '',
      '### Classification reason', 'Bounded because the scope has one owner.', '',
      '### Goal', 'Reconcile admission.', '',
      '### Scope', 'Issue admission labels.', '',
      '### Non-goals', 'No queue changes.', '',
      '### Acceptance criteria', 'Managed labels match classification.', '',
      '### Dependencies', 'none', '',
      '### Stop conditions', 'Stop on classification ambiguity.',
    ].join('\n'),
    get labels() { return [...labels].map((name) => ({ name })); },
  };
  const github = {
    rest: { issues: {
      get: async () => ({ data: issue }),
      listComments: async () => ({ data: comments }),
      listLabelsForRepo: async () => ({ data: [...labelDefinitions].map((name) => ({ name })) }),
      createLabel: async ({ name }: { name: string }) => { labelDefinitions.add(name); },
      addLabels: async ({ labels: additions }: { labels: string[] }) => {
        counts.addLabels += 1;
        for (const name of additions) labels.add(name);
        // A human adds a label after the workflow read its initial issue snapshot.
        labels.add('triage:concurrent');
        return { data: additions.map((name) => ({ name })) };
      },
      removeLabel: async ({ name }: { name: string }) => {
        counts.removeLabel += 1;
        labels.delete(name);
      },
      setLabels: async () => { counts.setLabels += 1; throw new Error('workflow must not replace the full label set'); },
      createComment: async ({ body }: { body: string }) => {
        counts.createComment += 1;
        comments.push({ id: 10, html_url: 'https://example.test/comment/10', user: { login: 'github-actions[bot]' }, body });
      },
      updateComment: async ({ comment_id, body }: { comment_id: number; body: string }) => {
        counts.updateComment += 1;
        const comment = comments.find((item) => item.id === comment_id);
        assert.ok(comment);
        comment.body = body;
      },
    } },
    paginate: async (method: Function, args: Record<string, unknown>) => (await method(args)).data,
  };
  const context = { repo: { owner: 'nurockplayer', repo: 'tachiko-conductor' } };
  const core = { setFailed(message: string) { throw new Error(message); } };
  const taskRequire = (id: string) => id === 'node:path' ? path : admission;
  const run = async () => {
    const executor = new AsyncFunction('github', 'context', 'core', 'process', 'require', script);
    await executor(github, context, core, { env: { TACHIKO_ISSUE_NUMBER: '1', GITHUB_WORKSPACE: '/workspace' } }, taskRequire);
  };

  await run();
  assert.ok(labels.has('priority:high'));
  assert.ok(labels.has('triage:concurrent'));
  assert.ok(labels.has('shape:bounded'));
  assert.ok(labels.has('profile:routine'));
  assert.ok(labels.has('dispatch:ready'));
  assert.equal(labels.has('shape:interacting'), false);
  assert.equal(labels.has('profile:complex'), false);
  assert.equal(counts.setLabels, 0);
  assert.equal(counts.removeLabel, 2);
  assert.equal(counts.updateComment, 1);
  assert.equal(counts.createComment, 0);
  const canonical = comments.find((comment) => comment.id === 9);
  assert.ok(canonical);
  const canonicalBody = canonical.body;
  assert.ok(canonicalBody.includes(admission.ADMISSION_MARKER));

  await run();
  assert.equal(counts.addLabels, 1);
  assert.equal(counts.removeLabel, 2);
  assert.equal(counts.updateComment, 1);
  assert.equal(counts.createComment, 0);
  assert.equal(canonical.body, canonicalBody);
  assert.ok(labels.has('triage:concurrent'));
});
