// tests/unit/renderer/nextFreeForcePrefix.h050.test.js
// ============================================================================
// H-050 (_5 audit): nextFreeForcePrefixPath must fail-CLOSED on existence
// check errors (treat as occupied), and throw when ALL checks error.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');

// Strip comment lines for negative assertions.
const CODE = APP_SRC.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

// ---------------------------------------------------------------------------
// Source guards
// ---------------------------------------------------------------------------

test('H-050: primary catch is fail-CLOSED (exists = true, not false)', () => {
  // The catch after the main fbExists call must set exists = true.
  assert.match(CODE, /catch\s*\{\s*exists\s*=\s*true;\s*checkErrors\+\+;\s*\}/,
    'primary catch must set exists=true (fail-closed) and increment checkErrors');
  // Must NOT have the old fail-open pattern.
  assert.doesNotMatch(CODE, /catch\s*\{\s*exists\s*=\s*false;\s*\}/,
    'old fail-open catch (exists=false) must be gone');
});

test('H-050: alt-ext catch is fail-CLOSED (exists = true)', () => {
  assert.match(CODE, /catch\s*\{\s*exists\s*=\s*true;\s*\}.*H-050/s,
    'alt-ext catch must set exists=true (fail-closed)');
});

test('H-050: checkErrors counter + throw when all checks fail', () => {
  assert.match(CODE, /let checkErrors = 0;/, 'checkErrors counter declared');
  assert.match(CODE, /if\s*\(checkErrors\s*>=\s*MAX_TRIES\)/, 'guard compares checkErrors to MAX_TRIES');
  assert.match(CODE, /throw new Error\('Cannot find a free output name/,
    'throws when all existence checks errored');
});

// ---------------------------------------------------------------------------
// Functional tests (vm extraction)
// ---------------------------------------------------------------------------

function extractFunctions() {
  // Extract buildForcePrefixFileName + nextFreeForcePrefixPath.
  const start = APP_SRC.indexOf('function buildForcePrefixFileName(');
  const end = APP_SRC.indexOf('window.nextFreeForcePrefixPath = nextFreeForcePrefixPath;');
  assert.ok(start > 0 && end > start, 'functions must exist in app.js');
  return APP_SRC.slice(start, end);
}

async function runNextFree(fbExistsImpl, grantHelperImpl, maxTriesOverride) {
  let code = extractFunctions();
  if (maxTriesOverride) {
    code = code.replace('const MAX_TRIES = 1000;', `const MAX_TRIES = ${maxTriesOverride};`);
  }
  const sandbox = {
    window: {
      api: { fbExists: fbExistsImpl },
      GrantHelper: grantHelperImpl || null,
    },
    Date,
    Math,
    Array,
    String,
    Error,
    console,
  };
  vm.createContext(sandbox);
  // Expose the async function so we can call it.
  const wrapper = code + '\n;__result = nextFreeForcePrefixPath(__dir, __counter, __prefix, __ext, __altExts);';
  sandbox.__dir = 'C:\\out';
  sandbox.__counter = { n: 0 };
  sandbox.__prefix = 'temp';
  sandbox.__ext = 'png';
  sandbox.__altExts = undefined;
  vm.runInContext(wrapper, sandbox, { filename: 'app.js#h050', timeout: 5000 });
  return sandbox.__result;
}

test('H-050: normal case — first path is free, returned immediately', async () => {
  const result = await runNextFree(async () => ({ ok: true, exists: false }));
  assert.equal(result, 'C:\\out\\temp000001.png');
});

test('H-050: existing files bump the counter (exists=true)', async () => {
  let call = 0;
  const result = await runNextFree(async () => {
    call++;
    // First 3 exist, 4th is free.
    return { ok: true, exists: call <= 3 };
  });
  assert.equal(result, 'C:\\out\\temp000004.png');
  assert.equal(call, 4);
});

test('H-050: fbExists THROW is fail-closed — bumps counter, does NOT return that path', async () => {
  let call = 0;
  const result = await runNextFree(async () => {
    call++;
    if (call === 1) throw new Error('IPC timeout');
    return { ok: true, exists: false }; // 2nd call is free
  });
  // The first path (temp000001) errored → treated as occupied → bumped.
  // The second path (temp000002) is verified free → returned.
  assert.equal(result, 'C:\\out\\temp000002.png');
  assert.equal(call, 2);
});

test('H-050: ALL checks throw → function throws (no path produced)', async () => {
  await assert.rejects(
    () => runNextFree(async () => { throw new Error('permission denied'); }, null, 5),
    /Cannot find a free output name.*5 existence checks failed/,
    'must throw when every check errors (MAX_TRIES=5)'
  );
});

test('H-050: mixed errors + genuine exists → timestamp fallback (no throw)', async () => {
  // Some checks error (fail-closed: occupied), some return exists:true,
  // but NONE return exists:false → loop exhausts → timestamp fallback.
  let call = 0;
  const result = await runNextFree(async () => {
    call++;
    if (call % 2 === 0) throw new Error('intermittent');
    return { ok: true, exists: true };
  }, null, 10);
  // Should get a timestamp fallback (contains Date.now() digits + random).
  assert.match(result, /^C:\\out\\temp\d+_\d+\.png$/, 'timestamp fallback path');
});
