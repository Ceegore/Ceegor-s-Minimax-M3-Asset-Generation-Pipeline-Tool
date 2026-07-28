// scripts/e2e/scenarios/image-processing.js
// ============================================================================
// Phase A2 — Image processing IPC coverage.
//
// Exercises the 3 never-invoked image:* IPC channels:
//   image:optimize, image:resize, image:writeBase64
//
// Uses a real PNG created via sharp (already a project dependency) so the
// Sharp-based optimize/resize handlers have valid input.
// ============================================================================

const path = require('path');
const fs = require('fs');

module.exports = {
  name: 'image-processing',
  needsRealApi: false,
  fakeOnly: false,
  order: 42,
  async run(ctx) {
    // NOTE: `exec` is the harness's win.webContents.executeJavaScript() — NOT child_process.exec.
    const { exec, sleep, check, OUT, sharp } = ctx;

    // Create a real 16x16 PNG for processing.
    const srcFile = path.join(OUT, 'e2e_imgproc_src.png');
    if (sharp) {
      const buf = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#336699' } }).png().toBuffer();
      fs.writeFileSync(srcFile, buf);
    } else {
      // Minimal valid 1x1 PNG (fallback when sharp is unavailable).
      fs.writeFileSync(srcFile, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
    }

    // Mint a directory grant covering read+write on OUT.
    const grant = await exec(`(async () => {
      try {
        const r = await window.api.mintGrant(${JSON.stringify(OUT)}, 'write', { kind: 'directory', capabilities: ['read', 'write'] });
        return r && r.ok ? r.grantId : null;
      } catch (e) { return null; }
    })()`);
    check(!!grant, 'image-processing: could not mint directory grant for OUT');

    // ---- image:optimize — re-encode as webp ----
    const optRes = await exec(`(async () => {
      try {
        return await window.api.optimizeImage(${JSON.stringify(srcFile)}, { quality: 75, format: 'webp', stripMetadata: true }, ${JSON.stringify(grant)});
      } catch (e) { return { ok: false, error: e.message }; }
    })()`);
    check(optRes && optRes.ok, `image:optimize failed: ${optRes && optRes.error}`);
    if (optRes && optRes.ok) {
      check(optRes.outputSize > 0, 'image:optimize returned zero output size');
      check(optRes.format === 'webp', `image:optimize expected format webp, got ${optRes.format}`);
    }

    // ---- image:resize — resize to 8x8 ----
    const resizeRes = await exec(`(async () => {
      try {
        return await window.api.resizeImage(${JSON.stringify(srcFile)}, { width: 8, height: 8 }, ${JSON.stringify(grant)});
      } catch (e) { return { ok: false, error: e.message }; }
    })()`);
    check(resizeRes && resizeRes.ok, `image:resize failed: ${resizeRes && resizeRes.error}`);
    if (resizeRes && resizeRes.ok) {
      check(resizeRes.width === 8 && resizeRes.height === 8,
        `image:resize expected 8x8, got ${resizeRes.width}x${resizeRes.height}`);
    }

    // ---- image:metadata — read dimensions/format ----
    const metaRes = await exec(`(async () => {
      try {
        return await window.api.imageMetadata(${JSON.stringify(srcFile)}, ${JSON.stringify(grant)});
      } catch (e) { return { ok: false, error: e.message }; }
    })()`);
    check(metaRes && metaRes.ok, `image:metadata failed: ${metaRes && metaRes.error}`);
    if (metaRes && metaRes.ok) {
      check(metaRes.width === 16 && metaRes.height === 16,
        `image:metadata expected 16x16, got ${metaRes.width}x${metaRes.height}`);
      check(metaRes.format === 'png', `image:metadata expected format png, got ${metaRes.format}`);
    }

    // ---- image:writeBase64 — write a base64-encoded image ----
    const b64Target = path.join(OUT, 'e2e_writeb64.png');
    const b64Data = fs.readFileSync(srcFile).toString('base64');
    const writeRes = await exec(`(async () => {
      try {
        return await window.api.writeImageBase64(${JSON.stringify(b64Target)}, ${JSON.stringify(b64Data)}, ${JSON.stringify(grant)});
      } catch (e) { return { ok: false, error: e.message }; }
    })()`);
    check(writeRes && writeRes.ok !== false, `image:writeBase64 failed: ${writeRes && writeRes.error}`);
    check(fs.existsSync(b64Target), 'image:writeBase64 did not produce the output file');

    // Cleanup.
    try { fs.unlinkSync(srcFile); } catch (_) {}
    try { fs.unlinkSync(b64Target); } catch (_) {}
    if (optRes && optRes.outputPath) { try { fs.unlinkSync(optRes.outputPath); } catch (_) {} }
    if (resizeRes && resizeRes.outputPath) { try { fs.unlinkSync(resizeRes.outputPath); } catch (_) {} }
  },
};
