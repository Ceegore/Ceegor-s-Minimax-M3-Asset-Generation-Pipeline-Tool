// tests/unit/renderer/fbSelectAllFilters.h047.test.js
// ============================================================================
// H-047 (_5 audit) regression: the file browser's "Select all" must honour
// the ACTIVE text search (#fb-search) and type filter (#fb-type-filter), not
// just the global "supported files" gate. Before the fix, fbSelectAll()
// filtered state._fbItems with isItemVisibleInList() alone, so files hidden
// by the search box or the type dropdown silently entered the bulk selection
// and could then be deleted / moved by fbBulkAction.
//
// The fix introduces ONE shared predicate — matchesFileBrowserFilters(it,
// filterState) — consumed by BOTH applyFileSearch (rendered-row visibility)
// and fbSelectAll (selection eligibility). This test loads the REAL
// renderer/services/fileBrowser1.js and verifies:
//   1. the pure predicate's truth table (type filter, text query, dirs),
//   2. fbSelectAll end-to-end excludes hidden files from the selection,
//   3. source guards pin the wiring so a future edit can't silently revert.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const FB1 = path.join(ROOT, 'renderer', 'services', 'fileBrowser1.js');

// ---------------------------------------------------------------------------
// Minimal window/DOM mock — just enough for fileBrowser1.js to execute its
// top-level declarations and write its helpers onto window. Mirrors the
// approach in realCodeHarness.test.js (no jsdom in the project's deps).
// ---------------------------------------------------------------------------
function setupWindowMock(searchValue, typeFilterValue) {
  delete global.window;
  delete global.document;
  delete global.$;
  delete global.$$;

  const win = {
    api: {
      fbList: async () => ({ ok: true, dir: '/tmp', parent: '/', items: [] }),
      fbMkdir: async () => ({ ok: true }),
      fbExists: async () => ({ ok: true, exists: false }),
      fbSetActiveDir: async () => ({ ok: true }),
      defaultOutputDir: async () => ({ ok: true, dir: '/tmp' }),
    },
    state: { fbShowAllFiles: false, config: { output_dir: '' } },
    toast: () => {},
    DropTarget: { attachDropTarget: () => {} },
    GrantHelper: { ensureDirList: async () => ({ ok: true, grantId: 'g' }) },
    dispatchEvent: () => true,
  };
  win.CustomEvent = function CustomEvent(type, opts) { this.type = type; this.detail = opts && opts.detail; };
  win.document = { getElementById: () => null, querySelectorAll: () => [], body: {} };

  // $ returns a stub element whose .value reflects the active filters for
  // the two inputs currentFbFilterState() reads; null for everything else
  // (so render paths bail early).
  global.$ = (sel) => {
    if (sel === '#fb-search') return { value: searchValue || '' };
    if (sel === '#fb-type-filter') return { value: typeFilterValue || '' };
    return null;
  };
  global.$$ = () => [];
  // fbSelectAll calls sortFbItems (defined in renderer/utils/fbSort.js, a
  // separate <script>) — provide an identity stub so the selection logic
  // runs without loading the whole renderer.
  global.sortFbItems = (items) => items;

  global.window = win;
  global.document = win.document;
  return win;
}

function loadFb1() {
  delete require.cache[require.resolve(FB1)];
  try {
    require(FB1);
  } catch (e) {
    // The module fires refreshBrowser() at load; deeper render calls may
    // throw against the null-DOM stubs. The helpers we test are written to
    // window BEFORE those render paths, so we proceed regardless.
    if (!String(e).match(/output|sort|applyFileSearch|render|Cannot read|undefined|null/i)) throw e;
  }
  return global.window;
}

// ---------------------------------------------------------------------------
// 1. Pure predicate truth table.
// ---------------------------------------------------------------------------
test('H-047: matchesFileBrowserFilters truth table (type filter + text query)', () => {
  const win = setupWindowMock('', '');
  loadFb1();
  const matches = win.matchesFileBrowserFilters;
  assert.equal(typeof matches, 'function', 'predicate must be exposed on window');

  const png = { name: 'hero.png', ext: '.png', isDir: false };
  const mp3 = { name: 'song.mp3', ext: '.mp3', isDir: false };
  const dir = { name: 'generated', ext: '', isDir: true };

  // No filters -> everything passes.
  const none = { query: '', typeSet: null };
  assert.equal(matches(png, none), true);
  assert.equal(matches(mp3, none), true);
  assert.equal(matches(dir, none), true);

  // Type filter "png" -> png passes, mp3 hidden, dir always passes.
  const pngOnly = { query: '', typeSet: new Set(['png']) };
  assert.equal(matches(png, pngOnly), true, 'png matches the png type filter');
  assert.equal(matches(mp3, pngOnly), false, 'mp3 must be hidden by the png type filter');
  assert.equal(matches(dir, pngOnly), true, 'directories always pass the type filter');

  // Type filter is bare extensions; item ext carries a leading dot — the
  // predicate must normalise the dot away before comparing.
  assert.equal(matches({ name: 'a.PNG', ext: '.PNG', isDir: false }, pngOnly), true,
    'case + leading-dot normalisation');

  // Text query applies to files AND directories.
  const heroQ = { query: 'hero', typeSet: null };
  assert.equal(matches(png, heroQ), true);
  assert.equal(matches(mp3, heroQ), false, 'non-matching name hidden by text query');
  assert.equal(matches(dir, heroQ), false, 'directories are subject to the text query too');

  // Combined: type png AND query "hero".
  const both = { query: 'hero', typeSet: new Set(['png']) };
  assert.equal(matches(png, both), true);
  assert.equal(matches({ name: 'hero.mp3', ext: '.mp3', isDir: false }, both), false,
    'name matches but type does not -> hidden');
  assert.equal(matches({ name: 'other.png', ext: '.png', isDir: false }, both), false,
    'type matches but name does not -> hidden');

  // Defensive: null item / missing filterState.
  assert.equal(matches(null, none), false);
  assert.equal(matches(png, undefined), true, 'missing filterState = no filtering');
});

// ---------------------------------------------------------------------------
// 2. currentFbFilterState parses the two inputs.
// ---------------------------------------------------------------------------
test('H-047: currentFbFilterState reads #fb-search + #fb-type-filter', () => {
  const win = setupWindowMock('  Hero ', 'png, mp3 ,, wav');
  loadFb1();
  const fState = win.currentFbFilterState();
  assert.equal(fState.query, '  hero ', 'query is lowercased but NOT trimmed (matches applyFileSearch)');
  assert.ok(fState.typeSet instanceof Set, 'type filter parsed into a Set');
  assert.deepEqual([...fState.typeSet].sort(), ['mp3', 'png', 'wav'], 'bare, trimmed, lowercased extensions');

  // Empty type filter -> null (no type filtering).
  const win2 = setupWindowMock('', '');
  delete require.cache[require.resolve(FB1)];
  try { require(FB1); } catch (_) {}
  assert.equal(global.window.currentFbFilterState().typeSet, null, 'empty dropdown = no type filter');
});

// ---------------------------------------------------------------------------
// 3. End-to-end: fbSelectAll must NOT select files hidden by the filters.
//    This is the actual bug: hidden MP3s used to land in the bulk selection.
// ---------------------------------------------------------------------------
test('H-047: fbSelectAll excludes files hidden by the text search', () => {
  const win = setupWindowMock('hero', ''); // search box hides song.mp3
  loadFb1();
  win.state._fbItems = [
    { name: 'hero.png', ext: '.png', isDir: false, path: '/tmp/hero.png' },
    { name: 'song.mp3', ext: '.mp3', isDir: false, path: '/tmp/song.mp3' },
    { name: 'generated', ext: '', isDir: true, path: '/tmp/generated' },
  ];
  win.state.fbSelected = new Set();
  // The selection is populated BEFORE the post-selection re-render, and
  // the re-render (renderFbList) throws against the null-DOM stub. Catch
  // it — fbSelected already holds the answer we assert on.
  try { win.fbSelectAll(); } catch (_) {}
  const sel = [...win.state.fbSelected];
  assert.ok(sel.includes('/tmp/hero.png'), 'visible matching file is selected');
  assert.ok(!sel.includes('/tmp/song.mp3'), 'file hidden by the text search must NOT be selected');
  assert.ok(!sel.includes('/tmp/generated'), 'directory not matching the query must NOT be selected');
});

test('H-047: fbSelectAll excludes files hidden by the type filter', () => {
  const win = setupWindowMock('', 'png'); // type dropdown = images only
  loadFb1();
  win.state._fbItems = [
    { name: 'hero.png', ext: '.png', isDir: false, path: '/tmp/hero.png' },
    { name: 'song.mp3', ext: '.mp3', isDir: false, path: '/tmp/song.mp3' },
    { name: 'generated', ext: '', isDir: true, path: '/tmp/generated' },
  ];
  win.state.fbSelected = new Set();
  try { win.fbSelectAll(); } catch (_) {} // re-render throws on null DOM (post-selection)
  const sel = [...win.state.fbSelected];
  assert.ok(sel.includes('/tmp/hero.png'), 'png passes the type filter');
  assert.ok(!sel.includes('/tmp/song.mp3'), 'mp3 hidden by the type filter must NOT be selected');
  assert.ok(sel.includes('/tmp/generated'), 'directories always pass the type filter');
});

test('H-047: fbSelectAll with no active filters selects every visible item', () => {
  const win = setupWindowMock('', ''); // no search, no type filter
  loadFb1();
  win.state._fbItems = [
    { name: 'hero.png', ext: '.png', isDir: false, path: '/tmp/hero.png' },
    { name: 'song.mp3', ext: '.mp3', isDir: false, path: '/tmp/song.mp3' },
    { name: 'generated', ext: '', isDir: true, path: '/tmp/generated' },
  ];
  win.state.fbSelected = new Set();
  try { win.fbSelectAll(); } catch (_) {} // re-render throws on null DOM (post-selection)
  const sel = [...win.state.fbSelected].sort();
  assert.deepEqual(sel, ['/tmp/generated', '/tmp/hero.png', '/tmp/song.mp3'],
    'with no filters, all supported items are selected');
});

// ---------------------------------------------------------------------------
// 4. Source guards: pin the wiring so a future edit can't silently revert
//    fbSelectAll to the isItemVisibleInList-only behaviour.
// ---------------------------------------------------------------------------
test('H-047: source guards — fbSelectAll + applyFileSearch share the predicate', () => {
  const raw = fs.readFileSync(FB1, 'utf8');
  // Strip comment lines so explanatory prose can't satisfy / defeat a guard.
  const code = raw.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  const fnMatch = code.match(/function fbSelectAll\(\)[\s\S]*?\n\}/);
  assert.ok(fnMatch, 'fbSelectAll must exist');
  const fn = fnMatch[0];
  assert.match(fn, /currentFbFilterState\(\)/, 'fbSelectAll must read the live filter state');
  assert.match(fn, /matchesFileBrowserFilters\(it, fState\)/,
    'fbSelectAll must gate selection on the shared predicate');
  assert.match(fn, /isItemVisibleInList\(it\) && matchesFileBrowserFilters/,
    'both gates must apply (supported-types AND search/type filter)');

  // applyFileSearch must consume the SAME predicate (lock-step visibility).
  const afs = code.match(/function applyFileSearch\(\)[\s\S]*?\n\}/);
  assert.ok(afs, 'applyFileSearch must exist');
  assert.match(afs[0], /matchesFileBrowserFilters\(rowItem, fState\)/,
    'applyFileSearch must delegate row visibility to the shared predicate');

  // Both helpers exposed on window.
  assert.match(code, /window\.matchesFileBrowserFilters = matchesFileBrowserFilters/);
  assert.match(code, /window\.currentFbFilterState = currentFbFilterState/);
});
