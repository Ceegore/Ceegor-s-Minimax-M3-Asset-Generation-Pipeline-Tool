const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { archiveFiles, releasePaths, validateArchiveSequence } = require('../../../scripts/releaseArtifacts');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-release-artifacts-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'fixture',
    version: '9.8.7',
    build: { productName: 'FixtureTool', directories: { output: 'out' } },
  }));
  return root;
}

test('release paths are derived from package metadata', () => {
  const root = fixture();
  try {
    const paths = releasePaths(root);
    assert.equal(paths.output, path.join(root, 'out'));
    assert.equal(path.basename(paths.executable), 'FixtureTool.exe');
    assert.equal(path.basename(paths.archive), 'FixtureTool-9.8.7-x64.zip');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('split archive parts are discovered as one intentional release', () => {
  const root = fixture();
  try {
    const paths = releasePaths(root);
    fs.mkdirSync(paths.output, { recursive: true });
    fs.writeFileSync(path.join(paths.output, `${paths.baseName}.part2.zip`), 'second');
    fs.writeFileSync(path.join(paths.output, `${paths.baseName}.part1.zip`), 'first');
    assert.deepEqual(archiveFiles(paths).map((filePath) => path.basename(filePath)), [
      'FixtureTool-9.8.7-x64.part1.zip',
      'FixtureTool-9.8.7-x64.part2.zip',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('single archive takes precedence over leftover split parts', () => {
  const root = fixture();
  try {
    const paths = releasePaths(root);
    fs.mkdirSync(paths.output, { recursive: true });
    fs.writeFileSync(path.join(paths.output, `${paths.baseName}.part1.zip`), 'stale part');
    fs.writeFileSync(paths.archive, 'single archive');
    assert.deepEqual(archiveFiles(paths), [paths.archive]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// RR2-H002/H005: the sequence validator must accept the unsplit form and
// reject every false-positive split shape the old verifier accepted.
test('RR2-H002: validateArchiveSequence accepts a single unsplit zip', () => {
  const root = fixture();
  try {
    const paths = releasePaths(root);
    fs.mkdirSync(paths.output, { recursive: true });
    fs.writeFileSync(paths.archive, 'unsplit');
    const r = validateArchiveSequence(paths);
    assert.equal(r.ok, true);
    assert.equal(r.single, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('RR2-H005: validateArchiveSequence rejects a gapped part sequence', () => {
  const root = fixture();
  try {
    const paths = releasePaths(root);
    fs.mkdirSync(paths.output, { recursive: true });
    fs.writeFileSync(path.join(paths.output, `${paths.baseName}.part1.zip`), 'first');
    fs.writeFileSync(path.join(paths.output, `${paths.baseName}.part3.zip`), 'third');
    const r = validateArchiveSequence(paths);
    assert.equal(r.ok, false, 'a .part1 + .part3 gap must be rejected');
    assert.match(r.error, /incomplete/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('RR2-H005: validateArchiveSequence rejects a sequence that does not start at part1', () => {
  const root = fixture();
  try {
    const paths = releasePaths(root);
    fs.mkdirSync(paths.output, { recursive: true });
    fs.writeFileSync(path.join(paths.output, `${paths.baseName}.part2.zip`), 'second');
    fs.writeFileSync(path.join(paths.output, `${paths.baseName}.part3.zip`), 'third');
    const r = validateArchiveSequence(paths);
    assert.equal(r.ok, false, 'a standalone .part2/.part3 sequence must be rejected');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('RR2-H005: validateArchiveSequence rejects an empty output dir', () => {
  const root = fixture();
  try {
    const paths = releasePaths(root);
    fs.mkdirSync(paths.output, { recursive: true });
    const r = validateArchiveSequence(paths);
    assert.equal(r.ok, false, 'no archive at all must fail closed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
