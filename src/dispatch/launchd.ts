import path from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';
import { assertSafeAccountOwnedPath } from '../account-home.js';
import {
  PRODUCTION_EXECUTION_PROFILE_CONFIG,
  PRODUCTION_HOSTED_CHECK_POLICY_CONFIG,
  PRODUCTION_LOCAL_VALIDATION_CONFIG,
} from '../production-policy.js';

export const DEFAULT_DISPATCH_LAUNCHD_LABEL = 'io.tachiko.conductor.dispatch-driver';

export interface DispatchLaunchdOptions {
  readonly label?: string;
  /** Absolute fixed driver in releases/<releaseId>/scripts; no current symlink. */
  readonly program: string;
  /** Stable absolute Node runtime supplied by the post-merge installer. */
  readonly nodeProgram: string;
  /** Stable absolute pnpm executable used by sandboxed local validation. */
  readonly pnpmProgram: string;
  /** Stable absolute Git executable used by repository validation probes. */
  readonly gitProgram: string;
  /** Read-only host-created pnpm store plus lockfile digest. */
  readonly dependencyArtifactPath: string;
  /** Owner-controlled, durable Luna configuration; never an implicit default. */
  readonly lunaCodexHome: string;
  /** Host-provisioned Playwright artifacts, never an ambient user cache. */
  readonly playwrightBrowsersPath: string;
  readonly workingDirectory: string;
  readonly standardErrorPath?: string;
  readonly standardOutPath?: string;
}

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function absolute(value: string, name: string): string {
  if (!path.isAbsolute(value) || value.includes('\0')) throw new Error(`${name} must be an absolute path.`);
  return value;
}

/** Render a launchd supervisor for the long-running provider-neutral driver. */
export function renderDispatchLaunchdPlist(options: DispatchLaunchdOptions): string {
  const label = options.label ?? DEFAULT_DISPATCH_LAUNCHD_LABEL;
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(label)) throw new Error('launchd label contains unsupported characters.');
  const program = absolute(options.program, 'launchd program');
  if (!/\/\.tachiko-conductor\/releases\/[A-Za-z0-9][A-Za-z0-9._-]{0,79}\/scripts\/dispatch-driver\.sh$/.test(program) || path.normalize(program) !== program) throw new Error('launchd driver must select one fixed accepted-release distribution.');
  const release = path.dirname(path.dirname(program));
  const releasesDirectory = path.dirname(release);
  const accountRoot = path.dirname(releasesDirectory);
  const home = path.dirname(accountRoot);
  if (path.basename(release) === 'current' || realpathSync.native(program) !== program) throw new Error('launchd driver must use a physical fixed accepted-release path without aliases.');
  for (const file of [program, path.join(release, 'dist/production-entry.js'), path.join(release, 'accepted-release.json')]) {
    assertSafeAccountOwnedPath(home, file, 'file');
    const info = lstatSync(file);
    if (!info.isFile() || info.nlink !== 1 || file === program && (info.mode & 0o100) === 0) throw new Error('launchd accepted-release files must be regular, unaliased and executable where required.');
  }
  const nodeProgram = absolute(options.nodeProgram, 'launchd node program');
  const pnpmProgram = absolute(options.pnpmProgram, 'launchd pnpm program');
  const gitProgram = absolute(options.gitProgram, 'launchd git program');
  const dependencyArtifactPath = absolute(options.dependencyArtifactPath, 'launchd dependency artifact path');
  const lunaCodexHome = absolute(options.lunaCodexHome, 'launchd Luna CODEX_HOME');
  const playwrightBrowsersPath = absolute(options.playwrightBrowsersPath, 'launchd Playwright browser artifact path');
  const workingDirectory = absolute(options.workingDirectory, 'launchd working directory');
  if (workingDirectory !== release || realpathSync.native(workingDirectory) !== release) throw new Error('launchd working directory must be the selected physical accepted release.');
  assertSafeAccountOwnedPath(home, workingDirectory, 'directory');
  const logDirectory = path.join(path.dirname(releasesDirectory), 'dispatch');
  const logPath = (value: string, name: string) => {
    const file = absolute(value, name);
    if (path.normalize(file) !== file) throw new Error('launchd log paths must use canonical physical spelling.');
    const parent = path.dirname(file);
    if (realpathSync.native(parent) !== parent) throw new Error('launchd log paths must use canonical physical spelling without aliases.');
    let existing = file;
    try { const info=lstatSync(file); if(!info.isFile() || info.isSymbolicLink() || info.nlink!==1 || (info.mode&0o7022)!==0 || info.uid!==process.getuid?.()) throw new Error('Unsafe launchd log file.'); }
    catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error; existing=parent; }
    for(let current=existing===parent?parent:path.dirname(existing);;current=path.dirname(current)) {
      const info=lstatSync(current);const mode=info.mode&0o7777;const stickyRoot=info.uid===0&&(mode&0o1000)!==0;
      if(!info.isDirectory() || info.isSymbolicLink() || info.uid!==0&&info.uid!==process.getuid?.() || (mode&0o022)!==0&&!stickyRoot || (mode&0o6000)!==0)throw new Error('Unsafe launchd log ancestry.');
      if(current===path.dirname(current))break;
    }
    const relative = path.relative(releasesDirectory, file);
    if (relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) throw new Error('launchd logs must be outside immutable accepted-release distributions.');
    return file;
  };
  const stdout = logPath(options.standardOutPath ?? path.join(logDirectory, `${label}.stdout.log`), 'launchd stdout path');
  const stderr = logPath(options.standardErrorPath ?? path.join(logDirectory, `${label}.stderr.log`), 'launchd stderr path');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key><array><string>${xml(program)}</string></array>
  <key>WorkingDirectory</key><string>${xml(workingDirectory)}</string>
  <key>EnvironmentVariables</key><dict><key>TACHIKO_NODE_PROGRAM</key><string>${xml(nodeProgram)}</string><key>TACHIKO_PNPM_PROGRAM</key><string>${xml(pnpmProgram)}</string><key>TACHIKO_GIT_PROGRAM</key><string>${xml(gitProgram)}</string><key>TACHIKO_PNPM_DEPENDENCY_ARTIFACT</key><string>${xml(dependencyArtifactPath)}</string><key>TACHIKO_LUNA_CODEX_HOME</key><string>${xml(lunaCodexHome)}</string><key>TACHIKO_PLAYWRIGHT_BROWSERS_PATH</key><string>${xml(playwrightBrowsersPath)}</string><key>TACHIKO_EXECUTION_PROFILE_CONFIG</key><string>${xml(JSON.stringify(PRODUCTION_EXECUTION_PROFILE_CONFIG))}</string><key>TACHIKO_LOCAL_VALIDATION_CONFIG</key><string>${xml(JSON.stringify(PRODUCTION_LOCAL_VALIDATION_CONFIG))}</string><key>TACHIKO_HOSTED_CHECK_POLICY_CONFIG</key><string>${xml(JSON.stringify(PRODUCTION_HOSTED_CHECK_POLICY_CONFIG))}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(stdout)}</string>
  <key>StandardErrorPath</key><string>${xml(stderr)}</string>
</dict>
</plist>
`;
}
