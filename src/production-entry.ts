#!/usr/bin/env -S node --no-global-search-paths
import { pathToFileURL } from 'node:url';
import type { CliNativeDependencies } from './cli.js';
import type { ProcessRunner } from './github/transport.js';
import { resolveProductionHost } from './production-host.js';

/** Fixed package entry: no configurable loader, module, fixture flag, or acceptance command. */
export async function productionMain(argv: string[], services: Omit<CliNativeDependencies, 'production' | 'nativeMergeHost'> & { readonly runner?: ProcessRunner } = {}): Promise<number> {
  const allowed = new Set(['runner', 'nativeReviewerHost', 'nativeLeadHost', 'historicalCompletionHosts', 'validation', 'implementation']);
  if (Object.keys(services).some(key => !allowed.has(key))) throw new Error('Unsupported internal production service dependency.');
  const production = resolveProductionHost(import.meta.url, services.runner, services.historicalCompletionHosts);
  // Canonical account-wide state cannot be hidden by candidate environment.
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, production.environment);
  const { main } = await import('./cli.js');
  return main(argv, { nativeReviewerHost: services.nativeReviewerHost, nativeLeadHost: services.nativeLeadHost, historicalCompletionHosts: services.historicalCompletionHosts, validation: services.validation, implementation: services.implementation, production });
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  productionMain(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => { console.error(`error: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
}
