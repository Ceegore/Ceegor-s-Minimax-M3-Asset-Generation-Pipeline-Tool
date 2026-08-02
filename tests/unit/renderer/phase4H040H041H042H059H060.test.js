// tests/unit/renderer/phase4H040H041H042H059H060.test.js
// ============================================================================
// Phase 4 regression tests:
//   H-040: "Test connection" tests the DRAFT key (not the saved one) + try/finally.
//   H-041: Output/report path inputs are readonly (grant-based only).
//   H-042: Ctrl+Enter blocked when a modal/overlay is open.
//   H-059: Pipeline import uses FormatRegistry.fromMagic (rejects MP4/MOV/M4A).
//   H-060: imageId strict charset [A-Za-z0-9_-]{1,64}.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');

// ---------------------------------------------------------------------------
// H-040: draft-key test connection
// ---------------------------------------------------------------------------

test('H-040: authTestDraft IPC module exists and uses secureHandle', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main', 'ipc', 'authTestDraft.js'), 'utf8');
  assert.match(src, /secureHandle\('mmx:authTestDraft'/,
    'must register mmx:authTestDraft via secureHandle');
  assert.match(src, /draftKey/, 'must accept a draftKey payload field');
  assert.match(src, /sessionOnly:\s*true/, 'must use sessionOnly so the draft never touches the persisted store');
});

test('H-040: registerMmxIpc requires and calls registerAuthTestDraft', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main', 'ipc', 'registerMmxIpc.js'), 'utf8');
  assert.match(src, /require\('\.\/authTestDraft'\)/, 'must require authTestDraft module');
  assert.match(src, /registerAuthTestDraft\(\{/, 'must call registerAuthTestDraft');
});

test('H-040: preload exposes authTestDraft', () => {
  const src = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  assert.match(src, /authTestDraft.*mmx:authTestDraft/, 'preload must bridge authTestDraft');
});

test('H-040: renderer Test-connection handler uses draft key + try/finally', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer', 'sections', 'section03_Settings_tab_panes.js'), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  // Must read the draft from the input field.
  assert.match(code, /apiKeyRow\.getValue\(\)\.trim\(\)/,
    'must read the draft key from the input');
  // Must call authTestDraft when a draft is present.
  assert.match(code, /authTestDraft\(\{\s*draftKey/,
    'must call authTestDraft with the draft key');
  // Must have try/finally for button state restoration.
  assert.match(code, /finally\s*\{[^}]*test\.disabled\s*=\s*false/s,
    'finally must restore button disabled state');
});

// ---------------------------------------------------------------------------
// H-041: readonly path inputs
// ---------------------------------------------------------------------------

test('H-041: output_dir and report_dir inputs are readonly', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer', 'sections', 'section03_Settings_tab_panes.js'), 'utf8');
  // Find the outInput creation — must have readonly.
  const outMatch = src.match(/const outInput = el\('input',\s*\{[^}]+\}/s);
  assert.ok(outMatch, 'outInput creation must exist');
  assert.match(outMatch[0], /readonly/, 'outInput must be readonly');
  // Find the reportInput creation — must have readonly.
  const repMatch = src.match(/const reportInput = el\('input',\s*\{[^}]+\}/s);
  assert.ok(repMatch, 'reportInput creation must exist');
  assert.match(repMatch[0], /readonly/, 'reportInput must be readonly');
});

// ---------------------------------------------------------------------------
// H-042: Ctrl+Enter blocked behind modals
// ---------------------------------------------------------------------------

test('H-042: Ctrl+Enter isAvailable checks for open modals/overlays', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer', 'services', 'shortcutRegistry.js'), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  // Find the Ctrl+Enter entry's isAvailable — must NOT be `() => true`.
  const entry = code.slice(code.indexOf("combo: 'Ctrl+Enter'"), code.indexOf("combo: 'Ctrl+Enter'") + 600);
  assert.doesNotMatch(entry, /isAvailable:\s*\(\)\s*=>\s*true/,
    'Ctrl+Enter must NOT have isAvailable: () => true');
  assert.match(entry, /isAvailable:.*modal-root/s,
    'Ctrl+Enter isAvailable must check for open modals');
});

// ---------------------------------------------------------------------------
// H-059: pipeline import uses FormatRegistry (rejects MP4/MOV/M4A)
// ---------------------------------------------------------------------------

test('H-059: pipeline:import uses FormatRegistry.fromMagic (not inline ftyp check)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main', 'ipc', 'registerPipelineIpc.js'), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  // The old naive inline ftyp check must be gone from the import handler.
  // Look for the section between "pipeline:import" and "pipeline:replace".
  const importStart = code.indexOf("'pipeline:import'");
  const replaceStart = code.indexOf("'pipeline:replace'");
  assert.ok(importStart > 0 && replaceStart > importStart, 'both handlers must exist');
  const importSection = code.slice(importStart, replaceStart);
  // Must NOT have the old inline ftyp byte check.
  assert.doesNotMatch(importSection, /header\[4\]\s*===\s*0x66/,
    'old inline ftyp byte check must be removed from pipeline:import');
  // Must use fromMagic.
  assert.match(importSection, /fromMagic/,
    'pipeline:import must use FormatRegistry.fromMagic');
  assert.match(importSection, /category\s*!==\s*'image'/,
    'must reject non-image categories');
});

test('H-059: FormatRegistry rejects MP4 major brands as non-image', () => {
  // Functional test: require the real FormatRegistry and probe with mp4 brands.
  const { fromMagic, ISOBMFF_AMBIGUOUS } = require(path.join(ROOT, 'src', 'services', 'FormatRegistry'));
  // Build a minimal ftyp box with major brand 'isom' (generic MP4).
  function ftypBuf(major) {
    const buf = Buffer.alloc(16);
    buf.writeUInt32BE(16, 0);
    buf.write('ftyp', 4, 'latin1');
    buf.write(major, 8, 'latin1');
    return buf;
  }
  const mp4 = fromMagic(ftypBuf('isom'));
  // Must NOT be detected as an image.
  assert.ok(!mp4 || mp4.category !== 'image',
    'isom (generic MP4) must not be category:image');
  // AVIF must still be detected as image.
  const avif = fromMagic(ftypBuf('avif'));
  assert.ok(avif && avif.category === 'image',
    'avif must be category:image');
});

// ---------------------------------------------------------------------------
// H-060: strict imageId charset
// ---------------------------------------------------------------------------

test('H-060: pipeline handlers use strict [A-Za-z0-9_-]{1,64} for imageId', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main', 'ipc', 'registerPipelineIpc.js'), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  // The old weak regex must be gone.
  assert.doesNotMatch(code, /\[\^\\\\\/\]\+/,
    'old weak /^[^\\\\/]+$/ regex must be removed');
  // Must have the strict pattern (at least 3 occurrences: import, replace, trash).
  const strictRe = /\[A-Za-z0-9_-\]\{1,64\}/g;
  const matches = code.match(strictRe);
  assert.ok(matches && matches.length >= 3,
    'must have at least 3 strict imageId validations (import, replace, trash), got ' + (matches ? matches.length : 0));
});

test('H-060: strict regex rejects Windows-illegal characters', () => {
  const re = /^[A-Za-z0-9_-]{1,64}$/;
  // Valid ids.
  assert.ok(re.test('abc123'));
  assert.ok(re.test('my-image_01'));
  assert.ok(re.test('A'.repeat(64)));
  // Invalid: Windows-illegal chars.
  assert.ok(!re.test('file:name'));
  assert.ok(!re.test('file*name'));
  assert.ok(!re.test('file?name'));
  assert.ok(!re.test('file"name'));
  assert.ok(!re.test('file<name'));
  assert.ok(!re.test('file>name'));
  assert.ok(!re.test('file|name'));
  // Invalid: path separators.
  assert.ok(!re.test('a/b'));
  assert.ok(!re.test('a\\b'));
  // Invalid: too long.
  assert.ok(!re.test('A'.repeat(65)));
  // Invalid: empty.
  assert.ok(!re.test(''));
});

// ---------------------------------------------------------------------------
// H-038: settings Save/Cancel transaction (commitState pattern)
// ---------------------------------------------------------------------------

test('H-038: pane change handlers do NOT write to state directly', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer', 'sections', 'section03_Settings_tab_panes.js'), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  // The old pattern: addEventListener('change', () => { state.X = ...; scheduleStateSave(); })
  // must be gone for the 5 buffered controls.
  assert.doesNotMatch(code, /state\.realesrganModel\s*=\s*modelSel\.value;\s*scheduleStateSave/,
    'realesrganModel must not be written on change');
  assert.doesNotMatch(code, /state\.popupPolicy\s*=\s*polSel\.value;\s*scheduleStateSave/,
    'popupPolicy must not be written on change');
  assert.doesNotMatch(code, /state\.batchesExportFormat\s*=\s*fmtSel\.value;\s*scheduleStateSave/,
    'batchesExportFormat must not be written on change');
  assert.doesNotMatch(code, /state\.batchesAutoRemove\s*=\s*autoRemoveCb\.checked;\s*scheduleStateSave/,
    'batchesAutoRemove must not be written on change');
  assert.doesNotMatch(code, /state\.jobsArchiveCap\s*=\s*v;\s*.*scheduleStateSave/,
    'jobsArchiveCap must not be written on change');
});

test('H-038: panes expose commitState() methods', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer', 'sections', 'section03_Settings_tab_panes.js'), 'utf8');
  // Each state-writing pane must have a commitState method.
  const count = (src.match(/commitState\(\)/g) || []).length;
  // General (apiKeyNoSave) + ImageAddons (realesrganModel) + Popups (popupPolicy)
  // + BatchGen (batchesExportFormat + batchesAutoRemove) + History (jobsArchiveCap) = 5 panes.
  assert.ok(count >= 5, 'at least 5 commitState() definitions expected, got ' + count);
});

test('H-038: Save handler calls commitState() on all panes after success', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer', 'sections', 'section04_Settings.js'), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.match(code, /inst\.commitState\(\)/,
    'Save handler must call inst.commitState()');
  // Must be AFTER the setConfig success check (result.ok === true).
  const okIdx = code.indexOf('result.ok !== true');
  const commitIdx = code.indexOf('inst.commitState()');
  assert.ok(commitIdx > okIdx,
    'commitState must be called AFTER the ok-check (only on success)');
});
