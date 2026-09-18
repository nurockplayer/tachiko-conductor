// Spike-only executable evidence; never merge into production runtime.
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';

const execFileP = promisify(execFile);
const ROOT = process.cwd();
const RUNTIME_DIR = process.env.ISSUE70_RUNTIME_DIR;
const BASE_SHA = process.env.ISSUE70_BASE_SHA;
const RUNNER_TEMP = process.env.RUNNER_TEMP;
const GITHUB_RUN_ID = process.env.GITHUB_RUN_ID ?? 'local';
if (!RUNTIME_DIR || !BASE_SHA || !RUNNER_TEMP) throw new Error('missing ISSUE70_RUNTIME_DIR / ISSUE70_BASE_SHA / RUNNER_TEMP');

const requireRuntime = createRequire(join(RUNTIME_DIR, 'package.json'));
const sdkEntry = requireRuntime.resolve('@agentclientprotocol/sdk');
const sdk = await import(pathToFileURL(sdkEntry).href);
const { client: createAcpClientApp, methods, ndJsonStream, PROTOCOL_VERSION } = sdk;
const dshPackagePath = requireRuntime.resolve('@deepseek-ai/dsh/package.json');
const dshPackage = JSON.parse(readFileSync(dshPackagePath, 'utf8'));
const DSH_BIN = join(dirname(dshPackagePath), dshPackage.bin.dsh);
const { GitWorktreeBootstrap } = await import(pathToFileURL(join(ROOT, 'dist/workspace/git-worktree-bootstrap.js')).href);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const nowIso = () => new Date().toISOString();
const sanitizeUpdate = update => ({
  sessionUpdate: update?.sessionUpdate,
  toolCallId: update?.toolCallId,
  status: update?.status,
  kind: update?.kind,
});

function messageStart() {
  return {
    type: 'message_start',
    message: { id: `msg_issue70_${Date.now()}`, model: 'issue70-mock', usage: { input_tokens: 3, output_tokens: 0 } },
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
function toolCallChunks(callId, name, input) {
  return [
    messageStart(),
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: callId, name, input: {} } },
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
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const text = messages.map(m => messageText(m?.content)).join('\n');
  for (const id of ['ISSUE70_C1', 'ISSUE70_C2', 'ISSUE70_C3']) if (text.includes(id)) return id;
  return 'UNKNOWN';
}
function latestNonSystem(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return [...messages].reverse().find(m => m?.role !== 'system');
}

const commands = new Map();
const modelRequests = [];
const server = createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/messages') {
    res.statusCode = 404;
    res.end();
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const scenario = detectScenario(body);
  const requestRecord = { scenario, at: nowIso(), model: body.model, toolNames: Array.isArray(body.tools) ? body.tools.map(t => t?.name).filter(Boolean) : [] };
  modelRequests.push(requestRecord);
  const latest = latestNonSystem(body);
  const toolResults = Array.isArray(latest?.content) ? latest.content.filter(block => block?.type === 'tool_result') : [];
  let response;
  if (toolResults.length > 0) {
    response = textChunks(`LATE_SUCCESS_${scenario}`);
  } else {
    const command = commands.get(scenario);
    if (!command) {
      response = textChunks('NO_SCENARIO');
    } else {
      if (!requestRecord.toolNames.includes('bash')) throw new Error(`bash tool not advertised for ${scenario}`);
      response = toolCallChunks(`${scenario.toLowerCase()}-bash`, 'bash', { command });
    }
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const event of response) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
if (!address || typeof address === 'string') throw new Error('mock server has no TCP address');
const MODEL_BASE_URL = `http://127.0.0.1:${address.port}`;

const bootstrap = new GitWorktreeBootstrap({
  repositoryRoot: ROOT,
  workspaceRoot: join(RUNNER_TEMP, 'issue70-worktrees'),
});
const target = { owner: 'nurockplayer', repo: 'tachiko-conductor', issueNumber: 70 };

async function git(args, cwd = ROOT) {
  const { stdout } = await execFileP('git', args, { cwd, maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

async function prepareScenario(label) {
  const runId = `issue70-${label}-${GITHUB_RUN_ID}`.toLowerCase();
  const request = { runId, target, baseBranch: 'main', baseSha: BASE_SHA };
  const identity = await bootstrap.plan(request);
  await bootstrap.prepare({ ...request, existing: identity });
  const guard = bootstrap.guard(identity);
  await guard.assertValid('before-execution');
  return { identity, guard };
}

function allowOnce(params) {
  const option = params.options?.find(candidate => candidate.kind === 'allow_once');
  if (!option) return Promise.resolve({ outcome: { outcome: 'cancelled' } });
  return Promise.resolve({ outcome: { outcome: 'selected', optionId: option.optionId } });
}

function launchAcp(cwd, label) {
  const dshHome = join(RUNNER_TEMP, `issue70-dsh-${label}-${GITHUB_RUN_ID}`);
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
  const passthrough = new Readable({ read() {} });
  child.stdout.on('data', buffer => passthrough.push(buffer));
  child.stdout.on('end', () => passthrough.push(null));
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin),
    Readable.toWeb(passthrough),
  );
  const updates = [];
  const clientApp = createAcpClientApp({ name: 'tachiko-issue70-spike' })
    .onNotification(methods.client.session.update, ({ params }) => { updates.push({ at: nowIso(), ...sanitizeUpdate(params.update) }); })
    .onRequest(methods.client.session.requestPermission, ({ params }) => allowOnce(params));
  const connection = clientApp.connect(stream);
  const context = connection.agent;
  const client = {
    initialize: params => context.request(methods.agent.initialize, params),
    newSession: params => context.request(methods.agent.session.new, params),
    listSessions: params => context.request(methods.agent.session.list, params),
    resumeSession: params => context.request(methods.agent.session.resume, params),
    closeSession: params => context.request(methods.agent.session.close, params),
    prompt: params => context.request(methods.agent.session.prompt, params),
    cancel: params => context.notify(methods.agent.session.cancel, params),
  };
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  return {
    child, client, updates, stderr: () => stderr.join(''), connection,
    async close() {
      if (child.exitCode === null && child.signalCode === null) child.stdin.end();
      await Promise.race([exited, sleep(15_000).then(() => 'timeout')]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
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
  throw new Error(`timeout waiting for ${description}${lastError ? `: ${lastError}` : ''}`);
}

async function fileLineCount(path) {
  try { return (await readFile(path, 'utf8')).split('\n').filter(Boolean).length; }
  catch { return 0; }
}
async function readPid(path) {
  try {
    const value = Number((await readFile(path, 'utf8')).trim());
    return Number.isInteger(value) && value > 1 ? value : undefined;
  } catch { return undefined; }
}
async function processInfo(pid) {
  if (!pid) return { pid: null, alive: false };
  try {
    process.kill(pid, 0);
  } catch {
    return { pid, alive: false };
  }
  try {
    const script = 'import json,os,sys; p=int(sys.argv[1]); print(json.dumps({"pid":p,"ppid":int(os.popen(f"ps -o ppid= -p {p}").read().strip() or 0),"pgid":os.getpgid(p),"sid":os.getsid(p)}))';
    const { stdout } = await execFileP('python3', ['-c', script, String(pid)]);
    return { ...JSON.parse(stdout), alive: true };
  } catch (error) {
    return { pid, alive: true, inspectError: String(error) };
  }
}
async function fingerprint(workspace, marker) {
  let markerRecord = { exists: false, size: 0, sha256: null };
  try {
    const data = await readFile(join(workspace, marker));
    const meta = await stat(join(workspace, marker));
    markerRecord = { exists: true, size: meta.size, sha256: createHash('sha256').update(data).digest('hex') };
  } catch {}
  return {
    at: nowIso(),
    marker: markerRecord,
    head: await git(['rev-parse', 'HEAD'], workspace),
    status: await git(['status', '--porcelain=v1', '--untracked-files=all'], workspace),
  };
}
function sameMarkerFingerprint(a, b) {
  return a.marker.exists === b.marker.exists && a.marker.size === b.marker.size && a.marker.sha256 === b.marker.sha256 && a.head === b.head && a.status === b.status;
}
async function sleepUntil(epochMs) {
  const delay = epochMs - Date.now();
  if (delay > 0) await sleep(delay);
}
async function cleanupKnownPids(pids) {
  const unique = [...new Set(pids.filter(pid => Number.isInteger(pid) && pid > 1))];
  for (const pid of unique) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  await sleep(500);
  for (const pid of unique) { try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch {} }
}

function commandFor(kind, marker) {
  if (kind === 'c1') {
    return `printf '%s\\n' "$$" > .issue70-root.pid; while :; do printf 'c1 %s\\n' "$(date +%s)" >> ${marker}; sleep 1; done`;
  }
  const detached = kind === 'c3';
  const python = detached
    ? `import os,time\nfrom pathlib import Path\npid=os.fork()\nif pid>0: os._exit(0)\nos.setsid()\npid=os.fork()\nif pid>0: os._exit(0)\nPath('.issue70-writer.pid').write_text(str(os.getpid()))\nwith open('${marker}','a',buffering=1) as f:\n    while True:\n        f.write('c3 %d\\n' % int(time.time())); f.flush(); time.sleep(1)`
    : `import os,subprocess\nfrom pathlib import Path\nPath('.issue70-child.pid').write_text(str(os.getpid()))\np=subprocess.Popen(['bash','-c', 'printf "%s\\n" "$$" > .issue70-writer.pid; while :; do printf "c2 %s\\n" "$(date +%s)" >> ${marker}; sleep 1; done'])\np.wait()`;
  if (detached) {
    return `printf '%s\\n' "$$" > .issue70-root.pid; python3 - <<'PY'\n${python}\nPY\nwhile [ ! -s .issue70-writer.pid ]; do sleep 0.1; done; while :; do sleep 10; done`;
  }
  return `printf '%s\\n' "$$" > .issue70-root.pid; python3 - <<'PY'\n${python}\nPY`;
}

const evidence = {
  phaseA: {
    tachikoBaseSha: BASE_SHA,
    harnessPackage: { name: dshPackage.name, version: dshPackage.version, bin: dshPackage.bin.dsh },
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    acpSdkEntry: sdkEntry,
    launch: 'node <published @deepseek-ai/dsh lib/bin.js> --profile acp (stdio ACP)',
    cancelSurface: 'ACP session.cancel notification; correlated terminal evidence is prompt stopReason plus independent process/worktree observation',
    modelEndpoint: 'local deterministic DeepSeek Messages-compatible HTTP fixture; exercises real ACP/tool/shell/subprocess runtime without API credentials',
  },
  scenarios: [],
  stop: null,
};

async function runCancellationScenario(kind) {
  const scenarioId = `ISSUE70_${kind.toUpperCase()}`;
  const marker = `.issue70-${kind}.log`;
  const prepared = await prepareScenario(kind);
  commands.set(scenarioId, commandFor(kind, marker));
  const launched = launchAcp(prepared.identity.workspacePath, kind);
  let sessionId;
  const requestStartIndex = modelRequests.length;
  const scenario = {
    kind,
    scenarioId,
    workspaceBranch: prepared.identity.branch,
    workspacePathBasename: prepared.identity.workspacePath.split('/').slice(-2).join('/'),
    guardBefore: 'PASS',
    samples: [],
  };
  const knownPids = [];
  try {
    const initialized = await launched.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    scenario.capabilities = initialized.agentCapabilities;
    const created = await launched.client.newSession({ cwd: prepared.identity.workspacePath, mcpServers: [] });
    sessionId = created.sessionId;
    scenario.sessionId = sessionId;
    scenario.configOptions = (created.configOptions ?? []).map(option => ({ id: option.id, type: option.type, name: option.name }));
    scenario.listBefore = await launched.client.listSessions({ cwd: prepared.identity.workspacePath });
    const promptStartedAt = Date.now();
    const promptPromise = launched.client.prompt({ sessionId, prompt: [{ type: 'text', text: `${scenarioId}: execute the single requested shell tool and do not do anything else.` }] })
      .then(value => ({ ok: true, value, at: Date.now() }), error => ({ ok: false, error: String(error), at: Date.now() }));

    await waitFor(async () => (await fileLineCount(join(prepared.identity.workspacePath, marker))) >= 2, 30_000, `${kind} active mutation`);
    for (const file of ['.issue70-root.pid', '.issue70-child.pid', '.issue70-writer.pid']) {
      const pid = await readPid(join(prepared.identity.workspacePath, file));
      if (pid) knownPids.push(pid);
    }
    scenario.preCancelProcesses = await Promise.all(knownPids.map(processInfo));
    if (kind === 'c3' && !scenario.preCancelProcesses.some(record => record.alive && record.ppid === 1)) {
      throw new Error('C3 fixture did not establish a ppid=1 detached writer before cancellation');
    }
    const cancelAt = Date.now();
    scenario.promptStartedAt = new Date(promptStartedAt).toISOString();
    scenario.cancelAt = new Date(cancelAt).toISOString();
    await launched.client.cancel({ sessionId });
    await launched.client.cancel({ sessionId });
    scenario.cancelDispatch = 'two supported ACP session.cancel notifications sent (idempotence probe)';

    for (const seconds of [1, 5, 10, 30]) {
      await sleepUntil(cancelAt + seconds * 1000);
      const pids = [];
      for (const file of ['.issue70-root.pid', '.issue70-child.pid', '.issue70-writer.pid']) {
        const pid = await readPid(join(prepared.identity.workspacePath, file));
        if (pid) pids.push(pid);
      }
      const sample = {
        seconds,
        fingerprint: await fingerprint(prepared.identity.workspacePath, marker),
        processes: await Promise.all([...new Set(pids)].map(processInfo)),
        modelRequestCount: modelRequests.slice(requestStartIndex).filter(r => r.scenario === scenarioId).length,
      };
      scenario.samples.push(sample);
    }
    const promptOutcome = await Promise.race([promptPromise, sleep(5_000).then(() => ({ ok: false, error: 'prompt did not settle within 5s after +30s observation', at: Date.now() }))]);
    scenario.promptOutcome = promptOutcome.ok ? { ok: true, value: promptOutcome.value, settledMsAfterCancel: promptOutcome.at - cancelAt } : { ok: false, error: promptOutcome.error, settledMsAfterCancel: promptOutcome.at - cancelAt };
    scenario.updatesAfterCancel = launched.updates.filter(update => Date.parse(update.at) >= cancelAt).slice(-20);
    const stable = scenario.samples.slice(1).every(sample => sameMarkerFingerprint(scenario.samples[0].fingerprint, sample.fingerprint));
    const finalProcesses = scenario.samples.at(-1).processes;
    const orphanMutating = finalProcesses.some(record => record.alive) || !stable;
    const promptCancelled = promptOutcome.ok && promptOutcome.value?.stopReason === 'cancelled';
    const noLateModelReplay = scenario.samples.at(-1).modelRequestCount === 1;
    scenario.assessment = { stableFromPlus1ThroughPlus30: stable, allKnownProcessesQuiescentAtPlus30: finalProcesses.every(record => !record.alive), promptCancelled, noLateModelReplay };
    if (orphanMutating || !promptCancelled || !noLateModelReplay) {
      evidence.stop = { phase: 'C', scenario: kind, reason: orphanMutating ? 'supported cancellation failed descendant/worktree quiescence' : !promptCancelled ? 'prompt did not settle cancelled' : 'late model replay/request observed' };
      return false;
    }
    await launched.client.closeSession({ sessionId });
    scenario.close = 'PASS';
    return true;
  } finally {
    evidence.scenarios.push(scenario);
    if (evidence.stop) await cleanupKnownPids(knownPids);
    try { await launched.close(); } catch (error) { scenario.launchCloseError = String(error); }
    scenario.stderrTail = launched.stderr().slice(-4000).replace(/sk-[A-Za-z0-9_-]+/g, 'sk-[redacted]');
  }
}

try {
  for (const kind of ['c1', 'c2', 'c3']) {
    const pass = await runCancellationScenario(kind);
    if (!pass) break;
  }
} finally {
  await new Promise(resolve => server.close(resolve));
}

console.log('ISSUE70_EVIDENCE_BEGIN');
console.log(JSON.stringify(evidence, null, 2));
console.log('ISSUE70_EVIDENCE_END');
if (evidence.stop) process.exitCode = 70;
