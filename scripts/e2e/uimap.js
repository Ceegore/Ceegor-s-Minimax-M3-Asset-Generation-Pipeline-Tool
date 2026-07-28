// scripts/e2e/uimap.js
// ============================================================================
// Drives E2E selectors from tests/ui_map.json (the 615-line map of every UI
// element) instead of hardcoding them, and measures UI-surface coverage.
//
// Two complementary signals feed the surface report (scripts/e2e/surface-
// report.js):
//   1. `sel(id)` — when a scenario asks for an element's selector we record
//      the id as "referenced" (the suite explicitly targets that element).
//   2. An in-page recorder (installed by installRecorder) that watches real
//      interactions — click / dblclick / input / change / focus (capture
//      phase) — and marks any ui_map element the event target matches.
//
// Elements in ui_map.json split into:
//   • automatable — have a `dom` selector (can be asserted/driven by a test)
//   • manual      — only a `visual_anchor` / `type` (need a human or a pixel
//     diff; this is the honest "cannot automate" boundary)
// ============================================================================

const path = require('path');
const fs = require('fs');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const UI_MAP_PATH = path.join(APP_ROOT, 'tests', 'ui_map.json');

let _map = null;
function loadUiMap() {
  if (!_map) _map = JSON.parse(fs.readFileSync(UI_MAP_PATH, 'utf8'));
  return _map;
}

// Walk screens / overlays / dynamic_elements and split every element node
// into automatable (has `dom`) vs manual (visual-only). An "element node" is
// any object carrying a `type` or a `dom`.
function flatten() {
  const map = loadUiMap();
  const automatable = [];
  const manual = [];
  const seen = new Set();

  function add(key, node, screen) {
    const id = node.id || key;
    if (seen.has(id)) return;
    seen.add(id);
    const entry = { id, screen, type: node.type || '', dom: node.dom || null, visual: node.visual_anchor || '' };
    if (node.dom) automatable.push(entry);
    else manual.push(entry);
  }
  function walk(obj, screen) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
    for (const [key, val] of Object.entries(obj)) {
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        if (typeof val.type === 'string' || typeof val.dom === 'string') add(key, val, screen);
        walk(val, screen);
      }
    }
  }

  for (const [k, v] of Object.entries(map.screens || {})) walk(v, k);
  for (const [k, v] of Object.entries(map.overlays || {})) walk(v, k);
  for (const [k, v] of Object.entries(map.dynamic_elements || {})) walk(v, 'dynamic');
  if (map.toasts && typeof map.toasts.dom === 'string') {
    add('TOAST', { id: 'TOAST', type: 'toast', dom: map.toasts.dom }, 'toasts');
  }
  return { automatable, manual };
}

let _byId = null;
function byId() {
  if (!_byId) _byId = new Map(flatten().automatable.map((e) => [e.id, e]));
  return _byId;
}

// Node-side record of which ids the scenarios explicitly targeted.
const _referenced = new Set();

/**
 * Return the DOM selector for a ui_map element id, and mark it referenced.
 * Throws for unknown ids so stale scenarios fail at the selector lookup.
 */
function sel(id) {
  const e = byId().get(id);
  if (!e) throw new Error('Unknown ui_map id: ' + id);
  _referenced.add(id);
  return e.dom;
}
function referencedIds() { return [..._referenced]; }

/**
 * Install the in-page interaction recorder. Idempotent per page. Must be
 * called after the harness has booted (a window is loaded).
 */
async function installRecorder(exec) {
  const list = flatten().automatable.map((e) => ({ id: e.id, dom: e.dom }));
  const payload = JSON.stringify(list);
  return exec(`(() => {
    if (window.__surfaceInstalled) return true;
    window.__surfaceInstalled = true;
    window.__uiSel = ${payload};
    window.__touchedSel = new Set();
    const markEl = (el) => {
      if (!el || typeof el.matches !== 'function') return;
      for (const e of window.__uiSel) {
        try { if (el.matches(e.dom)) window.__touchedSel.add(e.id); } catch (_) {}
      }
    };
    for (const ev of ['click', 'dblclick', 'input', 'change', 'focus']) {
      document.addEventListener(ev, (e) => markEl(e.target), true);
    }
    return true;
  })()`);
}

/**
 * Collect the set of touched element ids: the in-page interaction set plus
 * the Node-side referenced set.
 */
async function getTouched(exec) {
  let page = [];
  try { page = await exec(`Array.from(window.__touchedSel || [])`); } catch (_) { page = []; }
  return new Set([...(Array.isArray(page) ? page : []), ..._referenced]);
}

module.exports = { loadUiMap, flatten, sel, referencedIds, installRecorder, getTouched, UI_MAP_PATH };
