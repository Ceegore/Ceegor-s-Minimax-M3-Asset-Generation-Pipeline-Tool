// tests/unit/main/services/InstallPickCopyService.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const { pickAndCopy } = require('../../../../main/services/InstallPickCopyService');

test('pickAndCopy: successfully copies picked file to target', async () => {
  const tmpDir = path.join(os.tmpdir(), `install-pick-test-${Date.now()}`);
  await fs.mkdir(tmpDir, { recursive: true });

  const srcFile = path.join(tmpDir, 'mock-model.onnx');
  await fs.writeFile(srcFile, 'dummy ONNX content');

  const showOpenDialogMock = async () => ({
    canceled: false,
    filePaths: [srcFile]
  });

  const appRoot = path.join(tmpDir, 'app');
  const result = await pickAndCopy('isnetbg-model', showOpenDialogMock, appRoot);

  assert.ok(result.ok);
  assert.equal(result.kind, 'isnetbg-model');

  const expectedDest = path.join(appRoot, 'bin', 'models', 'isnet-general-use.onnx');
  assert.equal(result.destPath, expectedDest);

  const copiedContent = await fs.readFile(expectedDest, 'utf8');
  assert.equal(copiedContent, 'dummy ONNX content');

  // Clean up
  try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

test('pickAndCopy: returns canceled: true when dialog is canceled', async () => {
  const showOpenDialogMock = async () => ({
    canceled: true,
    filePaths: []
  });

  const result = await pickAndCopy('isnetbg-model', showOpenDialogMock, '/mock-root');
  assert.equal(result.ok, false);
  assert.equal(result.canceled, true);
});

test('pickAndCopy: returns error for unknown install kind', async () => {
  const result = await pickAndCopy('invalid-kind', () => {}, '/mock-root');
  assert.equal(result.ok, false);
  assert.ok(result.error.includes('Unknown install kind'));
});
