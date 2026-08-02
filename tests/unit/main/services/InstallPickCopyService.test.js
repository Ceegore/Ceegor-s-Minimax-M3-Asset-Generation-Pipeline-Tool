// tests/unit/main/services/InstallPickCopyService.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const { pickAndCopy } = require('../../../../main/services/InstallPickCopyService');
const assetPaths = require('../../../../src/assetPaths');

test('pickAndCopy: successfully copies picked file to target', async () => {
  const tmpDir = path.join(os.tmpdir(), `install-pick-test-${Date.now()}`);
  await fs.mkdir(tmpDir, { recursive: true });

  const srcFile = path.join(tmpDir, 'mock-model.onnx');
  // SEC-013: pickAndCopy validates the file header. ONNX models start
  // with protobuf field tag 0x08. Write a valid header so validation passes.
  await fs.writeFile(srcFile, Buffer.concat([Buffer.from([0x08, 0x07]), Buffer.from('dummy ONNX content')]));

  const showOpenDialogMock = async () => ({
    canceled: false,
    filePaths: [srcFile]
  });

  // H-065: the install destination is now EXCLUSIVELY the writable override
  // dir (<userData>/assets/...), never <appRoot>/bin. Configure a temp
  // userDataPath and restore the previous config afterwards.
  const appRoot = path.join(tmpDir, 'app');
  const userData = path.join(tmpDir, 'userData');
  const prevConfig = { ...assetPaths.getConfig() };
  assetPaths.init({ userDataPath: userData });
  try {
    const result = await pickAndCopy('isnetbg-model', showOpenDialogMock, appRoot);

    assert.ok(result.ok);
    assert.equal(result.kind, 'isnetbg-model');

    const expectedDest = path.join(userData, 'assets', 'models', 'isnet-general-use.onnx');
    assert.equal(result.destPath, expectedDest);

    const copiedContent = await fs.readFile(expectedDest);
    assert.equal(copiedContent[0], 0x08, 'ONNX header byte preserved');
    assert.ok(copiedContent.includes(Buffer.from('dummy ONNX content')), 'content preserved');
  } finally {
    assetPaths.init(prevConfig);
    // Clean up
    try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
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
