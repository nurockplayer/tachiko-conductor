import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { NodeProcessRunner, type ProcessRunner } from '../src/github/transport.js';

/** Small real Git/bare-remote fixture shared by bootstrap/lifecycle tests. */
export interface BootstrapGitFixture {
  readonly root: string;
  readonly remote: string;
  readonly source: string;
  readonly workspaceRoot: string;
  readonly runner: ProcessRunner;
  readonly baseSha: string;
  readonly branch: string;
  readonly commands: readonly { readonly file: string; readonly args: readonly string[]; readonly cwd?: string }[];
  git(cwd: string, args: readonly string[]): string;
  commit(cwd: string, file: string, contents: string, message?: string): string;
  cleanup(): void;
}

/**
 * Creates a source checkout whose real remote is local, while the identity
 * reads are presented as the expected GitHub repository.  This keeps Git
 * ancestry, refs, worktrees, and pushes real without contacting GitHub.
 */
export function createBootstrapGitFixture(options: { readonly branch?: string } = {}): BootstrapGitFixture {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-bootstrap-fixture-'));
  const remote = path.join(root, 'remote.git');
  const source = path.join(root, 'source');
  const workspaceRoot = path.join(root, 'workspaces');
  const branch = options.branch ?? 'main';
  execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' });
  mkdirSync(source);
  git(source, ['init', '-b', branch]);
  writeFileSync(path.join(source, 'README.md'), 'base\n');
  git(source, ['add', 'README.md']);
  git(source, ['-c', 'user.name=Tachiko', '-c', 'user.email=tachiko@example.invalid', 'commit', '-m', 'base']);
  git(source, ['remote', 'add', 'origin', `file://${remote}`]);
  git(source, ['push', '-u', 'origin', branch]);
  const baseSha = git(source, ['rev-parse', 'HEAD']);
  const runner = new GitHubIdentityRunner(new NodeProcessRunner());
  return {
    root,
    remote,
    source,
    workspaceRoot,
    runner,
    baseSha,
    branch,
    commands: runner.commands,
    git,
    commit: (cwd, file, contents, message = 'fixture change') => {
      writeFileSync(path.join(cwd, file), contents);
      git(cwd, ['add', file]);
      git(cwd, ['-c', 'user.name=Tachiko', '-c', 'user.email=tachiko@example.invalid', 'commit', '-m', message]);
      return git(cwd, ['rev-parse', 'HEAD']);
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** URL identity double only; every Git graph/ref/worktree operation is real. */
export class GitHubIdentityRunner implements ProcessRunner {
  readonly commands: { file: string; args: readonly string[]; cwd?: string }[] = [];
  constructor(private readonly delegate: ProcessRunner = new NodeProcessRunner()) {}

  async run(file: string, args: readonly string[], options: Parameters<ProcessRunner['run']>[2]) {
    this.commands.push({ file, args: [...args], cwd: options.cwd });
    if (file === 'git' && args.join(' ') === 'remote get-url origin') {
      return { stdout: 'git@github.com:acme/widgets.git\n', stderr: '', exitCode: 0 };
    }
    if (file === 'git' && args.join(' ') === 'remote get-url --all --push origin') {
      return { stdout: 'git@github.com:acme/widgets.git\n', stderr: '', exitCode: 0 };
    }
    return this.delegate.run(file, args, options);
  }
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
