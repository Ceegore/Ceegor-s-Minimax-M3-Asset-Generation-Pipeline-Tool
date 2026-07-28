// scripts/e2e/scenarios/editor-history.js
// ============================================================================
// Paint-editor undo/redo history semantics (STD-HISTORY).
//
// Exercises the snapshot/restore stack in the REAL renderer through the exact
// code path a user hits (Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z), using deterministic
// selection-cut edits whose pixel results are read back out of the natural-size
// render. Covers the invariants the Fabric v6 loadFromJSON migration touches:
//
//   • undo reverses an edit, redo re-applies it (pixel-exact round trip)
//   • multi-step undo/redo walks the stack in order
//   • a NEW edit after an undo clears the redo branch (Ctrl+Y becomes a no-op)
//   • baseObject stays linked to the back-most object across many undo/redo
//     cycles (the re-link fixup that the v5-callback bug used to skip)
// ============================================================================

const path = require('path');
const fs = require('fs');

// Alpha of one pixel of the editor's current scene (natural-size render).
function pixelAlphaJs(x, y) {
  return `(() => {
    const c = window.__ieCtrl; if (!c) return -1;
    const slot = c.queue[c.activeIndex]; if (!slot || !slot.session) return -1;
    const s = slot.session;
    const tmp = s.renderSceneAtNaturalSize();
    try { return tmp.toCanvasElement(1).getContext('2d').getImageData(${x}, ${y}, 1, 1).data[3]; }
    catch (_) { return -2; }
    finally { try { tmp.dispose(); } catch (_) {} }
  })()`;
}

// baseObject linkage + redo/undo stack depths for the active session.
const READ_HIST = `(() => {
  const c = window.__ieCtrl; if (!c) return { open: false };
  const slot = c.queue[c.activeIndex]; if (!slot || !slot.session) return { open: true, session: false };
  const s = slot.session;
  return { open: true, session: true, undo: s._undo.length, redo: s._redo.length, baseIsObj0: s.baseObject === s.canvas.getObjects()[0] };
})()`;

// Marquee-select a box (scene coords) with the Select tool.
function selectJs(x, y, w, h) {
  return `(() => {
    const c = window.__ieCtrl; c.setActiveTool('select');
    const cv = c.queue[c.activeIndex].session.canvas;
    const ev = { shiftKey: false, altKey: false, button: 0 };
    cv.fire('mouse:down', { e: ev, scenePoint: { x: ${x}, y: ${y} } });
    cv.fire('mouse:move', { e: ev, scenePoint: { x: ${x + w}, y: ${y + h} } });
    cv.fire('mouse:up', { e: ev, scenePoint: { x: ${x + w}, y: ${y + h} } });
    return true;
  })()`;
}

function keyJs(key, ctrl, shift) {
  return `document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, ctrlKey: ${!!ctrl}, shiftKey: ${!!shift}, bubbles: true, cancelable: true })); true;`;
}

// Cut a box to transparency: select it, then press Delete.
async function cutBox(ctx, x, y, w, h) {
  const { exec, sleep } = ctx;
  await exec(selectJs(x, y, w, h));
  await sleep(40);
  await exec(keyJs('Delete', false, false));
  await sleep(60);
}

module.exports = {
  name: 'editor-history',
  needsRealApi: false,
  order: 72,
  async run(ctx) {
    // NOTE: `exec` is the harness's win.webContents.executeJavaScript() — NOT child_process.exec.
    const { exec, sleep, check, OUT, sharp, closeModals } = ctx;

    const W = 48, H = 32;
    const imgPath = path.join(OUT, 'editor_history_seed.png');
    let haveImg = false;
    try {
      if (sharp) {
        fs.writeFileSync(imgPath, await sharp({ create: { width: W, height: H, channels: 4, background: '#22aa55' } }).png().toBuffer());
        haveImg = true;
      }
    } catch (_) {}
    if (!haveImg) { check(false, 'editor-history: sharp unavailable to seed a PNG'); return; }

    const opened = await exec(`(async () => {
      if (typeof window.showImageEditOverlay !== 'function') return { error: 'showImageEditOverlay missing' };
      window.__smoke.errors = [];
      window.showImageEditOverlay(${JSON.stringify(imgPath)}, [${JSON.stringify(imgPath)}]);
      for (let i = 0; i < 240; i++) {
        const c = window.__ieCtrl;
        const slot = c && c.queue && c.queue[c.activeIndex];
        if (slot && slot.session && slot.session.baseObject) return { ok: true };
        await new Promise((r) => setTimeout(r, 25));
      }
      return { error: 'editor session/base image did not load' };
    })()`);
    check(!opened.error, opened.error || '');
    if (opened.error) { await closeModals(); return; }

    await exec(`window.__rejDetail = [];
      addEventListener('unhandledrejection', (e) => { try { window.__rejDetail.push((e.reason && (e.reason.stack || e.reason.message)) || JSON.stringify(e.reason)); } catch (_) { window.__rejDetail.push(String(e.reason)); } });
      true;`);

    // Two disjoint probe pixels inside two disjoint cut boxes.
    const A = { x: 6, y: 6, w: 10, h: 10, px: 11, py: 11 };   // box A, probe (11,11)
    const B = { x: 30, y: 16, w: 10, h: 10, px: 35, py: 21 };  // box B, probe (35,21)

    check(await exec(pixelAlphaJs(A.px, A.py)) === 255, 'precondition: A probe opaque');
    check(await exec(pixelAlphaJs(B.px, B.py)) === 255, 'precondition: B probe opaque');

    // ---- A: single cut → undo → redo round trip (pixel-exact) ----
    await cutBox(ctx, A.x, A.y, A.w, A.h);
    check(await exec(pixelAlphaJs(A.px, A.py)) === 0, 'cut A must make A probe transparent');
    await exec(keyJs('z', true, false)); await sleep(90); // undo
    check(await exec(pixelAlphaJs(A.px, A.py)) === 255, 'undo must restore A probe to opaque');
    await exec(keyJs('y', true, false)); await sleep(90); // redo (Ctrl+Y)
    check(await exec(pixelAlphaJs(A.px, A.py)) === 0, 'redo (Ctrl+Y) must re-cut A probe');
    await exec(keyJs('z', true, true)); await sleep(90);  // undo the redo
    await exec(keyJs('z', true, false)); await sleep(90); // undo back to pristine
    check(await exec(pixelAlphaJs(A.px, A.py)) === 255, 'two undoes must return A probe to opaque');

    // ---- B: multi-step undo/redo walks the stack in order ----
    await cutBox(ctx, A.x, A.y, A.w, A.h); // edit 1: cut A
    await cutBox(ctx, B.x, B.y, B.w, B.h); // edit 2: cut B
    check(await exec(pixelAlphaJs(A.px, A.py)) === 0 && await exec(pixelAlphaJs(B.px, B.py)) === 0,
      'both A and B must be cut after two edits');
    await exec(keyJs('z', true, false)); await sleep(90); // undo edit 2
    check(await exec(pixelAlphaJs(B.px, B.py)) === 255 && await exec(pixelAlphaJs(A.px, A.py)) === 0,
      'undoing edit 2 must restore B but leave A cut');
    await exec(keyJs('z', true, false)); await sleep(90); // undo edit 1
    check(await exec(pixelAlphaJs(A.px, A.py)) === 255 && await exec(pixelAlphaJs(B.px, B.py)) === 255,
      'undoing edit 1 must restore A too (fully pristine)');
    await exec(keyJs('z', true, true)); await sleep(90);  // redo edit 1
    check(await exec(pixelAlphaJs(A.px, A.py)) === 0 && await exec(pixelAlphaJs(B.px, B.py)) === 255,
      'Ctrl+Shift+Z must redo edit 1 (cut A only)');
    await exec(keyJs('z', true, true)); await sleep(90);  // redo edit 2
    check(await exec(pixelAlphaJs(A.px, A.py)) === 0 && await exec(pixelAlphaJs(B.px, B.py)) === 0,
      'redo edit 2 must re-cut B (both cut again)');

    // ---- C: a new edit after undo clears the redo branch ----
    await exec(keyJs('z', true, false)); await sleep(90); // undo edit 2 (B restored)
    let h = await exec(READ_HIST);
    check(h.redo >= 1, `after an undo there must be a redo entry, got redo=${h.redo}`);
    await cutBox(ctx, A.x, A.y, A.w, A.h);                // NEW edit (cuts A again)
    h = await exec(READ_HIST);
    check(h.redo === 0, `a new edit must clear the redo branch, got redo=${h.redo}`);
    await exec(keyJs('y', true, false)); await sleep(90); // Ctrl+Y now a no-op
    check(await exec(pixelAlphaJs(B.px, B.py)) === 255,
      'Ctrl+Y after the redo branch was cleared must NOT re-cut B');

    // ---- D: baseObject stays linked across all those undo/redo cycles ----
    h = await exec(READ_HIST);
    check(h.baseIsObj0 === true, `baseObject must remain linked to the back-most object after many undo/redo cycles, got baseIsObj0=${h.baseIsObj0}`);

    // ---- no uncaught renderer errors throughout ----
    const errs = await exec(`(window.__smoke && window.__smoke.errors) || []`);
    const rejDetail = await exec(`(window.__rejDetail) || []`);
    check(Array.isArray(errs) && errs.length === 0,
      `editor-history produced renderer errors: ${JSON.stringify(errs)} | detail: ${JSON.stringify(rejDetail)}`);

    // ---- teardown ----
    await exec(`(() => { const c = window.__ieCtrl; if (c && c.queue) c.queue.forEach((s) => { s.modified = false; }); if (c && typeof c.requestClose === 'function') { try { Promise.resolve(c.requestClose('ui')).catch(() => {}); } catch (_) {} } return true; })()`);
    await sleep(120);
    await closeModals();
  },
};
