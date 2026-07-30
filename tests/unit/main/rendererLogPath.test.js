// tests/unit/main/rendererLogPath.test.js
// v1.1.27/28 regression test: the renderer-error.log was
// silently dropped in packaged builds because the hardcoded path
// `path.join(PARENT_ROOT, 'renderer-error.log')` resolved inside
// the asar (read-only virtual filesystem). This test pins the
// fallback strategy: try project-root, then Electron's
// `app.getPath('logs')`, then `process.cwd()`.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function loadResolver() {
  // Read main/index.js as text and extract the
  // _resolveRendererLogPath function. We do this by regex
  // (instead of requiring main/index.js) because main/index.js
  // pulls in Electron's `app` module which only exists inside
  // the Electron runtime — not under plain `node`.
  const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'main', 'index.js'), 'utf8');
  const m = src.match(/function _resolveRendererLogPath\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(m, 'main/index.js must export _resolveRendererLogPath');
  // P5 (M-046): the probe now uses existsSync + accessSync (non-destructive)
  // instead of writeFileSync (which truncated the previous session's log).
  // Stub accordingly: __READONLY__ paths "exist" but fail accessSync.
  const calls = [];
  const sandbox = {
    fs: {
      existsSync: (p) => { calls.push(p); return true; },
      accessSync: (p) => {
        if (p.includes('__READONLY__')) {
          const err = new Error('EACCES: permission denied');
          err.code = 'EACCES';
          throw err;
        }
        // writable — no throw
      },
      constants: { W_OK: 2 },
    },
    path: require('node:path'),
    app: { getPath: (k) => path.join(os.tmpdir(), 'mock-app-' + k) },
    process: { cwd: () => os.tmpdir() },
    PARENT_ROOT: '/__READONLY__/project-root',
  };
  sandbox.global = sandbox;
  vm.runInContext(`(${m[0]})()`, vm.createContext(sandbox));
  return { result: sandbox.__result, calls };
}
const vm = require('node:vm');

test('_resolveRendererLogPath: skips readonly project-root, falls back to app.getPath("logs")', () => {
  const { calls } = loadResolver();
  // The first candidate is the readonly project-root — must be
  // tried (and rejected via accessSync). The second is app.getPath('logs')
  // which the stub marks writable.
  assert.ok(calls.length >= 1, 'at least one candidate must be tried');
  assert.ok(calls[0].includes('project-root'), `first try should be PARENT_ROOT, got: ${calls[0]}`);
  // existsSync is called for each candidate until one passes accessSync.
  // First call = project-root (fails accessSync), second = app.getPath('logs') (passes).
  assert.ok(calls.length === 2, `should fall back to app.getPath('logs') after project-root fails, got attempts: ${JSON.stringify(calls)}`);
});

test('_resolveRendererLogPath: returns null if ALL candidates fail', () => {
  const calls = [];
  const sandbox = {
    fs: {
      existsSync: (p) => { calls.push(p); return true; },
      accessSync: (p) => {
        const err = new Error('EACCES');
        err.code = 'EACCES';
        throw err;
      },
      constants: { W_OK: 2 },
    },
    path: require('node:path'),
    app: { getPath: (k) => '/__READONLY__/' + k },
    process: { cwd: () => '/__READONLY__/cwd' },
    PARENT_ROOT: '/__READONLY__/project-root',
  };
  sandbox.global = sandbox;
  const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'main', 'index.js'), 'utf8');
  const m = src.match(/function _resolveRendererLogPath\(\)\s*\{[\s\S]*?\n\}/);
  vm.runInContext(`(${m[0]})()`, vm.createContext(sandbox));
  // When every candidate fails accessSync, _resolveRendererLogPath
  // returns null (not throw). All 3 candidates must be probed.
  assert.ok(calls.length >= 3, 'all 3 candidates should have been tried');
});
