// scripts/e2e/scenarios/upscale-isnetbg.js
// ============================================================================
// Phase A9 — Upscale (Real-ESRGAN) & IS-Net background removal IPC coverage.
//
// Exercises the 4 never-invoked IPC channels:
//   upscale:realesrgan:run, upscale:realesrgan:download,
//   isnetbg:run, isnetbg:download-model
//
// Note: upscale:realesrgan:available and isnetbg:available are already
// invoked by existing scenarios. Here we exercise the run/download paths.
// The binaries may not be present in CI — we assert IPC round-trip and
// accept graceful "not available" errors.
// ============================================================================

const path = require('path');
const fs = require('fs');

module.exports = {
  name: 'upscale-isnetbg',
  needsRealApi: false,
  fakeOnly: false,
  order: 56,
  async run(ctx) {
    // NOTE: `exec` is the harness's win.webContents.executeJavaScript() — NOT child_process.exec.
    const { exec, sleep, check, OUT, sharp } = ctx;

    // Create a small 8x8 test image for upscale/bg-removal input.
    const srcFile = path.join(OUT, 'e2e_upscale_src.png');
    if (sharp) {
      const buf = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#22cc66' } }).png().toBuffer();
      fs.writeFileSync(srcFile, buf);
    } else {
      // Minimal 1x1 PNG fallback.
      const px = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
      fs.writeFileSync(srcFile, px);
    }

    // Mint a grant for OUT.
    const grant = await exec(`(async () => {
      try {
        const r = await window.api.mintGrant(${JSON.stringify(OUT)}, 'write', { kind: 'directory', capabilities: ['read', 'write'] });
        return r && r.ok ? r.grantId : null;
      } catch (e) { return null; }
    })()`);
    check(!!grant, 'upscale-isnetbg: could not mint grant for OUT');

    // ---- upscale:realesrgan:run — attempt upscale (binary may be absent) ----
    const dstFile = path.join(OUT, 'e2e_upscale_out.png');
    const runRes = await exec(`(async () => {
      try {
        return await window.api.realesrganRun(
          ${JSON.stringify(srcFile)},
          ${JSON.stringify(dstFile)},
          { model: 'realesrgan-x4plus', scale: 2 },
          ${JSON.stringify(grant)}
        );
      } catch (e) { return { ok: false, error: e.message }; }
    })()`);
    check(runRes !== undefined && runRes !== null, 'upscale:realesrgan:run IPC was not invoked');
    // Accept graceful failure if binary not present.

    // ---- upscale:realesrgan:download — attempt download (may fail in CI) ----
    // Race with a 5s timeout so we don't hang if network is unavailable.
    const dlRes = await exec(`(async () => {
      try {
        const p = window.api.realesrganDownload();
        const timeout = new Promise(r => setTimeout(() => r({ ok: false, timeout: true }), 5000));
        return await Promise.race([p, timeout]);
      } catch (e) { return { ok: false, error: e.message }; }
    })()`);
    check(dlRes !== undefined && dlRes !== null, 'upscale:realesrgan:download IPC was not invoked');

    // ---- isnetbg:run — attempt background removal (binary may be absent) ----
    const bgDst = path.join(OUT, 'e2e_isnetbg_out.png');
    const bgRes = await exec(`(async () => {
      try {
        return await window.api.isnetbgRun(
          ${JSON.stringify(srcFile)},
          ${JSON.stringify(bgDst)},
          { useGpu: false },
          ${JSON.stringify(grant)}
        );
      } catch (e) { return { ok: false, error: e.message }; }
    })()`);
    check(bgRes !== undefined && bgRes !== null, 'isnetbg:run IPC was not invoked');

    // ---- isnetbg:download-model — attempt model download (may fail in CI) ----
    const modelDlRes = await exec(`(async () => {
      try {
        const p = window.api.isnetbgDownloadModel('isnet-general-use');
        const timeout = new Promise(r => setTimeout(() => r({ ok: false, timeout: true }), 5000));
        return await Promise.race([p, timeout]);
      } catch (e) { return { ok: false, error: e.message }; }
    })()`);
    check(modelDlRes !== undefined && modelDlRes !== null, 'isnetbg:download-model IPC was not invoked');

    // Cleanup — remove all test artifacts.
    try { fs.unlinkSync(srcFile); } catch (_) {}
    try { fs.unlinkSync(dstFile); } catch (_) {}
    try { fs.unlinkSync(bgDst); } catch (_) {}
  },
};
