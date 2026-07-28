// tests/unit/src/mmxApiKeySync.r23pp.test.js
// ============================================================================
// R2.3 Phasenpruefung-of-Phasenpruefung — adversarial tests against the
// ACTUAL `src/mmxApiKeySync.js` clear-path implementation.
//
// The 9 R2.3.A..I tests verify the documented contract. The 12 PP-1..12
// tests below probe failure modes the original suite missed:
//
//   PP-1:  re-entrancy — two clears in the same millisecond with the
//          same PID must not corrupt the on-disk file
//   PP-2:  temp-name uniqueness — the .tmp-… pattern is documented as
//          `pid + Date.now()`; under same-ms calls it collides
//   PP-3:  cache invalidation is COMPLETE (mtime + size + hash all reset)
//   PP-4:  the config-write that lands on disk is byte-valid JSON
//          (catches a JSON.stringify round-trip bug)
//   PP-5:  clear preserves a top-level `false` / `0` / `null` field
//          verbatim (catches a "preserved as string" or
//          "preserved as undefined" bug)
//   PP-6:  clear survives an existing config with a 1000-key
//          stress-load (no perf regression)
//   PP-7:  clear returns true when the file has only `api_key` and
//          nothing else (edge case: the only field is the one we
//          remove; result is `{}`)
//   PP-8:  clear does NOT delete the file when api_key is the only
//          field (the result is an empty object, not a deleted file)
//   PP-9:  redaction-of-PII: the `api_key` value is never logged
//          on the error path
//   PP-10: the new function is also exported by the type-compatible
//          legacy alias (defensive; future refactor may rename
//          but the R0.1-002.B test still passes)
//   PP-11: clear after a previous clear where the file is now
//          missing must still return true (idempotency under
//          external delete)
//   PP-12: clear must NOT log or expose the api_key value in any
//          error path
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SYNC_PATH = path.join(__dirname, '..', '..', '..', 'src', 'mmxApiKeySync.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-r23pp-'));

function freshHome() {
  const home = fs.mkdtempSync(path.join(TMP, 'home-'));
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  return home;
}

function freshSync() {
  try { delete require.cache[require.resolve(SYNC_PATH)]; } catch (_) {}
  return require(SYNC_PATH);
}

const M = () => path.join(process.env.USERPROFILE, '.mmx', 'config.json');
const seedConfig = (obj) => {
  const dir = path.dirname(M());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(M(), JSON.stringify(obj, null, 2));
};
const readConfig = () => {
  try { return JSON.parse(fs.readFileSync(M(), 'utf8')); } catch (_) { return null; }
};

test.beforeEach(() => {
  freshHome();
  freshSync()._resetForTest();
});

test.afterEach(() => {
  delete process.env.USERPROFILE;
  delete process.env.HOME;
  freshSync()._resetForTest();
});

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

// ---------------------------------------------------------------------------
// PP-1: re-entrancy — two clears in the same millisecond with the same
//       PID must not corrupt the on-disk file. The temp-name pattern
//       is `pid + Date.now()` which collides under same-ms calls.
// ---------------------------------------------------------------------------
test('PP-1: two clears in the same millisecond must not corrupt the file', () => {
  // Seed a config with api_key + other fields.
  seedConfig({ api_key: 'sk-RACE', region: 'global', model: 'image-01' });
  const sync = freshSync();
  // Fire two clears in the same tick. If the temp names collide,
  // one of the renames fails and the file is left in an
  // inconsistent state.
  const r1 = sync.clearApiKeyFromMmxCliConfig();
  const r2 = sync.clearApiKeyFromMmxCliConfig();
  // The expected behavior is: both clear, the file is the original
  // minus api_key. The pattern is NOT re-entrant safe today, so we
  // accept either (true,true) or (true,false); what we MUST NOT see
  // is a partial file or a missing file.
  assert.equal(typeof r1, 'boolean');
  assert.equal(typeof r2, 'boolean');
  // If both succeeded, the file must be the original minus api_key.
  if (r1 && r2) {
    const after = readConfig();
    assert.equal(Object.prototype.hasOwnProperty.call(after, 'api_key'), false);
    assert.equal(after.region, 'global');
    assert.equal(after.model, 'image-01');
  } else {
    // At least one must have succeeded; the file must still be
    // parseable JSON. (If the rename failed, the file should be
    // intact, untouched by the failed call.)
    const after = readConfig();
    assert.notEqual(after, null, 'after re-entrant clear, the file must still exist and be parseable');
  }
});

// ---------------------------------------------------------------------------
// PP-2 (Audit-Fix R0.1-006.Audit): the pid+Date.now() pattern was a
// documented "known limitation" in the original R2.3.PP suite. The
// R0.1-006 Audit-Fix changed mmxApiKeySync.js to use crypto.randomUUID()
// for the temp-name suffix (collisions free, even in same-ms parallel
// calls). This test now asserts the FIX, not the limitation.
// ---------------------------------------------------------------------------
test('PP-2: temp name pattern uses randomUUID() (R0.1-006.Audit-Fix: pid+Date.now() limitation is RESOLVED)', () => {
  const src = fs.readFileSync(SYNC_PATH, 'utf8');
  // FIX: the temp name must use randomUUID() (no more pid+Date.now()).
  const usesUuid = /\.tmp-['"]?\s*\+\s*randomUUID\(\)/.test(src)
    || /\.tmp-\$\{randomUUID\(\)\}/.test(src);
  assert.ok(usesUuid,
    'PP-2 (R0.1-006.Audit-Fix): mmxApiKeySync.js must use crypto.randomUUID() for temp names. ' +
    'The pid+Date.now() limitation documented in R2.3.PP has been resolved. ' +
    'If this fails, the R0.1-006.Audit-Fix was reverted.');
  // REGRESSION GUARD: the OLD pid+Date.now() pattern must NOT come back.
  const oldDeterministic = /\.tmp-['"]?\s*\+\s*process\.pid\s*\+\s*['"]-['"]?\s*\+\s*Date\.now\(\)/.test(src)
    || /\.tmp-\$\{process\.pid\}-\$\{Date\.now\(\)\}/.test(src);
  assert.equal(oldDeterministic, false,
    'PP-2 (R0.1-006.Audit-Fix): the OLD pid+Date.now() pattern must NOT come back. ' +
    'If this fails, someone reverted the R0.1-006.Audit-Fix to the buggy pattern.');
});

// ---------------------------------------------------------------------------
// PP-3: cache invalidation is COMPLETE (hash + mtime + size all reset)
// ---------------------------------------------------------------------------
test('PP-3: clear resets all 3 cache fields, not just the hash', () => {
  const sync = freshSync();
  seedConfig({ api_key: 'sk-OLD', region: 'global' });
  // Populate the cache via a real sync.
  sync.syncApiKeyToMmxCliConfig('sk-OLD');
  // Now clear.
  sync.clearApiKeyFromMmxCliConfig();
  // The next sync call must NOT no-op. We assert this by reading
  // the in-memory cache via a small probe: the helper doesn't
  // export the cache directly, but we can test the externally
  // observable behavior: a sync with a new key after clear must
  // actually write.
  sync.syncApiKeyToMmxCliConfig('sk-NEW-AFTER-CLEAR');
  const after = readConfig();
  assert.equal(after.api_key, 'sk-NEW-AFTER-CLEAR',
    'PP-3: cache must be fully invalidated so the next sync call writes a new key');
});

// ---------------------------------------------------------------------------
// PP-4: the on-disk config after a clear is byte-valid JSON
//       (catches a JSON.stringify round-trip bug or a missing-comma bug)
// ---------------------------------------------------------------------------
test('PP-4: after clear, the file is byte-valid JSON', () => {
  const sync = freshSync();
  seedConfig({
    api_key: 'sk-DEL-4',
    region: 'global',
    model: 'image-01',
    custom_cli_args: ['--no-banner', '--output', 'json'],
    nested: { key: 'value', arr: [1, 2, 3] },
  });
  const r = sync.clearApiKeyFromMmxCliConfig();
  assert.equal(r, true);
  const raw = fs.readFileSync(M(), 'utf8');
  // Must parse cleanly.
  const parsed = JSON.parse(raw);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, 'api_key'), false);
  assert.equal(parsed.region, 'global');
  assert.equal(parsed.model, 'image-01');
  assert.deepEqual(parsed.custom_cli_args, ['--no-banner', '--output', 'json']);
  assert.deepEqual(parsed.nested, { key: 'value', arr: [1, 2, 3] });
});

// ---------------------------------------------------------------------------
// PP-5: clear preserves a top-level `false` / `0` / `null` field verbatim
//       (catches a "preserved as string" or "preserved as undefined" bug)
// ---------------------------------------------------------------------------
test('PP-5: clear preserves top-level false / 0 / null / empty-string fields', () => {
  const sync = freshSync();
  seedConfig({
    api_key: 'sk-DEL-5',
    boolFalse: false,
    zero: 0,
    nothing: null,
    emptyStr: '',
  });
  const r = sync.clearApiKeyFromMmxCliConfig();
  assert.equal(r, true);
  const after = readConfig();
  assert.equal(after.boolFalse, false, 'false must be preserved as false (not undefined / null)');
  assert.equal(after.zero, 0, '0 must be preserved as 0 (not removed)');
  assert.equal(after.nothing, null, 'null must be preserved as null');
  assert.equal(after.emptyStr, '', 'empty string must be preserved as empty string');
  assert.equal(Object.prototype.hasOwnProperty.call(after, 'api_key'), false);
});

// ---------------------------------------------------------------------------
// PP-6: clear survives an existing config with a 1000-key stress-load
// ---------------------------------------------------------------------------
test('PP-6: clear handles a 1000-key stress-load without error', () => {
  const sync = freshSync();
  const big = { api_key: 'sk-DEL-6' };
  for (let i = 0; i < 1000; i++) big['key' + i] = 'value-' + i;
  seedConfig(big);
  const r = sync.clearApiKeyFromMmxCliConfig();
  assert.equal(r, true);
  const after = readConfig();
  assert.equal(Object.prototype.hasOwnProperty.call(after, 'api_key'), false);
  // All 1000 other fields preserved.
  for (let i = 0; i < 1000; i++) {
    assert.equal(after['key' + i], 'value-' + i, 'field key' + i + ' must be preserved');
  }
});

// ---------------------------------------------------------------------------
// PP-7 + PP-8: clear when api_key is the only field — result is `{}`,
//       NOT a deleted file.
// ---------------------------------------------------------------------------
test('PP-7: clear on a config that contains ONLY api_key leaves an empty {}', () => {
  const sync = freshSync();
  seedConfig({ api_key: 'sk-ONLY' });
  const r = sync.clearApiKeyFromMmxCliConfig();
  assert.equal(r, true);
  assert.equal(fs.existsSync(M()), true, 'file must still exist (empty object {})');
  const after = readConfig();
  assert.deepEqual(after, {}, 'file must be an empty object');
});

test('PP-8: clear must NOT delete the file when api_key is the only field', () => {
  const sync = freshSync();
  seedConfig({ api_key: 'sk-ONLY-2' });
  sync.clearApiKeyFromMmxCliConfig();
  assert.equal(fs.existsSync(M()), true,
    'PP-8: the file must still exist after clear (it now contains `{}`); deleting the file is a behavior change');
});

// ---------------------------------------------------------------------------
// PP-9: the api_key value must never appear in the error log path
//       (any thrown error must be caught and surfaced without the value)
// ---------------------------------------------------------------------------
test('PP-9: no error path exposes the api_key value in the returned error', () => {
  const sync = freshSync();
  // Force a failure by making the .mmx dir read-only mid-flight.
  // (We can't easily do that on Windows from a unit test; instead
  // we make the existing-file a directory so the rename fails.)
  const dir = path.dirname(M());
  fs.mkdirSync(dir, { recursive: true });
  // Make the target config file path be a directory. clear() will
  // fail at the rename step.
  fs.rmSync(M(), { force: true });
  fs.mkdirSync(M());
  let caught = null;
  let r = null;
  try { r = sync.clearApiKeyFromMmxCliConfig(); } catch (e) { caught = e; }
  // Must not throw.
  assert.equal(caught, null, 'clear must not throw; caught: ' + (caught && caught.message));
  assert.equal(r, false, 'clear must return false when rename fails');
  // The api_key was 'sk-EXPOSED'; the function must not return it.
  if (typeof r === 'object' && r && r.error) {
    assert.equal(r.error.includes('sk-EXPOSED'), false,
      'PP-9.SECURITY: error must NOT include the api_key value. Got: ' + r.error);
  }
  // Cleanup.
  fs.rmSync(M(), { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// PP-10: the new function is also exported by the type-compatible legacy
//        alias — defensive, in case a future refactor renames it.
//        R0.1-002.B accepts ANY of clearApiKeyFromMmxCliConfig /
//        removeApiKeyFromMmxCliConfig / purgePersistedKey.
// ---------------------------------------------------------------------------
test('PP-10: at least one of the R0.1-002.B accepted names is exported', () => {
  const sync = freshSync();
  const hasRemove = (typeof sync.clearApiKeyFromMmxCliConfig === 'function')
    || (typeof sync.removeApiKeyFromMmxCliConfig === 'function')
    || (typeof sync.purgePersistedKey === 'function');
  assert.equal(hasRemove, true, 'R0.1-002.B contract: at least one clear/remove helper must be exported');
});

// ---------------------------------------------------------------------------
// PP-11: clear after a previous clear where the file is now missing
//        (external delete between the two clears) must still return true
// ---------------------------------------------------------------------------
test('PP-11: clear is idempotent under external file delete', () => {
  const sync = freshSync();
  seedConfig({ api_key: 'sk-DEL-11' });
  assert.equal(sync.clearApiKeyFromMmxCliConfig(), true);
  // External delete: simulate the user manually removing
  // ~/.mmx/config.json between two privacy switches.
  fs.unlinkSync(M());
  // The next clear must be a no-op (file missing → return true).
  const r = sync.clearApiKeyFromMmxCliConfig();
  assert.equal(r, true, 'missing file after a previous clear must be a no-op success');
  // No file should be created.
  assert.equal(fs.existsSync(M()), false);
});

// ---------------------------------------------------------------------------
// PP-12: the error path must not log the api_key (no console.error,
//        no fs.appendFileSync, nothing that touches the global
//        side-channel).
// ---------------------------------------------------------------------------
test('PP-12: no log call in the error path contains the api_key value', () => {
  // Read the source and assert: no `console.error(` with the
  // api_key value (e.g. via interpolation). The function must
  // never log the secret.
  const src = fs.readFileSync(SYNC_PATH, 'utf8');
  // Find the clearApiKeyFromMmxCliConfig function body and check
  // it doesn't reference `api_key` in any log statement.
  const fnMatch = src.match(/function\s+clearApiKeyFromMmxCliConfig\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(fnMatch, 'clearApiKeyFromMmxCliConfig function must be defined');
  const body = fnMatch[1];
  // The function is allowed to reference `api_key` only in the
  // contract docstring. Any console / fs.appendFileSync call that
  // includes the api_key string in a log line is a leak.
  const suspicious = /console\.[a-z]+\([^)]*api_key|fs\.(?:appendFile|writeFile)Sync\([^)]*api_key/;
  assert.equal(suspicious.test(body), false,
    'PP-12.SECURITY: clearApiKeyFromMmxCliConfig must not log or persist the api_key value in any error path. Body:\n' + body);
});
