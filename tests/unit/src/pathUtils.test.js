// tests/unit/src/pathUtils.test.js
// Bug-fix #12 (2026-06-19): make isPathUnder symlink-aware.
// Previously the under-root check used `path.resolve` (normalise)
// only; a symlink inside an allowed root that pointed outside
// would silently pass. The new version uses realIfExists()
// (realpathSync) before comparison.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const pathUtils = require('../../../src/pathUtils');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-pathutils-'));

test('isPathUnder: plain under-root returns true', () => {
  const root = path.join(tmpRoot, 'root');
  fs.mkdirSync(root, { recursive: true });
  const child = path.join(root, 'sub', 'file.png');
  fs.mkdirSync(path.dirname(child), { recursive: true });
  fs.writeFileSync(child, 'x');
  assert.equal(pathUtils.isPathUnder(child, root), true);
});

test('isPathUnder: root itself returns true', () => {
  const root = path.join(tmpRoot, 'r');
  fs.mkdirSync(root, { recursive: true });
  assert.equal(pathUtils.isPathUnder(root, root), true);
});

test('isPathUnder: `..` traversal returns false', () => {
  const root = path.join(tmpRoot, 'r2');
  fs.mkdirSync(root, { recursive: true });
  const escape = path.join(root, '..', 'r2', '..', 'outside.txt');
  assert.equal(pathUtils.isPathUnder(escape, root), false);
});

test('isPathUnder: sibling directory returns false', () => {
  const a = path.join(tmpRoot, 'a');
  const b = path.join(tmpRoot, 'b');
  fs.mkdirSync(a, { recursive: true });
  fs.mkdirSync(b, { recursive: true });
  assert.equal(pathUtils.isPathUnder(path.join(b, 'x.txt'), a), false);
});

test('isPathUnder: sibling whose name is a STRING PREFIX of the root returns false (V104-H001 M10)', () => {
  // Kills the `startsWith(root)` mutant: "Gen2" starts with "Gen", so a
  // bare-prefix check would wrongly accept C:\Gen2\x.txt under root C:\Gen.
  // The comparison must include the separator (startsWith(root + sep)).
  const root = path.join(tmpRoot, 'Gen');
  const sibling = path.join(tmpRoot, 'Gen2');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(sibling, { recursive: true });
  assert.equal(pathUtils.isPathUnder(path.join(sibling, 'x.txt'), root), false);
  assert.equal(pathUtils.isPathUnderAny(path.join(sibling, 'x.txt'), [root]), false);
  assert.equal(pathUtils.isParentUnderAny(path.join(sibling, 'x.txt'), [root]), false);
  // Positive counterpart: a real child of the prefix-named root still passes.
  assert.equal(pathUtils.isPathUnder(path.join(root, 'x.txt'), root), true);
});

// ----- Symlink tests -----
// Skipped gracefully on platforms where symlink creation is denied
// (Windows without Developer Mode / admin).
function canSymlink() {
  // Retry with backoff: on Windows the capability exists (Developer Mode)
  // but fs.symlinkSync can fail TRANSIENTLY under load (Defender scanning,
  // ERROR_BUSY/ACCESS_DENIED). A single failed probe used to skip all six
  // symlink tests, which drops pathUtils.js branch coverage below its
  // RR2-B003 waiver floor and flakes the release coverage gate. The
  // privilege itself is deterministic, so retries cannot fake capability.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const probe = path.join(tmpRoot, `probe-symlink-${attempt}`);
      fs.symlinkSync(tmpRoot, probe, 'dir');
      fs.unlinkSync(probe);
      return true;
    } catch {
      const waitUntil = Date.now() + 150 * (attempt + 1);
      while (Date.now() < waitUntil) { /* busy backoff */ }
    }
  }
  return false;
}

const skipOnNoSymlink = canSymlink() ? test : test.skip;

skipOnNoSymlink('isPathUnder: symlink inside root pointing outside returns false', () => {
  const root = path.join(tmpRoot, 'allowed');
  fs.mkdirSync(root, { recursive: true });
  const outside = path.join(tmpRoot, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
  const link = path.join(root, 'escape');
  fs.symlinkSync(outside, link, 'dir');
  // Without the fix, the normalised path `<root>/escape/secret.txt`
  // would have started with `<root>/` and the check would have passed.
  assert.equal(pathUtils.isPathUnder(path.join(link, 'secret.txt'), root), false);
});

skipOnNoSymlink('isPathUnder: symlink whose target IS under root still returns true', () => {
  const root = path.join(tmpRoot, 'realroot');
  fs.mkdirSync(root, { recursive: true });
  const target = path.join(root, 'data');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'ok.txt'), 'x');
  const link = path.join(root, 'alias');
  fs.symlinkSync(target, link, 'dir');
  assert.equal(pathUtils.isPathUnder(path.join(link, 'ok.txt'), root), true);
});

skipOnNoSymlink('isParentUnderAny: symlinked parent directory is realpath-resolved', () => {
  // The parent-dir helper is what fb:write / audio:cut use for
  // write targets that don't exist yet. Make sure a symlinked
  // parent that points inside the root still passes.
  const root = path.join(tmpRoot, 'writeroot');
  fs.mkdirSync(root, { recursive: true });
  const realSub = path.join(root, 'realsub');
  fs.mkdirSync(realSub, { recursive: true });
  const link = path.join(tmpRoot, 'aliasdir');
  fs.symlinkSync(realSub, link, 'dir');
  // Write target is a non-existent leaf under the symlinked dir.
  const writeTarget = path.join(link, 'newfile.png');
  assert.equal(pathUtils.isParentUnderAny(writeTarget, [root]), true);
});

skipOnNoSymlink('isParentUnderAny: write target whose symlinked parent points outside returns false', () => {
  const root = path.join(tmpRoot, 'safe');
  fs.mkdirSync(root, { recursive: true });
  const outside = path.join(tmpRoot, 'outside-dir');
  fs.mkdirSync(outside, { recursive: true });
  const link = path.join(root, 'escape-link');
  fs.symlinkSync(outside, link, 'dir');
  const writeTarget = path.join(link, 'evil.png');
  assert.equal(pathUtils.isParentUnderAny(writeTarget, [root]), false);
});

skipOnNoSymlink('isPathUnder: non-existent leaf under symlinked parent pointing outside returns false (R5 F1)', () => {
  // The F1 gap: realIfExists used to return the unresolved string whenever
  // the leaf didn't exist, so `<root>/f1escape/evil.png` (a write target
  // that doesn't exist yet) passed isPathUnder even though f1escape points
  // outside the root. The fix walks up to the deepest existing ancestor and
  // realpaths it, resolving the symlink.
  const root = path.join(tmpRoot, 'f1root');
  fs.mkdirSync(root, { recursive: true });
  const outside = path.join(tmpRoot, 'f1outside');
  fs.mkdirSync(outside, { recursive: true });
  const link = path.join(root, 'f1escape');
  fs.symlinkSync(outside, link, 'dir');
  const writeTarget = path.join(link, 'evil.png'); // does not exist yet
  assert.equal(pathUtils.isPathUnder(writeTarget, root), false);
});

skipOnNoSymlink('isPathUnder: non-existent leaf under symlinked parent pointing inside root still returns true (R5 F1)', () => {
  // Positive counterpart: the walk-up fix must not over-reject a write
  // target whose symlinked parent resolves to INSIDE the root.
  const root = path.join(tmpRoot, 'f1posroot');
  fs.mkdirSync(root, { recursive: true });
  const realSub = path.join(root, 'f1realsub');
  fs.mkdirSync(realSub, { recursive: true });
  const link = path.join(root, 'f1alias');
  fs.symlinkSync(realSub, link, 'dir');
  const writeTarget = path.join(link, 'newfile.png'); // does not exist yet
  assert.equal(pathUtils.isPathUnder(writeTarget, root), true);
});

test('normalize: empty / non-string / NUL char returns null', () => {
  assert.equal(pathUtils.normalize(''), null);
  assert.equal(pathUtils.normalize(null), null);
  assert.equal(pathUtils.normalize(undefined), null);
  assert.equal(pathUtils.normalize(42), null);
  assert.equal(pathUtils.normalize('foo\x00bar'), null);
});

test.after(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});