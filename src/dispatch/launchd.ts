import path from 'node:path';

export const DEFAULT_DISPATCH_LAUNCHD_LABEL = 'io.tachiko.conductor.dispatch-driver';

export interface DispatchLaunchdOptions {
  readonly label?: string;
  readonly program: string;
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
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(stdout)}</string>
  <key>StandardErrorPath</key><string>${xml(stderr)}</string>
</dict>
</plist>
`;
}
