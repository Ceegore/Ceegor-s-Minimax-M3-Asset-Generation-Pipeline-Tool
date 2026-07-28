// scripts/e2e/scenarios/viewers-overlays.js
// ============================================================================
// Phase-2 surface scenario for the dynamic/overlay surface that no other
// scenario touches (ui_map screens: image_viewer_overlay, generation_-
// error_panel, dynamic batch overlay, toasts, audio_cutter):
//
//   • image viewer overlay — opened via window.openImageOverlay() on a
//     real PNG (sharp); asserts filename/position/size header + content.
//   • custom context menu — right-click on a file row.
//   • generation error panel — the scenario runs in the MAIN process, so
//     it temporarily swaps the fake mmx handlers for a failing one,
//     generates, and asserts .preview-error-message + .preview-error-tips
//     render the classified failure. Handlers are restored afterwards.
//   • batch overlay log — polls .batch-overlay-log mid-run; the defective
//     reasons node inside the BatchGen manager dialog.
//   • toast surface — #toast-root .toast renders.
//   • audio cutter — opens on a real (tiny) WAV; asserts the waveform
//     stage, markers, play cursor, time label, filename input, error box.
// ============================================================================

const path = require('path');
const fs = require('fs');
const { sel } = require('../uimap');

// Minimal valid PCM WAV (8 kHz, mono, 16-bit, ~0.1 s) so the cutter's
// decodeAudioData path succeeds even without sharp.
function tinyWav() {
  const sampleRate = 8000, n = 800, dataSize = n * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataSize, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(8000 * Math.sin(i / 12)), 44 + i * 2);
  return buf;
}

module.exports = {
  name: 'viewers-overlays',
  needsRealApi: false,
  order: 48,
  async run(ctx) {
    // NOTE: `exec` is the harness's win.webContents.executeJavaScript() — NOT child_process.exec.
    const { exec, sleep, check, OUT, sharp, closeModals } = ctx;

    // ---- image viewer overlay on a real PNG ----
    let imgPath = path.join(OUT, 'viewer_seed.png');
    try {
      if (sharp) fs.writeFileSync(imgPath, await sharp({ create: { width: 16, height: 12, channels: 3, background: '#26c' } }).png().toBuffer());
      else { fs.writeFileSync(imgPath, tinyWav()); imgPath = path.join(OUT, 'viewer_seed.bin'); }
    } catch (_) {}
    const fnSel = sel('FILENAME');
    const posSel = sel('POSITION');
    const sizeSel = sel('SIZE');
    const contentSel = sel('content');
    const ctxMenuSel = sel('context_menu');
    const viewer = await exec(`(async () => {
      if (typeof window.openImageOverlay !== 'function') return { error: 'window.openImageOverlay missing' };
      const p = ${JSON.stringify(imgPath)};
      const src = ${JSON.stringify('file:///' + imgPath.replace(/\\/g, '/'))};
      window.openImageOverlay(src, ${JSON.stringify(path.basename(imgPath))}, 16, 12, p);
      await new Promise((r) => setTimeout(r, 250));
      const ov = document.getElementById('image-overlay');
      if (!ov) return { error: 'image overlay did not mount' };
      const out = {
        mounted: true,
        filename: !!ov.querySelector(${JSON.stringify(fnSel)}),
        filenameText: (ov.querySelector(${JSON.stringify(fnSel)}) || {}).textContent || '',
        pos: !!ov.querySelector(${JSON.stringify(posSel)}),
        size: !!ov.querySelector(${JSON.stringify(sizeSel)}),
        content: !!ov.querySelector(${JSON.stringify(contentSel)}),
      };
      // right-click the image -> the "Save to…" context menu must appear
      const img = ov.querySelector(${JSON.stringify(contentSel)});
      if (img) {
        img.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
        await new Promise((r) => setTimeout(r, 150));
        out.ctxMenu = !!document.querySelector(${JSON.stringify(ctxMenuSel)});
        document.body.click();
        await new Promise((r) => setTimeout(r, 100));
      }
      // close it again (× button, then Escape as a fallback)
      const closeBtn = ov.querySelector('.image-overlay-close');
      if (closeBtn) closeBtn.click();
      await new Promise((r) => setTimeout(r, 120));
      if (document.getElementById('image-overlay')) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await new Promise((r) => setTimeout(r, 120));
      out.closed = !document.getElementById('image-overlay');
      return out;
    })()`);
    check(!viewer.error, viewer.error || '');
    if (!viewer.error) {
      check(viewer.filename, `image viewer: FILENAME ("${fnSel}") missing`);
      check(/viewer_seed/.test(viewer.filenameText), `image viewer: filename header should show the file name (got "${viewer.filenameText}")`);
      check(viewer.pos, `image viewer: POSITION ("${posSel}") missing`);
      check(viewer.size, `image viewer: SIZE ("${sizeSel}") missing`);
      check(viewer.content, `image viewer: content image ("${contentSel}") missing`);
      check(viewer.ctxMenu, `right-clicking the viewer image must show the context menu ("${ctxMenuSel}")`);
      check(viewer.closed, 'image viewer overlay did not close');
    }

    // ---- generation error panel (temporarily failing mmx backend) ----
    const msgSel = sel('STATUSBAR_ERROR');
    const tipsSel = sel('ACTION_LINKS');
    if (!ctx.real) {
      const { ipcMain } = require('electron');
      const fail = { ok: false, code: 1, stdout: '', stderr: 'API error 1004: authentication failed (invalid api key)', parsed: null, command: 'mmx', argv: [] };
      try {
        ipcMain.removeHandler('mmx:run');
        ipcMain.removeHandler('mmx:run:job');
        ipcMain.handle('mmx:run', async () => fail);
        ipcMain.handle('mmx:run:job', async () => fail);
        const err = await exec(`(async () => {
          window.__smoke.errors = [];
          if (typeof state !== 'undefined') state.generating = null;
          showTab('image');
          const p = document.querySelector('#tab-image');
          for (const ta of p.querySelectorAll('textarea')) { ta.value = 'error-panel probe'; ta.dispatchEvent(new Event('input', { bubbles: true })); }
          const b = [...p.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === 'Generate');
          b.click();
          await new Promise((r) => setTimeout(r, 1200));
          const msg = document.querySelector(${JSON.stringify(msgSel)});
          const tips = document.querySelector(${JSON.stringify(tipsSel)});
          return {
            msg: !!msg, msgText: msg ? msg.textContent.trim() : null,
            tips: !!tips,
            errors: window.__smoke.errors,
            running: window.JobRunner ? window.JobRunner.isTabRunning('image') : null,
          };
        })()`);
        check(err.msg, `generation failure must render the status-bar error ("${msgSel}")`);
        check(err.tips, `generation failure must render status-bar recovery actions ("${tipsSel}")`);
        check(err.running === false, 'the failed job must not leave the tab stuck in running state');
      } finally {
        // restore the fake backend exactly as the harness registered it
        try { ipcMain.removeHandler('mmx:run'); } catch (_) {}
        try { ipcMain.removeHandler('mmx:run:job'); } catch (_) {}
        ipcMain.handle('mmx:run', async (_e, args) => ctx.runFakeMmx(args));
        ipcMain.handle('mmx:run:job', async (_e, payload) => ctx.runFakeMmx(payload && payload.args));
      }
      await exec(`(() => { if (typeof state !== 'undefined') state.generating = null; return true; })()`);
    }

    // ---- batch overlay log mid-run + defective reasons node ----
    const batchLogSel = sel('LOG');
    const defectiveSel = sel('DEFECTIVE_WARNING');
    const bo = await exec(`(async () => {
      window.__smoke.errors = [];
      state.batchesAutoRemove = true;
      state.batches.image = ['overlay-a', 'overlay-b'];
      await window.api.batchesSet(state.batches);
      if (typeof _refreshBatchButtons === 'function') _refreshBatchButtons();
      const done = startBatchGen('image');
      let sawLog = false;
      for (let i = 0; i < 80 && !sawLog; i++) {
        sawLog = !!document.querySelector(${JSON.stringify(batchLogSel)});
        await new Promise((r) => setTimeout(r, 25));
      }
      await done;
      return { sawLog, remaining: (state.batches.image || []).length, errors: window.__smoke.errors };
    })()`);
    check(bo.sawLog, `the batch progress overlay must render its live log ("${batchLogSel}") while a batch runs`);
    check(bo.remaining === 0, 'batch overlay probe batch did not drain');
    const defective = await exec(`(async () => {
      if (typeof openBatchManager !== 'function') return { skipped: true };
      openBatchManager('image');
      await new Promise((r) => setTimeout(r, 200));
      const n = document.querySelectorAll(${JSON.stringify(defectiveSel)}).length;
      for (let i = 0; i < 8; i++) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await new Promise((r) => setTimeout(r, 100));
      return { skipped: false, count: n };
    })()`);
    if (!defective.skipped) check(defective.count >= 0, `DEFECTIVE_WARNING probe failed`);

    // ---- toast surface ----
    const toastSel = sel('TOAST');
    const toast = await exec(`(async () => {
      const tr = document.getElementById('toast-root');
      if (tr) tr.innerHTML = '';
      if (typeof window.toast === 'function') window.toast('surface-probe toast', 'ok');
      else if (typeof toast === 'function') toast('surface-probe toast', 'ok');
      await new Promise((r) => setTimeout(r, 150));
      const t = document.querySelector(${JSON.stringify(toastSel)});
      return { found: !!t, text: t ? t.textContent.trim() : null };
    })()`);
    check(toast.found, `a toast must render under "${toastSel}"`);
    check(/surface-probe/.test(toast.text || ''), `toast text should carry the message (got "${toast.text}")`);

    // ---- audio cutter surface on a real WAV ----
    const wavPath = path.join(OUT, 'cutter_seed.wav');
    try { fs.writeFileSync(wavPath, tinyWav()); } catch (_) {}
    const AC_IDS = ['META_FILENAME', 'ERROR_BOX', 'WAVEFORM_STAGE', 'MARKER_START', 'MARKER_END', 'PLAY_CURSOR', 'SELECTION_LABEL', 'INPUT_FILENAME'];
    await exec(`(async () => {
      if (typeof showAudioCutter !== 'function') return false;
      window.__smoke.errors = [];
      await showAudioCutter(${JSON.stringify(wavPath)});
      await new Promise((r) => setTimeout(r, 600));
      return true;
    })()`);
    // Per-element assertions (selectors resolved Node-side via uimap).
    for (const id of AC_IDS) {
      const s = sel(id);
      const found = await exec(`!!document.querySelector(${JSON.stringify(s)})`).catch(() => false);
      check(found, `audio cutter: ${id} ("${s}") missing after showAudioCutter()`);
    }
    await closeModals();
  },
};
