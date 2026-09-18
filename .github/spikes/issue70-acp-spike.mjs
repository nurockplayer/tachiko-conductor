// Spike-only executable evidence for Issue 70. Never merge into production runtime.
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';

const execFileP = promisify(execFile);
const ROOT = process.cwd();
const RUNTIME_DIR = process.env.ISSUE70_RUNTIME_DIR;
const TACHIKO_BASE_SHA = process.env.ISSUE70_BASE_SHA;
const HARNESS_COMMIT = process.env.ISSUE70_HARNESS_COMMIT ?? 'unknown';
const HARNESS_TAG = process.env.ISSUE70_HARNESS_TAG ?? 'unknown';
const RUNNER_TEMP = process.env.RUNNER_TEMP ?? '/tmp';
const RUN_ID = process.env.GITHUB_RUN_ID ?? `local-${process.pid}`;
if (!RUNTIME_DIR || !TACHIKO_BASE_SHA) throw new Error('missing ISSUE70_RUNTIME_DIR / ISSUE70_BASE_SHA');

const requireRuntime = createRequire(join(RUNTIME_DIR, 'package.json'));
const sdkEntry = requireRuntime.resolve('@agentclientprotocol/sdk');
const sdk = await import(pathToFileURL(sdkEntry).href);
const { client: createAcpClientApp, methods, ndJsonStream, PROTOCOL_VERSION } = sdk;
const dshPackagePath = requireRuntime.resolve('@deepseek-ai/dsh/package.json');
const dshPackage = JSON.parse(readFileSync(dshPackagePath, 'utf8'));
const DSH_BIN = join(dirname(dshPackagePath), dshPackage.bin.dsh);
const { GitWorktreeBootstrap } = await import(pathToFileURL(join(ROOT, 'dist/workspace/git-worktree-bootstrap.js')).href);
const { NodeProcessRunner } = await import(pathToFileURL(join(ROOT, 'dist/github/transport.js')).href);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const nowIso = () => new Date().toISOString();
function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}
const SAMPLE_SECONDS = [1, 5, 10, 30];
const COMMANDS = new Map();
const MODEL_REQUESTS = [];

function messageStart() {
  return {
    type: 'message_start',
    message: { id: `msg_issue70_${Date.now()}`, model: 'issue70-local-fixture', usage: { input_tokens: 3, output_tokens: 0 } },
  };
}
function textChunks(text) {
  return [
    messageStart(),
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ];
}
function toolCallChunks(callId, input) {
  return [
    messageStart(),
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: callId, name: 'bash', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ];
}
function messageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(block => block && typeof block === 'object' && typeof block.text === 'string').map(block => block.text).join('');
}
function detectScenario(body) {
  const text = (Array.isArray(body.messages) ? body.messages : []).map(message => messageText(message?.content)).join('\n');
  for (const id of ['B1', 'C1', 'C2', 'C3', 'E1']) if (text.includes(`ISSUE70_${id}`)) return id;
  return 'UNKNOWN';
}
function latestNonSystem(body) {
  return [...(Array.isArray(body.messages) ? body.messages : [])].reverse().find(message => message?.role !== 'system');
}

const modelServer = createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/messages') {
    response.statusCode = 404;
    response.end();
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const scenario = detectScenario(body);
  const latest = latestNonSystem(body);
  const toolResults = Array.isArray(latest?.content) ? latest.content.filter(block => block?.type === 'tool_result') : [];
  MODEL_REQUESTS.push({ at: nowIso(), scenario, model: body.model, hasToolResult: toolResults.length > 0 });
  let events;
  if (toolResults.length > 0) {
    events = textChunks(scenario === 'B1' ? 'PHASE_B_COMPLETE' : `LATE_SUCCESS_${scenario}`);
  } else {
    const command = COMMANDS.get(scenario);
    events = command === undefined ? textChunks(`NO_SCENARIO_${scenario}`) : toolCallChunks(`${scenario.toLowerCase()}-bash`, { command, description: `Run bounded Issue 70 ${scenario} shell fixture` });
  }
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
});
await new Promise((resolve, reject) => {
  modelServer.once('error', reject);
  modelServer.listen(0, '127.0.0.1', resolve);
});
const modelAddress = modelServer.address();
if (!modelAddress || typeof modelAddress === 'string') throw new Error('mock model server has no TCP address');
const MODEL_BASE_URL = `http://127.0.0.1:${modelAddress.port}`;

class GitHubIdentityRunner {
  constructor(delegate = new NodeProcessRunner()) { this.delegate = delegate; }
  async run(file, args, options) {
    const command = args.join(' ');
    if (file === 'git' && command === 'remote get-url origin') {
      return { stdout: 'git@github.com:acme/widgets.git\n', stderr: '', exitCode: 0 };
    }
    if (file === 'git' && command === 'remote get-url --all --push origin') {
      return { stdout: 'git@github.com:acme/widgets.git\n', stderr: '', exitCode: 0 };
    }
    return this.delegate.run(file, args, options);
  }
}

async function runCommand(file, args, cwd) {
  const { stdout } = await execFileP(file, args, { cwd, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' });
  return stdout.trim();
}

let fixture;
async function createFixture() {
  const root = join(RUNNER_TEMP, `tachiko-70-fixture-${RUN_ID}-${Date.now()}`);
  const remote = join(root, 'remote.git');
  const source = join(root, 'source');
  const workspaceRoot = join(root, 'workspaces');
  mkdirSync(root, { recursive: true });
  await runCommand('git', ['init', '--bare', remote], root);
  mkdirSync(source);
  await runCommand('git', ['init', '-b', 'main'], source);
  writeFileSync(join(source, 'README.md'), 'Issue 70 fixture base\n');
  await runCommand('git', ['config', 'user.name', 'Tachiko'], source);
  await runCommand('git', ['config', 'user.email', 'tachiko@example.invalid'], source);
  await runCommand('git', ['add', 'README.md'], source);
  await runCommand('git', ['commit', '-m', 'fixture base'], source);
  await runCommand('git', ['remote', 'add', 'origin', `file://${remote}`], source);
  await runCommand('git', ['push', '-u', 'origin', 'main'], source);
  const baseSha = await runCommand('git', ['rev-parse', 'HEAD'], source);
  return { root, remote, source, workspaceRoot, baseSha };
}

const bootstrap = () => new GitWorktreeBootstrap({
  repositoryRoot: fixture.source,
  workspaceRoot: fixture.workspaceRoot,
  runner: new GitHubIdentityRunner(),
});
const target = { owner: 'acme', repo: 'widgets', issueNumber: 70 };

async function prepareScenario(bootstrapAdapter, label) {
  const runId = `i70-${label}-${RUN_ID}`.toLowerCase().replace(/[^a-z0-9._-]/g, '-');
  const request = { runId, target, baseBranch: 'main', baseSha: fixture.baseSha };
  const identity = await bootstrapAdapter.plan(request);
  await bootstrapAdapter.prepare({ ...request, existing: identity });
  const guard = bootstrapAdapter.guard(identity);
  await guard.assertValid('before-execution');
  return { identity, guard, request };
}

function sanitizeUpdate(update) {
  return {
    sessionUpdate: update?.sessionUpdate,
    toolCallId: update?.toolCallId,
    status: update?.status,
    kind: update?.kind,
  };
}

function launchAcp(cwd, label, dshHome) {
  const child = spawn(process.execPath, [DSH_BIN, '--profile', 'acp'], {
    cwd,
    env: {
      ...process.env,
      DSH_HOME: dshHome,
      DSH_AGENTS_HOME: join(dshHome, 'agents'),
      DSH_TELEMETRY_DISABLED: '1',
      DSH_PERMISSION_MODE: 'workspace-write',
      DEEPSEEK_API_KEY: 'sk-issue70-local-fixture',
      DEEPSEEK_BASE_URL: MODEL_BASE_URL,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stderr = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => stderr.push(chunk));
  const stdout = new Readable({ read() {} });
  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stdout.on('end', () => stdout.push(null));
  const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(stdout));
  const updates = [];
  const clientApp = createAcpClientApp({ name: 'tachiko-issue70-spike' })
    .onNotification(methods.client.session.update, ({ params }) => updates.push({ at: nowIso(), ...sanitizeUpdate(params.update) }))
    .onRequest(methods.client.session.requestPermission, ({ params }) => {
      const option = params.options?.find(candidate => candidate.kind === 'allow_once');
      return Promise.resolve(option === undefined ? { outcome: { outcome: 'cancelled' } } : { outcome: { outcome: 'selected', optionId: option.optionId } });
    });
  const connection = clientApp.connect(stream);
  const agent = connection.agent;
  const client = {
    initialize: params => withTimeout(agent.request(methods.agent.initialize, params), 30_000, 'initialize'),
    newSession: params => withTimeout(agent.request(methods.agent.session.new, params), 30_000, 'session/new'),
    listSessions: params => withTimeout(agent.request(methods.agent.session.list, params), 15_000, 'session/list'),
    resumeSession: params => withTimeout(agent.request(methods.agent.session.resume, params), 30_000, 'session/resume'),
    closeSession: params => withTimeout(agent.request(methods.agent.session.close, params), 30_000, 'session/close'),
    prompt: params => withTimeout(agent.request(methods.agent.session.prompt, params), 60_000, 'session/prompt'),
    cancel: params => withTimeout(agent.notify(methods.agent.session.cancel, params), 5_000, 'session/cancel'),
  };
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal, at: Date.now() })));
  return {
    child, client, updates, connection, exited,
    stderr: () => stderr.join('').slice(-4000).replace(/sk-[A-Za-z0-9_-]+/g, 'sk-[redacted]'),
    async disconnect(labelForLog) {
      if (child.exitCode === null && child.signalCode === null) child.stdin.end();
      const result = await Promise.race([exited, sleep(15_000).then(() => ({ timeout: true }))]);
      if (result.timeout) child.kill('SIGKILL');
      return { at: nowIso(), mode: 'client-stdin-eof', result };
    },
    async close() {
      if (child.exitCode === null && child.signalCode === null) child.stdin.end();
      const result = await Promise.race([exited, sleep(15_000).then(() => ({ timeout: true }))]);
      if (result.timeout) child.kill('SIGKILL');
      return result;
    },
  };
}

async function waitFor(predicate, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) { lastError = error; }
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${description}${lastError === undefined ? '' : `: ${lastError}`}`);
}
async function sleepUntil(epochMs) {
  const delay = epochMs - Date.now();
  if (delay > 0) await sleep(delay);
}
async function readText(path) {
  try { return await readFile(path, 'utf8'); } catch { return ''; }
}
async function fileLineCount(path) {
  return (await readText(path)).split('\n').filter(Boolean).length;
}
async function readPid(path) {
  const value = Number((await readText(path)).trim());
  return Number.isInteger(value) && value > 1 ? value : undefined;
}
async function readKnownPids(workspace) {
  const pids = [];
  for (const name of ['.issue70-root.pid', '.issue70-child.pid', '.issue70-writer.pid']) {
    const pid = await readPid(join(workspace, name));
    if (pid !== undefined) pids.push(pid);
  }
  return [...new Set(pids)];
}
async function processInfo(pid) {
  if (pid === undefined) return { pid: null, alive: false };
  try { process.kill(pid, 0); } catch { return { pid, alive: false }; }
  try {
    const { stdout } = await execFileP('/bin/ps', ['-o', 'pid=,ppid=,pgid=,sess=,stat=,lstart=', '-p', String(pid)], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    const line = stdout.trim();
    if (line === '') return { pid, alive: false };
    const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/u.exec(line);
    if (match === null) return { pid, alive: true, inspectError: 'unparseable ps row' };
    const [, pidText, ppidText, pgidText, sessText, state, started] = match;
    const zombie = /^[ZXx]/u.test(state);
    return { pid: Number(pidText), ppid: Number(ppidText), pgid: Number(pgidText), sess: Number(sessText), state, started, alive: !zombie, zombie };
  } catch (error) {
    return { pid, alive: true, inspectError: String(error) };
  }
}
async function cleanupKnownPids(records) {
  const unique = [...new Map(records.filter(record => record?.alive && record.pid && record.started).map(record => [record.pid, record])).values()];
  const results = [];
  for (const record of unique) {
    const current = await processInfo(record.pid);
    if (current.alive && current.started === record.started) {
      try { process.kill(record.pid, 'SIGTERM'); results.push({ pid: record.pid, signal: 'SIGTERM' }); } catch (error) { results.push({ pid: record.pid, signal: 'SIGTERM', error: String(error) }); }
    }
  }
  await sleep(500);
  for (const record of unique) {
    const current = await processInfo(record.pid);
    if (current.alive && current.started === record.started) {
      try { process.kill(record.pid, 'SIGKILL'); results.push({ pid: record.pid, signal: 'SIGKILL' }); } catch (error) { results.push({ pid: record.pid, signal: 'SIGKILL', error: String(error) }); }
    }
  }
  await sleep(250);
  const after = await Promise.all(unique.map(record => processInfo(record.pid)));
  return { attempted: results, after, residual: after.filter(record => record.alive) };
}

async function walkFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === '.git') continue;
    const full = join(current, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(root, full));
    else if (entry.isFile()) {
      const meta = await stat(full);
      const data = await readFile(full);
      files.push({ path: relative(root, full), mode: meta.mode & 0o777, size: data.length, sha256: createHash('sha256').update(data).digest('hex') });
    }
  }
  return files;
}
async function fingerprint(workspace) {
  const files = await walkFiles(workspace);
  const status = await runCommand('git', ['status', '--porcelain=v1', '--untracked-files=all'], workspace);
  const head = await runCommand('git', ['rev-parse', 'HEAD'], workspace);
  return {
    at: nowIso(),
    files,
    contentSha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
    head,
    status,
  };
}
function sameFingerprint(a, b) {
  return a.contentSha256 === b.contentSha256 && a.head === b.head && a.status === b.status;
}
async function takeSample(workspace, seconds, baseAt, cancelAt, closeAt) {
  const found = await fingerprint(workspace);
  const pids = await readKnownPids(workspace);
  return {
    seconds,
    at: nowIso(),
    afterBaseMs: Date.now() - baseAt,
    afterCancelMs: cancelAt === undefined ? null : Date.now() - cancelAt,
    afterCloseMs: closeAt === undefined ? null : Date.now() - closeAt,
    fingerprint: found,
    processes: await Promise.all(pids.map(processInfo)),
  };
}

async function phaseA(bootstrapAdapter) {
  const prepared = await prepareScenario(bootstrapAdapter, 'a1');
  const dshHome = join(RUNNER_TEMP, `issue70-dsh-a1-${RUN_ID}`);
  const first = launchAcp(prepared.identity.workspacePath, 'a1', dshHome);
  const result = { workspaceBranch: prepared.identity.branch, sessions: {} };
  let sessionId;
  try {
    const initialized = await first.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    result.initialize = { protocolVersion: initialized.protocolVersion, agentInfo: initialized.agentInfo, agentCapabilities: initialized.agentCapabilities, authMethods: initialized.authMethods };
    const created = await first.client.newSession({ cwd: prepared.identity.workspacePath, mcpServers: [] });
    sessionId = created.sessionId;
    result.sessions.created = { sessionId, configOptions: (created.configOptions ?? []).map(option => ({ id: option.id, type: option.type, name: option.name, currentValue: option.currentValue })) };
    result.sessions.listAfterCreate = await first.client.listSessions({ cwd: prepared.identity.workspacePath });
    await first.client.closeSession({ sessionId });
    result.sessions.close = 'PASS';
  } finally {
    await first.close();
  }
  const second = launchAcp(prepared.identity.workspacePath, 'a1-reconnect', dshHome);
  try {
    const initialized = await second.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    result.reconnectInitialize = { protocolVersion: initialized.protocolVersion, agentInfo: initialized.agentInfo };
    result.sessions.listAfterReconnect = await second.client.listSessions({ cwd: prepared.identity.workspacePath });
    try { await second.client.resumeSession({ sessionId, cwd: prepared.identity.workspacePath, mcpServers: [] }); result.sessions.resumeAfterReconnect = 'PASS'; }
    catch (error) { result.sessions.resumeAfterReconnect = { error: String(error) }; }
    try { await second.client.closeSession({ sessionId }); result.sessions.closeAfterResume = 'PASS'; }
    catch (error) { result.sessions.closeAfterResume = { error: String(error) }; }
  } finally {
    await second.close();
  }
  result.launch = 'node <@deepseek-ai/dsh bin> --profile acp; ACP JSON-RPC over stdio (ndJsonStream)';
  result.cancelSurface = 'session/cancel is an ACP notification; prompt settlement returns stopReason=cancelled';
  result.workspaceScoping = 'session/new requires absolute cwd; session/list accepts cwd filter; session/resume verifies canonical workspace';
  return result;
}

async function phaseB(bootstrapAdapter) {
  const prepared = await prepareScenario(bootstrapAdapter, 'b1');
  COMMANDS.set('B1', 'printf "phase-b\\n" > issue70-phase-b.txt && git add issue70-phase-b.txt && git -c user.name=Tachiko -c user.email=tachiko@example.invalid commit -m "issue70 phase b"');
  const dshHome = join(RUNNER_TEMP, `issue70-dsh-b1-${RUN_ID}`);
  const launched = launchAcp(prepared.identity.workspacePath, 'b1', dshHome);
  const startedAt = Date.now();
  const result = { workspaceBranch: prepared.identity.branch };
  try {
    const initialized = await launched.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    result.initialize = { protocolVersion: initialized.protocolVersion, agentCapabilities: initialized.agentCapabilities };
    const created = await launched.client.newSession({ cwd: prepared.identity.workspacePath, mcpServers: [] });
    result.sessionId = created.sessionId;
    const prompt = await launched.client.prompt({ sessionId: created.sessionId, prompt: [{ type: 'text', text: 'ISSUE70_B1 create exactly one marker file and commit it' }] });
    result.prompt = { stopReason: prompt.stopReason };
    result.wallTimeMs = Date.now() - startedAt;
    result.updateTypes = [...new Set(launched.updates.map(update => update.sessionUpdate).filter(Boolean))];
    result.modelRequests = MODEL_REQUESTS.filter(request => request.scenario === 'B1').length;
    await prepared.guard.assertValid('after-execution');
    result.guardAfter = 'PASS';
    const head = await runCommand('git', ['rev-parse', 'HEAD'], prepared.identity.workspacePath);
    const status = await runCommand('git', ['status', '--porcelain=v1', '--untracked-files=all'], prepared.identity.workspacePath);
    const diff = await runCommand('git', ['diff', '--name-status', prepared.identity.baseSha, head, '--'], prepared.identity.workspacePath);
    result.headSha = head;
    result.workspaceClean = status === '';
    result.changedFiles = diff.split('\n').filter(Boolean);
    await runCommand('git', ['push', 'origin', `HEAD:refs/heads/${prepared.identity.branch}`], prepared.identity.workspacePath);
    result.published = await runCommand('git', ['ls-remote', '--heads', 'origin', `refs/heads/${prepared.identity.branch}`], prepared.identity.workspacePath);
    result.verifyDurable = await bootstrapAdapter.verifyDurable({ identity: prepared.identity, expectedHeadSha: head, progressBaseSha: prepared.identity.baseSha, workspaceGuard: prepared.guard });
    await launched.client.closeSession({ sessionId: created.sessionId });
    result.close = 'PASS';
  } catch (error) {
    result.error = String(error);
  } finally {
    result.stderrTail = launched.stderr();
    await launched.close();
  }
  return result;
}

function cancellationCommand(kind, marker) {
  if (kind === 'C1') {
    return `printf '%s\\n' "$$" > .issue70-root.pid; while :; do printf 'C1 %s\\n' "$(date +%s)" >> ${marker}; sleep 1; done`;
  }
  if (kind === 'C2') {
    return `printf '%s\\n' "$$" > .issue70-root.pid; python3 - <<'PY'\nimport os, subprocess\nfrom pathlib import Path\nPath('.issue70-child.pid').write_text(str(os.getpid()))\np = subprocess.Popen(['bash', '-c', 'printf "%s\\\\n" "$$" > .issue70-writer.pid; while :; do printf "C2 %s\\\\n" "$(date +%s)" >> ${marker}; sleep 1; done'])\np.wait()\nPY`;
  }
  return `printf '%s\\n' "$$" > .issue70-root.pid; python3 - <<'PY'\nimport os, time\nfrom pathlib import Path\npid = os.fork()\nif pid > 0:\n    os._exit(0)\nos.setsid()\npid = os.fork()\nif pid > 0:\n    os._exit(0)\nPath('.issue70-writer.pid').write_text(str(os.getpid()))\nwith open('${marker}', 'a', buffering=1) as handle:\n    while True:\n        handle.write('C3 %d\\n' % int(time.time()))\n        handle.flush()\n        time.sleep(1)\nPY\nwhile [ ! -s .issue70-writer.pid ]; do sleep 0.1; done; while :; do sleep 10; done`;
}

async function cancellationScenario(bootstrapAdapter, kind) {
  const marker = `.issue70-${kind.toLowerCase()}.log`;
  const prepared = await prepareScenario(bootstrapAdapter, kind.toLowerCase());
  COMMANDS.set(kind, cancellationCommand(kind, marker));
  const dshHome = join(RUNNER_TEMP, `issue70-dsh-${kind.toLowerCase()}-${RUN_ID}`);
  const launched = launchAcp(prepared.identity.workspacePath, kind.toLowerCase(), dshHome);
  const result = { kind, workspaceBranch: prepared.identity.branch, guardBefore: 'PASS' };
  let sessionId;
  let knownPids = [];
  let closeAt;
  let cancelAt;
  let promptOutcome;
  try {
    const initialized = await launched.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    result.initialize = { protocolVersion: initialized.protocolVersion, agentCapabilities: initialized.agentCapabilities };
    const created = await launched.client.newSession({ cwd: prepared.identity.workspacePath, mcpServers: [] });
    sessionId = created.sessionId;
    result.sessionId = sessionId;
    result.configOptions = (created.configOptions ?? []).map(option => ({ id: option.id, type: option.type, name: option.name, currentValue: option.currentValue }));
    result.listBefore = await launched.client.listSessions({ cwd: prepared.identity.workspacePath });
    const promptPromise = launched.client.prompt({ sessionId, prompt: [{ type: 'text', text: `ISSUE70_${kind} execute only the requested shell tool and do not do anything else` }] })
      .then(value => ({ ok: true, value, at: Date.now() }), error => ({ ok: false, error: String(error), at: Date.now() }));
    await waitFor(async () => (await fileLineCount(join(prepared.identity.workspacePath, marker))) >= 2, 30_000, `${kind} active mutation`);
    knownPids = await readKnownPids(prepared.identity.workspacePath);
    result.preCancelProcesses = await Promise.all(knownPids.map(processInfo));
    if (kind === 'C3' && !result.preCancelProcesses.some(record => record.alive && record.ppid === 1)) {
      throw new Error('C3 fixture did not establish a ppid=1 detached writer before cancellation');
    }
    cancelAt = Date.now();
    result.cancelAt = nowIso();
    await launched.client.cancel({ sessionId });
    await launched.client.cancel({ sessionId });
    result.cancelDispatch = 'two session/cancel notifications sent';
    promptOutcome = await Promise.race([promptPromise, sleep(15_000).then(() => ({ ok: false, error: 'prompt did not settle within 15s after cancel', at: Date.now() }))]);
    result.promptOutcome = promptOutcome.ok ? { stopReason: promptOutcome.value?.stopReason, settledMsAfterCancel: promptOutcome.at - cancelAt } : { error: promptOutcome.error, settledMsAfterCancel: promptOutcome.at - cancelAt };
    try { await launched.client.closeSession({ sessionId }); closeAt = Date.now(); result.close = 'PASS'; }
    catch (error) { closeAt = Date.now(); result.close = { error: String(error) }; }
    const baseline = await fingerprint(prepared.identity.workspacePath);
    result.postCloseBaseline = { at: baseline.at, contentSha256: baseline.contentSha256, head: baseline.head, status: baseline.status, fileCount: baseline.files.length };
    const sampleBaseAt = Math.max(cancelAt, closeAt, promptOutcome.at);
    result.samples = [];
    let failure = null;
    for (const seconds of SAMPLE_SECONDS) {
      await sleepUntil(sampleBaseAt + seconds * 1000);
      const current = await takeSample(prepared.identity.workspacePath, seconds, sampleBaseAt, cancelAt, closeAt);
      result.samples.push(current);
      const alive = current.processes.filter(record => record.alive);
      if (!sameFingerprint(baseline, current.fingerprint)) {
        failure = 'worktree fingerprint changed after cancel+close';
        result.failureSample = { reason: failure, alive, current: { seconds, afterCancelMs: current.afterCancelMs, afterCloseMs: current.afterCloseMs, fingerprint: { contentSha256: current.fingerprint.contentSha256, head: current.fingerprint.head, status: current.fingerprint.status } } };
        break;
      }
      if (alive.length > 0) {
        failure = `known mutating process alive after cancel+close: ${JSON.stringify(alive)}`;
        result.failureSample = { reason: failure, alive };
        break;
      }
    }
    result.modelRequestCount = MODEL_REQUESTS.filter(request => request.scenario === kind).length;
    result.updatesAfterCancel = launched.updates.filter(update => Date.parse(update.at) >= cancelAt).slice(-20);
    result.assessment = {
      promptCancelled: promptOutcome.ok && promptOutcome.value?.stopReason === 'cancelled',
      closeSettled: result.close === 'PASS',
      fingerprintStableThroughObservedWindow: failure === null && result.samples.length === SAMPLE_SECONDS.length,
      knownProcessesQuiescent: result.samples.at(-1).processes.every(record => !record.alive),
      noPpid1MutatingOrphan: result.samples.at(-1).processes.every(record => !record.alive || record.ppid !== 1),
      noLateSuccessOrReplay: MODEL_REQUESTS.filter(request => request.scenario === kind).length === 1,
      cancelledNotSuccess: promptOutcome.ok && promptOutcome.value?.stopReason === 'cancelled',
    };
    result.assessment.stableCancelBoundary = failure === null && result.samples.length === SAMPLE_SECONDS.length && result.assessment.knownProcessesQuiescent && result.assessment.promptCancelled && result.assessment.noLateSuccessOrReplay && result.assessment.cancelledNotSuccess;
    try { await prepared.guard.assertValid('after-execution'); result.guardAfter = 'PASS'; }
    catch (error) { result.guardAfter = { expectedCancellationRejection: true, error: String(error) }; }
    if (failure !== null || !result.assessment.stableCancelBoundary) {
      throw new Error(failure ?? `cancellation assessment failed: ${JSON.stringify(result.assessment)}`);
    }
    return result;
  } catch (error) {
    result.error = String(error);
    return result;
  } finally {
    result.stderrTail = launched.stderr();
    if (result.error !== undefined) result.cleanup = await cleanupKnownPids(result.preCancelProcesses ?? []);
    await launched.close();
  }
}

async function phaseE(bootstrapAdapter) {
  const prepared = await prepareScenario(bootstrapAdapter, 'e1');
  const marker = '.issue70-e1.log';
  COMMANDS.set('E1', `printf '%s\\n' "$$" > .issue70-root.pid; while :; do printf 'E1 %s\\n' "$(date +%s)" >> ${marker}; sleep 1; done`);
  const dshHome = join(RUNNER_TEMP, `issue70-dsh-e1-${RUN_ID}`);
  const launched = launchAcp(prepared.identity.workspacePath, 'e1', dshHome);
  const result = { workspaceBranch: prepared.identity.branch };
  let sessionId;
  let knownPids = [];
  try {
    const initialized = await launched.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    result.initialize = { protocolVersion: initialized.protocolVersion, agentCapabilities: initialized.agentCapabilities };
    const created = await launched.client.newSession({ cwd: prepared.identity.workspacePath, mcpServers: [] });
    sessionId = created.sessionId;
    result.sessionId = sessionId;
    const promptPromise = launched.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'ISSUE70_E1 execute only the requested shell tool and do not do anything else' }] })
      .then(value => ({ ok: true, value, at: Date.now() }), error => ({ ok: false, error: String(error), at: Date.now() }));
    await waitFor(async () => (await fileLineCount(join(prepared.identity.workspacePath, marker))) >= 2, 30_000, 'E1 active mutation');
    knownPids = await readKnownPids(prepared.identity.workspacePath);
    result.preDisconnectProcesses = await Promise.all(knownPids.map(processInfo));
    const disconnectAt = Date.now();
    result.disconnect = await launched.disconnect('e1-active');
    result.disconnectAt = nowIso();
    const baseline = await fingerprint(prepared.identity.workspacePath);
    const baseAt = disconnectAt;
    result.samples = [];
    let failure = null;
    for (const seconds of SAMPLE_SECONDS) {
      await sleepUntil(baseAt + seconds * 1000);
      const current = await takeSample(prepared.identity.workspacePath, seconds, baseAt, undefined, disconnectAt);
      result.samples.push(current);
      const alive = current.processes.filter(record => record.alive);
      if (alive.length > 0) { failure = `known mutating process alive after ACP disconnect: ${JSON.stringify(alive)}`; break; }
      if (!sameFingerprint(baseline, current.fingerprint)) { failure = 'worktree fingerprint changed after ACP disconnect'; break; }
    }
    result.promptOutcome = await Promise.race([promptPromise, sleep(1000).then(() => ({ pending: true }))]);
    result.assessment = { fingerprintStableThroughObservedWindow: failure === null && result.samples.length === SAMPLE_SECONDS.length, knownProcessesQuiescent: result.samples.at(-1).processes.every(record => !record.alive), noLateMutation: failure === null };
    if (failure !== null) throw new Error(failure);
    const reconnected = launchAcp(prepared.identity.workspacePath, 'e1-reconnect', dshHome);
    try {
      const init2 = await reconnected.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
      result.reconnect = { protocolVersion: init2.protocolVersion };
      result.listAfterReconnect = await reconnected.client.listSessions({ cwd: prepared.identity.workspacePath });
      const listed = JSON.stringify(result.listAfterReconnect).includes(sessionId);
      result.sessionDurableAcrossReconnect = listed;
      if (listed) {
        try { await reconnected.client.resumeSession({ sessionId, cwd: prepared.identity.workspacePath, mcpServers: [] }); result.resume = 'PASS'; }
        catch (error) { result.resume = { error: String(error) }; }
        const beforeReplay = MODEL_REQUESTS.filter(request => request.scenario === 'E1').length;
        await sleep(1500);
        result.replayCountAfterResume = MODEL_REQUESTS.filter(request => request.scenario === 'E1').length - beforeReplay;
        const afterResume = await fingerprint(prepared.identity.workspacePath);
        result.mutationAfterResume = sameFingerprint(baseline, afterResume) ? 'none' : 'changed';
        try { await reconnected.client.closeSession({ sessionId }); result.closeAfterResume = 'PASS'; }
        catch (error) { result.closeAfterResume = { error: String(error) }; }
      } else {
        result.resume = 'session-not-listed';
      }
    } finally {
      await reconnected.close();
    }
    return result;
  } catch (error) {
    result.error = String(error);
    return result;
  } finally {
    result.stderrTail = launched.stderr();
    if (result.error !== undefined) result.cleanup = await cleanupKnownPids(result.preDisconnectProcesses ?? []);
    await launched.close();
  }
}

const evidence = {
  harness: {
    commit: HARNESS_COMMIT,
    tag: HARNESS_TAG,
    tachikoBaseSha: TACHIKO_BASE_SHA,
    platform: `${process.platform}/${process.arch}`,
    node: process.version,
    dshPackage: { name: dshPackage.name, version: dshPackage.version, bin: dshPackage.bin.dsh },
    acpSdk: JSON.parse(readFileSync(join(RUNTIME_DIR, 'node_modules/@agentclientprotocol/sdk/package.json'), 'utf8')).version,
  },
  phaseA: null,
  phaseB: null,
  phaseC: {},
  phaseD: { status: 'not_started' },
  phaseE: null,
  phaseF: { status: 'not_implemented', reason: 'bounded spike only; adapter requires safe B-E evidence and explicit follow-up approval' },
  stop: null,
  recommendation: null,
  cleanup: { fixture: 'not_started' },
};

let bootstrapAdapter;
try {
  fixture = await createFixture();
  bootstrapAdapter = bootstrap();
  evidence.fixture = { remote: 'local bare remote with GitHub identity double', baseSha: fixture.baseSha };
  evidence.phaseA = await phaseA(bootstrapAdapter);
  evidence.phaseB = await phaseB(bootstrapAdapter);
  if (evidence.phaseB.error !== undefined) {
    evidence.stop = { phase: 'B', reason: evidence.phaseB.error };
  } else {
    for (const kind of ['C1', 'C2', 'C3']) {
      const result = await cancellationScenario(bootstrapAdapter, kind);
      evidence.phaseC[kind] = result;
      if (result.error !== undefined) {
        evidence.stop = { phase: 'C', scenario: kind, reason: result.error, cleanup: result.cleanup ?? null };
        break;
      }
    }
  }
  if (evidence.stop === null) {
    evidence.phaseD = {
      status: 'PASS',
      cancelledPromptsNotSuccess: ['C1', 'C2', 'C3'].every(kind => evidence.phaseC[kind]?.assessment?.cancelledNotSuccess === true),
      noLateReplay: ['C1', 'C2', 'C3'].every(kind => evidence.phaseC[kind]?.assessment?.noLateSuccessOrReplay === true),
      duplicateCancelBounded: ['C1', 'C2', 'C3'].every(kind => evidence.phaseC[kind]?.cancelDispatch === 'two session/cancel notifications sent'),
      stableSessionCorrelation: ['C1', 'C2', 'C3'].every(kind => typeof evidence.phaseC[kind]?.sessionId === 'string'),
    };
    evidence.phaseE = await phaseE(bootstrapAdapter);
    if (evidence.phaseE.error !== undefined) evidence.stop = { phase: 'E', reason: evidence.phaseE.error, cleanup: evidence.phaseE.cleanup ?? null };
  } else {
    evidence.phaseD = { status: 'blocked', reason: 'C cancellation gate failed; no restart/replay probe attempted' };
    evidence.phaseE = { status: 'blocked', reason: 'C cancellation gate failed; no restart/replay probe attempted' };
  }
} catch (error) {
  evidence.stop = evidence.stop ?? { phase: 'harness', reason: String(error) };
} finally {
  await new Promise(resolve => modelServer.close(resolve));
  const residual = Object.values(evidence.phaseC).some(result => (result?.cleanup?.residual ?? []).length > 0) || (evidence.phaseE?.cleanup?.residual ?? []).length > 0;
  if (fixture !== undefined && !residual && evidence.stop === null) {
    rmSync(fixture.root, { recursive: true, force: true });
    evidence.cleanup.fixture = 'removed';
  } else if (fixture !== undefined && !residual) {
    rmSync(fixture.root, { recursive: true, force: true });
    evidence.cleanup.fixture = 'removed_after_known_pid_cleanup';
  } else if (fixture !== undefined) {
    evidence.cleanup.fixture = { retainedForSafety: fixture.root };
  }
}

if (evidence.stop === null) {
  const cPass = ['C1', 'C2', 'C3'].every(kind => evidence.phaseC[kind]?.assessment?.stableCancelBoundary === true);
  const ePass = evidence.phaseE?.assessment?.noLateMutation === true;
  evidence.recommendation = cPass && ePass ? 'ADOPT_DEEPSEEK_HARNESS' : 'ADOPT_WITH_BLOCKERS';
} else if (evidence.stop.phase === 'C' || evidence.stop.phase === 'E') {
  evidence.recommendation = 'REJECT_DEEPSEEK_HARNESS';
} else {
  evidence.recommendation = 'ADOPT_WITH_BLOCKERS';
}

console.log('ISSUE70_EVIDENCE_BEGIN');
console.log(JSON.stringify(evidence, null, 2));
console.log('ISSUE70_EVIDENCE_END');
if (evidence.stop !== null) process.exitCode = 70;
