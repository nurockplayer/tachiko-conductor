import path from 'node:path';

export const integrationTest = 'browser-runtime-integration.test.ts';
// These tests require genuine TCP listeners or host sandbox context unavailable in production.
export const isolatedExcludedTests = Object.freeze([
  'browser-runtime.test.ts',
  'control-tower-browser.test.ts',
  'local-command-sandbox.test.ts',
]);
export const smokeTiers = new Map([
  ['smoke:claude', { test: 'claude-code-smoke.test.ts', environment: 'TACHIKO_SMOKE' }],
  ['smoke:codex', { test: 'codex-cli-smoke.test.ts', environment: 'TACHIKO_CODEX_SMOKE' }],
  ['smoke:worker-router', { test: 'worker-router-smoke.test.ts', environment: 'TACHIKO_WORKER_ROUTER_SMOKE' }],
  ['smoke:browser-agent', { test: 'browser-agent-smoke.test.ts', environment: 'TACHIKO_BROWSER_AGENT_SMOKE' }],
]);

export function selectTests(tier, allTests) {
  if (tier === 'unit' || tier === 'isolated') {
    const smokeTests = new Set([...smokeTiers.values()].map(({ test }) => test));
    const excludedTests = new Set([integrationTest, ...smokeTests]);
    if (tier === 'isolated') {
      for (const test of isolatedExcludedTests) excludedTests.add(test);
    }
    return allTests.filter((test) => !excludedTests.has(test));
  }
  if (tier === 'integration') return [integrationTest];

  const smoke = smokeTiers.get(tier);
  if (smoke !== undefined) return [smoke.test];
  throw new Error(`Unknown test tier ${JSON.stringify(tier)}.`);
}

export function environmentForTier(tier, inherited = process.env) {
  const smoke = smokeTiers.get(tier);
  return smoke === undefined ? inherited : { ...inherited, [smoke.environment]: '1' };
}

export function tsxInvocation(root) {
  return {
    command: process.execPath,
    arguments: [path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')],
  };
}
