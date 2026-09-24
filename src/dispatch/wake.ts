import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, watch, writeFileSync } from 'node:fs';
import path from 'node:path';
import { resolveAccountHomeDirectory } from '../account-home.js';

/** A local, provider-neutral nudge for an already-supervised dispatch driver. */
export function dispatchWakePath(env: NodeJS.ProcessEnv = process.env, homeDirectory: string = resolveAccountHomeDirectory()): string {
  const configured = env.TACHIKO_DISPATCH_WAKE_PATH;
  const value = configured ?? path.join(homeDirectory, '.tachiko-conductor', 'dispatch', 'wake');
  if (!path.isAbsolute(value) || value.includes('\0')) throw new Error('TACHIKO_DISPATCH_WAKE_PATH must be an absolute path.');
  return value;
}

function token(wakePath: string): string | null {
  try {
    const value = readFileSync(wakePath, 'utf8').trim();
    return value === '' ? null : value;
  } catch { return null; }
}

/** Record one coalescible local wake without touching queue, Run, or provider state. */
export function signalDispatchWake(wakePath: string): string {
  const value = randomUUID();
  mkdirSync(path.dirname(wakePath), { recursive: true });
  writeFileSync(wakePath, `${value}\n`, { encoding: 'utf8', mode: 0o600 });
  return value;
}

/**
 * Wait for either a changed local wake token or the bounded safety poll. A
 * stale token is only a baseline, so restart cannot replay it forever.
 */
export function createDispatchWakeWaiter(wakePath: string): (milliseconds: number) => Promise<void> {
  mkdirSync(path.dirname(wakePath), { recursive: true });
  let observed = token(wakePath);
  return async (milliseconds: number) => await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      watcher.close();
      clearTimeout(timeout);
      observed = token(wakePath);
      resolve();
    };
    const watcher = watch(path.dirname(wakePath), { persistent: false }, () => {
      if (token(wakePath) !== observed) finish();
    });
    const timeout = setTimeout(finish, milliseconds);
    // Close the check-before-watch race: a signal between baseline and watcher
    // setup is still a wake, while an unchanged stale token remains quiet.
    if (token(wakePath) !== observed) finish();
  });
}
