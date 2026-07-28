// tests/unit/src/fileBrowser.test.js
// Regression tests for src/fileBrowser.mkdir — in particular the
// drive-root bug that made all asset generation fail with ENOENT when
// output_dir was a drive root (e.g. D:\). See the comment in mkdir().

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const fb = require('../../../src/fileBrowser');

test('mkdir creates a subfolder under a normal directory', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'fb-mkdir-'));
  try {
    const created = await fb.mkdir(base, 'speech');
    assert.strictEqual(created, path.join(base, 'speech'));
    assert.ok(fs.existsSync(created), 'the subfolder should exist on disk');
    // idempotent: calling again must not throw
    await fb.mkdir(base, 'speech');
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('mkdir does NOT false-positive "escapes parent" for a drive-root parent', async (t) => {
  // path.resolve('D:\\') returns "D:\\" (already ending in a separator),
  // which the old check turned into the prefix "D:\\\\" so a legitimate
  // child "D:\\speech" failed startsWith() and threw — breaking every
  // generation when output_dir was a drive root. This is Windows-only
  // semantics, so skip elsewhere.
  if (process.platform !== 'win32') { t.skip('drive-root path semantics are Windows-only'); return; }
  // Mock the actual filesystem write so the test never touches a real
  // drive root; we only care that mkdir gets PAST the escape check and
  // calls fs.mkdir with the correct child path.
  const calls = [];
  t.mock.method(fsp, 'mkdir', async (target) => { calls.push(target); return undefined; });
  const created = await fb.mkdir('D:\\', 'speech');
  assert.strictEqual(created, path.join('D:\\', 'speech'));
  assert.deepStrictEqual(calls, [path.join('D:\\', 'speech')]);
});

test('mkdir rejects a name containing a path separator', async () => {
  await assert.rejects(() => fb.mkdir(os.tmpdir(), 'a/b'), /separator/i);
  await assert.rejects(() => fb.mkdir(os.tmpdir(), '..'), /"\."|cannot be/i);
});
