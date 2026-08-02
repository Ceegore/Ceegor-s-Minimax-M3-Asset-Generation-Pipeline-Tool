// tests/unit/main/singleInstanceBoot.h049.test.js
// ============================================================================
// H-049 (_5 audit): the single-instance loser must NOT register any
// handlers, listeners, or module init — it calls app.quit() and returns
// immediately from the bootstrap IIFE.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'main', 'index.js'), 'utf8');

// Strip comment lines for negative assertions (avoid false positives
// from comments that mention the old pattern).
const CODE = SRC.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

// ---------------------------------------------------------------------------
// Source guards
// ---------------------------------------------------------------------------

test('H-049: boot is wrapped in an IIFE', () => {
  assert.match(SRC, /;\(function bootstrap\(\)\s*\{/, 'opening IIFE');
  assert.match(SRC, /\}\)\(\);\s*\/\/ end H-049 bootstrap IIFE/, 'closing IIFE');
});

test('H-049: lock check is the FIRST executable statement (before assetPaths)', () => {
  const lockIdx = CODE.indexOf('requestSingleInstanceLock()');
  const assetIdx = CODE.indexOf("require('../src/assetPaths')");
  assert.ok(lockIdx > 0, 'lock check must exist');
  assert.ok(assetIdx > 0, 'assetPaths init must exist');
  assert.ok(lockIdx < assetIdx,
    'requestSingleInstanceLock must precede assetPaths.init so the loser never touches paths');
});

test('H-049: lock check is before ipcMain.on and log rotation', () => {
  const lockIdx = CODE.indexOf('requestSingleInstanceLock()');
  const ipcOnIdx = CODE.indexOf("ipcMain.on(");
  assert.ok(lockIdx < ipcOnIdx, 'lock must precede ipcMain.on so the loser registers no listeners');
});

test('H-049: app.quit() + return in the fail branch (no else)', () => {
  // The fail branch must be: if (!lock) { app.quit(); return; }
  assert.match(CODE, /if\s*\(\s*!_gotSingleInstanceLock\s*\)\s*\{\s*app\.quit\(\);\s*return;/,
    'fail branch must call app.quit() then return immediately');
  // No else branch after the fail block (flat control flow).
  assert.doesNotMatch(CODE, /if\s*\(\s*!_gotSingleInstanceLock\s*\)\s*\{[^}]*\}\s*else/,
    'must NOT have an else branch — flat return instead');
});

test('H-049: second-instance handler is registered AFTER the lock check', () => {
  const lockIdx = CODE.indexOf('requestSingleInstanceLock()');
  const secondIdx = CODE.indexOf("app.on('second-instance'");
  assert.ok(secondIdx > lockIdx, 'second-instance handler must come after the lock guard');
});

// ---------------------------------------------------------------------------
// Functional: loser path
// ---------------------------------------------------------------------------

test('H-049: loser instance calls app.quit() and registers NOTHING', () => {
  const calls = { quit: 0, on: [], ipcOn: [], whenReady: 0, processOn: [] };
  const electronMock = {
    app: {
      isPackaged: false,
      getPath: () => path.join(ROOT, 'fake'),
      requestSingleInstanceLock: () => false, // LOSE the lock
      quit: () => { calls.quit++; },
      on: (evt) => { calls.on.push(evt); },
      whenReady: () => { calls.whenReady++; return new Promise(() => {}); },
      exit: () => {},
    },
    BrowserWindow: class {},
    ipcMain: { on: (evt) => { calls.ipcOn.push(evt); }, handle: () => {} },
    dialog: { showErrorBox: () => {} },
    shell: { openPath: async () => '' },
  };

  const origLoad = Module._load;
  Module._load = function (request, parent, ...rest) {
    if (request === 'electron') return electronMock;
    return origLoad.call(this, request, parent, ...rest);
  };
  try {
    delete require.cache[require.resolve(path.join(ROOT, 'main', 'index.js'))];
    require(path.join(ROOT, 'main', 'index.js'));
  } finally {
    Module._load = origLoad;
    delete require.cache[require.resolve(path.join(ROOT, 'main', 'index.js'))];
  }

  assert.equal(calls.quit, 1, 'app.quit() must be called exactly once');
  assert.equal(calls.whenReady, 0, 'whenReady must NOT be called in the loser');
  assert.equal(calls.ipcOn.length, 0, 'no ipcMain.on listeners in the loser');
  assert.equal(calls.on.length, 0, 'no app.on handlers in the loser');
});
