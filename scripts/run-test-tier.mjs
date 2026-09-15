import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { environmentForTier, selectTests, tsxInvocation } from './test-tier.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tests = path.join(root, 'tests');
const tier = process.argv[2];
const all = readdirSync(tests).filter((file) => file.endsWith('.test.ts')).sort();
const selected = selectTests(tier, all);
const tsx = tsxInvocation(root);
const result = spawnSync(tsx.command, [...tsx.arguments, '--test', ...selected.map((file) => path.join('tests', file))], {
  cwd: root,
  env: environmentForTier(tier),
  stdio: 'inherit',
});
if (result.error !== undefined) throw result.error;
process.exitCode = result.status ?? 1;
