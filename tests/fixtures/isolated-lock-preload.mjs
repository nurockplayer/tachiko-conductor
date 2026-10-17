import './account-home-preload.mjs?isolated=kernel-ids-v1';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

// Isolated tests simulate only the two existing identity seams. The real lock
// implementation, error class, filesystem barriers and processAlive stay real.
const root = pathToFileURL(realpathSync(fileURLToPath(new URL('../../', import.meta.url))) + path.sep);
const targets = new Set([
  new URL('src/dispatch/invocation-lock.ts', root).href,
  new URL('dist/dispatch/invocation-lock.js', root).href,
]);
const originalQuery = '?tachiko-test-lock-original=1';
const admittedOriginals = new Set();
const hostId = createHash('sha256').update('tachiko isolated TEST host').digest('hex');
const bootId = createHash('sha256').update('tachiko isolated TEST boot').digest('hex');

function targetBase(value) {
  const parsed = new URL(value);
  parsed.search = ''; parsed.hash = '';
  return targets.has(parsed.href) ? parsed.href : null;
}

function guardedResolve(specifier, context, nextResolve) {
  const resolved = nextResolve(specifier, context);
  const base = targetBase(resolved.url);
  if (base !== null && resolved.url !== base) {
    if (resolved.url !== base + originalQuery || context.parentURL !== base) {
      throw new Error('Unsupported isolated lock target alias or original-module bypass.');
    }
    admittedOriginals.add(resolved.url);
  }
  return resolved;
}

let wrapperGuardInstalled = false;
registerHooks({
  resolve: guardedResolve,
  load(url, context, nextLoad) {
    const base = targetBase(url);
    if (base === null) return nextLoad(url, context);
    if (url !== base) {
      if (!admittedOriginals.has(url)) {
        throw new Error('Unadmitted isolated lock original module.');
      }
      admittedOriginals.delete(url);
      return nextLoad(url, context);
    }
    // tsx can short-circuit earlier resolve hooks. Install one outer guard
    // after its active hooks, before this wrapper's original import resolves.
    if (!wrapperGuardInstalled) {
      registerHooks({ resolve: guardedResolve });
      wrapperGuardInstalled = true;
    }
    const original = JSON.stringify(base + originalQuery);
    // This is an export wrapper, never a rewrite of private production text.
    return { format: 'module', shortCircuit: true, source: `
export * from ${original};
import { acquireDispatchInvocationLock as realAcquire } from ${original};
const fixtureHostBoot = () => ({ hostId: ${JSON.stringify(hostId)}, bootId: ${JSON.stringify(bootId)} });
const fixtureStart = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Isolated lock fixture requires a positive PID.');
  return 'simulated-start:' + pid;
};
export function acquireDispatchInvocationLock(options) {
  const supplied = Object.create(options);
  if (options.hostBootIdentity === undefined) Object.defineProperty(supplied, 'hostBootIdentity', { value: fixtureHostBoot });
  if (options.processStartIdentity === undefined) Object.defineProperty(supplied, 'processStartIdentity', { value: fixtureStart });
  return realAcquire(supplied);
}
` };
  },
});
