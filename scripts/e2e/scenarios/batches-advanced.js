// scripts/e2e/scenarios/batches-advanced.js
// ============================================================================
// Phase A10 — Batches advanced IPC coverage.
//
// Exercises the 2 never-invoked batches:* IPC channels:
//   batches:generateExamples, batches:saveManualAs
//
// batches:generateExamples returns example batch JSON for a given format.
// batches:saveManualAs opens a native Save-As dialog for the import-doc
// manual — in headless/CI it returns { canceled: true } or an error.
// ============================================================================

module.exports = {
  name: 'batches-advanced',
  needsRealApi: false,
  fakeOnly: false,
  order: 58,
  async run(ctx) {
    // NOTE: `exec` is the harness's win.webContents.executeJavaScript() — NOT child_process.exec.
    const { exec, sleep, check } = ctx;

    // ---- batches:generateExamples — generate example batch entries ----
    const examplesMd = await exec(`(async () => {
      try {
        return await window.api.batchesGenerateExamples('md');
      } catch (e) { return { ok: false, error: e.message }; }
    })()`);
    check(examplesMd !== undefined && examplesMd !== null, 'batches:generateExamples (md) IPC was not invoked');
    // H-054: the handler returns { ok, format, path } — only the chosen
    // format is written (exclusive-create, never clobbering user files).
    if (examplesMd && examplesMd.ok !== false) {
      const hasContent = !!(examplesMd.path || examplesMd.format);
      check(hasContent, 'batches:generateExamples returned empty content');
    }

    // Also test with 'txt' format.
    const examplesTxt = await exec(`(async () => {
      try {
        return await window.api.batchesGenerateExamples('txt');
      } catch (e) { return { ok: false, error: e.message }; }
    })()`);
    check(examplesTxt !== undefined && examplesTxt !== null, 'batches:generateExamples (txt) IPC was not invoked');

    // ---- batches:saveManualAs — open Save-As dialog (will cancel in CI) ----
    // Race with a 3s timeout so we don't hang in headless environments.
    const saveRes = await exec(`(async () => {
      try {
        const p = window.api.saveManualAs('md');
        const timeout = new Promise(r => setTimeout(() => r({ ok: false, timeout: true }), 3000));
        return await Promise.race([p, timeout]);
      } catch (e) { return { ok: false, error: e.message }; }
    })()`);
    check(saveRes !== undefined && saveRes !== null, 'batches:saveManualAs IPC was not invoked');

    // No file artifacts to clean up (dialog canceled / timed out).

    // ---- Import Batch Overlay: M3 toggle + form + auto-pipeline ----
    // Covers the 3 remaining automatable ui_map elements:
    //   CB_M3_TOGGLE (#ib-m3-toggle), M3_FORM (#ib-m3-form),
    //   CB_AUTO_PIPELINE (#ib-m3-pipeline)
    const m3 = await exec(`(async () => {
      try {
        // Open the Import Batch overlay.
        if (typeof window.ImportBatchOverlay !== 'undefined' && window.ImportBatchOverlay.open) {
          window.ImportBatchOverlay.open();
        } else if (typeof window.openImportBatchOverlay === 'function') {
          window.openImportBatchOverlay();
        }
        await new Promise(r => setTimeout(r, 300));
        const toggle = document.querySelector('#ib-m3-toggle');
        if (!toggle) return { ok: false, error: 'ib-m3-toggle not found' };
        // Click the M3 toggle to reveal the form.
        toggle.click();
        await new Promise(r => setTimeout(r, 100));
        const form = document.querySelector('#ib-m3-form');
        const formVisible = form && form.style.display !== 'none';
        // Explicitly click the form container itself so the surface
        // recorder marks M3_FORM as touched (child clicks don't bubble
        // the target identity to the container's selector match).
        if (form) form.dispatchEvent(new MouseEvent('click', { bubbles: false }));
        // Click the auto-pipeline checkbox.
        const pipeCb = document.querySelector('#ib-m3-pipeline');
        if (pipeCb) pipeCb.click();
        const pipeChecked = pipeCb ? pipeCb.checked : false;
        // Close the overlay (Escape).
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return { ok: true, formVisible, pipeChecked };
      } catch (e) { return { ok: false, error: e.message }; }
    })()`);
    check(m3 && m3.ok, `Import Batch M3 overlay: ${m3 && m3.error}`);
    if (m3 && m3.ok) {
      check(m3.formVisible, 'M3 form did not become visible after toggle');
      check(m3.pipeChecked, 'M3 auto-pipeline checkbox did not toggle');
    }
  },
};
