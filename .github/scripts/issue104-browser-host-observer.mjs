// Diagnostic only: no browser command, client, retry or qualification credit.
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RECORD = 'TACHIKO_BROWSER_OBSERVER_V1 ';
const END = 'TACHIKO_BROWSER_OBSERVER_END_V1 ';
const MAX_RECORDS = 512;
const MAX_BYTES = 512 * 1024;
const MAX_LINE = 4096;
const MAX = 1_000_000_000;
const events = new Set(['ready', 'guard_failed', 'server_seen', 'ping_start', 'ping_settle', 'server_close_entry', 'backend_initialize_entry', 'backend_initialize_settle', 'backend_dispose_entry', 'tool_entry', 'tool_settle', 'context_seen', 'browser_seen', 'page_seen', 'selected_page', 'context_page', 'context_close', 'browser_disconnect', 'page_close', 'page_crash', 'page_main_frame_navigation']);
const numeric = new Set(['v', 'child', 'index', 'ms', 'server', 'backend', 'context', 'browser', 'page', 'sequence', 'pending', 'pendingAgeMs', 'initialized', 'disposed', 'observedActive', 'pageCount']);
const enums = { event: events, kind: new Set(['bootstrap', 'transient', 'health', 'other']), outcome: new Set(['fulfilled', 'rejected', 'threw']), phase: new Set(['before', 'after']), category: new Set(['guard', 'shape']) };
const booleans = new Set(['first', 'present']);
const bounded = (n) => Math.min(MAX, Math.max(0, n));

// Pure negative-selector seam; expected values are fixed by install(), not env routing.
export function matchesManagedChild(command, args, options, expected) {
  if (command !== expected.node || !Array.isArray(args) || args.length !== 14 || !args.every((value) => typeof value === 'string') || !options || typeof options !== 'object') return false;
  if (typeof args[0] !== 'string' || !/^--title=tachiko-browser-runtime-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(args[0])) return false;
  if (args[1] !== expected.cli || args[2] !== '--host' || args[3] !== '127.0.0.1' || args[4] !== '--port' || !/^[1-9][0-9]{0,4}$/.test(args[5]) || Number(args[5]) > 65535) return false;
  if (args[6] !== '--allowed-hosts' || args[7] !== `127.0.0.1:${args[5]},localhost:${args[5]}` || args[8] !== '--user-data-dir' || args[10] !== '--output-dir' || args[12] !== '--shared-browser-context' || args[13] !== '--headless') return false;
  if (typeof args[9] !== 'string' || typeof args[11] !== 'string') return false;
  const root = path.dirname(path.dirname(args[9]));
  if (path.dirname(root) !== path.resolve(expected.tmp) || !/^tachiko-browser-bootstrap-integration-[A-Za-z0-9]{6}$/.test(path.basename(root))) return false;
  if (args[9] !== path.join(root, 'profiles', 'bootstrap') || args[11] !== path.join(root, 'runtimes', 'bootstrap-output') || options.cwd !== path.join(root, 'runtimes')) return false;
  return Array.isArray(options.stdio) && options.stdio.length === 3 && options.stdio[0] === 'pipe' && options.stdio[1] === 'ignore' && options.stdio[2] === 'ignore' && options.env !== null && typeof options.env === 'object' && options.env.PLAYWRIGHT_MCP_PING_TIMEOUT_MS === '100';
}

function validRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.v !== 1 || value.child !== 1 || !events.has(value.event)) return false;
  if (!Number.isSafeInteger(value.index) || value.index < 1 || value.index > MAX_RECORDS || !Number.isSafeInteger(value.ms) || value.ms < 0 || value.ms > MAX) return false;
  return Object.entries(value).every(([key, field]) => numeric.has(key)
    ? Number.isSafeInteger(field) && field >= (key === 'observedActive' ? -MAX_RECORDS : 0) && field <= MAX
    : Object.hasOwn(enums, key) ? enums[key].has(field) : booleans.has(key) && typeof field === 'boolean');
}

let selected = 0;
let ended = false;
let summary;
function output(marker, value) { try { process.stdout.write(marker + JSON.stringify(value) + '\n'); } catch {} }
function finish() {
  if (ended) return;
  ended = true;
  if (!summary) {
    output('BROWSER_DIAGNOSTIC_END ', { v: 1, child: 0, selected: 0, records: 0, sha256: createHash('sha256').digest('hex'), complete: false, missingReady: true });
    return;
  }
  summary();
}
process.once('exit', finish);

function install(candidate) {
  const require = createRequire(path.join(realpathSync(candidate), 'src/browser/playwright-mcp-runtime.ts'));
  const cli = realpathSync(path.join(path.dirname(require.resolve('@playwright/mcp')), 'cli.js'));
  const expected = { node: process.execPath, cli, tmp: os.tmpdir() };
  const preload = fileURLToPath(new URL('./issue104-browser-server-observer.cjs', import.meta.url));
  const original = childProcess.spawn;
  childProcess.spawn = function(command, args, options) {
    if (selected !== 0 || !matchesManagedChild(command, args, options, expected)) return Reflect.apply(original, this, arguments);
    // Preserve functional argv, env/cwd/stdin and original returned ChildProcess.
    const child = Reflect.apply(original, this, [command, ['--import', preload, ...args], { ...options, stdio: ['pipe', 'ignore', 'pipe'] }]);
    selected += 1;
    let bytes = 0, records = 0, invalid = 0, discarded = 0, lineOverflow = 0, streamErrors = 0;
    let closed = false, streamEnded = false, ready = false, overBytes = false, buffer = '', oversizedLine = false;
    let childEnd;
    let exit = 'unknown';
    const hash = createHash('sha256');
    const count = (value) => bounded(value + 1);
    function line(raw) {
      if (raw.startsWith(RECORD)) {
        let value;
        try { value = JSON.parse(raw.slice(RECORD.length)); } catch { invalid = count(invalid); return; }
        if (!validRecord(value) || value.index !== records + 1 || records >= MAX_RECORDS || childEnd) { invalid = count(invalid); return; }
        const payload = JSON.stringify(value);
        if (payload !== raw.slice(RECORD.length)) { invalid = count(invalid); return; }
        records += 1; ready ||= value.event === 'ready';
        hash.update(payload + '\n'); output('BROWSER_DIAGNOSTIC_RECORD ', value);
      } else if (raw.startsWith(END)) {
        let value;
        try { value = JSON.parse(raw.slice(END.length)); } catch { invalid = count(invalid); return; }
        const keys = ['v', 'records', 'sha256', 'dropped', 'observerErrors', 'missingShapes', 'listenersRemoved'];
        if (childEnd || !value || Object.keys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(value, key)) || value.v !== 1 || !/^[0-9a-f]{64}$/.test(value.sha256) || typeof value.listenersRemoved !== 'boolean' || !['records', 'dropped', 'observerErrors', 'missingShapes'].every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= MAX)) { invalid = count(invalid); return; }
        childEnd = value;
      } else { discarded = count(discarded); }
    }
    summary = () => {
      const sha256 = hash.digest('hex');
      const digestMatches = !!childEnd && childEnd.sha256 === sha256 && childEnd.records === records;
      output('BROWSER_DIAGNOSTIC_END ', { v: 1, child: 1, selected, records, sha256, rawBytes: bytes, invalid, discarded, lineOverflow, streamErrors, byteOverflow: overBytes, partialLine: buffer.length !== 0 || oversizedLine, closed, streamEnded, exit, childEndSeen: !!childEnd, missingReady: !ready, dropped: childEnd?.dropped ?? 0, observerErrors: childEnd?.observerErrors ?? 0, missingShapes: childEnd?.missingShapes ?? 0, listenersRemoved: childEnd?.listenersRemoved ?? false, digestMatches, complete: closed && streamEnded && ready && digestMatches && !overBytes && !invalid && !lineOverflow && !streamErrors && !buffer && !oversizedLine && childEnd.dropped === 0 && childEnd.observerErrors === 0 && childEnd.missingShapes === 0 && childEnd.listenersRemoved });
    };
    if (!child.stderr) { streamErrors += 1; }
    else {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        // Always drain. Never retain or print unrecognized stderr content.
        bytes = bounded(bytes + Buffer.byteLength(chunk));
        if (overBytes || bytes > MAX_BYTES) { overBytes = true; buffer = ''; return; }
        for (const character of chunk) {
          if (character === '\n') {
            if (!oversizedLine) line(buffer);
            buffer = ''; oversizedLine = false;
          } else if (!oversizedLine) {
            if (Buffer.byteLength(buffer) + Buffer.byteLength(character) > MAX_LINE) { lineOverflow = count(lineOverflow); buffer = ''; oversizedLine = true; }
            else buffer += character;
          }
        }
      });
      child.stderr.once('error', () => { streamErrors = count(streamErrors); });
      child.stderr.once('end', () => { streamEnded = true; });
    }
    child.once('error', () => { streamErrors = count(streamErrors); });
    child.once('close', (code, signal) => { closed = true; exit = signal ? 'signal' : code === 0 ? 'zero' : typeof code === 'number' ? 'nonzero' : 'unknown'; finish(); });
    return child;
  };
  syncBuiltinESMExports();
}
// Explicit host --import is inherited by Node test workers, never forwarded as
// NODE_OPTIONS or an extra child command. No candidate means no interception.
if (process.env.Q_BROWSER_CANDIDATE !== undefined) install(process.env.Q_BROWSER_CANDIDATE);
