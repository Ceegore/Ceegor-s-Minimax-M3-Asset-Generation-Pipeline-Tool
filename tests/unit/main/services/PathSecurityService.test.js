// tests/unit/main/services/PathSecurityService.test.js
// Bug-fix #4 (2026-06-19): guard the allow-list so a blank
// `output_dir` still yields `<configDir>/generated` as the
// single effective root. Previously the allow-list was empty
// in that case, which rejected every fb:* / image:optimize /
// upscale / audio IPC on freshly generated files.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Point config.js at a throw-away dir BEFORE requiring it.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-pathsec-'));
process.env.MINIMAX_CONFIG_DIR = tmpDir;

// Stub electron so config.js can resolve `app.getPath('exe')`.
require.cache[require.resolve('electron')] = {
  exports: { app: { getPath: () => tmpDir } },
};

delete require.cache[require.resolve('../../../../src/config')];
delete require.cache[require.resolve('../../../../src/pathUtils')];
delete require.cache[require.resolve('../../../../main/services/PathSecurityService')];

const cfgMod = require('../../../../src/config');
const pathSecurity = require('../../../../main/services/PathSecurityService');

function withConfig(cfg, fn) {
  const original = cfgMod.read;
  cfgMod.read = () => cfg;
  try { fn(); } finally { cfgMod.read = original; }
}

test('getAllowedRoots includes <configDir>/generated when output_dir is blank', () => {
  withConfig({ output_dir: '', api_key: 'x', region: 'global', theme: 'dark', styles: [], raw: '' }, () => {
    const roots = pathSecurity.getAllowedRoots();
    assert.ok(roots.includes(cfgMod.effectiveOutputDir({ output_dir: '' })));
    // Single root, no trustedPickPaths yet.
    assert.equal(roots.length, 1);
  });
});

test('isPathUnderAny allows a generated file under the effective output dir', () => {
  const eff = cfgMod.effectiveOutputDir({ output_dir: '' });
  const filePath = path.join(eff, 'subdir', 'asset.png');
  withConfig({ output_dir: '', api_key: '', region: 'global', theme: 'dark', styles: [], raw: '' }, () => {
    assert.equal(pathSecurity.isPathUnderAny(filePath), true);
  });
});

test('getAllowedRoots uses the configured output_dir when set', () => {
  const customDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-custom-'));
  try {
    withConfig({ output_dir: customDir, api_key: '', region: 'global', theme: 'dark', styles: [], raw: '' }, () => {
      const roots = pathSecurity.getAllowedRoots();
      assert.ok(roots.includes(customDir));
      assert.equal(pathSecurity.isPathUnderAny(path.join(customDir, 'a.png')), true);
    });
  } finally {
    try { fs.rmSync(customDir, { recursive: true, force: true }); } catch {}
  }
});

test('addTrusted adds a non-output_dir path to the allow-list', () => {
  withConfig({ output_dir: '', api_key: '', region: 'global', theme: 'dark', styles: [], raw: '' }, () => {
    // BUG-9-04: addTrusted now normalises the path through
    // path.resolve() so the same path string is used everywhere
    // (forward slashes get converted to the OS native separator
    // on Windows, then `isPathUnderAny` does a case-insensitive
    // comparison that ignores the separator). The test asserts
    // the BEHAVIOUR (the picked folder is reachable for writes
    // and its subfolders are too), not the exact string in the
    // set.
    const picked = 'C:/user/picked/folder';
    pathSecurity.addTrusted(picked);
    const roots = pathSecurity.getAllowedRoots();
    // The picked path (in either form) must appear in the roots.
    const norm = path.resolve(picked);
    assert.ok(roots.some((r) => r && r.toLowerCase() === norm.toLowerCase()),
      `addTrusted should normalise and add the picked path; roots = ${JSON.stringify(roots)}`);
    // Subfolders of the picked path are reachable for writes.
    assert.equal(pathSecurity.isPathUnderAny(path.join(norm, 'x.png')), true,
      'a file under the picked folder must be reachable');
  });
});

test.after(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});