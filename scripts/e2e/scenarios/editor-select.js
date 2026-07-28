// scripts/e2e/scenarios/editor-select.js
// ============================================================================
// Paint-editor selection / "mark an area + cut it out" behaviour (STD-SEL).
//
// Verifies the standard-tool (Photoshop/GIMP/Krita) selection commands that
// were added to the pixel editor, driving them through the REAL renderer the
// same way a user would (keyboard shortcuts + a real Fabric marquee drag):
//
//   • marquee drag with the ▭ Select tool creates a scene-aligned selection
//   • Shift constrains the marquee to a square
//   • Ctrl+A selects the whole image
//   • Arrow keys nudge the selection (Shift = 10px), clamped to the bounds
//   • Delete/Backspace cuts the selected region to TRUE transparency
//   • Ctrl+Z undo restores the cut pixels
//   • Ctrl+D deselects
//   • Escape clears an active selection WITHOUT closing the editor
//
// The transparency assertions read real pixels back out of the editor's
// natural-size render (renderSceneAtNaturalSize → getImageData alpha), so a
// green result means the cut genuinely removed pixels — not just that a DOM
// node exists.
// ============================================================================

const path = require('path');
const fs = require('fs');

// Read the alpha channel of one pixel of the editor's current scene.
function pixelAlphaJs(x, y) {
  return `(() => {
    const c = window.__ieCtrl; if (!c) return -1;
    const slot = c.queue[c.activeIndex]; if (!slot || !slot.session) return -1;
    const s = slot.session;
    const tmp = s.renderSceneAtNaturalSize();
    try {
      const el = tmp.toCanvasElement(1);
      const g = el.getContext('2d');
      return g.getImageData(${x}, ${y}, 1, 1).data[3];
    } catch (_) { return -2; }
    finally { try { tmp.dispose(); } catch (_) {} }
  })()`;
}

// Current selection { sel, hasRect } for the active slot.
const READ_SEL = `(() => {
  const c = window.__ieCtrl; if (!c) return { sel: null, hasRect: false, open: false };
  const slot = c.queue[c.activeIndex]; if (!slot || !slot.session) return { sel: null, hasRect: false, open: true };
  const s = slot.session;
  const sel = (window.ImageEditorHeal && window.ImageEditorHeal.getSelection) ? window.ImageEditorHeal.getSelection(s) : null;
  return { sel: sel, hasRect: !!slot._healRect, open: true };
})()`;

// Simulate a real marquee drag with the select tool (scene coordinates).
function marqueeJs(x0, y0, x1, y1, shift) {
  const sh = shift ? 'true' : 'false';
  return `(() => {
    const c = window.__ieCtrl; const slot = c.queue[c.activeIndex]; const cv = slot.session.canvas;
    const ev = { shiftKey: ${sh}, altKey: false, button: 0 };
    cv.fire('mouse:down', { e: ev, scenePoint: { x: ${x0}, y: ${y0} } });
    cv.fire('mouse:move', { e: ev, scenePoint: { x: ${x1}, y: ${y1} } });
    cv.fire('mouse:up', { e: ev, scenePoint: { x: ${x1}, y: ${y1} } });
    return true;
  })()`;
}

// Dispatch a keyboard shortcut on document (bubbles to the window handlers).
function keyJs(key, ctrl, shift) {
  return `document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, ctrlKey: ${!!ctrl}, shiftKey: ${!!shift}, bubbles: true, cancelable: true })); true;`;
}

module.exports = {
  name: 'editor-select',
  needsRealApi: false,
  order: 70,
  async run(ctx) {
    // NOTE: `exec` is the harness's win.webContents.executeJavaScript() — NOT child_process.exec.
    const { exec, sleep, check, OUT, sharp, closeModals } = ctx;

    // ---- seed a solid 40x30 opaque PNG so pixel alpha is deterministic ----
    const W = 40, H = 30;
    const imgPath = path.join(OUT, 'editor_select_seed.png');
    let haveImg = false;
    try {
      if (sharp) {
        fs.writeFileSync(imgPath, await sharp({ create: { width: W, height: H, channels: 4, background: '#cc2222' } }).png().toBuffer());
        haveImg = true;
      }
    } catch (_) {}
    if (!haveImg) { check(false, 'editor-select: sharp unavailable to seed a PNG'); return; }

    // ---- open the pixel editor on the seed image ----
    const opened = await exec(`(async () => {
      if (typeof window.showImageEditOverlay !== 'function') return { error: 'showImageEditOverlay missing' };
      window.__smoke.errors = [];
      window.showImageEditOverlay(${JSON.stringify(imgPath)}, [${JSON.stringify(imgPath)}]);
      for (let i = 0; i < 240; i++) {
        const c = window.__ieCtrl;
        const slot = c && c.queue && c.queue[c.activeIndex];
        if (slot && slot.session && slot.session.baseObject) {
          return { ok: true, imgW: slot.session.imgW, imgH: slot.session.imgH };
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      return { error: 'editor session/base image did not load' };
    })()`);
    check(!opened.error, opened.error || '');
    if (opened.error) { await closeModals(); return; }
    check(opened.imgW === W && opened.imgH === H, `editor opened at ${opened.imgW}x${opened.imgH}, expected ${W}x${H}`);

    // sanity: the seeded image is fully opaque in the middle before any edit
    const baseAlpha = await exec(pixelAlphaJs(20, 15));
    check(baseAlpha === 255, `seed image should be opaque (alpha 255) at centre, got ${baseAlpha}`);

    // Install a detailed rejection logger so any future unhandled rejection
    // surfaces its real source (stack/message) instead of "[object Object]".
    // NOTE: we deliberately do NOT clear window.__smoke.errors here — the test
    // must capture every renderer error from the whole flow (open + actions).
    await exec(`window.__rejDetail = [];
      addEventListener('unhandledrejection', (e) => { try { window.__rejDetail.push((e.reason && (e.reason.stack || e.reason.message)) || JSON.stringify(e.reason)); } catch (_) { window.__rejDetail.push(String(e.reason)); } });
      true;`);

    // ---- A: marquee drag with the Select tool creates a scene-aligned box ----
    await exec(`window.__ieCtrl.setActiveTool('select'); true;`);
    await exec(marqueeJs(5, 5, 20, 15, false));
    await sleep(60);
    let r = await exec(READ_SEL);
    check(r.sel && r.hasRect, 'a marquee drag with the Select tool must create a persistent selection');
    if (r.sel) {
      check(r.sel.x === 5 && r.sel.y === 5 && r.sel.w === 15 && r.sel.h === 10,
        `marquee selection should be {5,5,15,10}, got ${JSON.stringify(r.sel)}`);
    }

    // ---- B: Shift constrains the marquee to a square ----
    await exec(marqueeJs(5, 5, 20, 10, true)); // 15 wide, 5 tall -> constrained to 15x15
    await sleep(60);
    r = await exec(READ_SEL);
    check(r.sel && r.sel.w === r.sel.h, `Shift-drag must constrain to a square, got ${JSON.stringify(r.sel)}`);

    // ---- C: Ctrl+A selects the whole image ----
    await exec(keyJs('a', true, false));
    await sleep(40);
    r = await exec(READ_SEL);
    check(r.sel && r.sel.x === 0 && r.sel.y === 0 && r.sel.w === W && r.sel.h === H,
      `Ctrl+A must select the full ${W}x${H} image, got ${JSON.stringify(r.sel)}`);

    // ---- D: arrow keys nudge the selection (Shift = 10px), clamped ----
    await exec(marqueeJs(5, 5, 20, 15, false)); // {5,5,15,10}
    await sleep(40);
    await exec(keyJs('ArrowRight', false, false));
    await sleep(20);
    r = await exec(READ_SEL);
    check(r.sel && r.sel.x === 6 && r.sel.y === 5, `ArrowRight should nudge x 5->6, got ${JSON.stringify(r.sel)}`);
    await exec(keyJs('ArrowDown', false, true)); // Shift = 10px
    await sleep(20);
    r = await exec(READ_SEL);
    check(r.sel && r.sel.y === 15, `Shift+ArrowDown should nudge y 5->15, got ${JSON.stringify(r.sel)}`);
    // clamp: nudging a full-image selection must not move it off-canvas
    await exec(keyJs('a', true, false)); // select all
    await exec(keyJs('ArrowRight', false, false));
    await sleep(20);
    r = await exec(READ_SEL);
    check(r.sel && r.sel.x === 0 && r.sel.w === W, `nudging a full selection must stay clamped, got ${JSON.stringify(r.sel)}`);

    // ---- E: Delete cuts the selected region to TRUE transparency ----
    await exec(marqueeJs(10, 10, 20, 20, false)); // {10,10,10,10}
    await sleep(40);
    const before = await exec(pixelAlphaJs(15, 15));
    check(before === 255, `pixel inside the selection should start opaque, got ${before}`);
    await exec(keyJs('Delete', false, false));
    await sleep(60);
    const after = await exec(pixelAlphaJs(15, 15));
    const outside = await exec(pixelAlphaJs(2, 2));
    check(after === 0, `Delete must cut the selected pixels to transparency (alpha 0), got ${after}`);
    check(outside === 255, `Delete must NOT affect pixels outside the selection, got alpha ${outside}`);
    // the marching ants stay visible after the cut (standard behaviour)
    r = await exec(READ_SEL);
    check(r.sel && r.hasRect, 'the selection outline should persist after a Delete cut');

    // ---- F: Ctrl+Z undo restores the cut pixels ----
    await exec(keyJs('z', true, false));
    await sleep(80);
    const restored = await exec(pixelAlphaJs(15, 15));
    check(restored === 255, `undo must restore the cut pixels to opaque, got alpha ${restored}`);

    // ---- G: Ctrl+D deselects ----
    await exec(keyJs('a', true, false));
    await sleep(20);
    await exec(keyJs('d', true, false));
    await sleep(20);
    r = await exec(READ_SEL);
    check(!r.sel && !r.hasRect, `Ctrl+D must clear the selection, got ${JSON.stringify(r.sel)}`);

    // ---- H: Escape clears an active selection WITHOUT closing the editor ----
    await exec(keyJs('a', true, false));
    await sleep(20);
    await exec(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); true;`);
    await sleep(40);
    r = await exec(READ_SEL);
    check(r.open === true, 'Escape with an active selection must NOT close the editor');
    check(!r.sel && !r.hasRect, `Escape must clear the active selection, got ${JSON.stringify(r.sel)}`);

    // ---- no uncaught renderer errors throughout ----
    const errs = await exec(`(window.__smoke && window.__smoke.errors) || []`);
    const rejDetail = await exec(`(window.__rejDetail) || []`);
    check(Array.isArray(errs) && errs.length === 0,
      `editor-select produced renderer errors: ${JSON.stringify(errs)} | detail: ${JSON.stringify(rejDetail)}`);

    // ---- teardown: mark clean so the dirty-confirm never blocks, then close ----
    await exec(`(() => { const c = window.__ieCtrl; if (c && c.queue) c.queue.forEach((s) => { s.modified = false; }); if (c && typeof c.requestClose === 'function') { try { Promise.resolve(c.requestClose('ui')).catch(() => {}); } catch (_) {} } return true; })()`);
    await sleep(120);
    await closeModals();
  },
};
