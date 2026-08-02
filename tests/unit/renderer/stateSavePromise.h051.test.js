// tests/unit/renderer/stateSavePromise.h051.test.js
// ============================================================================
// H-051 (_5 audit): scheduleStateSave() must resolve with a TYPED result;
// cancelPendingStateSave() must deterministically resolve all waiters.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
const CODE = APP_SRC.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

// ---------------------------------------------------------------------------
// Source guards
// ---------------------------------------------------------------------------

test('H-051: _flushPendingStateSaveResolvers passes typed result to each resolver', () => {
  assert.match(CODE, /function _flushPendingStateSaveResolvers\(result\)/,
    'flush accepts a result parameter');
  assert.match(CODE, /r\(typed\)/, 'each resolver is called with the typed result');
});

test('H-051: success path passes { ok: true }', () => {
  assert.match(CODE, /_flushPendingStateSaveResolvers\(\{\s*ok:\s*true,\s*state:/,
    'sync success passes ok:true + state');
});

test('H-051: failure path passes { ok: false, error }', () => {
  assert.match(CODE, /_flushPendingStateSaveResolvers\(\{\s*ok:\s*false,\s*error:/,
    'failure passes ok:false + error string');
});

test('H-051: cancelPendingStateSave resolves waiters with canceled:true', () => {
  // Extract the cancelPendingStateSave function body (up to the next
  // `window.cancelPendingStateSave` assignment which follows it).
  const idx = CODE.indexOf('function cancelPendingStateSave()');
  assert.ok(idx > 0, 'cancelPendingStateSave must exist');
  const end = CODE.indexOf('window.cancelPendingStateSave', idx);
  const body = CODE.slice(idx, end);
  assert.match(body, /_flushPendingStateSaveResolvers\(\{\s*ok:\s*false,\s*canceled:\s*true\s*\}\)/,
    'cancel must flush waiters with {ok:false, canceled:true}');
});

// ---------------------------------------------------------------------------
// Functional tests (vm extraction)
// ---------------------------------------------------------------------------

function buildSandbox(saveAllStatesImpl, opts = {}) {
  // Minimal extraction of the debounce machinery.
  const sandbox = {
    _suppressStateSave: opts.suppress ? 1 : 0,
    _stateSaveTimer: null,
    _pendingStateSaveResolvers: [],
    saveAllStates: saveAllStatesImpl,
    window: { logAction: null },
    setTimeout: (fn, ms) => { sandbox._timerFn = fn; return 42; },
    clearTimeout: () => { sandbox._timerFn = null; },
    Promise,
    String,
    console,
  };
  // Extract the three functions from source.
  const schedStart = APP_SRC.indexOf('function scheduleStateSave() {');
  const cancelStart = APP_SRC.indexOf('function cancelPendingStateSave()');
  // The function ends just before the `window.cancelPendingStateSave` assignment.
  const cancelEnd = APP_SRC.indexOf('window.cancelPendingStateSave', cancelStart);
  const code = APP_SRC.slice(schedStart, cancelEnd);
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'app.js#h051', timeout: 3000 });
  return sandbox;
}

test('H-051: successful save resolves with { ok: true }', async () => {
  const sb = buildSandbox(() => ({ saved: true }));
  const p = vm.runInContext('scheduleStateSave()', sb);
  // Fire the debounce timer.
  sb._timerFn();
  const result = await p;
  assert.equal(result.ok, true);
  assert.deepEqual(result.state, { saved: true });
});

test('H-051: saveAllStates THROW resolves with { ok: false, error }', async () => {
  const sb = buildSandbox(() => { throw new Error('disk full'); });
  const p = vm.runInContext('scheduleStateSave()', sb);
  sb._timerFn();
  const result = await p;
  assert.equal(result.ok, false);
  assert.match(result.error, /disk full/);
});

test('H-051: async saveAllStates rejection resolves with { ok: false, error }', async () => {
  const sb = buildSandbox(() => Promise.reject(new Error('IPC timeout')));
  const p = vm.runInContext('scheduleStateSave()', sb);
  sb._timerFn();
  const result = await p;
  assert.equal(result.ok, false);
  assert.match(result.error, /IPC timeout/);
});

test('H-051: cancelPendingStateSave resolves waiters with { ok: false, canceled: true }', async () => {
  const sb = buildSandbox(() => ({ saved: true }));
  const p = vm.runInContext('scheduleStateSave()', sb);
  // Cancel BEFORE the timer fires.
  vm.runInContext('cancelPendingStateSave()', sb);
  const result = await p;
  assert.equal(result.ok, false);
  assert.equal(result.canceled, true);
});

test('H-051: multiple callers share the same write and result', async () => {
  let callCount = 0;
  const sb = buildSandbox(() => { callCount++; return { n: callCount }; });
  const p1 = vm.runInContext('scheduleStateSave()', sb);
  const p2 = vm.runInContext('scheduleStateSave()', sb);
  const p3 = vm.runInContext('scheduleStateSave()', sb);
  // Only ONE timer should be pending (debounce coalescing).
  sb._timerFn();
  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
  assert.equal(callCount, 1, 'saveAllStates called exactly once');
  assert.deepEqual(r1, r2, 'all callers get the same result');
  assert.deepEqual(r2, r3);
  assert.equal(r1.ok, true);
});

test('H-051: suppressed save returns immediately with typed result (source guard)', () => {
  // When _suppressStateSave > 0, scheduleStateSave returns
  // Promise.resolve({ ok: true, suppressed: true }) without scheduling.
  assert.match(CODE,
    /if\s*\(_suppressStateSave\s*>\s*0\)\s*return\s*Promise\.resolve\(\{\s*ok:\s*true,\s*suppressed:\s*true\s*\}\)/,
    'suppressed path must return a typed Promise.resolve without scheduling a timer');
});
