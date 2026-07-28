// KGO8-006 drift guard.
//
// src/state.js sanitises the persisted `imageEditorPrefs.tool` against a
// hard-coded whitelist. That list silently fell behind the editor: 'spray'
// and 'pipette' are real tools (registered by toolBtn(…) in
// renderer/overlays/imageEditorOverlay.js) but were not whitelisted, so
// choosing either and restarting reset the editor to 'pen' with no error.
//
// Unit tests on the sanitiser alone cannot catch that — they only ever assert
// what the whitelist already contains. This test derives the truth from the
// renderer instead and fails when the two drift apart, which is the class of
// bug that will recur the next time a tool is added.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const OVERLAY = path.join(ROOT, 'renderer', 'overlays', 'imageEditorOverlay.js');
const STATE = path.join(ROOT, 'src', 'state.js');

function toolsRegisteredByTheEditor() {
  const src = fs.readFileSync(OVERLAY, 'utf8');
  // toolBtn('B', '🖊', 'pen');  → third argument is the tool id
  const ids = [...src.matchAll(/toolBtn\(\s*'[^']*'\s*,\s*'[^']*'\s*,\s*'([a-z]+)'\s*\)/g)].map((m) => m[1]);
  return [...new Set(ids)];
}

function whitelistInStateJs() {
  const src = fs.readFileSync(STATE, 'utf8');
  const m = src.match(/const\s+WL_TOOLS\s*=\s*\[([^\]]*)\]/);
  assert.ok(m, 'WL_TOOLS not found in src/state.js — did the sanitiser move?');
  return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
}

test('every editor tool is whitelisted for persistence (KGO8-006)', () => {
  const registered = toolsRegisteredByTheEditor();
  const whitelisted = whitelistInStateJs();

  assert.ok(registered.length >= 9,
    `expected to find the editor's tool buttons, got ${JSON.stringify(registered)} — the toolBtn(…) call shape changed, fix this parser`);

  const missing = registered.filter((t) => !whitelisted.includes(t));
  assert.deepStrictEqual(missing, [],
    `these editor tools are NOT in src/state.js WL_TOOLS, so they silently reset to 'pen' on restart: ${missing.join(', ')}`);
});

test('spray and pipette specifically survive a persist round-trip (KGO8-006)', async () => {
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-tool-wl-'));
  const prev = process.env.MINIMAX_CONFIG_DIR;
  process.env.MINIMAX_CONFIG_DIR = dir;
  delete require.cache[require.resolve('../../../src/state.js')];
  const stateMod = require('../../../src/state.js');
  try {
    for (const tool of ['spray', 'pipette', 'eraser', 'bar', 'pen']) {
      stateMod.write({ imageEditorPrefs: { tool, brushSize: 12, brushOpacity: 1, fg: '#000000', bg: '#ffffff' } });
      const back = stateMod.read();
      assert.strictEqual(back.imageEditorPrefs.tool, tool,
        `tool "${tool}" did not survive write()+read() — it came back as "${back.imageEditorPrefs.tool}"`);
    }
  } finally {
    if (prev === undefined) delete process.env.MINIMAX_CONFIG_DIR;
    else process.env.MINIMAX_CONFIG_DIR = prev;
    delete require.cache[require.resolve('../../../src/state.js')];
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
