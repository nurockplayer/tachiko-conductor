export interface SystemCommandBoundary {
  run(command: string, args: readonly string[]): { readonly stdout: string; readonly status: number };
}

export interface DiskObservation {
  readonly totalBytes?: number;
  readonly freeBytes?: number;
}

/** Parses BSD and GNU `df -k` output without making a platform claim. */
export function parseDfKilobytes(output: string): DiskObservation {
  const line = output.trim().split('\n').filter(Boolean).at(-1);
  if (line === undefined) return {};
  const columns = line.trim().split(/\s+/);
  const total = Number(columns[1]);
  const free = Number(columns[3]);
  return Number.isFinite(total) && Number.isFinite(free) && total >= 0 && free >= 0
    ? { totalBytes: total * 1024, freeBytes: free * 1024 }
    : {};
}

export function collectDataVolume(command: SystemCommandBoundary, path: string): DiskObservation {
  const result = command.run('df', ['-k', path]);
  return result.status === 0 ? parseDfKilobytes(result.stdout) : {};
}
