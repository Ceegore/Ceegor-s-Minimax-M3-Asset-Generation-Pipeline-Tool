// tests/contract/music.contract.test.js
// H11-6: contract test — fires a REAL music generation. Confirms --duration
// survives to the provider (mmx 1.0.16 was known to silently drop it).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { skip, getApiKey, skipOnQuota } = require('./_env');
const ROOT = path.join(__dirname, '..', '..');
const { runMmx } = require(path.join(ROOT, 'src', 'mmx'));

test('music: real generation produces an audio file (smoke)', async (t) => {
  if (skip(t)) return;
  const apiKey = getApiKey();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-contract-music-'));
  const outFile = path.join(outDir, 'contract.mp3');
  try {
    const r = await runMmx({
      args: ['music', 'generate', '--prompt', 'A short upbeat electronic jingle', '--model', 'music-2.6', '--instrumental', '--out', outFile],
      apiKey, sessionOnly: false,
    });
    if (skipOnQuota(t, r)) return; // KGO8-010: quota wall = NOT VERIFIED, not a contract failure
    assert.equal(r.ok, true, 'music should succeed; stderr: ' + (r.stderr || '').slice(0, 300));
    assert.ok(fs.existsSync(outFile), 'output music file should exist');
  } finally {
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (_) {}
  }
});

test('music: --duration 6 survives to the provider (mmx 1.0.16 regression)', async (t) => {
  if (skip(t)) return;
  const apiKey = getApiKey();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-contract-music-dur-'));
  const outFile = path.join(outDir, 'contract_dur.mp3');
  try {
    const r = await runMmx({
      args: ['music', 'generate', '--prompt', 'A short calm ambient tone', '--model', 'music-2.6', '--instrumental', '--duration', '6', '--out', outFile],
      apiKey, sessionOnly: false,
    });
    if (skipOnQuota(t, r)) return; // KGO8-010: quota wall = NOT VERIFIED, not a contract failure
    assert.equal(r.ok, true, 'music with --duration 6 should succeed; stderr: ' + (r.stderr || '').slice(0, 300));
    assert.ok(fs.existsSync(outFile), 'output music file should exist');
  } finally {
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (_) {}
  }
});
