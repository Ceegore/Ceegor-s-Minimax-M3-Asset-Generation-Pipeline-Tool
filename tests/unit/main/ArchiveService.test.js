// tests/unit/main/ArchiveService.test.js
// ============================================================================
// Phase C of _plan3.md — tests for the append-only JSONL archive.
//
// The archive is a small wrapper around fs that:
//   - appends a single line per call
//   - reads back in chunks (for the ArchiveViewer)
//   - deletes a single entry by id
//   - clears the whole file
//   - reports the current size in bytes
//   - is crash-safe: a partial final line from a prior crash is
//     detected and silently dropped on the next append.
//
// We exercise every public function against a real temp directory.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const archive = require(path.join(ROOT, 'src', 'services', 'ArchiveService.js'));

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'archive-test-'));
}

test('append: writes a single line per call and appends, not overwrites', () => {
  const dir = makeTmpDir();
  archive.append(dir, { id: 'a', title: 'first' });
  archive.append(dir, { id: 'b', title: 'second' });
  archive.append(dir, { id: 'c', title: 'third' });
  const text = fs.readFileSync(archive.archivePath(dir), 'utf8');
  const lines = text.split('\n').filter(Boolean);
  assert.equal(lines.length, 3);
  assert.deepEqual(JSON.parse(lines[0]), { id: 'a', title: 'first' });
  assert.deepEqual(JSON.parse(lines[1]), { id: 'b', title: 'second' });
  assert.deepEqual(JSON.parse(lines[2]), { id: 'c', title: 'third' });
});

test('readChunk: returns the first chunk with hasMore=false on a small file', () => {
  const dir = makeTmpDir();
  for (let i = 0; i < 5; i++) archive.append(dir, { id: 'j' + i, title: 'job ' + i });
  const r = archive.readChunk(dir, { offset: 0, limit: 100 });
  assert.equal(r.ok === undefined || r.ok, true);
  assert.equal(r.lines.length, 5);
  assert.equal(r.lines[0].id, 'j0');
  assert.equal(r.lines[4].id, 'j4');
  assert.equal(r.hasMore, false);
});

test('readChunk: respects the limit and reports hasMore when truncated', () => {
  const dir = makeTmpDir();
  for (let i = 0; i < 20; i++) archive.append(dir, { id: 'j' + i });
  const r = archive.readChunk(dir, { offset: 0, limit: 5 });
  assert.equal(r.lines.length, 5);
  assert.equal(r.lines[0].id, 'j0');
  assert.equal(r.hasMore, true);
  assert.ok(r.nextOffset > 0);
});

test('readChunk: returns empty for a non-existent file', () => {
  const dir = makeTmpDir();
  const r = archive.readChunk(dir, { offset: 0, limit: 100 });
  assert.equal(r.lines.length, 0);
  assert.equal(r.hasMore, false);
});

test('deleteOne: removes the matching entry and keeps the rest', () => {
  const dir = makeTmpDir();
  archive.append(dir, { id: 'a' });
  archive.append(dir, { id: 'b' });
  archive.append(dir, { id: 'c' });
  const removed = archive.deleteOne(dir, 'b');
  assert.equal(removed, true);
  const r = archive.readChunk(dir, { offset: 0, limit: 100 });
  assert.equal(r.lines.length, 2);
  assert.deepEqual(r.lines.map((x) => x.id), ['a', 'c']);
});

test('deleteOne: returns false when no entry matches', () => {
  const dir = makeTmpDir();
  archive.append(dir, { id: 'a' });
  const removed = archive.deleteOne(dir, 'z');
  assert.equal(removed, false);
});

test('clear: empties the file and returns the previous size', () => {
  const dir = makeTmpDir();
  archive.append(dir, { id: 'a' });
  archive.append(dir, { id: 'b' });
  const before = archive.size(dir);
  assert.ok(before > 0);
  const removed = archive.clear(dir);
  assert.equal(removed, before);
  assert.equal(archive.size(dir), 0);
});

test('size: returns 0 for a non-existent file', () => {
  const dir = makeTmpDir();
  assert.equal(archive.size(dir), 0);
});

test('crash safety: a partial final line is dropped on the next append', () => {
  const dir = makeTmpDir();
  const p = archive.archivePath(dir);
  fs.writeFileSync(p, '{"id":"a","title":"ok"}\n{"id":"b","title":"PARTIAL', 'utf8');
  // Next append should detect the partial line and drop it.
  archive.append(dir, { id: 'c', title: 'fresh' });
  const text = fs.readFileSync(p, 'utf8');
  const lines = text.split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), { id: 'a', title: 'ok' });
  assert.deepEqual(JSON.parse(lines[1]), { id: 'c', title: 'fresh' });
});

test('append: validates its arguments', () => {
  const dir = makeTmpDir();
  assert.throws(() => archive.append(null, { id: 'a' }), /configDir/);
  assert.throws(() => archive.append(dir, null), /summary/);
});

test('integration: 1000 appends + chunked reads round-trip every entry', () => {
  const dir = makeTmpDir();
  for (let i = 0; i < 1000; i++) archive.append(dir, { id: 'j' + i, title: 'job ' + i });
  // Read in chunks of 100, accumulate all ids.
  const seen = new Set();
  let off = 0;
  let hasMore = true;
  while (hasMore) {
    const r = archive.readChunk(dir, { offset: off, limit: 100 });
    for (const j of r.lines) seen.add(j.id);
    off = r.nextOffset;
    hasMore = r.hasMore;
  }
  assert.equal(seen.size, 1000);
  for (let i = 0; i < 1000; i++) assert.ok(seen.has('j' + i));
});
