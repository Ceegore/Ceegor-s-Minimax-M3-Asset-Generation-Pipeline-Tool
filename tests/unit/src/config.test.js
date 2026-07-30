// tests/unit/src/config.test.js
// Bug-fix (2026-06-19, reported by user): the default output
// directory must land in `%APPDATA%/<productName>/generated`
// (i.e. Electron's `app.getPath('userData') + /generated`),
// NOT in `<exe-dir>/generated` (which is what the user sees as
// "<release>/win-unpacked/generated" for packaged builds —
// an unexpected location that may not even exist on disk).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Each test isolates its own config dir + electron stub so we
// can drive the module's `app.getPath('userData')` return value
// deterministically without colliding with other test files.
function loadFresh(userDataPath) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-config-test-'));
  process.env.MINIMAX_CONFIG_DIR = tmpDir;
  require.cache[require.resolve('electron')] = {
    exports: { app: { getPath: (k) => (k === 'userData' ? userDataPath : tmpDir) } },
  };
  delete require.cache[require.resolve('../../../src/config')];
  const cfgMod = require('../../../src/config');
  return { cfgMod, tmpDir };
}

test('defaultOutputDir returns <userData>/generated', () => {
  const userData = 'C:\\Users\\tester\\AppData\\Roaming\\MiniMaxAssetTool';
  const { cfgMod, tmpDir } = loadFresh(userData);
  try {
    const d = cfgMod.defaultOutputDir();
    assert.equal(d, path.join(userData, 'generated'));
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('defaultOutputDir does NOT land inside the exe dir', () => {
  // The old default was <configDir>/generated — i.e. <exe-dir>/generated.
  // For a packaged build that's <release>/win-unpacked/generated,
  // which the user explicitly asked NOT to use.
  const userData = 'C:\\Users\\tester\\AppData\\Roaming\\MiniMaxAssetTool';
  const exeDir = 'C:\\Projects\\app\\release\\win-unpacked';
  const { cfgMod, tmpDir } = loadFresh(userData);
  try {
    // Make configDir() resolve to the packaged-exe layout.
    require.cache[require.resolve('electron')] = {
      exports: {
        app: {
          getPath: (k) => (k === 'userData' ? userData : exeDir),
        },
      },
    };
    delete require.cache[require.resolve('../../../src/config')];
    const cfgMod2 = require('../../../src/config');
    const d = cfgMod2.defaultOutputDir();
    assert.notEqual(d, path.join(exeDir, 'generated'));
    assert.ok(d.startsWith(userData), `expected ${d} to start with ${userData}`);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('effectiveOutputDir falls back to defaultOutputDir when cfg.output_dir is blank', () => {
  const userData = 'C:\\Users\\tester\\AppData\\Roaming\\MiniMaxAssetTool';
  const { cfgMod, tmpDir } = loadFresh(userData);
  try {
    const d = cfgMod.effectiveOutputDir({ output_dir: '' });
    assert.equal(d, path.join(userData, 'generated'));
    const d2 = cfgMod.effectiveOutputDir({ output_dir: '   ' });
    assert.equal(d2, path.join(userData, 'generated'));
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('effectiveOutputDir respects a configured output_dir', () => {
  const userData = 'C:\\Users\\tester\\AppData\\Roaming\\MiniMaxAssetTool';
  const { cfgMod, tmpDir } = loadFresh(userData);
  try {
    const customDir = 'D:\\my-assets';
    const d = cfgMod.effectiveOutputDir({ output_dir: customDir });
    assert.equal(d, customDir);
    // Trimming whitespace is preserved.
    const d2 = cfgMod.effectiveOutputDir({ output_dir: '  ' + customDir + '  ' });
    assert.equal(d2, customDir);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('defaultOutputDir falls back to %APPDATA% even if electron is unavailable', () => {
  // Drive the fallback branch (electron's app.getPath throws).
  // The function must still produce a stable, %APPDATA%-based
  // path so tests in non-Electron contexts keep working.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-cfg-fallback-'));
  process.env.MINIMAX_CONFIG_DIR = tmpDir;
  process.env.APPDATA = 'C:\\Users\\tester\\AppData\\Roaming';
  // Stub electron so require('electron') succeeds but
  // app.getPath throws — that puts us in the catch branch.
  require.cache[require.resolve('electron')] = {
    exports: { app: { getPath: () => { throw new Error('not in electron context'); } } },
  };
  try {
    delete require.cache[require.resolve('../../../src/config')];
    const cfgMod = require('../../../src/config');
    const d = cfgMod.defaultOutputDir();
    assert.ok(d.startsWith('C:\\Users\\tester\\AppData\\Roaming'));
    assert.ok(d.endsWith(path.join('MiniMaxAssetTool', 'generated')));
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

// Task 4 (data-loss regression): report_dir / external_tools must survive a
// serialize → parse round-trip, and sanitize() must whitelist both (otherwise
// opening Settings → Save wipes them). removebg_api_key was REMOVED (H7-018);
// a leftover line in an old config.txt must be tolerated (silently dropped)
// so existing files migrate cleanly.
test('report_dir round-trips through serialize → parse', () => {
  const userData = 'C:\\Users\\tester\\AppData\\Roaming\\MiniMaxAssetTool';
  const { cfgMod, tmpDir } = loadFresh(userData);
  try {
    const serialized = cfgMod.serialize({
      api_key: 'k', output_dir: 'D:\\out', report_dir: 'E:\\reports',
      region: 'global', theme: 'dark', styles: [], external_tools: [],
    });
    const parsed = cfgMod.parse(serialized);
    assert.equal(parsed.report_dir, 'E:\\reports', 'report_dir must survive round-trip');
    // A blank report_dir must also round-trip (default).
    const serializedBlank = cfgMod.serialize({ report_dir: '' });
    assert.equal(cfgMod.parse(serializedBlank).report_dir, '');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('a leftover removebg_api_key line is tolerated and dropped (H7-018 migration)', () => {
  const userData = 'C:\\Users\\tester\\AppData\\Roaming\\MiniMaxAssetTool';
  const { cfgMod, tmpDir } = loadFresh(userData);
  try {
    // An old config.txt still containing the removed key must parse without
    // error and must NOT expose removebg_api_key on the resulting object.
    const text = 'api_key=k\nremovebg_api_key=legacy-secret\noutput_dir=D:\\out\n';
    const parsed = cfgMod.parse(text);
    assert.equal(parsed.api_key, 'k');
    assert.equal(parsed.output_dir, 'D:\\out');
    assert.equal(parsed.removebg_api_key, undefined, 'the removed key must not be present');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('external_tools round-trips through serialize → parse', () => {
  const userData = 'C:\\Users\\tester\\AppData\\Roaming\\MiniMaxAssetTool';
  const { cfgMod, tmpDir } = loadFresh(userData);
  try {
    const tools = [
      { name: 'GIMP', exe: 'C:\\Program Files\\GIMP\\bin\\gimp.exe', args: '-n' },
      { name: 'NoArgs', exe: 'D:\\editor\\app.exe', args: '' },
    ];
    const serialized = cfgMod.serialize({ external_tools: tools });
    const parsed = cfgMod.parse(serialized);
    assert.equal(parsed.external_tools.length, 2);
    assert.equal(parsed.external_tools[0].name, 'GIMP');
    assert.equal(parsed.external_tools[0].exe, 'C:\\Program Files\\GIMP\\bin\\gimp.exe');
    assert.equal(parsed.external_tools[0].args, '-n');
    assert.equal(parsed.external_tools[1].args, '');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('sanitize keeps report_dir + external_tools (data-loss regression)', () => {
  const { sanitize } = require('../../../main/models/ConfigSchema');
  const out = sanitize({
    report_dir: 'E:\\reports',
    external_tools: [{ name: 'GIMP', exe: 'C:\\gimp.exe', args: '' }],
  });
  assert.equal(out.report_dir, 'E:\\reports');
  assert.equal(out.external_tools.length, 1);
  assert.equal(out.external_tools[0].name, 'GIMP');
  // removebg_api_key was removed (H7-018) — sanitize must drop it entirely.
  assert.equal('removebg_api_key' in out, false, 'sanitize must not keep the removed key');
});

// P4.3 (DB-H-003): batch_max_units must survive serialize → parse AND the
// ConfigSchema sanitize() whitelist, else Settings → Save resets the cap.
test('batch_max_units round-trips through serialize → parse with clamping', () => {
  const userData = 'C:\\Users\\tester\\AppData\\Roaming\\MiniMaxAssetTool';
  const { cfgMod, tmpDir } = loadFresh(userData);
  try {
    assert.equal(cfgMod.parse(cfgMod.serialize({ batch_max_units: 500 })).batch_max_units, 500);
    // Default when absent / garbage.
    assert.equal(cfgMod.parse('api_key=k\n').batch_max_units, 200);
    assert.equal(cfgMod.parse('batch_max_units=banana\n').batch_max_units, 200);
    // Clamped: below 1 → default; above 10000 → ceiling.
    assert.equal(cfgMod.parse('batch_max_units=0\n').batch_max_units, 200);
    assert.equal(cfgMod.parse('batch_max_units=-5\n').batch_max_units, 200);
    assert.equal(cfgMod.parse('batch_max_units=999999\n').batch_max_units, 10000);
    assert.equal(cfgMod.parse(cfgMod.serialize({ batch_max_units: 999999 })).batch_max_units, 10000);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('sanitize keeps batch_max_units and clamps it (P4.3 data-loss regression)', () => {
  const { sanitize } = require('../../../main/models/ConfigSchema');
  assert.equal(sanitize({ batch_max_units: 500 }).batch_max_units, 500);
  assert.equal(sanitize({ batch_max_units: '750' }).batch_max_units, 750);
  assert.equal(sanitize({}).batch_max_units, 200, 'absent → default');
  assert.equal(sanitize({ batch_max_units: 'banana' }).batch_max_units, 200);
  assert.equal(sanitize({ batch_max_units: 0 }).batch_max_units, 200);
  assert.equal(sanitize({ batch_max_units: 999999 }).batch_max_units, 10000);
});

test('sanitize cleans malformed external_tools entries', () => {
  const { sanitize } = require('../../../main/models/ConfigSchema');
  const out = sanitize({
    external_tools: [
      { name: 'Good', exe: 'C:\\good.exe', args: '' },
      { name: 'NoExe', exe: '', args: '' },        // dropped (unusable)
      { name: '', exe: 'C:\\x.exe' },              // dropped (no name)
      'not-an-object',                              // dropped
      null,
    ],
  });
  assert.equal(out.external_tools.length, 1);
  assert.equal(out.external_tools[0].name, 'Good');
});

test('ensureOutputDir creates the default generated folder if missing (H7-004)', () => {
  // Point userData at a REAL temp path so mkdirSync actually runs. The folder
  // must NOT exist beforehand; after the call it must exist (recursively).
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-ensure-out-'));
  const userData = tmpRoot; // bare userData — generated/ is created underneath
  process.env.MINIMAX_CONFIG_DIR = tmpRoot;
  require.cache[require.resolve('electron')] = {
    exports: { app: { getPath: (k) => (k === 'userData' ? userData : tmpRoot) } },
  };
  delete require.cache[require.resolve('../../../src/config')];
  const cfgMod = require('../../../src/config');
  try {
    const expected = path.join(userData, 'generated');
    assert.ok(!fs.existsSync(expected), 'precondition: generated/ must not exist yet');
    const resolved = cfgMod.ensureOutputDir({ output_dir: '' });
    assert.equal(resolved, expected);
    assert.ok(fs.existsSync(expected), 'generated/ must exist after ensureOutputDir');
    assert.ok(fs.statSync(expected).isDirectory(), 'generated/ must be a directory');
    // Idempotent: a second call does not throw.
    cfgMod.ensureOutputDir({ output_dir: '' });
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  }
});

test('ensureOutputDir creates a configured nested output_dir (H7-004)', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-ensure-out2-'));
  process.env.MINIMAX_CONFIG_DIR = tmpRoot;
  require.cache[require.resolve('electron')] = {
    exports: { app: { getPath: () => tmpRoot } },
  };
  delete require.cache[require.resolve('../../../src/config')];
  const cfgMod = require('../../../src/config');
  try {
    const nested = path.join(tmpRoot, 'a', 'b', 'c');
    const resolved = cfgMod.ensureOutputDir({ output_dir: nested });
    assert.equal(resolved, nested);
    assert.ok(fs.existsSync(nested));
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  }
});
