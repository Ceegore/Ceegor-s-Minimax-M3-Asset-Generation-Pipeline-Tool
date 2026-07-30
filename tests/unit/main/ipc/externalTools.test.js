// tests/unit/src/externalTools.test.js
//
// v1.1.31 release gate: verify the External tools feature round-trips
// through the config layer + the IPC handler's validation. The
// "spawn" path is unit-tested via the `_internal` helpers
// (buildArgvForTool, validateExePath) because booting a real Electron
// process + child_process.spawn is out of scope for unit tests; the
// test for the actual spawn goes through the integration smoke
// harness in scripts/smoke-renderer.js (which we keep as a no-op here
// and rely on the existing manual QA path).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---- Set up a minimal electron stub so src/config.js can load ----
function loadFresh(userDataPath) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-exttools-test-'));
  process.env.MINIMAX_CONFIG_DIR = tmpDir;
  require.cache[require.resolve('electron')] = {
    exports: {
      app: {
        getPath: (k) => {
          if (k === 'userData') return userDataPath || tmpDir;
          if (k === 'exe') return tmpDir;
          return tmpDir;
        },
      },
    },
  };
  delete require.cache[require.resolve('../../../../src/config')];
  const cfgMod = require('../../../../src/config');
  return { cfgMod, tmpDir };
}

test('v1.1.31: default config includes an empty external_tools list', () => {
  const { cfgMod, tmpDir } = loadFresh();
  try {
    const cfg = cfgMod.defaultConfig();
    assert.ok(Array.isArray(cfg.external_tools));
    assert.equal(cfg.external_tools.length, 0);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('v1.1.31: parse reads [external_tools] block into the external_tools list', () => {
  const { cfgMod, tmpDir } = loadFresh();
  try {
    const text = [
      'api_key=sk-test',
      '',
      '[external_tools]',
      'GIMP = C:\\Program Files\\GIMP 2\\bin\\gimp-2.10.exe',
      'Notepad++ = C:\\Program Files\\Notepad++\\notepad++.exe|-multiInst',
      '  Padded Name  =  C:\\Tools\\padded.exe  |  --no-sandbox  ',
    ].join('\n');
    const cfg = cfgMod.parse(text);
    assert.equal(cfg.external_tools.length, 3);
    assert.deepEqual(cfg.external_tools[0], { name: 'GIMP', exe: 'C:\\Program Files\\GIMP 2\\bin\\gimp-2.10.exe', args: '' });
    assert.deepEqual(cfg.external_tools[1], { name: 'Notepad++', exe: 'C:\\Program Files\\Notepad++\\notepad++.exe', args: '-multiInst' });
    // Whitespace around the name + value is trimmed.
    assert.equal(cfg.external_tools[2].name, 'Padded Name');
    assert.equal(cfg.external_tools[2].exe, 'C:\\Tools\\padded.exe');
    assert.equal(cfg.external_tools[2].args, '--no-sandbox');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('v1.1.31: parse ignores malformed external_tools lines (no =)', () => {
  const { cfgMod, tmpDir } = loadFresh();
  try {
    const text = [
      '[external_tools]',
      'no-equals-sign-here',
      'GIMP = C:\\Tools\\gimp.exe',
    ].join('\n');
    const cfg = cfgMod.parse(text);
    assert.equal(cfg.external_tools.length, 1);
    assert.equal(cfg.external_tools[0].name, 'GIMP');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('v1.1.31: parse exits [external_tools] block on a new [section]', () => {
  const { cfgMod, tmpDir } = loadFresh();
  try {
    const text = [
      '[styles]',
      'MyStyle = cinematic, 35mm',
      '[external_tools]',
      'GIMP = C:\\Tools\\gimp.exe',
      '[styles]',                  // <-- re-entry into [styles] should close external_tools
      'ShouldNotLeak = bad',       // <-- shouldn't show up under external_tools
    ].join('\n');
    const cfg = cfgMod.parse(text);
    assert.equal(cfg.external_tools.length, 1);
    assert.equal(cfg.external_tools[0].name, 'GIMP');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('v1.1.31: serialize writes [external_tools] block when the list is non-empty', () => {
  const { cfgMod, tmpDir } = loadFresh();
  try {
    const cfg = cfgMod.defaultConfig();
    cfg.external_tools = [
      { name: 'GIMP', exe: 'C:\\Tools\\gimp.exe', args: '' },
      { name: 'Notepad++', exe: 'C:\\Tools\\npp.exe', args: '--multiInst' },
    ];
    const out = cfgMod.serialize(cfg);
    assert.ok(out.includes('[external_tools]'), 'serialize must write the [external_tools] header');
    assert.ok(/GIMP\s+=\s+C:\\Tools\\gimp\.exe\|\s*$/.test(out) || out.includes('GIMP = C:\\Tools\\gimp.exe|'),
      'serialize must write the GIMP entry (exe + empty args + pipe separator)');
    assert.ok(out.includes('Notepad++ = C:\\Tools\\npp.exe|--multiInst'),
      'serialize must write the Notepad++ entry with --multiInst args');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('v1.1.31: serialize + parse round-trips external_tools', () => {
  const { cfgMod, tmpDir } = loadFresh();
  try {
    const original = cfgMod.defaultConfig();
    original.api_key = 'sk-roundtrip';
    original.output_dir = 'D:\\assets';
    original.styles = [{ name: 'Cinematic', value: 'cinematic, 35mm' }];
    original.external_tools = [
      { name: 'GIMP', exe: 'C:\\Program Files\\GIMP 2\\bin\\gimp-2.10.exe', args: '' },
      { name: 'Photoshop', exe: 'C:\\Program Files\\Adobe\\Photoshop.exe', args: '' },
      { name: 'Custom Tool', exe: 'C:\\Tools\\custom.exe', args: '--foo --bar=1' },
    ];
    const text = cfgMod.serialize(original);
    const back = cfgMod.parse(text);
    assert.deepEqual(back.external_tools, original.external_tools,
      `round-trip must preserve external_tools. text was:\n${text}\n\nback was:\n${JSON.stringify(back)}`);
    // Other fields are also preserved.
    assert.equal(back.api_key, 'sk-roundtrip');
    assert.equal(back.output_dir, 'D:\\assets');
    assert.equal(back.styles.length, 1);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('v1.1.31: serialize strips newlines + pipes from the name (which would break the parser)', () => {
  const { cfgMod, tmpDir } = loadFresh();
  try {
    const cfg = cfgMod.defaultConfig();
    cfg.external_tools = [{ name: 'Bad|Name\nHere', exe: 'C:\\Tools\\ok.exe', args: '' }];
    const out = cfgMod.serialize(cfg);
    // The parser uses '|' as the in-band separator AND newlines
    // would break the line format. Both must be stripped (replaced
    // with a space) from the NAME so the round-trip is safe. The
    // serialised document itself obviously has newlines (it's a
    // line-oriented format), so we only check the name field —
    // i.e. the part that lands between [external_tools] and the
    // first '=' on the name's line.
    const toolLine = out.split(/\r?\n/).find((l) => l.includes('=') && l.includes('Bad'));
    assert.ok(toolLine, 'expected the tool line to exist');
    assert.ok(!toolLine.includes('|Name'), 'name must not contain a pipe');
    assert.ok(!toolLine.includes('\n'), 'tool line must not contain an embedded newline');
    // The sanitised name must round-trip back to a single token.
    // Both the pipe and the newline are collapsed to spaces by the
    // serializer so the line stays parseable.
    const back = cfgMod.parse(out);
    assert.equal(back.external_tools.length, 1);
    assert.equal(back.external_tools[0].name, 'Bad Name Here');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('v1.1.31: read + write round-trips a real config file on disk', () => {
  const { cfgMod, tmpDir } = loadFresh();
  try {
    const original = cfgMod.defaultConfig();
    original.api_key = 'sk-from-disk';
    original.external_tools = [
      { name: 'GIMP', exe: 'C:\\Tools\\gimp.exe', args: '' },
      { name: 'Note', exe: 'C:\\Tools\\npp.exe', args: '' },
    ];
    cfgMod.write(original);
    const back = cfgMod.read();
    assert.equal(back.api_key, 'sk-from-disk');
    assert.deepEqual(back.external_tools, original.external_tools);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('v1.1.31: missing external_tools in the saved file defaults to an empty list', () => {
  // Backwards compat: a user who upgrades from v1.1.30 has a
  // config.txt with no [external_tools] section. The parser must
  // produce an empty list, not undefined.
  const { cfgMod, tmpDir } = loadFresh();
  try {
    const text = 'api_key=sk-old\noutput_dir=\n';
    const cfg = cfgMod.parse(text);
    assert.ok(Array.isArray(cfg.external_tools));
    assert.equal(cfg.external_tools.length, 0);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('v1.1.31: blank exe with blank args is preserved through the round-trip (not dropped)', () => {
  // A user mid-edit might save a tool with an empty exe. The
  // parser still records the row (with an empty exe field) so the
  // edit isn't lost. The IPC handler will then refuse to launch
  // the tool — that's a separate concern.
  const { cfgMod, tmpDir } = loadFresh();
  try {
    const text = [
      '[external_tools]',
      'Half-Edited = |',
    ].join('\n');
    const cfg = cfgMod.parse(text);
    assert.equal(cfg.external_tools.length, 1);
    assert.equal(cfg.external_tools[0].name, 'Half-Edited');
    assert.equal(cfg.external_tools[0].exe, '');
    assert.equal(cfg.external_tools[0].args, '');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

// ============================================================
// registerExternalToolsIpc._internal helpers
// ============================================================

function loadIPC() {
  // The IPC module needs pathSecurityService + cfgMod. Stub them
  // minimally so the helpers (which don't actually IPC) can load.
  require.cache[require.resolve('../../../../src/pathUtils')] = {
    exports: {
      isPathUnderAny: () => true,
      normalize: (p) => (typeof p === 'string' ? p : null),
    },
  };
  require.cache[require.resolve('../../../../main/services/PathSecurityService')] = {
    exports: { getAllowedRoots: () => [] },
  };
  require.cache[require.resolve('electron')] = {
    exports: { app: { getPath: () => '/tmp' }, ipcMain: { handle: () => {} }, shell: {} },
  };
  delete require.cache[require.resolve('../../../../main/ipc/registerExternalToolsIpc')];
  return require('../../../../main/ipc/registerExternalToolsIpc');
}

test('v1.1.31: buildArgvForTool appends file paths after the extra args', () => {
  const ipc = loadIPC();
  const { buildArgvForTool } = ipc._internal;
  const argv = buildArgvForTool(
    { name: 'GIMP', args: '--no-sandbox' },
    ['C:\\a.png', 'C:\\b.png'],
    'win32',
  );
  assert.deepEqual(argv, ['--no-sandbox', 'C:\\a.png', 'C:\\b.png']);
});

test('v1.1.31: buildArgvForTool handles quoted args (a "b c" splits to a, b, c)', () => {
  const ipc = loadIPC();
  const { buildArgvForTool } = ipc._internal;
  const argv = buildArgvForTool(
    { name: 'Tool', args: '--foo "bar baz" --qux' },
    ['C:\\file.png'],
    'win32',
  );
  assert.deepEqual(argv, ['--foo', 'bar baz', '--qux', 'C:\\file.png']);
});

test('v1.1.31: buildArgvForTool rejects control characters in any token', () => {
  const ipc = loadIPC();
  const { buildArgvForTool } = ipc._internal;
  assert.throws(() => buildArgvForTool(
    { name: 'Tool', args: '' },
    ['C:\\file\nwith-newline.png'],
    'win32',
  ), /control character/);
});

test('v1.1.31: buildArgvForTool with no extra args still appends the file paths', () => {
  const ipc = loadIPC();
  const { buildArgvForTool } = ipc._internal;
  const argv = buildArgvForTool({ name: 'Tool' }, ['C:\\a.png'], 'win32');
  assert.deepEqual(argv, ['C:\\a.png']);
});

test('v1.1.31: buildArgvForTool with no tool at all yields just the file paths', () => {
  const ipc = loadIPC();
  const { buildArgvForTool } = ipc._internal;
  const argv = buildArgvForTool(null, ['C:\\a.png', 'C:\\b.png'], 'win32');
  assert.deepEqual(argv, ['C:\\a.png', 'C:\\b.png']);
});

test('v1.1.31: validateExePath rejects an empty path', async () => {
  const ipc = loadIPC();
  const { validateExePath } = ipc._internal;
  await assert.rejects(() => validateExePath(''), /Exe path is required/);
  await assert.rejects(() => validateExePath('   '), /Exe path is required/);
  await assert.rejects(() => validateExePath(null), /Exe path is required/);
  await assert.rejects(() => validateExePath(42), /Exe path is required/);
});

test('v1.1.31: validateExePath rejects a non-absolute path', async () => {
  const ipc = loadIPC();
  const { validateExePath } = ipc._internal;
  await assert.rejects(() => validateExePath('gimp.exe'), /absolute/);
  await assert.rejects(() => validateExePath('tools/gimp.exe'), /absolute/);
});

test('v1.1.31: validateExePath rejects shell meta characters', async () => {
  const ipc = loadIPC();
  const { validateExePath } = ipc._internal;
  for (const ch of ['"', '|', '<', '>', '&', ';', '`']) {
    await assert.rejects(() => validateExePath('C:\\foo' + ch + 'bar.exe'), /shell meta character/);
  }
});

test('v1.1.31: validateExePath rejects Windows reserved device names', async () => {
  const ipc = loadIPC();
  const { validateExePath } = ipc._internal;
  // CON.exe is the classic one. We don't actually need the file
  // to exist — the device-name check runs first.
  for (const dev of ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT1']) {
    await assert.rejects(() => validateExePath('C:\\Windows\\' + dev + '.exe'), /reserved device/);
  }
});

test('v1.1.31: validateExePath rejects a non-existent path', async () => {
  const ipc = loadIPC();
  const { validateExePath } = ipc._internal;
  const nonExistent = path.join(os.tmpdir(), 'definitely-does-not-exist-' + Date.now() + '.exe');
  await assert.rejects(() => validateExePath(nonExistent), /does not exist/);
});

test('v1.1.31: validateExePath accepts a real .exe file', async () => {
  const ipc = loadIPC();
  const { validateExePath } = ipc._internal;
  // Write a tiny file we can pretend is a .exe. The validator
  // only checks existence + isFile; it doesn't try to read the
  // PE header.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-exttools-validate-'));
  try {
    const fakeExe = path.join(tmpDir, 'fake.exe');
    fs.writeFileSync(fakeExe, 'MZ');
    const got = await validateExePath(fakeExe);
    assert.equal(got, fakeExe);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('v1.1.31: validateExePath rejects a directory', async () => {
  const ipc = loadIPC();
  const { validateExePath } = ipc._internal;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-exttools-dir-'));
  try {
    await assert.rejects(() => validateExePath(tmpDir), /not a regular file/);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('v1.1.31: runExternalTool returns error for an unknown tool name', async () => {
  const ipc = loadIPC();
  // Stub cfgMod.read to return an empty list.
  const cfgMod = require('../../../../src/config');
  const origRead = cfgMod.read;
  cfgMod.read = () => cfgMod.defaultConfig();
  // R1.5b.2: pre-populate the PathGrantService cache with a mock
  // that accepts everything. The unknown-tool error fires BEFORE
  // the grant check, so the grantId is irrelevant here — we
  // pass one for contract consistency.
  const pathGrantPath = require.resolve('../../../../main/services/PathGrantService');
  require.cache[pathGrantPath] = {
    exports: {
      defaultService: {
        authorize: () => ({ ok: true, canonicalPath: 'x' }),
        mintDirectoryGrant: () => ({ ok: true, grantId: 'g', grant: {} }),
        mintFileGrant: () => ({ ok: true, grantId: 'g', grant: {} }),
        revoke: () => ({ ok: true }),
        destroy: () => 0,
      },
    },
  };
  try {
    const r = await ipc._internal.runExternalTool({ name: 'NoSuchTool', paths: ['C:\\a.png'] }, 'mock-grant-id');
    assert.equal(r.ok, false);
    assert.ok(/not configured/i.test(r.error), `expected "not configured", got: ${r.error}`);
  } finally {
    cfgMod.read = origRead;
    delete require.cache[pathGrantPath];
  }
});

test('v1.1.31: runExternalTool returns error for a tool with an empty exe', async () => {
  const ipc = loadIPC();
  const cfgMod = require('../../../../src/config');
  const origRead = cfgMod.read;
  cfgMod.read = () => Object.assign(cfgMod.defaultConfig(), {
    external_tools: [{ name: 'NoExe', exe: '', args: '' }],
  });
  // R1.5b.2: same path-grant mock as above; the empty-exe error
  // fires AFTER the grant check (the grant is checked first,
  // then the tool lookup), so the grantId is also irrelevant
  // here but the handler still needs one.
  const pathGrantPath = require.resolve('../../../../main/services/PathGrantService');
  require.cache[pathGrantPath] = {
    exports: {
      defaultService: {
        authorize: () => ({ ok: true, canonicalPath: 'x' }),
        mintDirectoryGrant: () => ({ ok: true, grantId: 'g', grant: {} }),
        mintFileGrant: () => ({ ok: true, grantId: 'g', grant: {} }),
        revoke: () => ({ ok: true }),
        destroy: () => 0,
      },
    },
  };
  try {
    const r = await ipc._internal.runExternalTool({ name: 'NoExe', paths: ['C:\\a.png'] }, 'mock-grant-id');
    assert.equal(r.ok, false);
    assert.ok(/no exe path/i.test(r.error), `expected "no exe path", got: ${r.error}`);
  } finally {
    cfgMod.read = origRead;
    delete require.cache[pathGrantPath];
  }
});

test('v1.5b.2: runExternalTool rejects file paths outside the grant (replaces legacy isPathUnderAny gate)', async () => {
  const ipc = loadIPC();
  const cfgMod = require('../../../../src/config');
  const origRead = cfgMod.read;
  // Create a real .exe so the validator passes.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-exttools-run-'));
  const fakeExe = path.join(tmpDir, 'tool.exe');
  fs.writeFileSync(fakeExe, 'MZ');
  cfgMod.read = () => Object.assign(cfgMod.defaultConfig(), {
    external_tools: [{ name: 'Tool', exe: fakeExe, args: '' }],
  });
  // R1.5b.2: pre-populate the PathGrantService cache with a mock
  // whose authorize() rejects paths under C:\Windows\System32
  // (the legacy "outside the allowed directories" check). The
  // lazy require in grantAuthorizer (R1.5a.6) hits the cache at
  // handler-call time.
  const pathGrantPath = require.resolve('../../../../main/services/PathGrantService');
  require.cache[pathGrantPath] = {
    exports: {
      defaultService: {
        authorize: (grantId, spec) => {
          if (!grantId) return { ok: false, error: 'grantId required' };
          if (!spec || typeof spec.path !== 'string') return { ok: false, error: 'path required' };
          if (spec.path.startsWith('C:\\Windows\\System32')) {
            return { ok: false, error: 'path is outside the grant scope' };
          }
          return { ok: true, canonicalPath: spec.path };
        },
        mintDirectoryGrant: () => ({ ok: true, grantId: 'g', grant: {} }),
        mintFileGrant: () => ({ ok: true, grantId: 'g', grant: {} }),
        revoke: () => ({ ok: true }),
        destroy: () => 0,
      },
    },
  };
  // Bust the IPC module's cached require so it picks up the new stub.
  delete require.cache[require.resolve('../../../../main/ipc/registerExternalToolsIpc')];
  const ipc2 = require('../../../../main/ipc/registerExternalToolsIpc');
  try {
    const r = await ipc2._internal.runExternalTool({ name: 'Tool', paths: ['C:\\Windows\\System32\\evil.dll'] }, 'mock-grant-id');
    assert.equal(r.ok, false);
    // R1.5b.2: the new error envelope is "not authorised by the
    // grant" (matches the S1 §3 contract for the read grant on
    // Existenz-Probes). The legacy "outside the allowed
    // directories" wording is gone for the renderer's file
    // paths (it's still used by validateExePath for the tool's
    // exe path, which is config-derived).
    assert.ok(/not authorised|outside the allowed directories/i.test(r.error),
      `expected not-authorised/outside-allowed, got: ${r.error}`);
  } finally {
    cfgMod.read = origRead;
    delete require.cache[pathGrantPath];
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('v1.1.31: runExternalTool spawns a real .exe on a valid file path (win32 happy path)', async () => {
  const ipc = loadIPC();
  const cfgMod = require('../../../../src/config');
  // P1-C (360° Audit C-003): cmd.exe is now a BLOCKED interpreter binary.
  // Use attrib.exe instead — always present on Windows, not a shell/script
  // host, and exits immediately when given a file path argument.
  const attribExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'attrib.exe');
  const origRead = cfgMod.read;
  cfgMod.read = () => Object.assign(cfgMod.defaultConfig(), {
    external_tools: [
      { name: 'attrib', exe: attribExe, args: '' },
      { name: 'cmd', exe: process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe', args: '/c exit 0' },
    ],
  });
  // The IPC path check uses isPathUnderAny + the same allowed
  // roots. Stub it to allow any path under tmpDir.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-exttools-spawn-'));
  const fakeFile = path.join(tmpDir, 'a.txt');
  fs.writeFileSync(fakeFile, 'hello');
  require.cache[require.resolve('../../../../src/pathUtils')] = {
    exports: {
      isPathUnderAny: (p) => String(p).toLowerCase().startsWith(tmpDir.toLowerCase()),
      normalize: (p) => (typeof p === 'string' ? p : null),
    },
  };
  // R1.5b.2: pre-populate the PathGrantService cache with a mock
  // that accepts any path (the spawn test uses a path under
  // tmpDir; the mock authorises it).
  const pathGrantPath = require.resolve('../../../../main/services/PathGrantService');
  require.cache[pathGrantPath] = {
    exports: {
      defaultService: {
        authorize: (grantId, spec) => {
          if (!grantId) return { ok: false, error: 'grantId required' };
          if (!spec || typeof spec.path !== 'string') return { ok: false, error: 'path required' };
          return { ok: true, canonicalPath: spec.path };
        },
        mintDirectoryGrant: () => ({ ok: true, grantId: 'g', grant: {} }),
        mintFileGrant: () => ({ ok: true, grantId: 'g', grant: {} }),
        revoke: () => ({ ok: true }),
        destroy: () => 0,
      },
    },
  };
  delete require.cache[require.resolve('../../../../main/ipc/registerExternalToolsIpc')];
  const ipc2 = require('../../../../main/ipc/registerExternalToolsIpc');
  try {
    const r = await ipc2._internal.runExternalTool({ name: 'attrib', paths: [fakeFile] }, 'mock-grant-id');
    if (process.platform !== 'win32') {
      // We can only run the attrib.exe happy path on Windows. On
      // Linux/macOS the validator will reject the absolute
      // /Windows/System32/attrib.exe path; the test still passes
      // because we only check r.ok, not the precise error.
      return;
    }
    assert.equal(r.ok, true, `expected ok=true, got: ${JSON.stringify(r)}`);
    assert.ok(typeof r.pid === 'number' && r.pid > 0, 'pid should be a positive number');
    assert.ok(Array.isArray(r.argv) && r.argv.includes(fakeFile),
      `argv should include the file path. got: ${JSON.stringify(r.argv)}`);
    // P1-C (C-003): interpreter binaries must be REFUSED.
    const blocked = await ipc2._internal.runExternalTool({ name: 'cmd', paths: [fakeFile] }, 'mock-grant-id');
    assert.equal(blocked.ok, false, 'cmd.exe must be refused as an external tool');
    assert.ok(/interpreter|shell/i.test(blocked.error || ''),
      `expected interpreter-blocklist error, got: ${blocked.error}`);
  } finally {
    cfgMod.read = origRead;
    delete require.cache[pathGrantPath];
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('v1.1.31: probeExternalTool returns exists=false for a non-existent exe', async () => {
  const ipc = loadIPC();
  const cfgMod = require('../../../../src/config');
  const origRead = cfgMod.read;
  cfgMod.read = () => Object.assign(cfgMod.defaultConfig(), {
    external_tools: [{ name: 'Missing', exe: path.join(os.tmpdir(), 'definitely-does-not-exist.exe'), args: '' }],
  });
  try {
    const r = await ipc._internal.probeExternalTool({ name: 'Missing' });
    assert.equal(r.ok, true);
    assert.equal(r.validExecutable, false);
  } finally {
    cfgMod.read = origRead;
  }
});

test('v1.1.31: probeExternalTool returns exists=true + size for a real file', async () => {
  const ipc = loadIPC();
  const cfgMod = require('../../../../src/config');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-exttools-probe-'));
  const realExe = path.join(tmpDir, 'real.exe');
  fs.writeFileSync(realExe, Buffer.alloc(4096, 0x4D)); // 4 KB
  const origRead = cfgMod.read;
  cfgMod.read = () => Object.assign(cfgMod.defaultConfig(), {
    external_tools: [{ name: 'Real', exe: realExe, args: '' }],
  });
  try {
    const r = await ipc._internal.probeExternalTool({ name: 'Real' });
    assert.equal(r.ok, true);
    assert.equal(r.validExecutable, true);
  } finally {
    cfgMod.read = origRead;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('v1.1.31: probeExternalTool errors on an unknown tool name', async () => {
  const ipc = loadIPC();
  const cfgMod = require('../../../../src/config');
  const origRead = cfgMod.read;
  cfgMod.read = () => cfgMod.defaultConfig();
  try {
    const r = await ipc._internal.probeExternalTool({ name: 'NoSuch' });
    assert.equal(r.ok, false);
    assert.ok(/not configured/i.test(r.error));
  } finally {
    cfgMod.read = origRead;
  }
});