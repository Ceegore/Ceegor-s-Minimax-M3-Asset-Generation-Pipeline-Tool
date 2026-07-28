const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { archiveFiles, releasePaths } = require('../../../scripts/releaseArtifacts');

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

test('split archive volumes are discovered as one intentional release', () => {
  const root = fixture();
  try {
    const paths = releasePaths(root);
    fs.mkdirSync(paths.output, { recursive: true });
    fs.writeFileSync(paths.archive + '.002', 'second');
    fs.writeFileSync(paths.archive + '.001', 'first');
    assert.deepEqual(archiveFiles(paths).map((filePath) => path.basename(filePath)), [
      'FixtureTool-9.8.7-x64.zip.001',
      'FixtureTool-9.8.7-x64.zip.002',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('single archive takes precedence over leftover split volumes', () => {
  const root = fixture();
  try {
    const paths = releasePaths(root);
    fs.mkdirSync(paths.output, { recursive: true });
    fs.writeFileSync(paths.archive + '.001', 'stale part');
    fs.writeFileSync(paths.archive, 'single archive');
    assert.deepEqual(archiveFiles(paths), [paths.archive]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
