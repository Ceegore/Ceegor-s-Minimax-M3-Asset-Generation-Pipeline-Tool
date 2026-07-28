// tests/unit/renderer/aspectLink.test.js
// Task 1 — the GIMP/Photoshop chain-link aspect-ratio math is pure, so these
// load the renderer file into a vm sandbox with the minimal globals it needs
// (el() for the chain button) and assert the math + the upscale-threshold.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function loadAspectLink() {
  const sandbox = {
    window: {},
    el: (tag, attrs, text) => {
      // Minimal fake element: supports addEventListener + property storage.
      const node = { _tag: tag, attrs: attrs || {}, textContent: text || '', _listeners: {}, style: {}, classList: { add() {}, remove() {} } };
      node.addEventListener = (ev, fn) => { node._listeners[ev] = fn; };
      node.click = () => { if (node._listeners.click) node._listeners.click(); };
      return node;
    },
    console,
  };
  vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(ROOT, 'renderer/utils/aspectLink.js'), 'utf8');
  vm.runInContext(src, sandbox, { filename: 'aspectLink.js' });
  return sandbox.window.AspectLink;
}

test('linkedPair: editing W recomputes H from source AR', () => {
  const AL = loadAspectLink();
  // 800×600 → AR 4:3. Set W=400 → H should be 300.
  const p = AL.linkedPair({ w: 800, h: 600 }, 'w', 400);
  assert.equal(p.width, 400);
  assert.equal(p.height, 300);
});

test('linkedPair: editing H recomputes W from source AR', () => {
  const AL = loadAspectLink();
  // 1920×1080 → AR 16:9. Set H=540 → W should be 960.
  const p = AL.linkedPair({ w: 1920, h: 1080 }, 'h', 540);
  assert.equal(p.height, 540);
  assert.equal(p.width, 960);
});

test('linkedPair: rounds to integer pixels', () => {
  const AL = loadAspectLink();
  // 1000×333 → AR ~3.003. Set W=3000 → H ≈ 999.
  const p = AL.linkedPair({ w: 1000, h: 333 }, 'w', 3000);
  assert.ok(Number.isInteger(p.height));
  assert.ok(Math.abs(p.height - 999) <= 1);
});

test('linkedPair: 0 value yields 0 on both axes', () => {
  const AL = loadAspectLink();
  const p = AL.linkedPair({ w: 800, h: 600 }, 'w', 0);
  assert.equal(p.width, 0);
  assert.equal(p.height, 0);
});

test('linkedPair: no source dims keeps the typed value only', () => {
  const AL = loadAspectLink();
  const p = AL.linkedPair({ w: 0, h: 0 }, 'w', 500);
  assert.equal(p.width, 500);
  assert.equal(p.height, 0, 'cannot compute AR without source dims');
});

test('isLargeUpscale: true above 120% on either axis', () => {
  const AL = loadAspectLink();
  // exactly 120% is NOT large (>1.2 is strict).
  assert.equal(AL.isLargeUpscale({ w: 100, h: 100 }, { width: 120, height: 100 }), false);
  // 121% on one axis.
  assert.equal(AL.isLargeUpscale({ w: 100, h: 100 }, { width: 121, height: 100 }), true);
  // height axis only.
  assert.equal(AL.isLargeUpscale({ w: 100, h: 100 }, { width: 100, height: 200 }), true);
  // downscale / same size → false.
  assert.equal(AL.isLargeUpscale({ w: 100, h: 100 }, { width: 50, height: 50 }), false);
  assert.equal(AL.isLargeUpscale({ w: 100, h: 100 }, { width: 100, height: 100 }), false);
});

test('upscalePercent: reports the larger axis increase', () => {
  const AL = loadAspectLink();
  assert.equal(AL.upscalePercent({ w: 100, h: 100 }, { width: 250, height: 150 }), 250);
  assert.equal(AL.upscalePercent({ w: 100, h: 100 }, { width: 150, height: 300 }), 300);
  // not an enlargement → 0.
  assert.equal(AL.upscalePercent({ w: 100, h: 100 }, { width: 100, height: 100 }), 0);
});

test('buildChainToggle: starts linked, toggles to unlinked on click', () => {
  const AL = loadAspectLink();
  let observed;
  const btn = AL.buildChainToggle(true, (linked) => { observed = linked; });
  assert.equal(btn.linked, true);
  assert.equal(btn.textContent, '🔗');
  btn.click();
  assert.equal(btn.linked, false);
  assert.equal(btn.textContent, '🔓');
  assert.equal(observed, false);
  btn.click();
  assert.equal(btn.linked, true);
  assert.equal(observed, true);
});
