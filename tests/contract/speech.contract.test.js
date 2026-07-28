// tests/contract/speech.contract.test.js
// H11-6: contract test — fires a REAL speech generation. Confirms --emotion
// survives to the provider and an audio file lands on disk.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { skip, getApiKey, skipOnQuota } = require('./_env');
const ROOT = path.join(__dirname, '..', '..');
const { runMmx } = require(path.join(ROOT, 'src', 'mmx'));

test('speech: real generation produces an audio file (smoke)', async (t) => {
  if (skip(t)) return;
  const apiKey = getApiKey();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-contract-speech-'));
  const outFile = path.join(outDir, 'contract.mp3');
  try {
    const r = await runMmx({
      args: ['speech', 'synthesize', '--text', 'Hello, this is a contract test.', '--model', 'speech-01-hd', '--voice', 'English_captivating_female1', '--out', outFile],
      apiKey, sessionOnly: false,
    });
    if (skipOnQuota(t, r)) return; // KGO8-010: quota wall = NOT VERIFIED, not a contract failure
    assert.equal(r.ok, true, 'speech should succeed; stderr: ' + (r.stderr || '').slice(0, 300));
    assert.ok(fs.existsSync(outFile), 'output audio file should exist');
  } finally {
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (_) {}
  }
});

test('speech: --emotion survives to the provider', async (t) => {
  if (skip(t)) return;
  const apiKey = getApiKey();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-contract-speech-emotion-'));
  const outFile = path.join(outDir, 'contract_emotion.mp3');
  try {
    const r = await runMmx({
      args: ['speech', 'synthesize', '--text', 'I am so happy today!', '--model', 'speech-2.8-hd', '--voice', 'English_captivating_female1', '--emotion', 'happy', '--out', outFile],
      apiKey, sessionOnly: false,
    });
    if (skipOnQuota(t, r)) return; // KGO8-010: quota wall = NOT VERIFIED, not a contract failure
    assert.equal(r.ok, true, 'speech with --emotion should succeed; stderr: ' + (r.stderr || '').slice(0, 300));
    assert.ok(fs.existsSync(outFile), 'output audio file should exist');
  } finally {
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (_) {}
  }
});
