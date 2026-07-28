// tests/unit/renderer/pipelineReport.test.js
// Task 3b — the reusable Pipeline report writer. The pure helpers
// (resolveReportDir, summarizeAsset, buildReportMarkdown) are loaded into a vm
// sandbox; the I/O (writeReport) is covered indirectly by mocking fbWrite.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function loadReport(extraState) {
  const sandbox = {
    window: { state: Object.assign({ config: {}, pipeline: { image: { workspace: 'C:/ws/pipeline/image', items: [], trash: [], counter: 0 } } }, extraState || {}) },
    // Minimal el stub (the module doesn't build DOM, but btoa + encodeURIComponent are used).
    el: (tag) => ({ _tag: tag }),
    console,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    encodeURIComponent, unescape, escape,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'renderer/pipeline/pipelineReport.js'), 'utf8'), sandbox, { filename: 'pipelineReport.js' });
  return sandbox.window.PipelineReport;
}

const sampleItem = (over) => Object.assign({
  id: 'img_abc', name: 'hero', column: 'final', status: 'idle', createdAt: 1700000000000,
  _dims: { w: 1920, h: 1080 },
  files: { original: 'C:/o.png', final: 'C:/ws/pipeline/image/final/img_abc_hero.png' },
  history: [{ action: 'import' }, { action: 'run' }, { action: 'finalize' }],
}, over || {});

test('resolveReportDir: config.report_dir wins when set', () => {
  const R = loadReport({ config: { report_dir: 'E:/reports' } });
  assert.equal(R.resolveReportDir({ exportDir: 'D:/out' }), 'E:/reports');
});

test('resolveReportDir: falls back to exportDir when no report_dir', () => {
  const R = loadReport({ config: {} });
  assert.equal(R.resolveReportDir({ exportDir: 'D:/out' }), 'D:/out');
});

test('resolveReportDir: falls back to finalDir when neither set', () => {
  const R = loadReport({ config: {} });
  assert.equal(R.resolveReportDir({ finalDir: 'C:/ws/pipeline/image/final' }), 'C:/ws/pipeline/image/final');
});

test('resolveReportDir: falls back to workspace/final when nothing given', () => {
  const R = loadReport({ config: {} });
  // windows path: join uses \\ when the first arg has a backslash; the workspace here uses /
  const d = R.resolveReportDir({});
  assert.ok(d.indexOf('final') >= 0, 'falls back to the final folder');
});

test('summarizeAsset: captures name, id, dims, format, history count', () => {
  const R = loadReport();
  const s = R.summarizeAsset(sampleItem(), { exportDir: 'D:/out' });
  assert.equal(s.name, 'hero');
  assert.equal(s.id, 'img_abc');
  assert.equal(s.width, 1920);
  assert.equal(s.height, 1080);
  assert.equal(s.format, 'PNG');
  assert.equal(s.historyCount, 3);
  assert.equal(s.exportDest, 'D:/out');
});

test('buildReportMarkdown (clear mode): header + per-asset table + list', () => {
  const R = loadReport();
  const md = R.buildReportMarkdown([sampleItem(), sampleItem({ id: 'img_def', name: 'sidekick', _dims: { w: 512, h: 512 } })], { mode: 'clear' });
  assert.ok(md.indexOf('# Pipeline clear report') === 0, 'title reflects clear mode');
  assert.ok(md.indexOf('**Assets in this report:** 2') >= 0);
  assert.ok(md.indexOf('img_abc') >= 0, 'first asset id present');
  assert.ok(md.indexOf('img_def') >= 0, 'second asset id present');
  assert.ok(md.indexOf('1920 × 1080 px') >= 0, 'dims present');
  assert.ok(md.indexOf('## Asset list') >= 0, 'compact list section present');
  // Clear mode does NOT mention an export destination.
  assert.equal(md.indexOf('Exported to'), -1);
});

test('buildReportMarkdown (export mode): includes export destination per asset', () => {
  const R = loadReport();
  const md = R.buildReportMarkdown([sampleItem()], { mode: 'export', exportDir: 'D:/exports' });
  assert.ok(md.indexOf('# Pipeline export report') === 0, 'title reflects export mode');
  assert.ok(md.indexOf('**Export destination:**') >= 0);
  assert.ok(md.indexOf('Exported to') >= 0, 'per-asset export row present');
});

test('buildReportMarkdown: empty items → "(no assets were removed)"', () => {
  const R = loadReport();
  const md = R.buildReportMarkdown([], { mode: 'clear' });
  assert.ok(md.indexOf('no assets were removed') >= 0);
});

test('writeReport: empty items → ok:false', async () => {
  const R = loadReport();
  const r = await R.writeReport([], {});
  assert.equal(r.ok, false);
});

test('writeReport: resolves dir, ensures it, writes via fbWrite', async () => {
  let ensured = null, writtenPath = null, writtenB64 = null;
  const sandbox = {
    window: {
      state: { config: { report_dir: 'E:/reports' } },
      api: {
        fbEnsureDir: async (dir) => { ensured = dir; return { ok: true }; },
        fbExists: async () => ({ ok: true, exists: false }),
        fbWrite: async (p, b64) => { writtenPath = p; writtenB64 = b64; return { ok: true, path: p }; },
      },
    },
    el: (tag) => ({ _tag: tag }),
    console,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    encodeURIComponent, unescape, escape,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'renderer/pipeline/pipelineReport.js'), 'utf8'), sandbox, { filename: 'pipelineReport.js' });
  const R = sandbox.window.PipelineReport;
  const r = await R.writeReport([sampleItem()], { mode: 'clear' });
  assert.equal(r.ok, true);
  assert.equal(ensured, 'E:/reports');
  assert.ok(writtenPath.startsWith('E:/reports'), 'written into the report dir');
  assert.ok(writtenPath.endsWith('.md'));
  // The base64 decodes back to valid UTF-8 markdown.
  const md = Buffer.from(writtenB64, 'base64').toString('utf8');
  assert.ok(md.indexOf('# Pipeline clear report') === 0);
});
