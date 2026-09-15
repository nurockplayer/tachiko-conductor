import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tests = path.join(root, 'tests');
const tier = process.argv[2];
const integration = 'browser-runtime-integration.test.ts';
const smoke = new Map([
  ['smoke:claude', 'claude-code-smoke.test.ts'],
  ['smoke:codex', 'codex-cli-smoke.test.ts'],
  ['smoke:browser-agent', 'browser-agent-smoke.test.ts'],
]);
const all = readdirSync(tests).filter((file) => file.endsWith('.test.ts')).sort();

let selected;
if (tier === 'unit') {
  selected = all.filter((file) => file !== integration && !smoke.has(file));
  for (const file of smoke.values()) selected = selected.filter((candidate) => candidate !== file);
} else if (tier === 'integration') {
  selected = [integration];
} else if (smoke.has(tier)) {
  selected = [smoke.get(tier)];
} else {
  throw new Error(`Unknown test tier ${JSON.stringify(tier)}.`);
}

const tsx = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
const result = spawnSync(tsx, ['--test', ...selected.map((file) => path.join('tests', file))], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
});
if (result.error !== undefined) throw result.error;
process.exitCode = result.status ?? 1;
