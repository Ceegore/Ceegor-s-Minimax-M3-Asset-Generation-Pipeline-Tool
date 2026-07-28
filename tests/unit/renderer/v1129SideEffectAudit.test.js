// tests/unit/renderer/v1129SideEffectAudit.test.js
// Side-effect audit for v1.1.29 changes.
//
// The structural / source-pinned tests in
// v1129BatchImportStyle.test.js + v1129BatchImportStyle.adversarial.test.js
// verify the source has the right lines in the right order. This
// audit goes one level deeper: it actually LOADS the helpers
// from batchImportHelper.js in a vm sandbox with mocked IPC
// and DOM, then asserts the OBSERVABLE side effects:
//
//   1) applyStyleToImportedBatch:
//      a) successful write: state.config is replaced by the
//         IPC's returned config, the new style is present in
//         state.config.styles, and _refreshAllStyleDropdowns
//         was called exactly once.
//      b) idempotence: a second call with the same (name, value)
//         does NOT call setConfig (zero IPC traffic).
//      c) IPC failure: state.config.styles is NOT mutated
//         (the pre-A4 leak).
//      d) name with '=': rejected, zero IPC traffic, state.config
//         unchanged.
//      e) empty name or empty value: rejected, zero IPC traffic.
//      f) overwriting an existing style with a NEW value: the new
//         value wins, the old entry of the same name is gone.
//
//   2) stampStyleOnImportedBatch:
//      a) writes style=name on every entry of every type
//      b) handles empty slots, non-object entries, missing fields
//      c) returns the same object reference (it's a mutator)
//      d) empty style name is a no-op
//
//   3) the applyStyleToImportedBatch DOES NOT mutate the in-memory
//      state.config.styles when the IPC fails. This is the
//      bug-A4 regression check — important because a leak there
//      would persist the unpersisted style into the NEXT
//      setConfig call (e.g. the user's next settings save).
//
// The helpers are loaded by evaluating batchImportHelper.js in a
// fresh vm context per test, with the per-test mocks as the
// sandbox globals. This is the same pattern the existing
// ensureSubDir test uses (tests/unit/renderer/ensureSubDir.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC_PATH = path.join(__dirname, '..', '..', '..', 'renderer', 'tabs', 'batchImportHelper.js');
const helperSrc = fs.readFileSync(SRC_PATH, 'utf8');

// Build a fresh vm sandbox for each test with per-test mocks.
// The helpers reference `state`, `window`, `toast`,
// `_refreshAllStyleDropdowns` as bare identifiers in the file's
// top-level scope. By providing per-test values for these
// globals in the sandbox, the helpers see them at call time.
function makeSandbox({ initialConfig, setConfigResult, setConfigImpl } = {}) {
  const calls = {
    setConfig: [],
    toast: [],
    refreshDropdowns: 0,
  };
  const state = {
    config: initialConfig || { styles: [] },
  };
  const setConfig = setConfigImpl
    ? async (cfg) => {
        calls.setConfig.push(JSON.parse(JSON.stringify(cfg)));
        return setConfigImpl(cfg);
      }
    : (setConfigResult === undefined
        ? async (cfg) => {
            calls.setConfig.push(JSON.parse(JSON.stringify(cfg)));
            return { ok: true, config: cfg };
          }
        : async (cfg) => {
            calls.setConfig.push(JSON.parse(JSON.stringify(cfg)));
            return setConfigResult;
          });
  const window = { api: { setConfig } };
  const toast = (msg, kind, ms) => { calls.toast.push({ msg, kind, ms }); };
  const _refreshAllStyleDropdowns = () => { calls.refreshDropdowns++; };

  // Build the sandbox: every bare identifier the file references
  // must resolve to a value we control. The four the helpers
  // actually use (state, window, toast, _refreshAllStyleDropdowns)
  // are the per-test values. The rest are minimal stubs — they
  // just need to be addressable so the file's top-level
  // function declarations can be hoisted and the IIFE-style
  // helper initialisation can run.
  const sandbox = makeStubs();
  sandbox.state = state;
  sandbox.window = window;
  sandbox.toast = toast;
  sandbox._refreshAllStyleDropdowns = _refreshAllStyleDropdowns;
  vm.createContext(sandbox);
  vm.runInContext(helperSrc, sandbox, { filename: 'batchImportHelper.js' });
  // The helpers attach to window.BatchManager (per the file's
  // bottom-of-file assignments). Pull them out of the sandbox.
  const batchManager = sandbox.window.BatchManager || {};
  return {
    state,
    window,
    calls,
    fns: {
      applyStyleToImportedBatch: batchManager.applyStyleToImportedBatch,
      stampStyleOnImportedBatch: batchManager.stampStyleOnImportedBatch,
    },
  };
}

function makeStubs() {
  return {
    window: { BatchManager: {} },
    state: { config: { styles: [] } },
    document: {
      addEventListener: () => {},
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => null,
    },
    console: { log: () => {}, error: () => {}, warn: () => {} },
    setTimeout: (fn) => fn && fn(),
    setInterval: () => 0,
    clearInterval: () => {},
    clearTimeout: () => {},
    el: () => null,
    $: () => null,
    $$: () => [],
    toast: () => {},
    showModal: () => {},
    _refreshAllStyleDropdowns: () => {},
    showRevealableKey: () => ({ row: { appendChild: () => {}, querySelector: () => null }, input: { value: '' }, getValue: () => '' }),
    helpButton: () => ({}),
    refreshBrowser: () => {},
    applyFileSearch: () => {},
    isItemVisibleInList: () => true,
    isSupportedAssetFile: () => true,
    SUPPORTED_FILE_EXTS: [],
    fbSelectAll: () => {},
    fbClearSelection: () => {},
    fbBulkAction: () => {},
    runImagePipelineBatch: () => {},
    renderFbDrivesList: () => {},
    openItem: () => {},
    notifyImageGenerated: () => {},
    markFbItemActive: () => {},
    previewImageFromFile: () => {},
    _stopPreviewMedia: () => {},
    _batchAbortByTab: {},
    refreshQuota: () => {},
    _refreshBatchButtons: () => {},
    _currentManualText: () => '',
    getStyleById: () => null,
    getStyleText: () => '',
    setStatus: () => {},
    ModelSpecs: { validateValues: () => ({ errors: [] }) },
    StyleHelpers: {},
    BatchManager: {},
    DropTarget: { attachDropTarget: () => {} },
    FbSort: { sortFbItems: (a) => a },
    SplitterDrag: { applyLayoutSettings: () => {} },
    ArchiveViewer: { open: () => {} },
    showAudioCutter: () => {},
    openFirstTimeSetup: () => {},
    openStyleSettings: () => {},
    openSettings: () => {},
    openFolderOptions: () => {},
    openAdvancedPipelineSettings: () => {},
    openOptionalAddons: () => {},
    showDiagnose: () => {},
    showTab: () => {},
    nextFreeForcePrefixPath: () => '',
    ensureSubDir: async () => '',
    startBatchGen: async () => ({ status: 'ok' }),
    _isTabRunningNow: () => false,
    scheduleStateSave: () => {},
    suppressStateSave: (fn) => fn && fn(),
    refreshTabStatusDots: () => {},
    armGenBtnWithCancel: () => () => {},
  };
}

// --- 1a) successful write ---
test('audit 1a: applyStyleToImportedBatch on a fresh install writes the new style to state.config.styles and replaces state.config wholesale', async () => {
  const { state, calls, fns } = makeSandbox({
    initialConfig: { api_key: 'k', output_dir: 'C:/out', styles: [] },
  });
  const r = await fns.applyStyleToImportedBatch({ name: 'Pixel Art', value: 'pixel art, 8-bit, neon' });
  assert.equal(r, 'Pixel Art');
  assert.equal(calls.setConfig.length, 1);
  const sentToMain = calls.setConfig[0];
  assert.deepEqual(sentToMain.styles, [{ name: 'Pixel Art', value: 'pixel art, 8-bit, neon' }]);
  assert.equal(sentToMain.api_key, 'k');
  assert.equal(sentToMain.output_dir, 'C:/out');
  assert.equal(state.config.styles.length, 1);
  assert.equal(state.config.styles[0].name, 'Pixel Art');
  assert.equal(calls.refreshDropdowns, 1);
});

// --- 1b) idempotence ---
test('audit 1b: second call with identical (name, value) does NOT call setConfig (A3 idempotence)', async () => {
  const { state, calls, fns } = makeSandbox({
    initialConfig: { styles: [{ name: 'Pixel Art', value: 'pixel art, 8-bit, neon' }] },
  });
  const r = await fns.applyStyleToImportedBatch({ name: 'Pixel Art', value: 'pixel art, 8-bit, neon' });
  assert.equal(r, 'Pixel Art');
  assert.equal(calls.setConfig.length, 0,
    'idempotent call must NOT call setConfig (the in-memory + on-disk state already match)');
  assert.equal(calls.refreshDropdowns, 0,
    'idempotent call must NOT refresh dropdowns (nothing changed)');
  assert.equal(state.config.styles.length, 1);
});

test('audit 1b-2: second call with the same name but a DIFFERENT value DOES call setConfig (A3 only short-circuits on identity)', async () => {
  const { calls, fns } = makeSandbox({
    initialConfig: { styles: [{ name: 'Pixel Art', value: 'OLD VALUE' }] },
  });
  const r = await fns.applyStyleToImportedBatch({ name: 'Pixel Art', value: 'NEW VALUE' });
  assert.equal(r, 'Pixel Art');
  assert.equal(calls.setConfig.length, 1, 'different value must re-persist');
  const sent = calls.setConfig[0];
  assert.equal(sent.styles.length, 1);
  assert.equal(sent.styles[0].value, 'NEW VALUE');
  assert.equal(sent.styles.filter((s) => s.name === 'Pixel Art').length, 1,
    'name collision must overwrite the existing entry, not add a duplicate');
});

// --- 1c) IPC failure: state.config.styles is NOT mutated ---
test('audit 1c: failed IPC does NOT leak the new style into state.config.styles (A4 fix)', async () => {
  const { state, calls, fns } = makeSandbox({
    initialConfig: { styles: [] },
    setConfigResult: { ok: false, error: 'disk full' },
  });
  const r = await fns.applyStyleToImportedBatch({ name: 'Pixel Art', value: 'pixel art' });
  assert.equal(r, '');
  assert.equal(calls.setConfig.length, 1);
  assert.equal(state.config.styles.length, 0,
    'A4 regression: state.config.styles was mutated even though the IPC failed. ' +
    'The next setConfig save would have leaked the unpersisted style into config.txt.');
  assert.ok(calls.toast.some((t) => t.msg.includes('disk full')),
    'a failed IPC must surface a toast with the error message');
  assert.equal(calls.refreshDropdowns, 0);
});

test('audit 1c-2: thrown IPC (network blip) also does NOT mutate state.config.styles (A4 fix)', async () => {
  const { state, calls, fns } = makeSandbox({
    initialConfig: { styles: [] },
    setConfigImpl: async () => { throw new Error('IPC offline'); },
  });
  const r = await fns.applyStyleToImportedBatch({ name: 'Pixel Art', value: 'pixel art' });
  assert.equal(r, '');
  assert.equal(calls.setConfig.length, 1);
  assert.equal(state.config.styles.length, 0,
    'A4 regression: a thrown IPC must also leave state.config.styles untouched');
});

// --- 1d) name with '=' ---
test('audit 1d: name containing "=" is rejected up-front, no IPC call, state.config unchanged', async () => {
  const { state, calls, fns } = makeSandbox({
    initialConfig: { styles: [] },
  });
  const r = await fns.applyStyleToImportedBatch({ name: 'a=b', value: 'pixel art' });
  assert.equal(r, '');
  assert.equal(calls.setConfig.length, 0, 'name with "=" must never reach setConfig');
  assert.equal(state.config.styles.length, 0);
  assert.ok(calls.toast.some((t) => t.kind === 'err' && t.msg.includes('=')),
    'a toast with kind="err" must explain the rejection');
});

// --- 1e) empty inputs ---
test('audit 1e: empty name OR empty value is rejected up-front, no IPC call', async () => {
  for (const input of [{}, { name: '' }, { value: '' }, { name: '   ', value: 'ok' }, { name: 'ok', value: '   ' }]) {
    const { calls, fns } = makeSandbox({ initialConfig: { styles: [] } });
    const r = await fns.applyStyleToImportedBatch(input);
    assert.equal(r, '', 'empty name/value must return ""');
    assert.equal(calls.setConfig.length, 0, 'empty name/value must NOT call setConfig');
  }
});

// --- 1f) overwriting an existing style with a new value ---
test('audit 1f: a name collision (different value) replaces the existing entry, not appends', async () => {
  const { state, calls, fns } = makeSandbox({
    initialConfig: { styles: [{ name: 'Pixel Art', value: 'OLD' }, { name: 'Other', value: 'kept' }] },
  });
  await fns.applyStyleToImportedBatch({ name: 'Pixel Art', value: 'NEW' });
  assert.equal(calls.setConfig.length, 1);
  const sent = calls.setConfig[0];
  assert.equal(sent.styles.length, 2);
  assert.deepEqual(
    sent.styles.find((s) => s.name === 'Pixel Art'),
    { name: 'Pixel Art', value: 'NEW' },
  );
  assert.deepEqual(
    sent.styles.find((s) => s.name === 'Other'),
    { name: 'Other', value: 'kept' },
    'unrelated styles must be preserved across the merge',
  );
  assert.equal(state.config.styles.length, 2);
});

// --- 2) stampStyleOnImportedBatch ---
test('audit 2a: stampStyleOnImportedBatch writes style=name on every entry of every type', () => {
  const { fns } = makeSandbox();
  const importedBatches = {
    image: [{ prompt: 'a' }, { prompt: 'b' }],
    speech: [{ prompt: 's' }],
    music: [{ prompt: 'm1' }, { prompt: 'm2' }, { prompt: 'm3' }],
    video: [{ prompt: 'v' }],
  };
  fns.stampStyleOnImportedBatch(importedBatches, 'Pixel Art');
  for (const list of Object.values(importedBatches)) {
    for (const e of list) {
      assert.equal(e.style, 'Pixel Art', 'every entry must carry the style');
    }
  }
});

test('audit 2b: stampStyleOnImportedBatch handles missing slots, non-object entries, and unrecognised types', () => {
  const { fns } = makeSandbox();
  const importedBatches = {
    image: [
      null,
      undefined,
      'legacy-string-entry',
      { prompt: 'ok' },
      { prompt: 'with-style', style: 'OLD' },
    ],
    music: [{ prompt: 'm' }],
    video: [{ prompt: 'v' }],
  };
  assert.doesNotThrow(() => fns.stampStyleOnImportedBatch(importedBatches, 'Pixel Art'));
  assert.equal(importedBatches.image[3].style, 'Pixel Art');
  assert.equal(importedBatches.image[4].style, 'Pixel Art', 'existing style must be overwritten');
  assert.equal(importedBatches.image[2], 'legacy-string-entry');
  assert.equal(importedBatches.music[0].style, 'Pixel Art');
  assert.equal(importedBatches.video[0].style, 'Pixel Art');
});

test('audit 2c: stampStyleOnImportedBatch returns the same object reference (mutator contract)', () => {
  const { fns } = makeSandbox();
  const importedBatches = { image: [{ prompt: 'a' }], speech: [], music: [], video: [] };
  const r = fns.stampStyleOnImportedBatch(importedBatches, 'X');
  assert.equal(r, importedBatches, 'must return the same object reference');
});

test('audit 2d: stampStyleOnImportedBatch with empty style name is a no-op', () => {
  const { fns } = makeSandbox();
  const importedBatches = { image: [{ prompt: 'a', style: 'OLD' }], speech: [], music: [], video: [] };
  fns.stampStyleOnImportedBatch(importedBatches, '');
  fns.stampStyleOnImportedBatch(importedBatches, '   ');
  fns.stampStyleOnImportedBatch(importedBatches, null);
  fns.stampStyleOnImportedBatch(importedBatches, undefined);
  assert.equal(importedBatches.image[0].style, 'OLD', 'empty/whitespace/null style name must not overwrite existing style');
});

// --- 3) end-to-end config shape still round-trips through the schema ---
test('audit 3: a config that includes v1.1.29 fields round-trips through sanitize() unchanged', () => {
  const { sanitize } = require('../../../main/models/ConfigSchema');
  const cfg = {
    api_key: 'k',
    output_dir: 'C:/out',
    region: 'global',
    theme: 'dark',
    styles: [
      { name: 'Pixel Art', value: 'pixel art, 8-bit, neon' },
      { name: 'Watercolour', value: 'watercolour, soft lighting' },
    ],
  };
  const out = sanitize(cfg);
  assert.deepEqual(out.styles, cfg.styles,
    'all valid styles must round-trip through sanitize() unchanged');
  const cfgMod = require('../../../src/config');
  const ser = cfgMod.serialize(out);
  const re = cfgMod.parse(ser);
  assert.deepEqual(re.styles, cfg.styles,
    'a config with v1.1.29 styles must round-trip through serialize/parse unchanged');
});
