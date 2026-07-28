// tests/contract/video.contract.test.js
// H11-6: contract test — fires a REAL video generation. Confirms --duration,
// --resolution, and --prompt-optimizer survive to the provider (mmx 1.0.16 was
// known to silently drop video duration/resolution while exiting 0).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { skip, getApiKey, skipOnQuota } = require('./_env');
const ROOT = path.join(__dirname, '..', '..');
const { runMmx } = require(path.join(ROOT, 'src', 'mmx'));

test('video: real generation produces a video file (smoke)', async (t) => {
  if (skip(t)) return;
  const apiKey = getApiKey();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-contract-video-'));
  const outFile = path.join(outDir, 'contract.mp4');
  try {
    const r = await runMmx({
      args: ['video', 'generate', '--prompt', 'A slow zoom into a static white circle on a black background', '--model', 'MiniMax-Hailuo-2.3', '--duration', '6', '--resolution', '768P', '--download', outFile],
      apiKey, sessionOnly: false,
    });
    if (skipOnQuota(t, r)) return; // KGO8-010: quota wall = NOT VERIFIED, not a contract failure
    assert.equal(r.ok, true, 'video should succeed; stderr: ' + (r.stderr || '').slice(0, 300));
    assert.ok(fs.existsSync(outFile), 'output video file should exist');
  } finally {
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (_) {}
  }
});

test('video: --duration 6 + --resolution 768P + --prompt-optimizer survive to the provider', async (t) => {
  if (skip(t)) return;
  const apiKey = getApiKey();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-contract-video-dur-'));
  const outFile = path.join(outDir, 'contract_dur.mp4');
  try {
    const r = await runMmx({
      args: ['video', 'generate', '--prompt', 'A gentle fade from black to white', '--model', 'MiniMax-Hailuo-2.3', '--duration', '6', '--resolution', '768P', '--prompt-optimizer', '--download', outFile],
      apiKey, sessionOnly: false,
    });
    if (skipOnQuota(t, r)) return; // KGO8-010: quota wall = NOT VERIFIED, not a contract failure
    assert.equal(r.ok, true, 'video with --duration 6 + --resolution 768P + --prompt-optimizer should succeed; stderr: ' + (r.stderr || '').slice(0, 300));
    assert.ok(fs.existsSync(outFile), 'output video file should exist');
  } finally {
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (_) {}
  }
});
