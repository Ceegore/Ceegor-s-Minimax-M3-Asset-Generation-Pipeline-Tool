'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { captureLegacyShellLock } = require('../../../scripts/capture-legacy-shell-lock');
const { collectPeMap, composeLegacyRelease } = require('../../../scripts/compose-legacy-release');

function file(root, relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-tools-'));
  const seed = path.join(base, 'seed');
  const current = path.join(base, 'current');
  const output = path.join(base, 'output');
  file(seed, 'MiniMaxAssetTool.exe', 'stable-exe');
  file(seed, 'chrome_elf.dll', 'stable-dll');
  file(seed, 'resources/app.asar', 'old-app-content'.repeat(100));
  file(seed, 'resources/app.asar.unpacked/helper.js', 'old-helper');
  file(seed, 'README.md', 'old readme');
  file(current, 'MiniMaxAssetTool.exe', 'new-unreputed-exe');
  file(current, 'chrome_elf.dll', 'stable-dll');
  file(current, 'resources/app.asar', 'new-app-content'.repeat(100));
  file(current, 'resources/app.asar.unpacked/helper.js', 'new-helper');
  file(current, 'README.md', 'new readme');
  return { base, seed, current, output };
}

test('capture lock records all PE files', () => {
  const f = fixture();
  const lock = captureLegacyShellLock({ seed: f.seed, tag: 'test' });
  assert.deepEqual(Object.keys(lock.peFiles).sort(), ['MiniMaxAssetTool.exe', 'chrome_elf.dll']);
  assert.equal(lock.sourceTag, 'test');
});

test('legacy composition replaces donor PE bytes and keeps new app.asar', () => {
  const f = fixture();
  const lock = captureLegacyShellLock({ seed: f.seed, tag: 'test' });
  const lockPath = path.join(f.base, 'lock.json');
  fs.writeFileSync(lockPath, JSON.stringify(lock));
  composeLegacyRelease({ seed: f.seed, current: f.current, output: f.output, lockPath, version: '1.0.7', commit: 'abc' });
  assert.equal(fs.readFileSync(path.join(f.output, 'MiniMaxAssetTool.exe'), 'utf8'), 'stable-exe');
  assert.equal(fs.readFileSync(path.join(f.output, 'chrome_elf.dll'), 'utf8'), 'stable-dll');
  assert.equal(fs.readFileSync(path.join(f.output, 'resources/app.asar'), 'utf8'), 'new-app-content'.repeat(100));
  assert.deepEqual(collectPeMap(f.output), lock.peFiles);
});

test('legacy composition rejects changed native runtime bytes even at the same path', () => {
  const f = fixture();
  const lock = captureLegacyShellLock({ seed: f.seed, tag: 'test' });
  const lockPath = path.join(f.base, 'lock.json');
  fs.writeFileSync(lockPath, JSON.stringify(lock));
  fs.writeFileSync(path.join(f.current, 'chrome_elf.dll'), 'changed-native-runtime');
  assert.throws(
    () => composeLegacyRelease({ seed: f.seed, current: f.current, output: f.output, lockPath, version: '1.0.7' }),
    /current native-runtime PE inventory byte mismatch/,
  );
});

test('legacy composition rejects a new PE path', () => {
  const f = fixture();
  const lock = captureLegacyShellLock({ seed: f.seed, tag: 'test' });
  const lockPath = path.join(f.base, 'lock.json');
  fs.writeFileSync(lockPath, JSON.stringify(lock));
  file(f.current, 'resources/bin/new-helper.exe', 'new executable');
  assert.throws(() => composeLegacyRelease({ seed: f.seed, current: f.current, output: f.output, lockPath, version: '1.0.7' }), /path set differs/);
});

test('capture detects a PE file hidden behind an unusual extension', () => {
  const f = fixture();
  file(f.seed, 'resources/payload.bin', Buffer.from([0x4d, 0x5a, 0x00, 0x01]));
  const lock = captureLegacyShellLock({ seed: f.seed, tag: 'test' });
  assert.ok(lock.peFiles['resources/payload.bin']);
});
