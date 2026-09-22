import path from 'node:path';
import {
  PRODUCTION_EXECUTION_PROFILE_CONFIG,
  PRODUCTION_HOSTED_CHECK_POLICY_CONFIG,
  PRODUCTION_LOCAL_VALIDATION_CONFIG,
} from '../production-policy.js';

export const DEFAULT_DISPATCH_LAUNCHD_LABEL = 'io.tachiko.conductor.dispatch-driver';

export interface DispatchLaunchdOptions {
  readonly label?: string;
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
  const nodeProgram = absolute(options.nodeProgram, 'launchd node program');
  const pnpmProgram = absolute(options.pnpmProgram, 'launchd pnpm program');
  const gitProgram = absolute(options.gitProgram, 'launchd git program');
  const dependencyArtifactPath = absolute(options.dependencyArtifactPath, 'launchd dependency artifact path');
  const lunaCodexHome = absolute(options.lunaCodexHome, 'launchd Luna CODEX_HOME');
  const playwrightBrowsersPath = absolute(options.playwrightBrowsersPath, 'launchd Playwright browser artifact path');
  const workingDirectory = absolute(options.workingDirectory, 'launchd working directory');
  const stdout = absolute(options.standardOutPath ?? path.join(path.dirname(program), `${label}.stdout.log`), 'launchd stdout path');
  const stderr = absolute(options.standardErrorPath ?? path.join(path.dirname(program), `${label}.stderr.log`), 'launchd stderr path');
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
