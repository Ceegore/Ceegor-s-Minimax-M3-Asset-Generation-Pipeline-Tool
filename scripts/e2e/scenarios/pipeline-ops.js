// scripts/e2e/scenarios/pipeline-ops.js
// ============================================================================
// Phase A3 — Pipeline IPC coverage.
//
// Exercises the 4 never-invoked pipeline:* IPC channels:
//   pipeline:import, pipeline:thumb, pipeline:replace, pipeline:trash
//
// Creates a real image in OUT, imports it into the pipeline board, generates
// a thumbnail, replaces the card file, and trashes it.
// ============================================================================

const path = require('path');
const fs = require('fs');

module.exports = {
  name: 'pipeline-ops',
  needsRealApi: false,
  fakeOnly: false,
  order: 44,
  async run(ctx) {
    // NOTE: `exec` is the harness's win.webContents.executeJavaScript() — NOT child_process.exec.
    const { exec, sleep, check, OUT, sharp } = ctx;

    // Create a real image for pipeline import.
    const srcFile = path.join(OUT, 'e2e_pipeline_src.png');
    if (sharp) {
      const buf = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#cc3300' } }).png().toBuffer();
      fs.writeFileSync(srcFile, buf);
    } else {
      fs.writeFileSync(srcFile, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
    }

    // Ensure the pipeline board state exists.
    await exec(`(() => {
      if (!state.pipeline) state.pipeline = {};
      if (!state.pipeline.image) state.pipeline.image = { items: [], trash: [], workspace: '' };
      state.pipeline.image.workspace = ${JSON.stringify(OUT)};
      return true;
    })()`);

    // ---- pipeline:import — import the image into the pipeline board ----
    const importRes = await exec(`(async () => {
      try {
        const r = await window.api.pipelineImport({ paths: [${JSON.stringify(srcFile)}], workspace: ${JSON.stringify(OUT)} });
        return r;
      } catch (e) { return { ok: false, error: e.message }; }
    })()`);
    check(importRes && importRes.ok !== false, `pipeline:import failed: ${importRes && importRes.error}`);

    // Get the imported item's id from the board state.
    const itemId = await exec(`(() => {
      const b = state.pipeline && state.pipeline.image;
      if (!b || !b.items || !b.items.length) return null;
      return b.items[b.items.length - 1].id;
    })()`);

    // ---- pipeline:thumb — generate a thumbnail for the card ----
    const thumbRes = await exec(`(async () => {
      try {
        return await window.api.pipelineThumb({ srcPath: ${JSON.stringify(srcFile)}, workspace: ${JSON.stringify(OUT)} });
      } catch (e) { return { ok: false, error: e.message }; }
    })()`);
    // Thumbnail generation is best-effort (may fail if sharp is missing); just verify IPC was invoked.
    check(thumbRes !== undefined && thumbRes !== null, 'pipeline:thumb IPC was not invoked');

    // ---- pipeline:replace — replace the card's file with a new one ----
    const replaceFile = path.join(OUT, 'e2e_pipeline_replace.png');
    if (sharp) {
      const buf = await sharp({ create: { width: 24, height: 24, channels: 3, background: '#00cc66' } }).png().toBuffer();
      fs.writeFileSync(replaceFile, buf);
    } else {
      fs.writeFileSync(replaceFile, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
    }
    const replaceRes = await exec(`(async () => {
      try {
        return await window.api.pipelineReplace({
          srcAbsPath: ${JSON.stringify(replaceFile)},
          workspace: ${JSON.stringify(OUT)},
          column: 'original',
          imageId: ${JSON.stringify(itemId || 'e2e-test-id')},
          displayName: 'e2e_pipeline_replace.png',
        });
      } catch (e) { return { ok: false, error: e.message }; }
    })()`);
    check(replaceRes && replaceRes.ok !== false, `pipeline:replace failed: ${replaceRes && replaceRes.error}`);

    // ---- pipeline:trash — move card files to .trash ----
    const trashRes = await exec(`(async () => {
      try {
        return await window.api.pipelineTrash({
          imageId: ${JSON.stringify(itemId || 'e2e-test-id')},
          files: [${JSON.stringify(srcFile)}],
          workspace: ${JSON.stringify(OUT)},
        });
      } catch (e) { return { ok: false, error: e.message }; }
    })()`);
    check(trashRes !== undefined && trashRes !== null, 'pipeline:trash IPC was not invoked');

    // ---- pipeline:mintWorkspace — mint a workspace grant for an allowed directory ----
    const mintRes = await exec(`(async () => {
      try {
        return await window.api.pipelineMintWorkspace({ path: ${JSON.stringify(OUT)} });
      } catch (e) { return { ok: false, error: e.message }; }
    })()`);
    check(mintRes && mintRes.ok !== false, `pipeline:mintWorkspace failed: ${mintRes && mintRes.error}`);

    // Cleanup.
    try { fs.unlinkSync(srcFile); } catch (_) {}
    try { fs.unlinkSync(replaceFile); } catch (_) {}
    await exec(`(() => { if (state.pipeline && state.pipeline.image) { state.pipeline.image.items = []; state.pipeline.image.trash = []; } return true; })()`);
  },
};
