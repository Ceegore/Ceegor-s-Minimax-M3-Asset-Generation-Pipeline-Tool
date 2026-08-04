'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { createSigningBundle } = require('../../../scripts/create-signing-bundle');
const { mergeSignedBundle } = require('../../../scripts/merge-signed-bundle');
const { classifyPath, globToRegExp } = require('../../../scripts/verify-signing-scope');

function file(root, relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

test('glob supports recursive PE patterns', () => {
  assert.equal(globToRegExp('resources/**/*.dll').test('resources/a/b/c.dll'), true);
  assert.equal(globToRegExp('resources/**/*.dll').test('resources/a/b/c.exe'), false);
});

test('policy classifies owned and upstream files', () => {
  const policy = { ownedSigned: [{ path: 'MiniMaxAssetTool.exe' }], upstreamPatterns: ['resources/**/*.dll'] };
  assert.equal(classifyPath('MiniMaxAssetTool.exe', policy).kind, 'owned');
  assert.equal(classifyPath('resources/a.dll', policy).kind, 'upstream');
  assert.equal(classifyPath('unexpected.exe', policy).kind, 'unknown');
});

test('signing input contains only the project executable', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'signing-tools-'));
  const unpacked = path.join(base, 'unpacked');
  const output = path.join(base, 'bundle');
  file(unpacked, 'MiniMaxAssetTool.exe', 'unsigned');
  file(unpacked, 'chrome_elf.dll', 'upstream');
  const result = createSigningBundle({
    unpacked,
    output,
    version: '1.1.0',
    metadataProvider: () => ({ ProductName: 'MiniMaxAssetTool', ProductVersion: '1.1.0', FileVersion: '1.1.0.0', OriginalFilename: 'MiniMaxAssetTool.exe' }),
  });
  assert.deepEqual(fs.readdirSync(output), ['MiniMaxAssetTool.exe']);
  assert.ok(result.sha256);
});

test('merge copies only the signed executable into the unsigned tree', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'signing-merge-'));
  const unsigned = path.join(base, 'unsigned');
  const signed = path.join(base, 'signed');
  const output = path.join(base, 'output');
  file(unsigned, 'MiniMaxAssetTool.exe', 'unsigned');
  file(unsigned, 'resources/app.asar', 'app');
  file(signed, 'MiniMaxAssetTool.exe', 'signed-with-different-bytes');
  file(signed, 'must-not-copy.txt', 'forbidden');
  const result = mergeSignedBundle({
    unsigned,
    signed,
    output,
    version: '1.1.0',
    signatureProvider: () => ({ Status: 'Valid', SignerSubject: 'CN=SignPath Foundation', ProductName: 'MiniMaxAssetTool', ProductVersion: '1.1.0', FileVersion: '1.1.0.0', OriginalFilename: 'MiniMaxAssetTool.exe' }),
  });
  assert.equal(fs.readFileSync(path.join(output, 'MiniMaxAssetTool.exe'), 'utf8'), 'signed-with-different-bytes');
  assert.equal(fs.readFileSync(path.join(output, 'resources/app.asar'), 'utf8'), 'app');
  assert.equal(fs.existsSync(path.join(output, 'must-not-copy.txt')), false);
  assert.notEqual(result.unsignedSha256, result.signedSha256);
});
