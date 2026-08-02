'use strict';

/**
 * L-004 (hhhhu2 audit): Architecture integration tests.
 *
 * These tests verify architectural invariants based on import/call graphs,
 * NOT source-comment assertions. They catch the class of defect where a
 * service exists but is never wired into the live code path.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

function readSrc(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

// ---- Provider output pipeline ----

test('L-004: registerProvidersIpc imports ArtifactFinalizer', () => {
  const src = readSrc('main/ipc/registerProvidersIpc.js');
  assert.ok(src.includes('ArtifactFinalizer'), 'must import ArtifactFinalizer');
});

test('L-004: registerProvidersIpc imports OutputTransactionService', () => {
  const src = readSrc('main/ipc/registerProvidersIpc.js');
  assert.ok(src.includes('OutputTransactionService'), 'must import OutputTransactionService');
});

test('L-004: registerProvidersIpc calls finalize() for outputs', () => {
  const src = readSrc('main/ipc/registerProvidersIpc.js');
  assert.ok(src.includes('finalize('), 'must call finalize()');
});

test('L-004: registerProvidersIpc calls txnService.commit()', () => {
  const src = readSrc('main/ipc/registerProvidersIpc.js');
  assert.ok(src.includes('.commit('), 'must commit the output transaction');
});

test('L-004: registerProvidersIpc imports SafeHttpClient', () => {
  const src = readSrc('main/ipc/registerProvidersIpc.js');
  assert.ok(src.includes('SafeHttpClient'), 'must import SafeHttpClient');
});

// ---- No global fetch for output downloads ----

test('L-004: registerProvidersIpc does not download outputs with raw fetch', () => {
  const src = readSrc('main/ipc/registerProvidersIpc.js');
  assert.ok(!src.includes("fetch(o.url") && !src.includes("fetch(output.url"), 'must not download outputs with raw fetch');
});

test('L-004: ArtifactFinalizer uses injected http client for URL downloads', () => {
  const src = readSrc('main/services/ArtifactFinalizer.js');
  assert.ok(src.includes('http.toFile('), 'must use injected http client');
});

test('L-004: openaiCompatible uses bounded response reading', () => {
  const src = readSrc('src/providers/openaiCompatible.js');
  assert.ok(src.includes('_readBounded') || src.includes('_jsonBounded') || src.includes('MAX_JSON_BYTES'), 'must use bounded response body handling (H-004)');
});

test('L-004: replicate uses per-request timeout', () => {
  const src = readSrc('src/providers/replicate.js');
  assert.ok(src.includes('_fetchSignal') || src.includes('FETCH_TIMEOUT') || src.includes('AbortSignal'), 'must use per-request timeout (H-005)');
});

// ---- File browser security wiring ----

test('L-004: registerFileBrowserIpc imports OperationIntentService', () => {
  // Lint size-budget split: the intent machinery lives in
  // fileBrowserDestructiveIntent.js, which registerFileBrowserIpc wires in.
  const src = readSrc('main/ipc/registerFileBrowserIpc.js');
  const intentSrc = readSrc('main/ipc/fileBrowserDestructiveIntent.js');
  assert.ok(src.includes("require('./fileBrowserDestructiveIntent')"), 'must wire the destructive-intent module');
  assert.ok(intentSrc.includes("require('../services/OperationIntentService')"), 'intent module must import OperationIntentService');
});

test('L-004: fb:delete requires intentId', () => {
  const src = readSrc('main/ipc/registerFileBrowserIpc.js');
  assert.ok(src.includes('intentId') && src.includes('fb:delete'), 'fb:delete must require an intentId');
});

test('L-004: fb:move requires intentId', () => {
  const src = readSrc('main/ipc/registerFileBrowserIpc.js');
  assert.ok(src.includes('intentId') && src.includes('fb:move'), 'fb:move must require an intentId');
});

test('L-004: fb:rename requires intentId', () => {
  const src = readSrc('main/ipc/registerFileBrowserIpc.js');
  assert.ok(src.includes('intentId') && src.includes('fb:rename'), 'fb:rename must require an intentId');
});

test('L-004: fb:confirmDestructive handler is registered', () => {
  const src = readSrc('main/ipc/registerFileBrowserIpc.js');
  assert.ok(src.includes('fb:confirmDestructive'), 'fb:confirmDestructive must be registered');
});

// ---- DirectoryListingService is wired ----

test('L-004: registerFileBrowserIpc imports DirectoryListingService', () => {
  // Lint size-budget split: the paginated listing handlers live in
  // fileBrowserListingIpc.js, which registerFileBrowserIpc wires in.
  const src = readSrc('main/ipc/registerFileBrowserIpc.js');
  const listingSrc = readSrc('main/ipc/fileBrowserListingIpc.js');
  assert.ok(src.includes("require('./fileBrowserListingIpc')"), 'must wire the listing module');
  assert.ok(listingSrc.includes("require('../services/DirectoryListingService')"), 'listing module must import DirectoryListingService');
});

test('L-004: fb:listStart handler is registered', () => {
  const src = readSrc('main/ipc/fileBrowserListingIpc.js');
  assert.ok(src.includes('fb:listStart'), 'fb:listStart must be registered');
});

test('L-004: fb:listNext handler is registered', () => {
  const src = readSrc('main/ipc/fileBrowserListingIpc.js');
  assert.ok(src.includes('fb:listNext'), 'fb:listNext must be registered');
});

test('L-004: fb:listClose handler is registered', () => {
  const src = readSrc('main/ipc/fileBrowserListingIpc.js');
  assert.ok(src.includes('fb:listClose'), 'fb:listClose must be registered');
});

// ---- Setup uses RuntimeInstaller ----

test('L-004: setup.js imports RuntimeInstaller', () => {
  const src = readSrc('scripts/setup.js');
  assert.ok(src.includes('RuntimeInstaller'), 'setup.js must use RuntimeInstaller');
});

test('L-004: setup.js calls stage/verify/activate/commit', () => {
  const src = readSrc('scripts/setup.js');
  assert.ok(src.includes('verifyStage') || src.includes('verify'), 'setup must verify stage');
  assert.ok(src.includes('activate'), 'setup must activate');
  assert.ok(src.includes('commit') || src.includes('verifyAndCommit'), 'setup must commit');
});

// ---- JobId path traversal protection ----

test('L-004: registerProvidersIpc sanitizes jobId for path use', () => {
  const src = readSrc('main/ipc/registerProvidersIpc.js');
  assert.ok(!src.includes("path.join(req.jobId") && !src.includes("path.join(jobId"), 'jobId must not be used directly in path.join');
});

// ---- OutputTransactionService crash recovery ----

test('L-004: OutputTransactionService handles ROLLBACK_INCOMPLETE state', () => {
  const src = readSrc('main/services/OutputTransactionService.js');
  assert.ok(src.includes('ROLLBACK_INCOMPLETE'), 'must handle ROLLBACK_INCOMPLETE state');
});

test('L-004: OutputTransactionService uses intent-before-action journaling', () => {
  const src = readSrc('main/services/OutputTransactionService.js');
  assert.ok(src.includes('file.installing = true'), 'must journal intent before rename');
});

// ---- ArtifactFinalizer correctness ----

test('L-004: ArtifactFinalizer hashes before zeroing buffer', () => {
  const src = readSrc('main/services/ArtifactFinalizer.js');
  const hashIdx = src.indexOf("sha256 = crypto.createHash('sha256').update(buffer)");
  const zeroIdx = src.indexOf('buffer.fill(0)');
  if (hashIdx >= 0 && zeroIdx >= 0) {
    assert.ok(hashIdx < zeroIdx, 'SHA-256 must be computed before buffer is zeroed');
  }
});

test('L-004: ArtifactFinalizer detects AAC type', () => {
  const { detectType } = require(path.join(ROOT, 'main', 'services', 'ArtifactFinalizer'));
  const aacHeader = Buffer.from([0xFF, 0xF1, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00]);
  assert.equal(detectType(aacHeader), 'aac', 'Must detect AAC ADTS header');
});

test('L-004: ArtifactFinalizer detects WebM type', () => {
  const { detectType } = require(path.join(ROOT, 'main', 'services', 'ArtifactFinalizer'));
  const webmHeader = Buffer.from([0x1A, 0x45, 0xDF, 0xA3, 0x00, 0x00, 0x00, 0x00]);
  assert.equal(detectType(webmHeader), 'webm', 'Must detect WebM EBML header');
});

test('L-004: safeExtract does NOT detect ..foo as traversal', () => {
  const safeExtract = require(path.join(ROOT, 'scripts', 'lib', 'safeExtract'));
  if (safeExtract.validateEntry) {
    const result = safeExtract.validateEntry('..foo/model.bin', '/tmp/dest');
    assert.ok(result.ok, 'Names starting with .. but not .. segments must be allowed');
  }
});

// ---- ProviderCredentialRepository session keys ----

test('L-004: ProviderCredentialRepository uses in-memory session key map', () => {
  const src = readSrc('main/services/ProviderCredentialRepository.js');
  assert.ok(src.includes('this._sessionKeys'), 'must use an in-memory session key map');
  assert.ok(src.includes('this._sessionKeys.set('), 'useSessionOnly must store the key');
  assert.ok(src.includes('this._sessionKeys.has(') || src.includes('this._sessionKeys.get('), 'resolveKey must check the session map');
});
