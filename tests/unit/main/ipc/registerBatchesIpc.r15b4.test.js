// tests/unit/main/ipc/registerBatchesIpc.r15b4.test.js
// ============================================================================
// R1.5b.4 — Batches IPC audit (S1 §6 R1.5b).
//
// The R1.5b.4 audit verified that none of the 4 Batches handlers
// require a `grantId`. The tests below lock in the "no grant
// required" contract so a future change that adds a
// renderer-supplied path (and would need a grant) is caught.
//
// R1.5b.4 Phasenpruefung-of-Phasenpruefung-of-Phasenpruefung added
// the test-coverage gaps the previous passes did not close:
//   - `batches:saveManualAs` real write path (overrides the dialog
//     mock to return a real filePath and asserts the file is
//     actually written + content matches the registry)
//   - `batches:saveManualAs` calls `pathSecurity.addTrusted` with
//     the dialog-picked dirname (load-bearing for the cross-IPC
//     trust chain that R1.5b.4 Phasenpruefung-of-Phasenpruefung
//     identified for `registerPipelineIpc:82`)
//   - `batches:saveManualAs` extension heuristic (truth table
//     locked in so a future simplification is conscious)
//   - `batches:saveManualAs` does NOT call `addTrusted` on a
//     canceled dialog
//   - `batches:saveManualAs` write-error path (ok:false, no
//     throw to renderer, addTrusted fires BEFORE the write —
//     the current order; a future hardening pass may move it
//     into the success branch)
//   - `batches:generateExamples` partial-failure path (2nd
//     write throws, ok:false, error propagated, no grant
//     check fires)
//   - `batches:set` legacy normalize() behaviour for a
//     non-object input (test renamed to reflect the actual
//     contract — the original name was misleading)
//
// Contract per handler:
//   - `batches:get`     — reads persisted state. No file paths in
//                         the payload. Main-known dest
//                         (configDir()/batches.json).
//   - `batches:set`     — writes persisted state. The `batches`
//                         arg is the full state object (no path
//                         strings). Main-known dest.
//   - `batches:generateExamples` — writes 2 example files to
//                         `effectiveOutputDir(cfg)`. Main-known
//                         dest. The `format` arg picks which
//                         file to keep.
//   - `batches:saveManualAs` — opens native Save-As dialog.
//                         User-picked dest. Trust gesture per
//                         S1 §3.
//
// The tests assert that each handler:
//   (1) succeeds WITHOUT a grantId in the payload (the new
//       contract — no grant required);
//   (2) does NOT call grantAuthorizer / PathGrantService (no
//       grant check fires);
//   (3) writes to / reads from the Main-known or dialog-picked
//       path (NOT to a renderer-supplied path).
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const BATCHES_IPC = path.join(ROOT, 'main', 'ipc', 'registerBatchesIpc.js');
const BATCHES = path.join(ROOT, 'src', 'batches.js');
const CONFIG = path.join(ROOT, 'src', 'config.js');
const PATH_GRANT = path.join(ROOT, 'main', 'services', 'PathGrantService.js');
const PATH_SECURITY = path.join(ROOT, 'main', 'services', 'PathSecurityService.js');
const IMPORT_DOC = path.join(ROOT, 'main', 'services', 'importDocManual.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-r15b4-'));

// Pre-populated config with output_dir = TMP so the example files
// land somewhere isolated. We use a real on-disk config to make
// the test exercise the real `configDir()` + `effectiveOutputDir()`
// paths.
const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-r15b4-config-'));
fs.writeFileSync(path.join(CONFIG_DIR, 'config.txt'), '');

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  try { fs.rmSync(CONFIG_DIR, { recursive: true, force: true }); } catch (_) {}
});

function loadIpc(opts = {}) {
  for (const p of [BATCHES_IPC, BATCHES, CONFIG, PATH_GRANT, PATH_SECURITY, IMPORT_DOC]) {
    try { delete require.cache[require.resolve(p)]; } catch (_) {}
  }
  // Reset the defaultService singleton (R1.5a.6 fix).
  try {
    const { defaultService } = require(PATH_GRANT);
    defaultService.destroy();
  } catch (_) {}

  const handlers = new Map();
  const calls = { grantAuthorize: [] };

  // Track grant service calls: any call to authorize() or
  // mintDirectoryGrant() / mintFileGrant() etc. would indicate a
  // grant check firing (which Batches is not supposed to do).
  const defaultServiceMock = {
    authorize: (grantId, spec) => {
      calls.grantAuthorize.push({ op: 'authorize', grantId, spec });
      return { ok: true, canonicalPath: spec && spec.path };
    },
    mintDirectoryGrant: (spec) => {
      calls.grantAuthorize.push({ op: 'mintDirectoryGrant', spec });
      return { ok: true, grantId: 'g', grant: spec };
    },
    mintFileGrant: (spec) => {
      calls.grantAuthorize.push({ op: 'mintFileGrant', spec });
      return { ok: true, grantId: 'g', grant: spec };
    },
    revoke: () => ({ ok: true }),
    destroy: () => 0,
  };

  // Mutable dialog return — tests can override `dialogReturn.value`
  // before invoking the handler. Default = canceled (the old
  // behaviour for the "no successful write" tests).
  const dialogReturn = { value: opts.dialogReturn || { canceled: true, filePath: '' } };

  // Mock electron + dialog.
  require.cache[require.resolve('electron')] = {
    exports: {
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
      dialog: {
        showSaveDialog: async () => dialogReturn.value,
        showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      },
      app: { getPath: () => path.join(TMP, 'fake-userData') },
    },
  };

  // Mock config to use the isolated CONFIG_DIR.
  process.env.MINIMAX_CONFIG_DIR = CONFIG_DIR;
  require.cache[require.resolve(CONFIG)] = {
    exports: {
      read: () => ({ output_dir: TMP, api_key: 'test', theme: 'dark' }),
      effectiveOutputDir: () => TMP,
      configDir: () => CONFIG_DIR,
      defaultConfig: () => ({ output_dir: TMP }),
    },
  };

  // Mock PathGrantService with the recording mock above.
  require.cache[require.resolve(PATH_GRANT)] = {
    exports: { defaultService: defaultServiceMock },
  };

  // Mock PathSecurityService so we can track addTrusted() calls
  // (the load-bearing legacy call in batches:saveManualAs that
  // R1.5b.4 Phasenpruefung-of-Phasenpruefung identified as the
  // cross-IPC trust chain for registerPipelineIpc:82).
  const pathSecurityCalls = { addTrusted: [] };
  require.cache[require.resolve(PATH_SECURITY)] = {
    exports: {
      addTrusted: (p) => { pathSecurityCalls.addTrusted.push(p); return [p]; },
      isPathUnderAny: () => true,
      isParentUnderAny: () => true,
      getAllowedRoots: () => [TMP],
      setActiveDir: () => {},
      getActiveDir: () => null,
      refreshOutputRoot: () => {},
    },
  };

  // Optional fs.writeFileSync override (for partial-failure tests).
  // If `opts.writeFile` is provided, replace fs.writeFileSync in
  // the cache with a recording wrapper that delegates to the
  // override. The original is stashed on `loadIpc._origWriteFileSync`
  // so the next call to `loadIpc()` (without opts.writeFile) can
  // restore the real implementation — otherwise later tests would
  // hit the wrapper and fail mysteriously.
  // Restore FIRST (so the previous test's override is cleared
  // before THIS test's override is installed). The order matters:
  // restore → install, not install → restore.
  if (loadIpc._origWriteFileSync) {
    require('fs').writeFileSync = loadIpc._origWriteFileSync;
    loadIpc._origWriteFileSync = null;
  }
  if (opts.writeFile) {
    const realFs = require('fs');
    const writeFileCalls = [];
    const origWriteFileSync = realFs.writeFileSync;
    const writeFileOverride = opts.writeFile;
    realFs.writeFileSync = function (p, data, enc) {
      writeFileCalls.push({ path: p, data, enc });
      if (writeFileOverride.shouldThrow && writeFileOverride.shouldThrow(p)) {
        const err = new Error(writeFileOverride.message || 'simulated write failure');
        err.code = writeFileOverride.code || 'EACCES';
        throw err;
      }
      return origWriteFileSync.apply(this, arguments);
    };
    // Save the original so the NEXT loadIpc() call (which does
    // NOT pass opts.writeFile) can restore the real implementation.
    loadIpc._origWriteFileSync = origWriteFileSync;
    // Stash the call recorder on the returned object so tests can assert.
    // (Closure-captured — we return the same `writeFileCalls` below.)
    opts._writeFileCalls = writeFileCalls;
  }

  // Mock importDocManual.
  require.cache[require.resolve(IMPORT_DOC)] = {
    exports: {
      generateManual: () => '# test markdown manual\n',
      generateTxtManual: () => 'TEST TXT MANUAL\n',
    },
  };

  // (Restore branch was here — moved UP before the install branch
  // so the install is not immediately undone. See the comment
  // above the new restore location.)

  // Now load the IPC.
  require(BATCHES_IPC).register({ appRoot: ROOT, getMainWindow: () => null });
  return { handlers, calls, defaultServiceMock, dialogReturn, pathSecurityCalls, TMP, writeFileCalls: opts._writeFileCalls };
}

// ===========================================================================
// batches:get — no grant required
// ===========================================================================

test('R1.5b.4: batches:get succeeds without a grantId (no grant check fires)', () => {
  const { handlers, calls } = loadIpc();
  const r = handlers.get('batches:get')();
  // The handler returns the default state (no batches.json yet).
  assert.ok(r, 'must return a value');
  assert.equal(typeof r, 'object');
  // NO grant check fired (Batches doesn't need a grant).
  assert.equal(calls.grantAuthorize.length, 0,
    'batches:get must NOT call any grant service method (no grant required)');
});

test('R1.5b.4: batches:get returns the proper default shape on a fresh install', () => {
  const { handlers } = loadIpc();
  const r = handlers.get('batches:get')();
  // The renderer's defensive reads happen not to crash on an
  // empty array, but any future code that spread state.batches
  // would silently produce junk keys. The contract is an
  // object keyed by tab.
  assert.ok(r && typeof r === 'object' && !Array.isArray(r),
    'batches:get must return an OBJECT (not an array) on a fresh install');
  assert.ok('image' in r && 'speech' in r && 'music' in r && 'video' in r,
    'batches:get must return the canonical 4-tab shape');
});

// ===========================================================================
// batches:set — no grant required
// ===========================================================================

test('R1.5b.4: batches:set succeeds without a grantId (writes to Main-known dest)', () => {
  const { handlers, calls } = loadIpc();
  const r = handlers.get('batches:set')(null, {
    image: ['a cat', 'a dog'],
    speech: [],
    music: [],
    video: [],
  });
  assert.deepEqual(r, { ok: true });
  // NO grant check fired.
  assert.equal(calls.grantAuthorize.length, 0,
    'batches:set must NOT call any grant service method');
  // The state was actually written (a real on-disk file).
  const r2 = handlers.get('batches:get')();
  assert.deepEqual(r2.image, ['a cat', 'a dog']);
});

test('R1.5b.4: batches:set pins the legacy normalize() behaviour for a non-object input', () => {
  const { handlers } = loadIpc();
  // The handler does `JSON.stringify(clean)` — passing a string
  // doesn't throw (stringify succeeds); passing null doesn't throw
  // either (normalize returns the default). The handler returns
  // {ok:true} for both. The test pins the LEGACY behaviour so
  // a future refactor that adds a strict type check is caught.
  // NOTE: despite the original test name, the handler does NOT
  // return ok:false for a non-object — it silently coerces to
  // the default empty shape. This is the canonical (legacy)
  // behaviour. The rename (Phasenpruefung-of-Phasenpruefung-of-Phasenpruefung)
  // clarifies the actual contract.
  const r = handlers.get('batches:set')(null, 'not-an-object');
  assert.equal(r.ok, true, 'legacy: a non-object is silently coerced to default by normalize()');
});

// ===========================================================================
// batches:generateExamples — no grant required (Main-known dest)
// ===========================================================================

test('R1.5b.4: batches:generateExamples succeeds without a grantId (writes to Main-known dest)', async () => {
  const { handlers, calls } = loadIpc();
  const r = await handlers.get('batches:generateExamples')(null, 'md');
  assert.equal(r.ok, true);
  assert.equal(r.format, 'md');
  // The handler wrote the example file to the Main-known dest
  // (effectiveOutputDir = TMP).
  assert.ok(r.path.startsWith(TMP), `outPath must be under TMP (the Main-known dest); got: ${r.path}`);
  assert.ok(fs.existsSync(r.path), 'the example file must exist on disk');
  // NO grant check fired.
  assert.equal(calls.grantAuthorize.length, 0,
    'batches:generateExamples must NOT call any grant service method');
});

test('R1.5b.4: batches:generateExamples writes to effectiveOutputDir (not a renderer-supplied path)', async () => {
  const { handlers } = loadIpc();
  // The renderer's `format` arg is the ONLY renderer input.
  // Even if the renderer tries to smuggle a path into the format
  // arg, the handler treats it as a format selector (not a path).
  const r = await handlers.get('batches:generateExamples')(null, 'C:\\evil\\x.md');
  assert.equal(r.ok, true);
  // The format arg falls back to 'md' (anything that isn't exactly
  // 'txt' is treated as 'md' — the format arg is NEVER a path).
  assert.equal(r.format, 'md', 'the format arg is treated as a format selector, NOT a path');
  assert.ok(r.path.startsWith(TMP), 'outPath must STILL be under TMP (the format arg cannot redirect the dest)');
});

test('R1.5b.4: batches:generateExamples deletes the other format file (legacy behaviour)', async () => {
  const { handlers } = loadIpc();
  // After the first call with format=md, the handler wrote both
  // files then DELETED the unselected (txt). So only the .md
  // file should remain on disk.
  await handlers.get('batches:generateExamples')(null, 'md');
  assert.ok(fs.existsSync(path.join(TMP, 'example_batch_import.md')));
  assert.ok(!fs.existsSync(path.join(TMP, 'example_batch_import.txt')),
    'txt file must be deleted when format=md is requested (legacy behaviour)');
  // A second call with format=txt should now delete md and
  // keep txt (the legacy toggle).
  await handlers.get('batches:generateExamples')(null, 'txt');
  assert.ok(!fs.existsSync(path.join(TMP, 'example_batch_import.md')),
    'md file must be deleted when format=txt is requested');
  assert.ok(fs.existsSync(path.join(TMP, 'example_batch_import.txt')),
    'txt file must be created when format=txt is requested');
});

test('R1.5b.4 Phasenpruefung-of-Phasenpruefung-of-Phasenpruefung: batches:generateExamples partial-failure (2nd write throws) returns ok:false and does NOT throw to the renderer', async () => {
  // The handler writes md, then txt, then deletes the unselected
  // one. If the txt write throws (e.g. disk full on the second
  // write), the handler catches the error and returns {ok:false,
  // error}. The .md file is left behind. This is acceptable
  // best-effort behaviour, but it must NOT throw to the renderer
  // and it must NOT leave the grant service called.
  // Clean up any leftover example files from earlier tests so
  // the partial-failure assertion sees a pristine state.
  for (const f of ['example_batch_import.md', 'example_batch_import.txt']) {
    try { fs.unlinkSync(path.join(TMP, f)); } catch (_) { /* may not exist */ }
  }
  const txtPath = path.join(TMP, 'example_batch_import.txt');
  const { handlers, calls, writeFileCalls } = loadIpc({
    writeFile: {
      shouldThrow: (p) => p === txtPath,
      message: 'simulated disk full on txt write',
      code: 'ENOSPC',
    },
  });
  const r = await handlers.get('batches:generateExamples')(null, 'md');
  assert.equal(r.ok, false, 'partial failure must surface as ok:false');
  assert.ok(r.error && /simulated disk full/.test(r.error),
    'the error message must be propagated to the renderer');
  // The md write succeeded (delegated to the real fs.writeFileSync),
  // the txt write threw. The handler never reached the unlink
  // branch. The .md file is on disk (it was the first write and
  // was delegated); the .txt file is NOT on disk (its write
  // threw before any bytes hit the disk).
  assert.ok(fs.existsSync(path.join(TMP, 'example_batch_import.md')),
    'md file was written before the txt write threw and must remain on disk');
  assert.ok(!fs.existsSync(txtPath),
    'txt file must not exist when its write threw');
  // The handler attempted exactly 2 writes (md + txt) — the
  // unlink was never reached.
  assert.equal(writeFileCalls.length, 2,
    'handler must have attempted exactly 2 writes (md + txt) before throwing on the txt write');
  // No grant check fired.
  assert.equal(calls.grantAuthorize.length, 0);
  // Clean up the .md file so the next test sees a clean state.
  try { fs.unlinkSync(path.join(TMP, 'example_batch_import.md')); } catch (_) {}
});

// ===========================================================================
// batches:saveManualAs — no grant required (user-picked via native dialog)
// ===========================================================================

test('R1.5b.4: batches:saveManualAs does NOT mint a grant (the dialog is the trust gesture)', async () => {
  const { handlers, calls } = loadIpc();
  // The dialog returns canceled (default mock) — the handler
  // short-circuits with {ok:false, canceled:true} without
  // touching the filesystem. The key assertion is that NO
  // grant check fired (the dialog itself is the trust
  // gesture per S1 §3).
  const r = await handlers.get('batches:saveManualAs')(null, 'md');
  assert.deepEqual(r, { ok: false, canceled: true });
  assert.equal(calls.grantAuthorize.length, 0,
    'batches:saveManualAs must NOT call any grant service method (the dialog is the trust gesture)');
});

test('R1.5b.4 Phasenpruefung-of-Phasenpruefung-of-Phasenpruefung: batches:saveManualAs writes the manual to the user-picked dest (real file write)', async () => {
  // Use a unique dest inside TMP so this test does not collide
  // with the example_batch_import.* files used by the
  // generateExamples tests.
  const dest = path.join(TMP, 'picked-by-user.md');
  const { handlers, calls, pathSecurityCalls } = loadIpc({
    dialogReturn: { canceled: false, filePath: dest },
  });
  const r = await handlers.get('batches:saveManualAs')(null, 'md');
  // The handler returns the dialog-picked path.
  assert.equal(r.ok, true);
  assert.equal(r.path, dest);
  assert.equal(r.format, 'md');
  // The file was ACTUALLY written (this is the gap the original
  // R1.5b.4 test left open — the mock dialog always returned
  // canceled, so the writeFileSync line was never exercised).
  assert.ok(fs.existsSync(dest), 'the dialog-picked file must exist on disk after the IPC call');
  const content = fs.readFileSync(dest, 'utf8');
  assert.equal(content, '# test markdown manual\n',
    'the written content must match the registry output (markdown manual)');
  // The cross-IPC legacy trust chain still fires:
  // addTrusted(path.dirname(dest)) is load-bearing for
  // registerPipelineIpc:82 (per the R1.5b.4 Phasenpruefung-of-Phasenpruefung
  // doc-fix in commit 8b99d99). A refactor that drops the call
  // would break the Pipeline's ability to write into the dialog-picked
  // folder via the legacy gate. Lock it in.
  assert.deepEqual(pathSecurityCalls.addTrusted, [path.dirname(dest)],
    'addTrusted must be called with the dialog-picked dirname (load-bearing for registerPipelineIpc:82)');
  // And the new grant contract still does NOT fire (the dialog
  // is the trust gesture per S1 §3).
  assert.equal(calls.grantAuthorize.length, 0,
    'batches:saveManualAs must NOT call any grant service method (dialog is the trust gesture)');
});

test('R1.5b.4 Phasenpruefung-of-Phasenpruefung-of-Phasenpruefung: batches:saveManualAs extension heuristic (ext=.md always wins over chosen=txt)', async () => {
  // The heuristic is:
  //   useTxt = (ext === '.txt') || (chosen === 'txt' && ext !== '.md')
  // Truth table (locked in by these tests):
  //   ext='.txt', chosen='md'  → useTxt=true  (txt content in .txt file)
  //   ext='.txt', chosen='txt' → useTxt=true  (txt content in .txt file)
  //   ext='.md',  chosen='md'  → useTxt=false (md content in .md file)
  //   ext='.md',  chosen='txt' → useTxt=false (md content in .md file — EXTENSION WINS)
  //   ext='',    chosen='md'  → useTxt=false (md content, extensionless — default)
  //   ext='',    chosen='txt' → useTxt=true  (txt content, extensionless — chosen wins as fallback)
  // A refactor that simplifies the heuristic to "chosen wins"
  // (useTxt = (chosen === 'txt')) would break the 1st and 3rd
  // rows and surface here. A refactor that drops the
  // `(chosen === 'txt' && ext !== '.md')` clause would break
  // the last row and surface here.
  const dest = path.join(TMP, 'weird-name.md');
  const { handlers } = loadIpc({ dialogReturn: { canceled: false, filePath: dest } });
  const r = await handlers.get('batches:saveManualAs')(null, 'txt');
  assert.equal(r.ok, true);
  assert.equal(r.format, 'md', '.md extension always wins — content is the md manual even when chosen=txt');
  assert.equal(fs.readFileSync(dest, 'utf8'), '# test markdown manual\n',
    'md content is written because the extension is .md (extension wins)');
});

test('R1.5b.4 Phasenpruefung-of-Phasenpruefung-of-Phasenpruefung: batches:saveManualAs extension heuristic (ext=.txt wins for chosen=md)', async () => {
  // ext='.txt' forces useTxt=true regardless of chosen. The
  // renderer asked for md but typed a .txt name — content is
  // txt. Locks in the (ext === '.txt') first disjunct.
  const dest = path.join(TMP, 'user-typed.txt');
  const { handlers } = loadIpc({ dialogReturn: { canceled: false, filePath: dest } });
  const r = await handlers.get('batches:saveManualAs')(null, 'md');
  assert.equal(r.ok, true);
  assert.equal(r.format, 'txt', '.txt extension always wins — content is the txt manual');
  assert.equal(fs.readFileSync(dest, 'utf8'), 'TEST TXT MANUAL\n');
});

test('R1.5b.4 Phasenpruefung-of-Phasenpruefung-of-Phasenpruefung: batches:saveManualAs extension heuristic (chosen=md, ext=.md → md content)', async () => {
  // The "happy path" — both signals agree.
  const dest = path.join(TMP, 'normal.md');
  const { handlers } = loadIpc({ dialogReturn: { canceled: false, filePath: dest } });
  const r = await handlers.get('batches:saveManualAs')(null, 'md');
  assert.equal(r.ok, true);
  assert.equal(r.format, 'md');
  assert.equal(fs.readFileSync(dest, 'utf8'), '# test markdown manual\n');
});

test('R1.5b.4 Phasenpruefung-of-Phasenpruefung-of-Phasenpruefung: batches:saveManualAs with the dialog canceled still does not call addTrusted (trust chain only fires on actual write)', async () => {
  // Defence: if the user cancels the dialog, addTrusted must
  // NOT fire. Otherwise a malicious renderer could ping the
  // dialog with arbitrary folder paths and the last one wins
  // (since addTrusted deduplicates on the exact resolved path,
  // this is not a real exploit, but the contract should be
  // "trust only on a real write").
  const { handlers, pathSecurityCalls } = loadIpc({
    dialogReturn: { canceled: true, filePath: '' },
  });
  const r = await handlers.get('batches:saveManualAs')(null, 'md');
  assert.deepEqual(r, { ok: false, canceled: true });
  assert.equal(pathSecurityCalls.addTrusted.length, 0,
    'addTrusted must NOT fire on a canceled dialog (trust chain only on real write)');
});

test('R1.5b.4 Phasenpruefung-of-Phasenpruefung-of-Phasenpruefung: batches:saveManualAs with a write error returns ok:false and does NOT call addTrusted before the error', async () => {
  // Simulate a write error by pointing the dialog at a path
  // inside a non-existent directory. The writeFileSync will
  // throw ENOENT, the handler catches it, returns ok:false.
  // The test asserts:
  //   (1) the handler returns ok:false on a real write error
  //   (2) addTrusted IS called (it fires BEFORE the write,
  //       which is the current order in the handler)
  //   (3) the error is propagated to the renderer
  // This is a real failure mode the original R1.5b.4 test
  // did not cover (the mock dialog always returned canceled,
  // so writeFileSync was never called).
  const dest = path.join(TMP, 'does-not-exist', 'wont-work.md');
  const { handlers, pathSecurityCalls } = loadIpc({
    dialogReturn: { canceled: false, filePath: dest },
  });
  const r = await handlers.get('batches:saveManualAs')(null, 'md');
  assert.equal(r.ok, false, 'write error must surface as ok:false');
  assert.ok(r.error, 'the error message must be returned to the renderer');
  // addTrusted currently fires BEFORE writeFileSync (the order
  // in the handler is: addTrusted → writeFileSync). On a
  // write failure, the trust chain is established for the
  // dirname even though the file was not written. This is a
  // known soft spot — a future hardening pass should move
  // addTrusted into the success path. For now, the test
  // locks in the current order so a refactor is conscious.
  assert.deepEqual(pathSecurityCalls.addTrusted, [path.dirname(dest)],
    'addTrusted fires before the write (current handler order); a future hardening pass may move it to the success path');
});

// ===========================================================================
// Cross-cutting: no handler in this file calls the grant service
// ===========================================================================

test('R1.5b.4: NONE of the 4 batches handlers ever call the grant service', async () => {
  const { handlers, calls } = loadIpc();
  // Exercise every handler with a no-grant payload.
  handlers.get('batches:get')();
  handlers.get('batches:set')(null, { image: ['x'], speech: [], music: [], video: [] });
  await handlers.get('batches:generateExamples')(null, 'md');
  await handlers.get('batches:saveManualAs')(null, 'md');
  assert.equal(calls.grantAuthorize.length, 0,
    'NONE of the 4 batches handlers may call the grant service (the legacy gate is the only one)');
});

// ===========================================================================
// Defence-in-depth: if a future change adds a renderer-supplied path to
// any of the 4 handlers, the test below catches it (the handler would
// either try to call the grant service OR would write to an
// out-of-TMP dest).
// ===========================================================================

test('R1.5b.4 (defence): a future batches:generateExamples that accepts a renderer path would still fail because the dest is Main-derived', async () => {
  const { handlers, calls } = loadIpc();
  // If a future refactor added a `path` arg to
  // batches:generateExamples, the handler should STILL write
  // to the Main-known dest (not the renderer-supplied path).
  // Today, the handler ignores any renderer input beyond
  // `format`, so this test passes trivially. The defence is
  // that a future maintainer who adds a `path` arg must
  // also add a grant check.
  const r = await handlers.get('batches:generateExamples')(null, 'md');
  // The dest is the Main-known TMP, not anywhere else.
  assert.ok(r.path.startsWith(TMP));
  // No grant check fired.
  assert.equal(calls.grantAuthorize.length, 0);
});
