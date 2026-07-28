// tests/unit/renderer/pipelineModelBridgeLockstep.test.js
// 360° audit 2026-07-11 (run 2): renderer/pipeline/pipelineModelBridge.js is a
// hand-maintained mirror of src/pipeline/pipelineModel.js ("The two MUST stay
// in lock-step") — but nothing enforced that. A drift means the renderer
// computes a different output path / sanitised name than the main-process IPC
// handlers, producing files the board then can't find. This test loads the
// bridge in a vm sandbox and compares it against the source of truth across a
// matrix of realistic + adversarial inputs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const srcModel = require(path.join(ROOT, 'src', 'pipeline', 'pipelineModel.js'));

function loadBridge() {
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(ROOT, 'renderer', 'pipeline', 'pipelineModelBridge.js'), 'utf8'),
    sandbox, { filename: 'pipelineModelBridge.js' });
  return sandbox.window.PipelineModel;
}
const bridge = loadBridge();

// Objects/arrays created inside the vm have a different realm's prototypes,
// which deepStrictEqual rejects. JSON round-trip flattens that.
const j = (v) => JSON.parse(JSON.stringify(v));

test('bridge column constants match src exactly', () => {
  assert.deepEqual(j(bridge.COLUMN_ORDER), srcModel.COLUMN_ORDER);
  assert.deepEqual(j(bridge.ACTIVE_COLUMNS), srcModel.ACTIVE_COLUMNS);
  assert.deepEqual(j(bridge.STORAGE_COLUMNS), srcModel.STORAGE_COLUMNS);
  assert.deepEqual(j(bridge.COLUMN_DEFAULTS), srcModel.COLUMN_DEFAULTS);
});

test('bridge safeBaseName matches src for a matrix of names', () => {
  const cases = [
    'hero.png', 'weird name  .png', '../../evil.png', 'C:\\abs\\name.png',
    'nul\0byte.png', '...', '.', '..', '', null, undefined, 42,
    'no-extension', 'a'.repeat(200) + '.png', 'a'.repeat(200),
    'dots.in.middle.png', 'trailing.dot.', 'ümlaut ünïcode.webp',
  ];
  for (const c of cases) {
    assert.equal(bridge.safeBaseName(c, 'image'), srcModel.safeBaseName(c, 'image'),
      `safeBaseName drift for input: ${JSON.stringify(c)}`);
  }
});

test('bridge outPath matches src (normalised) for a matrix of inputs', () => {
  const workspaces = ['C:\\ws\\pipeline\\image', 'C:\\ws with space\\pipeline\\image'];
  const columns = srcModel.STORAGE_COLUMNS;
  const optsList = [
    {}, { mult: 2 }, { mult: 4, ext: 'png' }, { ext: '.jpg' }, { replaceN: 3 },
    { columnFolders: { upscale: 'D:\\Output\\Upscaled', final: 'D:\\Out Final' } },
    { columnFolders: { resize: 'D:\\Output\\Resized' }, ext: 'webp' },
  ];
  const names = ['hero.png', 'no-ext', 'two.dots.png'];
  for (const ws of workspaces) {
    for (const col of columns) {
      for (const opts of optsList) {
        for (const name of names) {
          const a = path.normalize(bridge.outPath(ws, 'img_x1', name, col, opts));
          const b = path.normalize(srcModel.outPath(ws, 'img_x1', name, col, opts));
          assert.equal(a, b,
            `outPath drift: ws=${ws} col=${col} name=${name} opts=${JSON.stringify(opts)}`);
        }
      }
    }
  }
});

test('bridge nextColumn/prevColumn match src across the full order', () => {
  for (const col of [...srcModel.COLUMN_ORDER, 'bogus', null]) {
    assert.equal(bridge.nextColumn(col), srcModel.nextColumn(col), `nextColumn(${col})`);
    assert.equal(bridge.prevColumn(col), srcModel.prevColumn(col), `prevColumn(${col})`);
  }
});

test('bridge resolveSettings matches src', () => {
  for (const col of srcModel.ACTIVE_COLUMNS) {
    assert.deepEqual(j(bridge.resolveSettings(col, null)), srcModel.resolveSettings(col, null));
    assert.deepEqual(
      j(bridge.resolveSettings(col, { [col]: { quality: 55, multiplier: 4, width: 640 } })),
      srcModel.resolveSettings(col, { [col]: { quality: 55, multiplier: 4, width: 640 } }));
  }
});
