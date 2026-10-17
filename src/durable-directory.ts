import { closeSync, fsyncSync, mkdirSync, openSync, statSync } from 'node:fs';
import path from 'node:path';

/** Path-aware fault seam for the parent-directory barriers of a hierarchy. */
export type SyncDirectoryHierarchy = (directoryPath: string) => void;

export function syncDirectory(directoryPath: string): void {
  const descriptor = openSync(directoryPath, 'r');
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

/**
 * Ensure an absolute directory path exists and durably publish every path
 * component. Each parent is synced on every pass, including when the child is
 * already visible from an earlier attempt whose sync result was uncertain.
 */
export function ensureDurableDirectory(
  directoryPath: string,
  options: { readonly mode?: number; readonly syncDirectoryHierarchy?: SyncDirectoryHierarchy } = {},
): string {
  if (!path.isAbsolute(directoryPath)) throw new Error(`Durable directory path must be absolute: ${directoryPath}`);
  const resolved = path.resolve(directoryPath);
  const root = path.parse(resolved).root;
  const components = resolved.slice(root.length).split(path.sep).filter((component) => component.length > 0);
  const sync = options.syncDirectoryHierarchy ?? syncDirectory;
  let current = root;
  if (!statSync(root).isDirectory()) throw new Error(`Filesystem root is not a directory: ${root}`);
  for (const component of components) {
    current = path.join(current, component);
    try {
      if (options.mode === undefined) mkdirSync(current);
      else mkdirSync(current, { mode: options.mode });
    } catch (error) {
      if (typeof error !== 'object' || error === null || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (!statSync(current).isDirectory()) throw new Error(`Durable path component is not a directory: ${current}`);
    sync(path.dirname(current));
  }
  return resolved;
}
