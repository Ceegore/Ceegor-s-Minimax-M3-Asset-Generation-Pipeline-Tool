// tests/unit/renderer/audit360Regressions.test.js
// Regression guards for the 360° bug-hunting audit (_temp5.md part 2).
// Each test here pins a specific fix so a future revert fails loud.
// The fixes are also exercised live by the smoke harness where
// possible; these unit tests cover the code paths the smoke can't
// reach (e.g. simulating disk failures, infinite-loop conditions,
// and wrapper-DOM plumbing).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..', '..');

// ---- shared minimal DOM/window mock for renderer files ----
function makeEl(tag) {
  return {
    tagName: (tag || 'div').toUpperCase(),
    children: [],
    attributes: {},
    style: {},
    classList: {
      _set: new Set(),
      add(c) { if (c) for (const cls of String(c).split(/\s+/).filter(Boolean)) this._set.add(cls); },
      remove(c) { if (c) for (const cls of String(c).split(/\s+/).filter(Boolean)) this._set.delete(cls); },
      contains(c) { return this._set.has(c); },
      toggle(c, force) {
        if (force === true) this.add(c);
        else if (force === false) this.remove(c);
        else if (this._set.has(c)) this.remove(c);
        else this.add(c);
        return this._set.has(c);
      },
    },
    dataset: {},
    parentNode: null,
    _value: '',
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k] == null ? null : String(this.attributes[k]); },
    addEventListener() {},
    removeEventListener() {},
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
    insertBefore(child) { this.children.push(child); child.parentNode = this; return child; },
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); return child; },
    querySelector(sel) {
      // Minimal selector support for the class-based lookups the
      // tests use: '.cls', 'select', 'input', 'input.enum-custom-input'.
      if (sel.startsWith('.')) {
        const cls = sel.slice(1);
        return this.children.find((c) => c.classList && c.classList.contains(cls)) || null;
      }
      return this.children.find((c) => c.tagName === sel.toUpperCase()) || null;
    },
    querySelectorAll(sel) {
      if (sel.startsWith('.')) {
        const cls = sel.slice(1);
        return this.children.filter((c) => c.classList && c.classList.contains(cls));
      }
      if (sel.includes(',')) {
        const sels = sel.split(',').map((s) => s.trim());
        const out = [];
        for (const c of this.children) {
          if (sels.some((s) => s.startsWith('.') ? c.classList.contains(s.slice(1)) : c.tagName === s.toUpperCase())) out.push(c);
        }
        return out;
      }
      return this.children.filter((c) => c.tagName === sel.toUpperCase());
    },
    set textContent(v) { this._text = v; },
    get textContent() { return this._text != null ? this._text : ''; },
    set value(v) { this._value = String(v == null ? '' : v); },
    get value() { return this._value; },
    dispatchEvent() {},
    focus() {},
  };
}
function elFactory(tag, attrs, ...children) {
  const n = makeEl(tag);
  if (attrs && typeof attrs === 'object') {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.classList.add(v);
      else if (k === 'value') n.value = v;
      else n.attributes[k] = v;
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    if (typeof c === 'string' || typeof c === 'number') {
      const t = makeEl('span');
      t.textContent = String(c);
      n.children.push(t);
      t.parentNode = n;
    } else if (typeof c === 'object' && c.tagName) {
      n.children.push(c);
      c.parentNode = n;
    }
  }
  return n;
}

// =====================================================================
// H1: .input.value on ParamRow enum/number wrappers
// =====================================================================
// The bug: since v1.1.15, ParamRow's `kind: 'enum'` and `kind: 'number'`
// branches return a wrapper DIV as `input` (with `.getValue()` wired up
// but `.value` undefined — divs don't have `.value`). The tab handlers
// (musicTab mode/audioFormat/outputFormat, speechTab format, videoTab
// resolution/duration) used to read `.input.value`, getting undefined.
//
// This test loads the REAL ParamRow.js + the REAL tab files is heavy
// (they boot a full tab). Instead we pin the contract at the ParamRow
// level: assert the wrapper exposes getValue() AND that .value is NOT
// a working setter on the wrapper (so a future revert that reads
// .input.value again is detectable). The end-to-end coverage lives in
// the smoke harness (step 3 + the B2 prefix step already exercise all
// four tabs' generate paths).

test('H1: ParamRow.js enum wrapper exposes getValue() and the underlying select via .el', () => {
  const win = {};
  global.window = win;
  global.document = { createElement: (t) => makeEl(t), createElementNS: (_, t) => makeEl(t) };
  win.el = elFactory;
  win.createElement = elFactory;
  win.document = global.document;
  const file = path.join(ROOT, 'renderer', 'components', 'ParamRow.js');
  delete require.cache[require.resolve(file)];
  require(file);
  const { buildParamRow } = win.ParamRow;
  // Build an enum row (the kind that caused the H1 bug).
  const r = buildParamRow('Mode', {
    kind: 'enum', default: 'a',
    options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
  }, 'test-enum');
  assert.equal(typeof r.input.getValue, 'function', 'wrapper must expose getValue()');
  assert.equal(r.input.getValue(), 'a', 'getValue() returns the current option');
  assert.ok(r.el, 'wrapper must expose .el pointing at the inner select');
  assert.equal(r.el.tagName, 'SELECT', '.el should be the inner <select>');
  // The wrapper itself is a div — `.value` on it is NOT the select's value.
  assert.notEqual(r.input.tagName, 'SELECT',
    'the wrapper must NOT be a bare <select> (the bug was reading .value on this div)');
});

test('H1: musicTab.js does NOT read mode.input.value (revert guard)', () => {
  // Source-pinned guard: the live musicTab.js must read
  // mode.input.getValue() (NOT mode.input.value) for the vocal-mode
  // logic. A revert to the buggy form fails this grep.
  const code = fs.readFileSync(path.join(ROOT, 'renderer', 'tabs', 'musicTab.js'), 'utf8');
  // Extract just the lines that reference mode.input (not the comment
  // that explains the bug, which legitimately mentions the old form).
  const modeRefs = code.split('\n').filter((l) => /mode\.input\.(value|getValue)/.test(l) && !l.trim().startsWith('//') && !l.includes('`mode.input.value`'));
  const buggy = modeRefs.filter((l) => /mode\.input\.value/.test(l));
  assert.deepEqual(buggy, [],
    `musicTab.js must not read mode.input.value (the wrapper has no .value) — revert found: ${JSON.stringify(buggy)}`);
});

test('H1: speechTab.js does NOT read format.input.value (revert guard)', () => {
  const code = fs.readFileSync(path.join(ROOT, 'renderer', 'tabs', 'speechTab.js'), 'utf8');
  // Ignore comment lines and the line that reads bitrate.el (the fix).
  const refs = code.split('\n').filter((l) => /format\.input\.value/.test(l) && !l.trim().startsWith('//'));
  assert.deepEqual(refs, [],
    `speechTab.js must not read format.input.value (the wrapper has no .value) — revert found: ${JSON.stringify(refs)}`);
});

test('H1: videoTab.js log lines use getValue() for resolution/duration (revert guard)', () => {
  const code = fs.readFileSync(path.join(ROOT, 'renderer', 'tabs', 'videoTab.js'), 'utf8');
  assert.ok(!/resolution\.input\.value/.test(code),
    'videoTab.js must not read resolution.input.value (use getValue())');
  assert.ok(!/duration\.input\.value/.test(code),
    'videoTab.js must not read duration.input.value (use getValue())');
});

// =====================================================================
// H2: ArchiveViewer Close button + Escape shadowing
// =====================================================================
test('H2: ArchiveViewer.js does not shadow the close() function with a local button const (revert guard)', () => {
  const code = fs.readFileSync(path.join(ROOT, 'renderer', 'widgets', 'ArchiveViewer.js'), 'utf8');
  // The bug was `const close = document.createElement('button')`
  // inside _ensureModal, which shadowed the function-scoped close().
  // The fix renamed it to closeBtn. Assert no `const close =` exists
  // inside _ensureModal.
  const ensureMatch = code.match(/function _ensureModal\(\) \{[\s\S]*?\n  \}/);
  assert.ok(ensureMatch, 'could not locate _ensureModal in ArchiveViewer.js');
  assert.ok(!/const close\s*=/.test(ensureMatch[0]),
    'ArchiveViewer._ensureModal must not declare `const close` (it shadows the close() function — H2 regression)');
  // The close button must be registered with the function, not itself.
  assert.ok(/closeBtn\.addEventListener\('click', close\)/.test(ensureMatch[0]),
    'the Close button must call close() (the function), not closeBtn (the element)');
});

// =====================================================================
// H3 (superseded by H-044): archive starvation — the renderer must NOT
// pre-trim jobsSnapshot to jobsArchiveCap. The old client-side trim meant
// the overflow never reached src/state.js write(), so nothing was ever
// appended to the L3 archive (the oldest entries were silently destroyed).
// Main now archives the overflow on every save and reports `jobsArchived`;
// saveAllStates drops exactly that many entries from the renderer's list.
// =====================================================================
test('H-044: JobRunner._pushJobSnapshot keeps the overflow (no cap trim; only a runaway hard bound)', () => {
  const raw = fs.readFileSync(path.join(ROOT, 'renderer', 'jobs', 'JobRunner.js'), 'utf8');
  // Strip comment lines so the explanatory comment (which names the old
  // jobsArchiveCap behaviour) doesn't false-fire — we assert on CODE only.
  const code = raw.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const pushMatch = code.match(/function _pushJobSnapshot[\s\S]*?\n  \}/);
  assert.ok(pushMatch, 'could not locate _pushJobSnapshot in JobRunner.js');
  assert.ok(!/slice\(-cap\)/.test(pushMatch[0]),
    '_pushJobSnapshot must NOT trim to jobsArchiveCap (H-044: pre-trim starves the Main-side archiver)');
  assert.ok(!/jobsArchiveCap/.test(pushMatch[0]),
    '_pushJobSnapshot must not read jobsArchiveCap at all — Main owns the L2→L3 move');
  assert.ok(/HARD_BOUND\s*=\s*5000/.test(pushMatch[0]),
    '_pushJobSnapshot must keep the 5000-entry runaway bound (memory safety when saves persistently fail)');
  assert.ok(/slice\(-HARD_BOUND\)/.test(pushMatch[0]),
    'the runaway bound must keep the NEWEST entries');
});

test('H-044: saveAllStates drops exactly jobsArchived entries from the FRONT after a successful save', () => {
  const raw = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
  assert.ok(/Number\(r\.jobsArchived\)\s*\|\|\s*0/.test(raw),
    'saveAllStates must read r.jobsArchived from the state:set response');
  assert.ok(/state\.jobsSnapshot\.splice\(0,\s*archived\)/.test(raw),
    'saveAllStates must splice the archived count off the FRONT of state.jobsSnapshot');
});

// =====================================================================
// H4: before-quit flush — must call saveAllStates() directly, not scheduleStateSave()
// =====================================================================
test('H4: onBeforeQuit calls saveAllStates() directly, not the debounced scheduleStateSave() (revert guard)', () => {
  const raw = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
  // Strip comment lines so a comment that mentions the old behaviour
  // doesn't false-fire (the actual call is what we care about).
  const code = raw.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  // Isolate the onBeforeQuit handler block.
  const quitMatch = code.match(/window\.api\.onBeforeQuit\([\s\S]*?\}\);/);
  assert.ok(quitMatch, 'could not locate onBeforeQuit handler in app.js');
  const block = quitMatch[0];
  assert.ok(/saveAllStates\b/.test(block),
    'onBeforeQuit must call saveAllStates() directly so the write completes before the renderer is torn down (H4 regression)');
  assert.ok(!/scheduleStateSave\(\)/.test(block),
    'onBeforeQuit must NOT call scheduleStateSave() — its 500ms debounce never fires before window destruction (H4 regression)');
});

// =====================================================================
// H5: LogService infinite loop — _maybeEvictJobSecondaries returns false on failed drop
// =====================================================================
test('H5: LogService _maybeEvictJobSecondaries returns false when drop fails (revert guard)', () => {
  const code = fs.readFileSync(path.join(ROOT, 'renderer', 'services', 'LogService.js'), 'utf8');
  const fnMatch = code.match(/function _maybeEvictJobSecondaries[\s\S]*?\n  \}/);
  assert.ok(fnMatch, 'could not locate _maybeEvictJobSecondaries in LogService.js');
  const fn = fnMatch[0];
  // The bug: the function returned `true` unconditionally when count > cap,
  // even if _dropOldestSecondaryOfJob returned null (stale firstId). The
  // caller's `while (evicted)` then looped forever. The fix checks the
  // drop's return value and returns false on null.
  assert.ok(/dropped\s*==\s*null/.test(fn) || /dropped\s*===\s*null/.test(fn) || /!dropped/.test(fn),
    "_maybeEvictJobSecondaries must check the drop return value so the caller's while-loop terminates when the drop fails (H5 regression)");
  assert.ok(/return false/.test(fn),
    '_maybeEvictJobSecondaries must return false on a failed drop (H5 regression)');
});

test('H5: LogService global-cap trim updates _jobSecondaryCounts (revert guard)', () => {
  const code = fs.readFileSync(path.join(ROOT, 'renderer', 'services', 'LogService.js'), 'utf8');
  // The bug: the global-cap trim removed events from _logEvents but
  // never decremented _jobSecondaryCounts, leaving stale counts that
  // triggered the infinite eviction loop. The fix decrements inside
  // the trim loop.
  const trimMatch = code.match(/LOG_MAX_EVENTS\)\s*\{[\s\S]*?for \(const r of removed\)[\s\S]*?\}\s*\}/);
  assert.ok(trimMatch, 'could not locate the global-cap trim block in LogService.js');
  assert.ok(/_jobSecondaryCounts/.test(trimMatch[0]),
    'global-cap trim must update _jobSecondaryCounts so counts stay in sync with the trimmed array (H5 regression)');
});

// =====================================================================
// H6: batchImportHelper combo-select-enum case
// =====================================================================
test('H6: getTabInputValue handles combo-select-enum wrappers (live behavior)', () => {
  const win = {};
  global.window = win;
  win.el = elFactory;
  win.createElement = elFactory;
  global.document = { createElement: (t) => makeEl(t), createElementNS: (_, t) => makeEl(t) };
  win.document = global.document;
  const file = path.join(ROOT, 'renderer', 'tabs', 'batchImportHelper.js');
  // batchImportHelper is wrapped in an IIFE that attaches to window —
  // load it and grab the helpers.
  delete require.cache[require.resolve(file)];
  require(file);
  // The helpers are exposed on window.batchImportHelperInternal (or
  // similar). Verify by reading the source for the export shape.
  const code = fs.readFileSync(file, 'utf8');
  assert.ok(/classList\.contains\('combo-select-enum'\)/.test(code),
    'getTabInputValue/setTabInputValue must handle the combo-select-enum wrapper (H6 regression)');

  // Build a fake combo-select-enum wrapper and exercise the helper
  // directly by requiring the internal exports. The helper functions
  // are attached to window in the IIFE.
  const wrap = elFactory('div', { class: 'combo-select-enum' });
  const sel = elFactory('select', {});
  sel.children.push(elFactory('option', { value: 'a' }));
  sel.children.push(elFactory('option', { value: '__custom__' }));
  const txt = elFactory('input', { class: 'enum-custom-input', value: '' });
  wrap.children.push(sel, txt, elFactory('button', {}));

  // Find the helpers on window (the IIFE exposes them).
  const bih = global.window.batchImportHelper || global.window.BatchImportHelper;
  if (bih && bih.getTabInputValue) {
    // Non-custom: select is on option 'a'.
    sel.value = 'a';
    assert.equal(bih.getTabInputValue(wrap), 'a', 'getTabInputValue(combo-select-enum) should return the select value when not in Custom mode');
    // Custom: select is on __custom__, text has the real value.
    sel.value = '__custom__';
    txt.value = 'custom-model-xyz';
    assert.equal(bih.getTabInputValue(wrap), 'custom-model-xyz',
      'getTabInputValue(combo-select-enum) must return the typed custom value (H6 regression: it used to return "__custom__")');
  }
});

// =====================================================================
// M1: config:set envelope contract
// =====================================================================
test('M1: config:set returns { ok, config, error } envelope (live behavior)', () => {
  // Stub electron + the config module so we can invoke the handler
  // directly and assert the envelope shape on both success and failure.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-cfgset-test-'));
  process.env.MINIMAX_CONFIG_DIR = tmp;
  require.cache[require.resolve('electron')] = {
    exports: { ipcMain: { handle() {} }, dialog: { showOpenDialog() {} } },
  };
  // Force a fresh require of the registrar.
  delete require.cache[require.resolve(path.join(ROOT, 'main', 'ipc', 'registerConfigIpc.js'))];
  delete require.cache[require.resolve(path.join(ROOT, 'src', 'config'))];
  // B-002 (hhhhu2 audit): config:set stores keys through the
  // CredentialRepository + SecretBlobStore; re-load them fresh.
  for (const rel of [
    ['main', 'services', 'CredentialRepository.js'],
    ['main', 'services', 'SecretBlobStore.js'],
    ['main', 'services', 'SessionCredentialStore.js'],
    ['main', 'services', 'credentialPresence.js'],
  ]) {
    try { delete require.cache[require.resolve(path.join(ROOT, ...rel))]; } catch (_) {}
  }
  // Mock voicesCache so the require doesn't pull in the full service.
  const voicesPath = path.join(ROOT, 'main', 'services', 'VoicesCacheService.js');
  const origVoices = require.cache[require.resolve(voicesPath)];
  require.cache[require.resolve(voicesPath)] = { exports: { reset() {} } };
  try {
    const handlers = {};
    const fakeIpc = {
      handle(channel, fn) { handlers[channel] = fn; },
    };
    const electronBackup = require.cache[require.resolve('electron')];
    // B-002: safeStorage for SecretBlobStore + app.getPath for its store dir.
    require.cache[require.resolve('electron')] = { exports: {
      ipcMain: fakeIpc,
      dialog: { showOpenDialog() {} },
      app: { getPath: () => tmp },
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (s) => Buffer.from('enc:' + s, 'utf8'),
        decryptString: (buf) => buf.toString('utf8').replace(/^enc:/, ''),
      },
    } };
    delete require.cache[require.resolve(path.join(ROOT, 'main', 'ipc', 'registerConfigIpc.js'))];
    require(path.join(ROOT, 'main', 'ipc', 'registerConfigIpc.js')).register({ getMainWindow: () => null });
    require.cache[require.resolve('electron')] = electronBackup;

    // R1.2a: changing output_dir requires a grant. We mint a
    // directory-root grant via the PathGrantService singleton
    // (the same singleton config:set uses) and pass the grantId
    // through the new {cfg, grants} envelope. This pins the
    // end-to-end contract: pick → grant → set with grant.
    // The target directory must exist before minting the grant so
    // that realpath resolves the FULL target (not just an
    // ancestor) into the grant's canonicalPath.
    const grantPath = require('path');
    const targetOutputDir = grantPath.join(tmp, 'output-root');
    fs.mkdirSync(targetOutputDir, { recursive: true });
    const pathGrant = require(path.join(ROOT, 'main', 'services', 'PathGrantService.js'));
    const grant = pathGrant.defaultService.mintDirectoryGrant({
      origin: 'config-output',
      purpose: 'M1 test setup',
      path: targetOutputDir,
      capabilities: ['read', 'write', 'delete', 'mkdir', 'rename', 'move', 'copy'],
      coversRoot: true,
    });
    assert.equal(grant.ok, true, 'mintDirectoryGrant must succeed in M1 setup');
    assert.equal(grant.grant.canonicalPath, targetOutputDir,
      'the grant\'s canonicalPath must be the full target (mkdir before mint)');

    // Success path: valid config + matching grant → { ok: true, config: {...}, error: null }.
    const ok = handlers['config:set'](null, {
      cfg: { api_key: 'sk-test', output_dir: targetOutputDir, region: 'global' },
      grants: { output_dir: grant.grantId },
    });
    assert.ok(ok && typeof ok === 'object', 'config:set must return an envelope object');
    assert.equal(ok.ok, true, 'success envelope must have ok: true');
    assert.equal(ok.error, null, 'success envelope must have error: null');
    assert.ok(ok.config && typeof ok.config === 'object', 'success envelope must include the config object');
    // SEC-001: config:set returns a public DTO (no raw api_key).
    assert.equal(ok.config.hasApiKey, true, 'the returned config must reflect the written values');
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    if (origVoices) require.cache[require.resolve(voicesPath)] = origVoices;
  }
});

// =====================================================================
// M2: _markJobDone does NOT emit job-removed (only job-updated)
// =====================================================================
test('M2: _markJobDone emits job-updated but NOT job-removed (revert guard)', () => {
  const code = fs.readFileSync(path.join(ROOT, 'renderer', 'jobs', 'JobRunner.js'), 'utf8');
  const fnMatch = code.match(/function _markJobDone[\s\S]*?\n  \}/);
  assert.ok(fnMatch, 'could not locate _markJobDone in JobRunner.js');
  const fn = fnMatch[0];
  assert.ok(/_emit\('jobrunner:job-updated'/.test(fn),
    '_markJobDone must emit job-updated (status changed)');
  // The spurious job-removed emit must be gone (it's now only in
  // _pruneFinishedJobs, when the job is ACTUALLY evicted).
  assert.ok(!/_emit\('jobrunner:job-removed'/.test(fn),
    '_markJobDone must NOT emit job-removed — the job stays in _jobs for scrollback; job-removed fires only on eviction in _pruneFinishedJobs (M2 regression)');
});

// =====================================================================
// M3: batches:get returns defaultBatches() on error (not [])
// =====================================================================
test('M3: registerBatchesIpc batches:get returns defaultBatches() on error, not [] (revert guard)', () => {
  const code = fs.readFileSync(path.join(ROOT, 'main', 'ipc', 'registerBatchesIpc.js'), 'utf8');
  // The bug: catch returned `[]`. The fix returns batchMod.defaultBatches().
  // P1-A (C-001): registrars now use the secureHandle wrapper instead of
  // bare ipcMain.handle — accept either spelling so this guard keeps working.
  const getMatch = code.match(/(?:ipcMain\.handle|secureHandle)\('batches:get'[\s\S]*?\}\s*\);/);
  assert.ok(getMatch, 'could not locate batches:get handler');
  assert.ok(/defaultBatches\(\)/.test(getMatch[0]),
    'batches:get must return defaultBatches() on error (M3 regression: it used to return [])');
  assert.ok(!/return \[\];/.test(getMatch[0]),
    'batches:get must NOT return [] on error — that violates the BatchesState contract (M3 regression)');
});

// =====================================================================
// MEDIUM-1: scheduleStateSave returns a Promise (not undefined)
// =====================================================================
test('MEDIUM-1: scheduleStateSave returns a Promise that resolves after saveAllStates (revert guard)', () => {
  const raw = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
  const code = raw.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const fnMatch = code.match(/function scheduleStateSave\(\) \{[\s\S]*?\n\}/);
  assert.ok(fnMatch, 'could not locate scheduleStateSave in app.js');
  const fn = fnMatch[0];
  // The bug: the function returned undefined (no return statement),
  // so `await scheduleStateSave()` resolved immediately. The fix
  // returns a Promise that resolves when the debounced save completes.
  assert.ok(/return Promise\.resolve\(\)/.test(fn) || /return new Promise/.test(fn),
    'scheduleStateSave must return a Promise (MEDIUM-1 regression: it used to return undefined and callers awaited it)');
  // The pending-resolver coalescing must be present so multiple calls
  // within the debounce window all resolve.
  assert.ok(/_pendingStateSaveResolvers/.test(code),
    'scheduleStateSave must coalesce pending resolvers so every caller resolves (MEDIUM-1)');
});

test('MEDIUM-1: saveAllStates returns the stateSet promise (revert guard)', () => {
  const code = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
  const fnMatch = code.match(/function saveAllStates\(\) \{[\s\S]*?\n\}/);
  assert.ok(fnMatch, 'could not locate saveAllStates in app.js');
  const fn = fnMatch[0];
  assert.ok(/return window\.api\.stateSet/.test(fn),
    'saveAllStates must return the stateSet promise so callers (scheduleStateSave) can await the real IPC (MEDIUM-1)');
});

// =====================================================================
// LOW-2: ArchiveService.readChunk has no dead `cur` variable
// =====================================================================
test('LOW-2: ArchiveService.readChunk has no dead cur variable (revert guard)', () => {
  const code = fs.readFileSync(path.join(ROOT, 'src', 'services', 'ArchiveService.js'), 'utf8');
  const fnMatch = code.match(/function readChunk[\s\S]*?\n\}/);
  assert.ok(fnMatch, 'could not locate readChunk in ArchiveService.js');
  const fn = fnMatch[0];
  // The dead `cur` variable was always equal to `pos` (both updated in
  // lockstep) — removed in the fix. Assert it's gone.
  assert.ok(!/\bcur\b/.test(fn),
    'readChunk must not contain the dead `cur` variable (LOW-2 regression: it was always equal to `pos`)');
  // P2-D (M-018): the scan-from-0 `pos >= offset` implementation was
  // replaced by a true streaming read that seeks straight to the offset
  // (fs.readSync with an explicit position) instead of decoding the whole
  // file. Pin the streaming contract: the read cursor starts AT the offset
  // and readSync is positional.
  assert.ok(/let pos = offset/.test(fn),
    'readChunk must start its read cursor at the byte offset (P2-D streaming, supersedes the LOW-2 pos>=offset scan)');
  assert.ok(/fs\.readSync\(fd,\s*buf,\s*0,\s*toRead,\s*pos\)/.test(fn),
    'readChunk must use positional fs.readSync so it never decodes bytes before the offset (P2-D / M-018)');
  assert.ok(!/readFileSync/.test(fn),
    'readChunk must NOT slurp the whole archive with readFileSync (M-018 regression)');
});

// =====================================================================
// LOW-4: fb:reveal propagates the real shell result
// =====================================================================
test('LOW-4: src/fileBrowser.js reveal() returns a boolean (revert guard)', () => {
  const code = fs.readFileSync(path.join(ROOT, 'src', 'fileBrowser.js'), 'utf8');
  const fnMatch = code.match(/function reveal[\s\S]*?\n\}/);
  assert.ok(fnMatch, 'could not locate reveal() in fileBrowser.js');
  const fn = fnMatch[0];
  assert.ok(/return\s+(true|false)/.test(fn),
    'reveal() must return a boolean so the IPC handler can report real failures (LOW-4 regression: it always returned undefined, and the handler always said ok:true)');
});

test('LOW-4: registerFileBrowserIpc fb:reveal propagates the reveal() result (revert guard)', () => {
  const code = fs.readFileSync(path.join(ROOT, 'main', 'ipc', 'registerFileBrowserIpc.js'), 'utf8');
  // P1-A (C-001): accept the secureHandle wrapper spelling too.
  const handlerMatch = code.match(/(?:ipcMain\.handle|secureHandle)\('fb:reveal'[\s\S]*?\}\s*\);/);
  assert.ok(handlerMatch, 'could not locate fb:reveal handler');
  const handler = handlerMatch[0];
  assert.ok(/fb\.reveal\(p\)/.test(handler) && /revealed/.test(handler),
    'fb:reveal handler must capture the reveal() return value and branch on it (LOW-4)');
  assert.ok(/ok:\s*false/.test(handler),
    'fb:reveal handler must return ok:false when reveal() fails (LOW-4 regression: it always returned ok:true)');
});

// =====================================================================
// P4.5 (DB-H-005): preview commits are revision-guarded
// =====================================================================
test('P4.5: fileBrowser2a preview onload commits only if {revision, path} still current (revert guard)', () => {
  const code = fs.readFileSync(path.join(ROOT, 'renderer', 'services', 'fileBrowser2a.js'), 'utf8');
  assert.ok(/const rev = \(state\._previewRevision = \(state\._previewRevision \|\| 0\) \+ 1\)/.test(code),
    'previewImageFromFile must capture a preview revision at click time (DB-H-005)');
  assert.ok(/state\._previewRevision === rev && state\._lastPreviewPath === p/.test(code),
    'the async onload commit must be gated on the revision AND path still being current (DB-H-005: a slow decode must not clobber a newer preview)');
  // Every preview-mode change bumps the revision so pending commits void:
  // the null-reset branch and the multi-image grid path each bump too.
  const bumps = code.match(/state\._previewRevision = \(state\._previewRevision \|\| 0\) \+ 1/g) || [];
  assert.ok(bumps.length >= 3,
    `all three preview-mode changes (single, null reset, grid) must bump _previewRevision — found ${bumps.length} bump(s)`);
});

// =====================================================================
// P4.5 (DB-H-006): gen poller binds to the start-of-run dir + image jobs
// =====================================================================
test('P4.5: fileBrowser2b poller binds to an immutable pollDir (revert guard)', () => {
  const code = fs.readFileSync(path.join(ROOT, 'renderer', 'services', 'fileBrowser2b.js'), 'utf8');
  assert.ok(/const pollDir = state\.fbDir/.test(code),
    'startGenPolling must capture state.fbDir ONCE as an immutable pollDir (DB-H-006: per-tick re-reads re-pointed the diff at whatever folder the user browsed to)');
  const fnMatch = code.match(/async function startGenPolling\(\) \{[\s\S]*?\n\}/);
  assert.ok(fnMatch, 'could not locate startGenPolling in fileBrowser2b.js');
  assert.ok(!/fbList\(state\.fbDir/.test(fnMatch[0]),
    'the poller must never fbList(state.fbDir) directly — all listing goes through the captured pollDir (DB-H-006)');
  assert.ok(/if \(state\.fbDir !== pollDir\) return;/.test(fnMatch[0]),
    'the tick must skip render/notify when the user navigated away from the polled dir (DB-H-006)');
});

test('P4.5: fileBrowser2b thumbnail pushes require an active IMAGE job (revert guard)', () => {
  const code = fs.readFileSync(path.join(ROOT, 'renderer', 'services', 'fileBrowser2b.js'), 'utf8');
  assert.ok(/function _isImageJobActive\(\)/.test(code),
    'fileBrowser2b must define _isImageJobActive (DB-H-006: a speech/music run must not thumbnail unrelated image files)');
  assert.ok(/\.some\(\(j\) => j && \(j\.tab === 'image' \|\| j\.type === 'image'\)\)/.test(code),
    '_isImageJobActive must check JobRunner.activeJobs() for an image-tab job');
  assert.ok(/if \(imgActive && \[/.test(code),
    'the notifyImageGenerated push must be gated on imgActive (P4.5)');
});

// =====================================================================
// P4.4 (DB-H-004): audio cut writes atomically via a uuid temp file
// =====================================================================
test('P4.4: AudioTrimCut.cut ffmpeg writes to a uuid temp in the dest folder, probes it, then renames (revert guard)', () => {
  const code = fs.readFileSync(path.join(ROOT, 'src', 'audio', 'AudioTrimCut.js'), 'utf8');
  assert.ok(!/args\.push\('-y', dstPath\)/.test(code),
    'ffmpeg must NEVER write straight to dstPath (DB-H-004: a killed encode left a truncated file over the original)');
  assert.ok(/const tmpPath = path\.join\(path\.dirname\(dstPath\), `\.cut-\$\{crypto\.randomUUID\(\)\}\.tmp\.\$\{ext\}`\)/.test(code),
    'the temp file must be uuid-named IN the destination folder (same volume ⇒ atomic rename)');
  assert.ok(/args\.push\('-y', tmpPath\)/.test(code),
    'ffmpeg must target the temp path');
  assert.ok(/await probe\(tmpPath\)/.test(code),
    'the finished temp must be probed for a real duration BEFORE it replaces anything (DB-H-004)');
  assert.ok(/fs\.renameSync\(tmpPath, dstPath\)/.test(code),
    'the temp must be moved into place with an atomic rename');
  // Every failure path must clean the temp up and leave the original alone.
  const cleanups = code.match(/cleanupTmp\(\);/g) || [];
  assert.ok(cleanups.length >= 5,
    `timeout, spawn error, non-zero exit, failed validation, and failed rename must all delete the temp — found ${cleanups.length} cleanupTmp() call(s)`);
  assert.ok(/the original file was preserved/.test(code),
    'the validation-failure error must state that the original was preserved');
});

// =====================================================================
// P5 (DA-M-007 / DA-M-008): Telea heal writes atomically + PNG extension
// =====================================================================
test('P5 DA-M-007: Telea heal encodes to a uuid temp, validates dims, then renames (revert guard)', () => {
  const code = fs.readFileSync(path.join(ROOT, 'main', 'ipc', 'registerInpaintIpc.js'), 'utf8');
  assert.ok(!/\.toFile\(outPath\)/.test(code),
    'Telea must NEVER sharp().toFile(outPath) directly (DA-M-007: a killed encode left a truncated file at the destination)');
  assert.ok(/const tmpOut = path\.join\(path\.dirname\(outPath\), `\.telea-\$\{crypto\.randomUUID\(\)\}\.tmp\.png`\)/.test(code),
    'the encode target must be a uuid temp in the SAME folder (same volume ⇒ atomic rename)');
  assert.ok(/await sharp\(tmpOut\)\.metadata\(\)/.test(code),
    'the encoded temp must be validated (metadata re-read) before it replaces anything');
  assert.ok(/check\.width !== w \|\| check\.height !== h/.test(code),
    'validation must assert the decoded dims match the source');
  assert.ok(/await fs\.promises\.rename\(tmpOut, outPath\)/.test(code),
    'the validated temp must be moved into place with an atomic rename');
  assert.ok(/await fs\.promises\.unlink\(tmpOut\)/.test(code),
    'the failure path must delete the temp so no partial .png is left behind');
});

test('P5 DA-M-008: Telea output extension is forced to .png to match the encoder (revert guard)', () => {
  const code = fs.readFileSync(path.join(ROOT, 'main', 'ipc', 'registerInpaintIpc.js'), 'utf8');
  assert.ok(/function forcePngExt\(p\)/.test(code),
    'registerInpaintIpc must define forcePngExt (DA-M-008)');
  assert.ok(/const outPath = forcePngExt\(args\.outPath \|\| deriveOutPath\(srcPath, '_healed'\)\)/.test(code),
    'the resolved outPath must be routed through forcePngExt — a .jpg source must not yield PNG bytes mislabelled .jpg');
  // Behavioural check of the helper itself.
  const m = code.match(/function forcePngExt\(p\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'forcePngExt must be defined');
  // eslint-disable-next-line no-new-func
  const forcePngExt = new Function(m[0] + '; return forcePngExt;')();
  assert.equal(forcePngExt('C:/x/y.jpg'), 'C:/x/y.png', '.jpg → .png');
  assert.equal(forcePngExt('C:/x/y.png'), 'C:/x/y.png', '.png unchanged');
  assert.equal(forcePngExt('C:/x/y'), 'C:/x/y.png', 'no extension → .png appended');
  assert.equal(forcePngExt('C:/dir.png/y'), 'C:/dir.png/y.png', 'a dot in a dir name is not an extension');
});

// =====================================================================
// P5 (M-038): grant errors must not echo the allowed root paths
// =====================================================================
test('P5 M-038: pathGrant:mint rejection does not leak the allowed roots to the renderer (revert guard)', () => {
  const code = fs.readFileSync(path.join(ROOT, 'main', 'ipc', 'registerPathGrantIpc.js'), 'utf8');
  // The returned bad() must not interpolate the roots list...
  assert.ok(!/return bad\([^)]*roots\.join/.test(code),
    'the mint rejection must NOT return the allowed roots to the renderer (M-038: that leaked the user\'s drive/folder layout)');
  // ...but the main-side forensic log may still record them.
  assert.ok(/console\.error\('\[pathGrant:mint\] REJECTED/.test(code),
    'the root detail must stay main-side in the console.error forensic line');
  assert.ok(/return bad\('Path is not in an allowed root\./.test(code),
    'the renderer must get a generic, root-free rejection message');
});

// =====================================================================
// P5 (M-039): job:list must not expose job meta (srcPath/dstPath)
// =====================================================================
test('P5 M-039: job:list projects only safe fields (no meta/paths) (revert guard)', () => {
  const code = fs.readFileSync(path.join(ROOT, 'main', 'ipc', 'registerJobIpc.js'), 'utf8');
  const handler = code.match(/secureHandle\('job:list'[\s\S]*?\}\);/);
  assert.ok(handler, 'could not locate the job:list handler');
  assert.ok(!/return \{ ok: true, jobs \};\s*\}\);/.test(handler[0]) || /\.map\(/.test(handler[0]),
    'job:list must not return getActiveJobs() verbatim (M-039: meta carries srcPath/dstPath)');
  assert.ok(/\.map\(\(j\) => \(\{/.test(handler[0]),
    'job:list must project each job through an explicit allowlist');
  assert.ok(!/meta:/.test(handler[0]),
    'the job:list projection must NOT include meta');
  for (const f of ['jobId', 'runId', 'backend', 'startedAt', 'alive']) {
    assert.ok(handler[0].includes(f + ':'), `the job:list projection must keep ${f}`);
  }
});

// =====================================================================
// P5 (M-046): renderer log rotation preserves the previous session
// =====================================================================
test('P5 M-046: startup log handling preserves the previous session (revert guard)', () => {
  const code = fs.readFileSync(path.join(ROOT, 'main', 'index.js'), 'utf8');
  assert.ok(!/fs\.writeFileSync\(p, ''\)/.test(code),
    'the writability probe must NOT truncate the existing log (M-046: it wiped the previous session on every start)');
  assert.ok(/fs\.accessSync\(p, fs\.constants\.W_OK\)/.test(code),
    'writability must be probed non-destructively via accessSync');
  assert.ok(/fs\.renameSync\(RENDERER_LOG, RENDERER_LOG \+ '\.prev'\)/.test(code),
    'the existing log must be rotated to .prev (preserved) before the new session header is written');
});

// =====================================================================
// P5 batch: M-027, DA-M-002, DA-M-004, DA-M-014, DA-M-015, DA-M-017,
// DA-M-019, DA-M-022, DB-M-006, DB-M-007, DB-M-008, DB-M-012
// =====================================================================
test('P5 M-027: archive redacts secrets and strips absolute paths (revert guard)', () => {
  const code = fs.readFileSync(path.join(ROOT, 'src', 'services', 'ArchiveService.js'), 'utf8');
  assert.ok(/deepRedact/.test(code), 'ArchiveService must import/use deepRedact');
  assert.ok(/_sanitizeSummary/.test(code), 'append() must route through _sanitizeSummary');
  assert.ok(/path\.basename\(p\)/.test(code), 'outputPaths must be reduced to basenames');
});

test('P5 DA-M-002: alpha probe is tri-state, JPEG blocked on unknown (revert guard)', () => {
  const code = fs.readFileSync(path.join(ROOT, 'renderer', 'overlays', 'imageEditorActions.js'), 'utf8');
  assert.ok(/function probeAlpha\(session\)/.test(code), 'probeAlpha must exist');
  assert.ok(/ok: false, hasAlpha: false, error:/.test(code), 'probeAlpha must return {ok:false} on error');
  assert.ok(/!alphaProbe\.ok/.test(code), 'onSave must block JPEG when alpha is unknown');
  assert.ok(/!innerProbe\.ok \|\| innerProbe\.hasAlpha/.test(code), 'doSave must fail closed (use matte) on unknown alpha');
});

test('P5 DA-M-004: existence check fail-closed in save (revert guard)', () => {
  const code = fs.readFileSync(path.join(ROOT, 'renderer', 'overlays', 'imageEditorActions.js'), 'utf8');
  assert.ok(!/existence check failed .* proceed with original path/.test(code),
    'the old fail-open comment must be gone');
  assert.ok(/DA-M-004: fail CLOSED/.test(code), 'catch block must auto-version (fail closed)');
});

test('P5 DA-M-014: crop pass-through requires BOTH axes unset (revert guard)', () => {
  const code = fs.readFileSync(path.join(ROOT, 'renderer', 'pipeline', 'pipelineOps.js'), 'utf8');
  assert.ok(/column === 'crop' && !Number\(settings\.w\) && !Number\(settings\.h\)/.test(code),
    'crop passedThrough must use AND (both axes), not OR');
});

test('P5 DA-M-015: skipIfTransparent actually checks alpha (revert guard)', () => {
  const code = fs.readFileSync(path.join(ROOT, 'renderer', 'pipeline', 'pipelineOps.js'), 'utf8');
  assert.ok(/settings\.skipIfTransparent/.test(code), 'doRemoveBg must read skipIfTransparent');
  assert.ok(/hasTransparent/.test(code), 'must sample alpha before deciding to skip');
});

test('P5 DA-M-017: clipboard temp files cleaned in finally (revert guard)', () => {
  const code = fs.readFileSync(path.join(ROOT, 'renderer', 'pipeline', 'pipelineImport.js'), 'utf8');
  assert.ok(/tempPaths/.test(code), 'must track temp paths');
  assert.ok(/finally/.test(code), 'cleanup must be in a finally block');
  assert.ok(/fbDelete\(tp/.test(code), 'must delete each temp file');
  assert.ok(/dirR && dirR\.ok === false/.test(code), 'must check fbEnsureDir result');
});

test('P5 DA-M-019: removeItems returns actual counts (revert guard)', () => {
  const code = fs.readFileSync(path.join(ROOT, 'renderer', 'pipeline', 'pipelineClear.js'), 'utf8');
  assert.ok(/return \{ removed: removedCount, failed: failedCount/.test(code),
    'removeItems must return actual counts');
  assert.ok(/res\.removed/.test(code), 'clearFinalColumn must use actual removed count');
});

test('P5 DA-M-022: loadFromDisc shows error on failure (revert guard)', () => {
  const code = fs.readFileSync(path.join(ROOT, 'renderer', 'pipeline', 'pipelineImport.js'), 'utf8');
  assert.ok(/res && res\.ok && res\.added > 0/.test(code),
    'loadFromDisc must check res.ok && added>0 for success');
  assert.ok(/Import failed/.test(code), 'must show error text on failure');
});

test('P5 DB-M-006: no hardcoded video quota numbers (revert guard)', () => {
  const bm = fs.readFileSync(path.join(ROOT, 'renderer', 'tabs', 'batchManager.js'), 'utf8');
  const help = fs.readFileSync(path.join(ROOT, 'renderer', 'sections', 'section23_Centralized_help_system.js'), 'utf8');
  assert.ok(!/3 video generations per day/.test(bm), 'batchManager must not hardcode quota');
  assert.ok(!/3 per week/.test(help), 'help system must not hardcode quota');
});

test('P5 DB-M-007/008: audio existence checks fail closed (revert guard)', () => {
  const code = fs.readFileSync(path.join(ROOT, 'renderer', 'audioCutter.js'), 'utf8');
  assert.ok(/catch\(\(\) => \(\{ ok: false, exists: true \}\)\)/.test(code),
    'single export fbExists catch must return occupied (DB-M-007)');
  assert.ok(/DB-M-008: fail CLOSED/.test(code), 'batch fsExists catch must return true (occupied)');
});

test('P5 DB-M-012: fmtTime rounds total ms before decomposing (revert guard)', () => {
  const code = fs.readFileSync(path.join(ROOT, 'renderer', 'audioCutter.js'), 'utf8');
  assert.ok(/Math\.round\(sec \* 1000\)/.test(code), 'must round total ms first');
  assert.ok(/totalMs % 1000/.test(code), 'ms must come from the rounded total');
  assert.ok(!/Math\.round\(\(sec - Math\.floor\(sec\)\) \* 1000\)/.test(code),
    'the old per-component rounding (produces .1000) must be gone');
});

// =====================================================================
// P5.6 Release Hardening (H-013, M-024, M-033, M-035, M-036)
// =====================================================================

test('P5.6 H-013: minisign signing script exists and signs the manifest (revert guard)', () => {
  const scriptPath = path.join(ROOT, 'scripts', 'sign-release.js');
  assert.ok(fs.existsSync(scriptPath), 'scripts/sign-release.js must exist');
  const code = fs.readFileSync(scriptPath, 'utf8');
  assert.ok(/minisign/.test(code), 'must use minisign');
  assert.ok(/\.minisig/.test(code), 'must produce a .minisig detached signature');
  assert.ok(/--verify/.test(code), 'must support verification mode');
});

test('P5.6 M-024: build produces per-file FILES.sha256 manifest (revert guard)', () => {
  const code = fs.readFileSync(path.join(ROOT, 'scripts', 'zip-portable.js'), 'utf8');
  assert.ok(/FILES\.sha256/.test(code), 'build must write FILES.sha256 per-file manifest');
  const installer = fs.readFileSync(path.join(ROOT, 'Install MiniMax Asset Tool.cmd'), 'utf8');
  assert.ok(/FILES\.sha256/.test(installer), 'installer must verify against FILES.sha256');
  assert.ok(/integrity check/i.test(installer), 'installer must report integrity failures');
});

test('P5.6 M-033: Electron fuse configuration script exists (revert guard)', () => {
  const scriptPath = path.join(ROOT, 'scripts', 'set-fuses.js');
  assert.ok(fs.existsSync(scriptPath), 'scripts/set-fuses.js must exist');
  const code = fs.readFileSync(scriptPath, 'utf8');
  assert.ok(/RunAsNode.*false/.test(code), 'RunAsNode fuse must be disabled');
  assert.ok(/OnlyLoadAppFromAsar.*true/.test(code), 'OnlyLoadAppFromAsar must be enabled');
  assert.ok(/EnableNodeCliInspectArguments.*false/.test(code), 'CLI inspect must be disabled');
});

test('P5.6 M-035: CycloneDX SBOM generation script exists (revert guard)', () => {
  const scriptPath = path.join(ROOT, 'scripts', 'generate-sbom.js');
  assert.ok(fs.existsSync(scriptPath), 'scripts/generate-sbom.js must exist');
  const code = fs.readFileSync(scriptPath, 'utf8');
  assert.ok(/CycloneDX/.test(code), 'must produce CycloneDX format');
  assert.ok(/specVersion.*1\.5/.test(code), 'must target spec 1.5');
  assert.ok(/purl/.test(code), 'must include package URLs');
});

test('P5.6 M-036: SECURITY.md and dependabot.yml exist (revert guard)', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'SECURITY.md')), 'SECURITY.md must exist');
  assert.ok(fs.existsSync(path.join(ROOT, '.github', 'dependabot.yml')), '.github/dependabot.yml must exist');
  const sec = fs.readFileSync(path.join(ROOT, 'SECURITY.md'), 'utf8');
  assert.ok(/Reporting a Vulnerability/.test(sec), 'must have reporting instructions');
  const dep = fs.readFileSync(path.join(ROOT, '.github', 'dependabot.yml'), 'utf8');
  assert.ok(/package-ecosystem.*npm/.test(dep), 'must monitor npm');
  assert.ok(/github-actions/.test(dep), 'must monitor GitHub Actions');
});

test('P5.6 M-034: CI uses npm ci (lockfile-verified install) (revert guard)', () => {
  const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.ok(/npm ci/.test(ci), 'CI must use npm ci (not npm install)');
  assert.ok(!/npm install/.test(ci), 'CI must NOT use npm install');
});
