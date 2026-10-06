export interface ParsedGitWorktree {
  readonly path: string;
  readonly headSha?: string;
  readonly branch?: string;
  readonly detached: boolean;
}

/** Parse Git's porcelain format without splitting paths on whitespace. */
export function parseGitWorktreePorcelain(output: string): readonly ParsedGitWorktree[] {
  const blocks = output.trim().split(/\n\s*\n/).filter(Boolean);
  return blocks.flatMap((block) => {
    const fields = new Map(block.split('\n').map((line) => {
      const separator = line.indexOf(' ');
      return separator < 0 ? [line, ''] : [line.slice(0, separator), line.slice(separator + 1)];
    }));
    const worktree = fields.get('worktree');
    if (worktree === undefined || worktree === '') return [];
    const ref = fields.get('branch');
    return [{ path: worktree, ...(fields.get('HEAD') ? { headSha: fields.get('HEAD') } : {}), ...(ref ? { branch: ref.replace(/^refs\/heads\//, '') } : {}), detached: fields.has('detached') }];
  });
}

export interface CommandBoundary {
  run(command: string, args: readonly string[]): { readonly stdout: string; readonly status: number };
}

export function collectGitWorktrees(command: CommandBoundary): readonly ParsedGitWorktree[] {
  const result = command.run('git', ['worktree', 'list', '--porcelain']);
  return result.status === 0 ? parseGitWorktreePorcelain(result.stdout) : [];
}
