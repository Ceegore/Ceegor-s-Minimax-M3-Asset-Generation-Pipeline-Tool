// tests/unit/renderer/resizeUi.qa.test.js
// Phase 3 (adversarial QA) — aspectLink boundary cases + resizeUpscaleDialog
// promise/branch behaviour + imageResizeOverlay build/batch wiring. Loads the
// renderer files into a vm sandbox with the minimal globals they need.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..', '..');

// Minimal fake element: supports the DOM calls these files make
// (addEventListener, appendChild, style, classList, click, property storage).
function fakeEl(tag, attrs, children) {
  const node = {
    _tag: tag, attrs: attrs || {}, _listeners: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} },
    textContent: '', value: '', checked: false, disabled: false, dataset: {},
    childNodes: [], children: [],
  };
  node.appendChild = (c) => { node.childNodes.push(c); node.children.push(c); return c; };
  node.append = (...cs) => { for (const c of cs) { node.childNodes.push(c); node.children.push(c); } };
  node.addEventListener = (ev, fn) => { node._listeners[ev] = fn; };
  node.removeEventListener = () => {};
  node.click = () => { if (node._listeners.click) node._listeners.click(); };
  if (typeof children === 'string') node.textContent = children;
  else if (Array.isArray(children)) for (const c of children) node.appendChild(c);
  return node;
}

function makeSandbox() {
  const sandbox = {
    window: {},
    console,
    el: fakeEl,
    setTimeout, clearTimeout, Promise, Date, Math, Number, parseInt, parseFloat,
    isNaN, isFinite, String, Object, Array, Boolean, JSON, btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  };
  vm.createContext(sandbox);
  return sandbox;
}

function loadFile(sandbox, rel) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), sandbox, { filename: rel });
}

// ============================================================ aspectLink
function loadAspectLink() {
  const sb = makeSandbox();
  loadFile(sb, 'renderer/utils/aspectLink.js');
  return { AL: sb.window.AspectLink, sb };
}

test('AL linkedPair: NaN/negative/string inputs are coerced to 0 (no throw)', () => {
  const { AL } = loadAspectLink();
  const src = { w: 800, h: 600 };
  assert.equal(AL.linkedPair(src, 'w', NaN).width, 0);
  assert.equal(AL.linkedPair(src, 'w', -10).width, 0);
  assert.equal(AL.linkedPair(src, 'w', 'abc').width, 0);
  // A float is floored.
  assert.equal(AL.linkedPair(src, 'w', 400.9).width, 400);
  assert.equal(AL.linkedPair(src, 'w', 400.9).height, 300);
});

test('AL linkedPair: editedKey is case-insensitive after the O-1 fix ("W" now treats as "w")', () => {
  const { AL } = loadAspectLink();
  // After the fix, 'W' normalises to 'w' → width branch on a 100×100 source.
  const p = AL.linkedPair({ w: 100, h: 100 }, 'W', 50);
  assert.equal(p.width, 50, '"W" is now treated as width');
  assert.equal(p.height, 50, 'recomputed from AR=1');
  // And 'H' → height branch.
  const p2 = AL.linkedPair({ w: 200, h: 100 }, 'H', 50);
  assert.equal(p2.height, 50);
  assert.equal(p2.width, 100);
});

test('AL isLargeUpscale: exact 120% boundary is NOT large (strict >)', () => {
  const { AL } = loadAspectLink();
  // 120% on W exactly → false.
  assert.equal(AL.isLargeUpscale({ w: 100, h: 100 }, { width: 120, height: 100 }), false);
  // 121% → true.
  assert.equal(AL.isLargeUpscale({ w: 100, h: 100 }, { width: 121, height: 100 }), true);
});

test('AL isLargeUpscale: missing/zero dims → false (no crash)', () => {
  const { AL } = loadAspectLink();
  assert.equal(AL.isLargeUpscale(null, { width: 500, height: 500 }), false);
  assert.equal(AL.isLargeUpscale({ w: 0, h: 0 }, { width: 500, height: 500 }), false);
  assert.equal(AL.isLargeUpscale({ w: 100, h: 100 }, null), false);
  assert.equal(AL.isLargeUpscale({ w: 100, h: 100 }, { width: 0, height: 0 }), false);
});

test('AL upscalePercent: returns 0 when not an enlargement (never negative)', () => {
  const { AL } = loadAspectLink();
  // A downscale should report 0, not a negative percent.
  assert.equal(AL.upscalePercent({ w: 1000, h: 1000 }, { width: 100, height: 100 }), 0);
});

test('AL buildChainToggle: initialLinked=false starts unlocked; onChange fires', () => {
  const { AL } = loadAspectLink();
  let observed = 'init';
  const btn = AL.buildChainToggle(false, (linked) => { observed = linked; });
  assert.equal(btn.linked, false);
  assert.equal(btn.textContent, '🔓');
  btn.click();
  assert.equal(btn.linked, true);
  assert.equal(btn.textContent, '🔗');
  assert.equal(observed, true);
});

// ===================================================== resizeUpscaleDialog
function loadDialog() {
  const sb = makeSandbox();
  loadFile(sb, 'renderer/utils/aspectLink.js');
  loadFile(sb, 'renderer/utils/resizeUpscaleDialog.js');
  return { D: sb.window.ResizeUpscaleDialog, sb };
}

test('D maybeWarnUpscale: NOT a large enlargement → resolves "proceed" immediately (no modal)', async () => {
  const { D, sb } = loadDialog();
  let modalShown = false;
  sb.showModal = () => { modalShown = true; };
  const r = await D.maybeWarnUpscale({ srcW: 1000, srcH: 1000, targetW: 1100, targetH: 1100 });
  assert.equal(r, 'proceed');
  assert.equal(modalShown, false, 'no popup should appear for a <=120% resize');
});

test('D maybeWarnUpscale: missing AspectLink → resolves "proceed" (defensive)', async () => {
  const sb = makeSandbox();
  loadFile(sb, 'renderer/utils/aspectLink.js');
  loadFile(sb, 'renderer/utils/resizeUpscaleDialog.js');
  // Wipe AspectLink to simulate a load-order regression.
  delete sb.window.AspectLink;
  const D = sb.window.ResizeUpscaleDialog;
  const r = await D.maybeWarnUpscale({ srcW: 100, srcH: 100, targetW: 500, targetH: 500 });
  assert.equal(r, 'proceed', 'without AspectLink it must still resolve, never reject');
});

test('D maybeWarnUpscale: large enlargement but NO showModal → resolves "proceed" (test-env fallback)', async () => {
  const { D } = loadDialog();
  // showModal is undefined in this sandbox.
  const r = await D.maybeWarnUpscale({ srcW: 100, srcH: 100, targetW: 500, targetH: 500 });
  assert.equal(r, 'proceed', 'falls back to proceed when there is no modal host');
});

test('D maybeWarnUpscale: large enlargement WITH showModal → wires buttons; Cancel resolves "cancel"', async () => {
  const sb = makeSandbox();
  // Capture every button the el() factory produces while the modal builds, so
  // we can locate the Cancel button regardless of nesting depth.
  const madeButtons = [];
  sb.el = (tag, attrs, children) => {
    const node = fakeEl(tag, attrs, children);
    if (tag === 'button') madeButtons.push(node);
    return node;
  };
  loadFile(sb, 'renderer/utils/aspectLink.js');
  loadFile(sb, 'renderer/utils/resizeUpscaleDialog.js');
  const D = sb.window.ResizeUpscaleDialog;

  let captured;
  sb.showModal = (builder) => { captured = builder; };
  const p = D.maybeWarnUpscale({ srcW: 100, srcH: 100, targetW: 400, targetH: 400 });
  await Promise.resolve();
  assert.ok(captured, 'showModal must be invoked for a large enlargement');
  const m = fakeEl('div');
  const closeCalls = [];
  captured(m, () => { closeCalls.push(1); });
  const cancelBtn = madeButtons.find((b) => /Cancel/i.test(b.textContent));
  assert.ok(cancelBtn, 'a Cancel button must exist');
  cancelBtn.click();
  const r = await p;
  assert.equal(r, 'cancel');
  assert.equal(closeCalls.length, 1, 'close() must be called exactly once on cancel');
});

test('D THRESHOLD is exactly 1.2 (120%)', () => {
  const { D } = loadDialog();
  assert.equal(D.THRESHOLD, 1.2);
});
