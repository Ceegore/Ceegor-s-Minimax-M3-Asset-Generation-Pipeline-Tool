// tests/unit/renderer/components/SplitterDrag.test.js
// Bug-fix #14 (2026-06-19): clamp math for the splitter drag
// handler. The drag handler attaches to document on DOMContentLoaded
// (which JSDOM provides during require), so we only need to test
// the pure clamp helper here.

const test = require('node:test');
const assert = require('node:assert/strict');

// JSDOM isn't a dependency; we shim the minimum needed by
// SplitterDrag's IIFE.
global.window = global;
const noopStyle = {
  setProperty: () => {},
  getPropertyValue: () => '',
};
global.document = {
  readyState: 'complete',
  documentElement: { style: noopStyle },
  getElementById: () => null, // no actual splitters in the test
  addEventListener: () => {},
  body: { style: {} },
};

require('../../../../renderer/components/SplitterDrag.js');

const { clampLayout, SPLITTERS } = window.SplitterDrag;

test('SPLITTERS lists three splitters (sidebar, logbar, log-preview)', () => {
  assert.equal(SPLITTERS.length, 3);
  const ids = SPLITTERS.map((s) => s.id);
  assert.ok(ids.includes('splitter-sidebar'));
  assert.ok(ids.includes('splitter-logbar'));
  assert.ok(ids.includes('splitter-log-preview'));
});

test('clampLayout: clamps sidebar to >= 200px', () => {
  assert.equal(clampLayout('--sidebar-w', 50), 200);
  assert.equal(clampLayout('--sidebar-w', 199), 200);
  assert.equal(clampLayout('--sidebar-w', 200), 200);
});

test('clampLayout: leaves a normal sidebar value untouched', () => {
  assert.equal(clampLayout('--sidebar-w', 360), 360);
  // v1.1 (audit L18): MAX is now finite (3840 for sidebar/preview,
  // 2160 for logbar) — a dragged splitter can no longer persist
  // state.layoutSettings.sidebarW = 9999, which broke the layout
  // on the next launch.
  assert.equal(clampLayout('--sidebar-w', 9999), 3840); // upper bound is 3840
  assert.equal(clampLayout('--sidebar-w', 3840), 3840);
});

test('clampLayout: clamps logbar to >= 80px', () => {
  assert.equal(clampLayout('--logbar-h', 10), 80);
  assert.equal(clampLayout('--logbar-h', 200), 200);
  assert.equal(clampLayout('--logbar-h', 9999), 2160); // upper bound is 2160
});

test('clampLayout: clamps preview to >= 200px', () => {
  assert.equal(clampLayout('--preview-w', 100), 200);
  assert.equal(clampLayout('--preview-w', 540), 540);
  assert.equal(clampLayout('--preview-w', 9999), 3840); // upper bound is 3840
});

test('clampLayout: returns the value unchanged when no clamp bounds are registered', () => {
  // Defensive: an unknown CSS var name has no bound, so the
  // helper just passes through.
  assert.equal(clampLayout('--whatever', 42), 42);
  assert.equal(clampLayout('--whatever', -100), -100);
});