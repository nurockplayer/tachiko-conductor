'use strict';
// Exact-version diagnostic observer. Promise/listener/stdio observation perturbs
// scheduling; every result has ZERO qualification credit. No browser commands.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { performance } = require('node:perf_hooks');
const MAX_RECORDS = 512;
const MAX_BYTES = 512 * 1024 - 4096; // reserve room for the terminal scalar record
const MAX = 1_000_000_000;
const started = performance.now();
const hash = createHash('sha256');
let bytes = 0;
let records = 0, dropped = 0, observerErrors = 0, missingShapes = 0, finished = false;
const cleanup = new Set();
const maps = Object.fromEntries(['server', 'backend', 'browser', 'context', 'page'].map((kind) => [kind, new WeakMap()]));
const ordinals = { server: 0, backend: 0, browser: 0, context: 0, page: 0 };
const safe = (callback) => { try { return callback(); } catch { observerErrors = Math.min(MAX, observerErrors + 1); } };
const missing = () => { missingShapes = Math.min(MAX, missingShapes + 1); };
const ms = () => Math.min(MAX, Math.max(0, Math.round(performance.now() - started)));
function emit(event, fields = {}) {
  safe(() => {
    if (finished) return;
    if (records >= MAX_RECORDS) { dropped = Math.min(MAX, dropped + 1); return; }
    const value = { v: 1, child: 1, index: records + 1, event, ms: ms(), ...fields };
    const payload = JSON.stringify(value);
    // All callers pass fixed keys and bounded scalars, never argument/result data.
    if (Buffer.byteLength(payload) > 4096) { missing(); return; }
    const line = 'TACHIKO_BROWSER_OBSERVER_V1 ' + payload + '\n';
    if (bytes + Buffer.byteLength(line) > MAX_BYTES) { dropped = Math.min(MAX, dropped + 1); return; }
    fs.writeSync(2, line); bytes += Buffer.byteLength(line);
    hash.update(payload + '\n'); records += 1;
  });
}
function state(kind, object) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function')) { missing(); return; }
  let value = maps[kind].get(object);
  if (!value) {
    if (ordinals[kind] >= MAX_RECORDS) { missing(); return; }
    value = { id: ++ordinals[kind], listening: false };
    maps[kind].set(object, value);
  }
  return value;
}
function kindOf(name) {
  if (name === 'tachiko-browser-bootstrap') return 'bootstrap';
  if (name === 'tachiko-browser-integration-test') return 'transient';
  if (name === 'tachiko-browser-health') return 'health';
  return 'other';
}
function listeners(object, handlers) {
  if (typeof object.on !== 'function' || typeof object.removeListener !== 'function' || cleanup.size >= 2048) { missing(); return () => {}; }
  const attached = [];
  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    for (const [event, handler] of attached) safe(() => object.removeListener(event, handler));
    cleanup.delete(remove);
  };
  cleanup.add(remove);
  for (const [event, handler] of Object.entries(handlers)) {
    const guarded = (...args) => safe(() => {
      try { handler(...args); } finally { if (event === 'close' || event === 'disconnected') remove(); }
    });
    object.on(event, guarded); attached.push([event, guarded]);
  }
  return remove;
}
function observePage(page, contextId) {
  const entry = state('page', page);
  if (!entry || entry.listening) return entry?.id ?? 0;
  if (typeof page.mainFrame !== 'function') { missing(); return entry.id; }
  entry.listening = true;
  emit('page_seen', { context: contextId, page: entry.id });
  // Only identity comparison with the existing main frame; never URL/document reads.
  const mainFrame = page.mainFrame();
  listeners(page, {
    close: () => emit('page_close', { context: contextId, page: entry.id }),
    crash: () => emit('page_crash', { context: contextId, page: entry.id }),
    framenavigated: (frame) => { if (frame === mainFrame) emit('page_main_frame_navigation', { context: contextId, page: entry.id }); },
  });
  return entry.id;
}
function observeContext(context) {
  const entry = state('context', context);
  if (!entry) return;
  entry.initialized ??= 0; entry.disposed ??= 0;
  if (!entry.listening) {
    if (typeof context.pages !== 'function' || typeof context.browser !== 'function') { missing(); return entry; }
    entry.listening = true;
    emit('context_seen', { context: entry.id });
    const browser = context.browser();
    if (browser) {
      const browserEntry = state('browser', browser);
      if (browserEntry && !browserEntry.listening) {
        browserEntry.listening = true;
        emit('browser_seen', { browser: browserEntry.id });
        listeners(browser, { disconnected: () => emit('browser_disconnect', { browser: browserEntry.id }) });
      }
    } else { missing(); }
    listeners(context, {
      page: (page) => { const id = observePage(page, entry.id); emit('context_page', { context: entry.id, page: id }); },
      close: () => emit('context_close', { context: entry.id, initialized: entry.initialized, disposed: entry.disposed, observedActive: entry.initialized - entry.disposed }),
    });
  }
  const pages = context.pages();
  if (!Array.isArray(pages) || pages.length > MAX_RECORDS) { missing(); return entry; }
  for (const page of pages) observePage(page, entry.id);
  return entry;
}
function snapshot(backend, phase, requireContext) {
  const entry = state('backend', backend);
  const contextEntry = observeContext(backend._browserContext);
  if (!entry || !contextEntry) return;
  entry.context = contextEntry;
  let page;
  if (backend._context !== undefined) {
    if (typeof backend._context.currentTab !== 'function') { missing(); return; }
    page = backend._context.currentTab()?.page;
  } else if (requireContext) { missing(); }
  const pageId = page ? observePage(page, contextEntry.id) : 0;
  const pages = backend._browserContext.pages();
  if (!Array.isArray(pages) || pages.length > MAX_RECORDS) { missing(); return; }
  emit('selected_page', { backend: entry.id, context: contextEntry.id, page: pageId, present: !!page, phase, pageCount: pages.length });
}
function settled(result, yes, no) {
  // These three existing methods are awaited/Raced by real callers. Return the
  // ORIGINAL promise; only this observer branch handles its own observations.
  if (!(result instanceof Promise)) { missing(); return; }
  safe(() => Promise.prototype.then.call(result, () => { safe(yes); }, () => { safe(no); }));
}
function serverState(server) {
  const entry = state('server', server);
  if (!entry) return;
  if (!entry.pending) {
    entry.pending = new Map(); entry.sequence = 0;
    emit('server_seen', { server: entry.id, kind: kindOf(server.getClientVersion()?.name) });
  }
  return entry;
}
function pendingInfo(entry) {
  let oldest = ms();
  for (const began of entry.pending.values()) oldest = Math.min(oldest, began);
  return { pending: entry.pending.size, pendingAgeMs: entry.pending.size ? Math.max(0, ms() - oldest) : 0 };
}
function wrap(prototype, name, observe) {
  const original = prototype[name];
  const own = Object.getOwnPropertyDescriptor(prototype, name);
  if (typeof original !== 'function' || (own && (!own.writable || !own.configurable))) throw new Error('Observer method shape mismatch.');
  Object.defineProperty(prototype, name, { configurable: true, writable: true, enumerable: own?.enumerable ?? false,
    value: function(...args) { return observe.call(this, original, args); } });
}
process.once('exit', () => {
  safe(() => {
    for (const remove of [...cleanup]) remove();
    const listenersRemoved = cleanup.size === 0;
    finished = true;
    fs.writeSync(2, 'TACHIKO_BROWSER_OBSERVER_END_V1 ' + JSON.stringify({ v: 1, records, sha256: hash.digest('hex'), dropped, observerErrors, missingShapes, listenersRemoved }) + '\n');
  });
});

try {
  if (!process.env.Q_BROWSER_CANDIDATE || !path.isAbsolute(process.env.Q_BROWSER_CANDIDATE)) throw new Error('Observer candidate missing.');
  const candidate = fs.realpathSync(process.env.Q_BROWSER_CANDIDATE);
  const fromCandidate = createRequire(path.join(candidate, 'src/browser/playwright-mcp-runtime.ts'));
  const cli = fs.realpathSync(path.join(path.dirname(fromCandidate.resolve('@playwright/mcp')), 'cli.js'));
  if (!process.argv[1] || fs.realpathSync(process.argv[1]) !== cli) throw new Error('Observer child mismatch.');
  const fromCli = createRequire(cli);
  const corePath = fromCli.resolve('playwright-core/lib/coreBundle');
  const utilsPath = fromCli.resolve('playwright-core/lib/utilsBundle');
  const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
  if (readJson(path.join(path.dirname(cli), 'package.json')).version !== '0.0.79' || readJson(path.join(path.dirname(corePath), '..', 'package.json')).version !== '1.63.0-alpha-2026-08-05') throw new Error('Observer version mismatch.');
  const digest = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (digest(corePath) !== 'adf9246486a03bee08b2895db057ba470c62377911d291693fe783d91d6fec52' || digest(utilsPath) !== '580f571bf063e2256b51b3946a035bc452fc0e22808d5547b198baea39923a32') throw new Error('Observer bundle mismatch.');
  // Public export spellings and cache are the exact paths used by the MCP CLI.
  const { Server } = fromCli('playwright-core/lib/utilsBundle');
  const { tools } = fromCli('playwright-core/lib/coreBundle');
  const Backend = tools?.BrowserBackend;
  if (typeof Server !== 'function' || typeof Backend !== 'function' || typeof Server.prototype.ping !== 'function' || typeof Server.prototype.close !== 'function' || typeof Server.prototype.getClientVersion !== 'function' || !['initialize', 'dispose', 'callTool'].every((name) => typeof Backend.prototype[name] === 'function')) throw new Error('Observer export mismatch.');
  wrap(Server.prototype, 'ping', function(original, args) {
    const entry = safe(() => serverState(this));
    const sequence = entry ? Math.min(MAX, ++entry.sequence) : 0;
    safe(() => {
      if (!entry) return;
      if (entry.pending.size < MAX_RECORDS) entry.pending.set(sequence, ms()); else missing();
      emit('ping_start', { server: entry.id, kind: kindOf(this.getClientVersion()?.name), sequence });
    });
    let result;
    try { result = Reflect.apply(original, this, args); }
    catch (error) { safe(() => { entry?.pending.delete(sequence); emit('ping_settle', { server: entry?.id ?? 0, sequence, outcome: 'threw' }); }); throw error; }
    settled(result, () => { entry?.pending.delete(sequence); emit('ping_settle', { server: entry?.id ?? 0, sequence, outcome: 'fulfilled' }); }, () => { entry?.pending.delete(sequence); emit('ping_settle', { server: entry?.id ?? 0, sequence, outcome: 'rejected' }); });
    return result;
  });
  wrap(Server.prototype, 'close', function(original, args) {
    safe(() => { const entry = serverState(this); if (entry) emit('server_close_entry', { server: entry.id, kind: kindOf(this.getClientVersion()?.name), ...pendingInfo(entry) }); });
    // Do not observe returned settlement: preserve otherwise-unhandled rejection.
    return Reflect.apply(original, this, args);
  });
  wrap(Backend.prototype, 'initialize', function(original, args) {
    const entry = safe(() => state('backend', this));
    safe(() => { if (entry) entry.kind = kindOf(args[0]?.clientName); emit('backend_initialize_entry', { backend: entry?.id ?? 0, kind: entry?.kind ?? 'other' }); snapshot(this, 'before', false); });
    let result;
    try { result = Reflect.apply(original, this, args); }
    catch (error) { emit('backend_initialize_settle', { backend: entry?.id ?? 0, outcome: 'threw' }); throw error; }
    settled(result, () => {
      snapshot(this, 'after', true);
      if (entry?.context && !entry.initialized) { entry.initialized = true; entry.context.initialized += 1; }
      emit('backend_initialize_settle', { backend: entry?.id ?? 0, kind: entry?.kind ?? 'other', outcome: 'fulfilled', context: entry?.context?.id ?? 0, initialized: entry?.context?.initialized ?? 0, disposed: entry?.context?.disposed ?? 0, observedActive: (entry?.context?.initialized ?? 0) - (entry?.context?.disposed ?? 0) });
    }, () => emit('backend_initialize_settle', { backend: entry?.id ?? 0, outcome: 'rejected' }));
    return result;
  });
  wrap(Backend.prototype, 'dispose', function(original, args) {
    safe(() => {
      const entry = state('backend', this);
      if (!entry) return;
      const first = !entry.disposed; entry.disposed = true;
      if (first && entry.context) entry.context.disposed += 1;
      emit('backend_dispose_entry', { backend: entry.id, kind: entry.kind ?? 'other', first, context: entry.context?.id ?? 0, initialized: entry.context?.initialized ?? 0, disposed: entry.context?.disposed ?? 0, observedActive: (entry.context?.initialized ?? 0) - (entry.context?.disposed ?? 0) });
    });
    // First-entry counts are observation counts, NOT private factory clientCount.
    // No catch/then added to this original async method or its returned promise.
    return Reflect.apply(original, this, args);
  });
  wrap(Backend.prototype, 'callTool', function(original, args) {
    const entry = safe(() => state('backend', this));
    safe(() => { emit('tool_entry', { backend: entry?.id ?? 0, kind: entry?.kind ?? 'other' }); snapshot(this, 'before', true); });
    let result;
    try { result = Reflect.apply(original, this, args); }
    catch (error) { emit('tool_settle', { backend: entry?.id ?? 0, outcome: 'threw' }); throw error; }
    settled(result, () => { snapshot(this, 'after', true); emit('tool_settle', { backend: entry?.id ?? 0, outcome: 'fulfilled' }); }, () => { snapshot(this, 'after', true); emit('tool_settle', { backend: entry?.id ?? 0, outcome: 'rejected' }); });
    return result;
  });
  emit('ready');
} catch {
  emit('guard_failed', { category: 'guard' });
  throw new Error('Browser diagnostic observer readiness guard failed.');
}
