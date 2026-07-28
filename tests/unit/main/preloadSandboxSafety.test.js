// tests/unit/main/preloadSandboxSafety.test.js
// ============================================================================
// R7.5 — Regression guard for the sandboxed preload (P0#1).
//
// PRE-1 originally did `require('path')` at the top of preload.js. With
// `sandbox: true` (main/window/createMainWindow.js) a preload may only
// require a tiny allow-list of modules (`electron`, plus the `events`,
// `timers`, and `url` Node built-ins) — Node's built-in `path` is NOT on it,
// so the require crashed the preload with "module not found: path" and left
// the whole renderer without `window.api` (init() then died on
// `window.api.getConfig`). The fix replaced `require('path')` with a
// sandbox-safe port of Node's `path.win32` algorithms (see the "sandbox-safe
// path utilities" block at the top of preload.js).
//
// This file guards BOTH halves of that fix:
//
//   1. Sandbox-safety — the preload must not require any module outside the
//      sandbox allow-list. Checked two independent ways:
//        a. DYNAMICALLY: load the REAL preload.js with a `Module._load` that
//           throws on any non-allow-listed module (mimicking the sandbox's
//           "module not found" behaviour). If a top-level `require('path')`
//           (or any other forbidden built-in) is ever reintroduced, the load
//           throws and this test fails.
//        b. STATICALLY: a comment-aware scan of every `require('...')`
//           specifier in the source. This also catches a forbidden require
//           hidden inside a function body (a lazy require) that the dynamic
//           load test cannot see at module-evaluation time. The scan skips
//           comments and string literals, so the doc-comments in preload.js
//           that merely MENTION `require('path')` do not false-positive.
//
//   2. Correctness — the sandbox-safe path shim must behave exactly like
//      Node's `path.win32` (dirname / basename / extname / join). Verified
//      against the REAL `path` module as the oracle across a battery of
//      Windows path shapes (drive letters, UNC roots, mixed separators,
//      trailing separators, `.`/`..` segments, reserved device names).
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PRELOAD = path.join(ROOT, 'preload.js');

// The module allow-list a sandboxed Electron preload may require.
// A sandboxed preload gets only `electron` (a subset: contextBridge,
// ipcRenderer, webFrame, …) plus the `events`, `timers`, and `url` Node
// built-ins (bare or `node:`-prefixed). Everything else — `path`, `fs`,
// `child_process`, … — throws "module not found" at require time.
const SANDBOX_ALLOWLIST = new Set([
  'electron',
  'events', 'node:events',
  'timers', 'node:timers',
  'url', 'node:url',
]);

// ----------------------------------------------------------------------------
// Comment-aware extraction of every `require('...')` / `require("...")`
// module specifier in a source file.
//
// A naive `/require\(['"]path['"]\)/` regex would FALSE-POSITIVE on preload.js:
// its doc-comments mention `require('path')` three times (the PRE-1 cautionary
// note). So we walk the source character-by-character, tracking whether we are
// inside a line comment, block comment, or string literal, and only record a
// specifier when the `require(` token appears in real code.
//
// Note: template-literal `${...}` interpolation is not recursively lexed (a
// `require(` inside an interpolation would be missed) — acceptable here since
// preload.js has no such construct and the dynamic test above independently
// covers module evaluation.
// ----------------------------------------------------------------------------
function extractRequireSpecifiers(source) {
  const specs = [];
  const n = source.length;
  let state = 'code'; // 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl'
  let i = 0;
  const isIdentChar = (ch) => /[A-Za-z0-9_$]/.test(ch);
  while (i < n) {
    const c = source[i];
    const next = i + 1 < n ? source[i + 1] : '';
    if (state === 'code') {
      if (c === '/' && next === '/') { state = 'line'; i += 2; continue; }
      if (c === '/' && next === '*') { state = 'block'; i += 2; continue; }
      if (c === "'") { state = 'sq'; i++; continue; }
      if (c === '"') { state = 'dq'; i++; continue; }
      if (c === '`') { state = 'tpl'; i++; continue; }
      if (source.startsWith('require', i)) {
        const before = i > 0 ? source[i - 1] : '';
        if (!isIdentChar(before)) {
          let j = i + 'require'.length;
          while (j < n && /\s/.test(source[j])) j++;
          if (source[j] === '(') {
            j++;
            while (j < n && /\s/.test(source[j])) j++;
            const q = source[j];
            if (q === "'" || q === '"') {
              let k = j + 1;
              let spec = '';
              while (k < n && source[k] !== q) {
                if (source[k] === '\\') { spec += source[k + 1]; k += 2; continue; }
                spec += source[k];
                k++;
              }
              specs.push(spec);
              i = k + 1;
              continue;
            }
          }
        }
      }
      i++;
      continue;
    }
    if (state === 'line') { if (c === '\n') state = 'code'; i++; continue; }
    if (state === 'block') {
      if (c === '*' && next === '/') { state = 'code'; i += 2; continue; }
      i++;
      continue;
    }
    if (state === 'sq') {
      if (c === '\\') { i += 2; continue; }
      if (c === "'") state = 'code';
      i++;
      continue;
    }
    if (state === 'dq') {
      if (c === '\\') { i += 2; continue; }
      if (c === '"') state = 'code';
      i++;
      continue;
    }
    if (state === 'tpl') {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') state = 'code';
      i++;
      continue;
    }
  }
  return specs;
}

// ----------------------------------------------------------------------------
// Load the REAL preload.js with a `Module._load` that mimics the sandbox's
// module restrictions: `electron` resolves to a mock, allow-listed built-ins
// resolve normally, and anything else throws MODULE_NOT_FOUND (exactly what a
// sandboxed preload experiences). Returns the captured `api` object plus any
// violations / load error.
// ----------------------------------------------------------------------------
function loadPreloadSandboxed() {
  delete require.cache[require.resolve(PRELOAD)];
  const capture = { api: null };
  const electronMock = {
    contextBridge: { exposeInMainWorld(_name, exposed) { capture.api = exposed; } },
    ipcRenderer: {
      invoke() { return Promise.resolve({}); },
      on() {}, removeListener() {}, send() {},
    },
  };
  const violations = [];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    // Let file-path requires through: the preload itself is required by
    // absolute path, and any relative import inside it is a project file
    // (not a Node built-in). The sandbox restriction only applies to BARE
    // module specifiers (built-ins / node_modules).
    if (request.startsWith('.') || path.isAbsolute(request)) {
      return originalLoad.call(this, request, parent, isMain);
    }
    if (request === 'electron') return electronMock;
    if (SANDBOX_ALLOWLIST.has(request)) return originalLoad.call(this, request, parent, isMain);
    violations.push(request);
    const err = new Error(`Cannot find module '${request}'`);
    err.code = 'MODULE_NOT_FOUND';
    throw err;
  };
  let loadError = null;
  try {
    require(PRELOAD);
  } catch (e) {
    loadError = e;
  } finally {
    Module._load = originalLoad;
  }
  return { api: capture.api, violations, loadError };
}

// ============================================================================
// 1. Sandbox-safety
// ============================================================================

test('R7.5.PRE-1.dynamic: the real preload loads cleanly under sandbox module restrictions', () => {
  const { api, violations, loadError } = loadPreloadSandboxed();
  assert.equal(loadError, null,
    'preload.js must not throw under sandbox module restrictions. A top-level ' +
    "require of a non-allow-listed module (e.g. require('path'), the PRE-1 bug) " +
    'crashes the sandboxed preload and leaves the renderer without window.api. ' +
    'Load error: ' + (loadError && loadError.message));
  assert.deepEqual(violations, [],
    'preload.js must not require any module outside the sandbox allow-list ' +
    JSON.stringify([...SANDBOX_ALLOWLIST]) + '. Violations: ' + JSON.stringify(violations));
  assert.ok(api, 'preload must expose the api object via contextBridge.exposeInMainWorld');
});

test('R7.5.PRE-1.static: every require() specifier in preload.js is on the sandbox allow-list', () => {
  const src = fs.readFileSync(PRELOAD, 'utf8');
  const specs = extractRequireSpecifiers(src);
  assert.ok(specs.length > 0,
    'sanity: preload.js must contain at least one require() (electron)');
  for (const spec of specs) {
    assert.ok(SANDBOX_ALLOWLIST.has(spec),
      `preload.js requires '${spec}', which is NOT on the sandboxed-preload ` +
      'allow-list ' + JSON.stringify([...SANDBOX_ALLOWLIST]) + '. A sandboxed ' +
      'preload can only require electron + events + timers + url; any other ' +
      "Node built-in (require('path') being the PRE-1 regression) crashes the " +
      'preload at load time.');
  }
});

test('R7.5.PRE-1.static.selftest: the comment-aware scanner ignores commented requires', () => {
  // Guard the guard: prove the scanner does not false-positive on a comment
  // that mentions require('path') (preload.js has three such comments) and
  // does detect a real require.
  const sample = [
    "// require('path') in a line comment must be ignored",
    "/* require('fs') in a block comment must be ignored */",
    "const s = \"require('os') in a string literal must be ignored\";",
    "const { x } = require('electron');",
    "const lazy = () => require('timers');",
  ].join('\n');
  const specs = extractRequireSpecifiers(sample);
  assert.deepEqual(specs.sort(), ['electron', 'timers'],
    'scanner must record only real-code require() specifiers');
});

// ============================================================================
// 2. Path-shim correctness (oracle = Node's real path.win32)
// ============================================================================

// Windows path shapes: drive letters, UNC roots, mixed `/`+`\` separators,
// trailing separators, `.`/`..` segments, reserved device names, edge cases.
const DIRNAME_CASES = [
  'C:\\foo\\bar\\baz.txt',
  'C:\\foo\\bar',
  'C:\\foo',
  'C:\\',
  'C:',
  'C:foo',
  'foo\\bar\\baz',
  'foo\\bar',
  'foo',
  '.',
  '..',
  '...',
  '\\server\\share\\dir\\file.txt',
  '\\server\\share\\file.txt',
  '\\server\\share',
  'C:/foo/bar/baz.txt',
  'C:/foo/bar',
  'C:/foo',
  'C:/',
  'foo/bar/baz',
  'foo/bar',
  '/foo/bar/baz',
  '/foo/bar',
  '/foo',
  '/',
  '\\foo\\bar',
  '\\foo',
  '\\',
  'C:\\foo\\bar\\',
  'C:\\foo\\\\bar',
  'foo\\bar\\',
  'foo\\',
  '',
  'a\\b\\c\\d\\e\\f\\g.txt',
  'C:\\Program Files\\My App\\data\\file.json',
  'C:\\Users\\test\\..\\other\\file.txt',
  'CON\\file.txt',
  'nul\\sub\\file.txt',
];

const BASENAME_CASES = [
  'C:\\foo\\bar\\baz.txt',
  'C:\\foo\\bar\\',
  'C:\\foo\\bar',
  'C:\\',
  'C:',
  'foo',
  'foo\\',
  '',
  '.',
  '..',
  '\\server\\share\\file.txt',
  '\\server\\share\\',
  'C:/foo/bar/baz.txt',
  'foo/bar/baz',
  '/foo/bar',
  'file.tar.gz',
  '.hidden',
  'trailing.',
];

const EXTNAME_CASES = [
  'file.txt',
  'file',
  '.hidden',
  'file.tar.gz',
  'file.',
  'C:\\foo\\bar.baz\\qux',
  'C:\\foo\\bar.baz\\qux.txt',
  '..',
  '.',
  '',
  'foo\\bar\\baz.JPEG',
  'foo\\..\\bar.txt',
  'foo\\.bar',
  'a\\b\\c.d\\e.f.g',
];

const JOIN_CASES = [
  [],
  [''],
  ['C:\\foo', 'bar'],
  ['C:\\foo\\', 'bar'],
  ['C:\\foo', 'bar', 'baz'],
  ['foo', 'bar', 'baz'],
  ['foo', '', 'bar'],
  ['C:\\foo', '..', 'bar'],
  ['C:\\foo', '.', 'bar'],
  ['C:\\foo\\bar', '..', '..', 'baz'],
  ['a', 'b', '..', 'c'],
  ['C:', 'foo'],
  ['/foo', 'bar'],
  ['\\server\\share', 'dir', 'file.txt'],
  ['C:\\foo', 'bar\\baz'],
  ['C:\\foo', '/bar'],
  ['foo/', 'bar'],
  ['a\\', '\\b'],
  ['a', 'b', 'c', 'd'],
];

test('R7.5.PRE-1.shim: pathDirname matches path.win32.dirname', () => {
  const { api, loadError } = loadPreloadSandboxed();
  assert.equal(loadError, null, 'preload must load: ' + (loadError && loadError.message));
  for (const p of DIRNAME_CASES) {
    assert.equal(api.pathDirname(p), path.win32.dirname(p),
      `pathDirname(${JSON.stringify(p)}) diverges from path.win32.dirname`);
  }
});

test('R7.5.PRE-1.shim: pathBasename matches path.win32.basename', () => {
  const { api, loadError } = loadPreloadSandboxed();
  assert.equal(loadError, null, 'preload must load: ' + (loadError && loadError.message));
  for (const p of BASENAME_CASES) {
    assert.equal(api.pathBasename(p), path.win32.basename(p),
      `pathBasename(${JSON.stringify(p)}) diverges from path.win32.basename`);
  }
});

test('R7.5.PRE-1.shim: pathExtname matches path.win32.extname', () => {
  const { api, loadError } = loadPreloadSandboxed();
  assert.equal(loadError, null, 'preload must load: ' + (loadError && loadError.message));
  for (const p of EXTNAME_CASES) {
    assert.equal(api.pathExtname(p), path.win32.extname(p),
      `pathExtname(${JSON.stringify(p)}) diverges from path.win32.extname`);
  }
});

test('R7.5.PRE-1.shim: pathJoin matches path.win32.join', () => {
  const { api, loadError } = loadPreloadSandboxed();
  assert.equal(loadError, null, 'preload must load: ' + (loadError && loadError.message));
  for (const args of JOIN_CASES) {
    assert.equal(api.pathJoin(...args), path.win32.join(...args),
      `pathJoin(${JSON.stringify(args)}) diverges from path.win32.join`);
  }
});

test('R7.5.PRE-1.shim: non-string input throws TypeError (matches Node)', () => {
  const { api, loadError } = loadPreloadSandboxed();
  assert.equal(loadError, null, 'preload must load: ' + (loadError && loadError.message));
  assert.throws(() => api.pathDirname(42), TypeError);
  assert.throws(() => api.pathBasename(null), TypeError);
  assert.throws(() => api.pathExtname({}), TypeError);
  assert.throws(() => api.pathJoin('a', 42), TypeError);
});
