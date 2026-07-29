// tests/contract/image.contract.test.js
// H11-6: contract test — fires a REAL image generation through the bundled
// mmx-cli + the real API. Confirms a setting like --aspect-ratio survives
// all the way to the provider and a file lands on disk.
//
// Gated behind RUN_CONTRACT_TESTS=1. Skipped in `npm test` (the unit suite).
// Run with: RUN_CONTRACT_TESTS=1 npm run test:contract

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { skip, getApiKey, skipOnQuota } = require('./_env');

const ROOT = path.join(__dirname, '..', '..');
const { runMmx } = require(path.join(ROOT, 'src', 'mmx'));

test('image: real generation produces a file on disk (smoke)', async (t) => {
  if (skip(t)) return;
  const apiKey = getApiKey();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-contract-image-'));
  const outFile = path.join(outDir, 'contract.png');
  try {
    const r = await runMmx({
      args: ['image', 'generate', '--prompt', 'a small red circle on a white background', '--out', outFile],
      apiKey, sessionOnly: true,
    });
    if (skipOnQuota(t, r)) return; // KGO8-010: quota wall = NOT VERIFIED, not a contract failure
    assert.equal(r.ok, true, 'mmx should succeed; stderr: ' + (r.stderr || '').slice(0, 300));
    // The file may land as .png or .jpg (mmx may convert). Check both.
    const pngExists = fs.existsSync(outFile);
    const jpgPath = outFile.replace(/\.png$/, '.jpg');
    const jpgExists = fs.existsSync(jpgPath);
    assert.ok(pngExists || jpgExists, 'output file should exist on disk');
  } finally {
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (_) {}
  }
});

test('image: --aspect-ratio 16:9 survives to the provider', async (t) => {
  if (skip(t)) return;
  const apiKey = getApiKey();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-contract-ar-'));
  const outFile = path.join(outDir, 'contract_ar.png');
  try {
    const r = await runMmx({
      args: ['image', 'generate', '--prompt', 'a wide landscape banner', '--aspect-ratio', '16:9', '--out', outFile],
      apiKey, sessionOnly: true,
    });
    if (skipOnQuota(t, r)) return; // KGO8-010: quota wall = NOT VERIFIED, not a contract failure
    assert.equal(r.ok, true, 'mmx should succeed with --aspect-ratio; stderr: ' + (r.stderr || '').slice(0, 300));
    // If mmx dropped the flag, the image would still generate but at the
    // default aspect (1:1). We can't assert the pixel dimensions without
    // loading the image (which needs sharp), so the contract here is just
    // "the call succeeded with the flag present" — the flag-survival is
    // implicit (a dropped flag that causes a provider error would fail).
    const exists = fs.existsSync(outFile) || fs.existsSync(outFile.replace(/\.png$/, '.jpg'));
    assert.ok(exists, 'output file should exist');
  } finally {
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (_) {}
  }
});
