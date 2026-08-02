// tests/unit/main/batchUnitsGate.h046.test.js
// ============================================================================
// H-046 (_5 audit) — Main-side authoritative batch_max_units cost cap.
//
// Before this fix the cap was enforced ONLY by the renderer's batchManager
// gate, and even that gate was broken: the public config DTO never carried
// batch_max_units, so `parseInt(undefined) || 200` silently replaced any
// user-configured cap with 200. A manipulated renderer could bypass the cap
// entirely because Main never checked it.
//
// These tests pin:
//   1. the canonical clamp (1..10000, garbage → 200),
//   2. maxBatchUnits() reading the AUTHORITATIVE config.txt fresh per call,
//   3. checkMmxUnits(): --n over the cap is blocked for every generation
//      subcommand, free subcommands are never gated,
//   4. checkProviderUnits(): params.n / params.num_outputs over the cap is
//      blocked,
//   5. source guards: both mmx handlers + providers:generate call the gate,
//      and all three config DTO builders expose batch_max_units.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..', '..', '..');

// Point config.js at a throw-away dir BEFORE requiring it (same harness as
// state.test.js): env override + electron stub + fresh require.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-units-gate-'));
process.env.MINIMAX_CONFIG_DIR = tmpDir;
require.cache[require.resolve('electron')] = {
  exports: { app: { getPath: () => tmpDir } },
};
delete require.cache[require.resolve('../../../src/config')];
delete require.cache[require.resolve('../../../main/services/batchUnitsGate')];

const gate = require('../../../main/services/batchUnitsGate');

function setCap(n) {
  fs.writeFileSync(path.join(tmpDir, 'config.txt'), 'batch_max_units=' + n + '\n');
}

test.after(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

test('H-046: clampBatchMaxUnits mirrors the config parse clamp (1..10000, garbage → 200)', () => {
  assert.equal(gate.clampBatchMaxUnits(500), 500);
  assert.equal(gate.clampBatchMaxUnits('750'), 750);
  assert.equal(gate.clampBatchMaxUnits(undefined), 200);
  assert.equal(gate.clampBatchMaxUnits('banana'), 200);
  assert.equal(gate.clampBatchMaxUnits(0), 200);
  assert.equal(gate.clampBatchMaxUnits(-5), 200);
  assert.equal(gate.clampBatchMaxUnits(999999), 10000);
});

test('H-046: maxBatchUnits reads the authoritative config.txt fresh on every call', () => {
  setCap(3);
  assert.equal(gate.maxBatchUnits(), 3);
  // A Settings save (file change) must take effect immediately — no cache.
  setCap(7);
  assert.equal(gate.maxBatchUnits(), 7);
  // Missing config file → default 200.
  fs.rmSync(path.join(tmpDir, 'config.txt'));
  assert.equal(gate.maxBatchUnits(), 200);
});

test('H-046: checkMmxUnits blocks --n over the cap for generation subcommands', () => {
  setCap(3);
  // Acceptance criterion: batch_max_units=3 blocks four units.
  const err = gate.checkMmxUnits(['image', '--prompt', 'x', '--n', '4']);
  assert.ok(err && /4 billable unit/.test(err) && /3-unit limit/.test(err),
    'over-cap --n must be rejected with a message naming units and cap, got: ' + err);
  // Exactly at the cap is allowed.
  assert.equal(gate.checkMmxUnits(['image', '--prompt', 'x', '--n', '3']), null);
  // No --n → 1 unit → allowed.
  assert.equal(gate.checkMmxUnits(['image', '--prompt', 'x']), null);
  // Every generation subcommand is gated, not just image.
  for (const sub of ['speech', 'music', 'video']) {
    assert.ok(gate.checkMmxUnits([sub, '--n', '4']),
      sub + ' --n 4 must be blocked at cap 3');
  }
});

test('H-046: checkMmxUnits never gates free subcommands and tolerates malformed --n', () => {
  setCap(3);
  // quota/voices don't spend generation quota — never blocked.
  assert.equal(gate.checkMmxUnits(['quota']), null);
  assert.equal(gate.checkMmxUnits(['voices', '--n', '999']), null);
  // Malformed --n is left for the CLI's own validation (counts as 1 unit).
  assert.equal(gate.checkMmxUnits(['image', '--n', 'banana']), null);
  // Defensive: non-array input is a no-op, not a crash.
  assert.equal(gate.checkMmxUnits(null), null);
});

test('H-046: checkProviderUnits blocks params.n / params.num_outputs over the cap', () => {
  setCap(3);
  const err = gate.checkProviderUnits({ n: 4 });
  assert.ok(err && /4 billable unit/.test(err) && /3-unit limit/.test(err),
    'over-cap n must be rejected, got: ' + err);
  assert.ok(gate.checkProviderUnits({ num_outputs: 4 }),
    'num_outputs (Replicate-style) must be gated too');
  assert.equal(gate.checkProviderUnits({ n: 3 }), null);
  assert.equal(gate.checkProviderUnits({ n: 1 }), null);
  // No count params → 1 unit → allowed.
  assert.equal(gate.checkProviderUnits({}), null);
  assert.equal(gate.checkProviderUnits(undefined), null);
});

// ---------------------------------------------------------------------------
// Source guards: the gate must actually be WIRED into every paid path, and
// the safe numeric field must be exposed in every config DTO builder so the
// renderer's estimate gate reads the real configured cap.
// ---------------------------------------------------------------------------

test('H-046: both mmx handlers call the units gate before spawning', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main', 'ipc', 'registerMmxIpc.js'), 'utf8');
  assert.ok(/require\('\.\.\/services\/batchUnitsGate'\)/.test(src),
    'registerMmxIpc must require batchUnitsGate');
  const calls = src.match(/_checkMmxUnits\(safeArgs\)/g) || [];
  assert.equal(calls.length, 2,
    'the gate must run in BOTH mmx:run and mmx:run:job (found ' + calls.length + ' call(s))');
});

test('H-046: providers:generate checks the units gate before acquiring a cloud slot', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main', 'ipc', 'registerProvidersIpc.js'), 'utf8');
  assert.ok(/require\('\.\.\/services\/batchUnitsGate'\)/.test(src),
    'registerProvidersIpc must require batchUnitsGate');
  const gateIdx = src.indexOf('checkProviderUnits(req.params)');
  const slotIdx = src.indexOf('cloudJobGate.acquire((provider');
  assert.ok(gateIdx !== -1, 'providers:generate must call checkProviderUnits(req.params)');
  assert.ok(slotIdx !== -1 && gateIdx < slotIdx,
    'the cost check must run BEFORE the cloud gate slot is acquired');
});

test('H-046: batch_max_units is exposed in every public config DTO + the renderer boot reconstruction', () => {
  const pub = fs.readFileSync(path.join(ROOT, 'main', 'ipc', 'registerConfigPublicIpc.js'), 'utf8');
  assert.ok(/batch_max_units:\s*clampBatchMaxUnits\(cfg\.batch_max_units\)/.test(pub),
    'config:getPublic must carry the clamped batch_max_units');
  const cfgIpc = fs.readFileSync(path.join(ROOT, 'main', 'ipc', 'registerConfigIpc.js'), 'utf8');
  assert.ok(/batch_max_units:\s*clampBatchMaxUnits\(cfg\.batch_max_units\)/.test(cfgIpc),
    '_publicConfig (config:set responses) must carry the clamped batch_max_units');
  const app = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
  assert.ok(/batch_max_units:\s*\(_cfgPublic/.test(app),
    'app.js boot must reconstruct state.config.batch_max_units from the DTO');
  // The renderer estimate gate still reads state.config.batch_max_units.
  const bm = fs.readFileSync(path.join(ROOT, 'renderer', 'tabs', 'batchManager.js'), 'utf8');
  assert.ok(/state\.config\s*&&\s*state\.config\.batch_max_units/.test(bm),
    'batchManager keeps its aggregate estimate gate (UX layer)');
});
