// tests/unit/renderer/utils/PathBuilder.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

global.window = global;
global.window.api = { fbExists: async (p) => ({ ok: true, exists: false }) }; // immer "existiert nicht"
require('../../../../renderer/utils/PathBuilder.js');

const { derivedOutputPath, nextFreeName, resolveUniqueOutputPath } = window.PathBuilder;

test('derivedOutputPath inserts suffix before extension', () => {
  assert.equal(derivedOutputPath('C:/out/foo.png', '_optimized'), 'C:/out/foo_optimized.png');
  assert.equal(derivedOutputPath('C:/out/foo.jpg', '_cut'), 'C:/out/foo_cut.jpg');
});

test('derivedOutputPath handles no-extension paths', () => {
  assert.equal(derivedOutputPath('C:/out/Makefile', '_bak'), 'C:/out/Makefile_bak');
});

test('derivedOutputPath handles dotfiles', () => {
  // .gitignore has a dot, no slash after — should append suffix at end
  assert.equal(derivedOutputPath('.gitignore', '_bak'), '.gitignore_bak');
});

test('nextFreeName produces incremental names', () => {
  const tryN = nextFreeName('C:/out/foo.png');
  assert.equal(tryN(0), 'C:/out/foo.png');
  assert.equal(tryN(1), 'C:/out/foo (1).png');
  assert.equal(tryN(7), 'C:/out/foo (7).png');
});

test('nextFreeName handles no-extension', () => {
  const tryN = nextFreeName('C:/out/Makefile');
  assert.equal(tryN(0), 'C:/out/Makefile');
  assert.equal(tryN(1), 'C:/out/Makefile (1)');
});

test('resolveUniqueOutputPath returns original when free', async () => {
  const r = await resolveUniqueOutputPath('C:/out/foo.png');
  assert.equal(r, 'C:/out/foo.png');
});

test('resolveUniqueOutputPath skips existing files', async () => {
  // Mock: first 2 exist, then free
  let call = 0;
  window.api.fbExists = async () => { call++; return { ok: true, exists: call <= 2 }; };
  const r = await resolveUniqueOutputPath('C:/out/foo.png');
  assert.equal(r, 'C:/out/foo (2).png');
});
