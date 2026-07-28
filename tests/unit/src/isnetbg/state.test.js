// tests/unit/src/isnetbg/state.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-isnetbg-state-test-'));
process.env.MINIMAX_CONFIG_DIR = tmpDir;

require.cache[require.resolve('electron')] = {
  exports: { app: { getPath: () => tmpDir } },
};

delete require.cache[require.resolve('../../../../src/config')];
delete require.cache[require.resolve('../../../../src/state')];

const stateMod = require('../../../../src/state');
// PE-014: the fallback is now dynamic (auto-best-compatible). Compute the
// expected value the same way state.write() does so the test is env-agnostic.
const { resolveAutoBestModel } = require('../../../../src/isnetbg/binaryDiscovery');
const expectedFallback = resolveAutoBestModel();

test('state: removeBackgroundModel accepts known keys and rejects unknown keys', () => {
  const p = path.join(tmpDir, 'state.json');

  // 1. Valid model key should survive
  const snap1 = { removeBackgroundModel: 'birefnet-general-lite' };
  const clean1 = stateMod.write(snap1);
  assert.equal(clean1.removeBackgroundModel, 'birefnet-general-lite');

  // 2. Invalid model key should fall back to auto-best (PE-014)
  const snap2 = { removeBackgroundModel: 'garbage-model-name-xyz' };
  const clean2 = stateMod.write(snap2);
  assert.equal(clean2.removeBackgroundModel, expectedFallback);

  // 3. Null or undefined model key should fall back to auto-best (PE-014)
  const snap3 = { removeBackgroundModel: null };
  const clean3 = stateMod.write(snap3);
  assert.equal(clean3.removeBackgroundModel, expectedFallback);

  // Cleanup
  try { fs.unlinkSync(p); } catch (_) {}
  try { fs.rmdirSync(tmpDir); } catch (_) {}
});
