// scripts/e2e/scenarios/editor-tools.js
// ============================================================================
// Paint-editor drawing tools, zoom levels, colors, brush size and the
// undo-after-tool-change invariant (STD-TOOLS).
//
// Drives the REAL renderer exactly like a user (keyboard shortcuts + real
// Fabric canvas events) and asserts on the live session/canvas state:
//
//   • every tool hotkey switches session.tool AND reconfigures the Fabric
//     canvas drawing mode (pen/spray/eraser = drawing mode; move/select/
//     pipette/bar/zoom = object mode)
//   • [ / ] change the brush size (slider + session.brushSize stay in sync)
//   • X swaps FG/BG, D resets to black/white
//   • Ctrl+1 = 100%, Ctrl+= / Ctrl+- zoom in/out, Ctrl+0 fit-to-container
//   • the pipette (I) samples the real pixel colour under the cursor
//   • undo after a tool change restores BOTH the tool AND the canvas drawing
//     mode (regression guard for the Fabric v6 loadFromJSON migration: the
//     v5-style callback was mis-used as a reviver, so the post-load fixups —
//     baseObject re-link + setTool re-apply — were silently skipped)
// ============================================================================

const path = require('path');
const fs = require('fs');

// Live snapshot of the active editor session's tool/zoom/color/brush state.
const READ_STATE = `(() => {
  const c = window.__ieCtrl; if (!c) return { open: false };
  const slot = c.queue[c.activeIndex]; if (!slot || !slot.session) return { open: true, session: false };
  const s = slot.session;
  return {
    open: true, session: true,
    tool: s.tool,
    isDrawingMode: !!s.canvas.isDrawingMode,
    zoom: s.canvas.getZoom(),
    fg: s.fg, bg: s.bg,
    brushSize: s.brushSize,
    sizeVal: c.ui.sizeSlider.value,
    objCount: s.canvas.getObjects().length,
    baseIsObj0: s.baseObject === s.canvas.getObjects()[0]
  };
})()`;

// Dispatch a keyboard shortcut on document (bubbles to the window handlers).
function keyJs(key, ctrl, shift) {
  return `document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, ctrlKey: ${!!ctrl}, shiftKey: ${!!shift}, bubbles: true, cancelable: true })); true;`;
}

module.exports = {
  name: 'editor-tools',
  needsRealApi: false,
  order: 71,
  async run(ctx) {
    // NOTE: `exec` is the harness's win.webContents.executeJavaScript() — NOT child_process.exec.
    const { exec, sleep, check, OUT, sharp, closeModals } = ctx;

    // ---- seed a solid 40x30 opaque PNG (#3366cc) for deterministic picks ----
    const W = 40, H = 30;
    const imgPath = path.join(OUT, 'editor_tools_seed.png');
    let haveImg = false;
    try {
      if (sharp) {
        fs.writeFileSync(imgPath, await sharp({ create: { width: W, height: H, channels: 4, background: '#3366cc' } }).png().toBuffer());
        haveImg = true;
      }
    } catch (_) {}
    if (!haveImg) { check(false, 'editor-tools: sharp unavailable to seed a PNG'); return; }

    // ---- open the pixel editor on the seed image ----
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

    // detailed rejection logger (surface real source instead of [object Object])
    await exec(`window.__rejDetail = [];
      addEventListener('unhandledrejection', (e) => { try { window.__rejDetail.push((e.reason && (e.reason.stack || e.reason.message)) || JSON.stringify(e.reason)); } catch (_) { window.__rejDetail.push(String(e.reason)); } });
      true;`);

    // ---- A: pen tool engages drawing mode ----
    // NOTE: the editor persists the last-used tool across sessions (a real
    // feature), so we must NOT assume a fixed open default — a prior scenario
    // may have left it on another tool. Activate pen explicitly, then assert
    // the canvas is put into free-drawing mode.
    await exec(keyJs('b', false, false));
    await sleep(15);
    let st = await exec(READ_STATE);
    check(st.tool === 'pen' && st.isDrawingMode === true,
      `activating the pen tool must enter drawing mode, got tool=${st.tool} drawing=${st.isDrawingMode}`);

    // ---- B: tool hotkeys switch tool AND reconfigure the canvas mode ----
    const cases = [
      ['e', 'eraser', true],
      ['a', 'spray', true],
      ['v', 'move', false],
      ['m', 'select', false],
      ['i', 'pipette', false],
      ['l', 'bar', false],
      ['z', 'zoom', false],
      ['b', 'pen', true],
    ];
    for (const [key, tool, drawing] of cases) {
      await exec(keyJs(key, false, false));
      await sleep(15);
      st = await exec(READ_STATE);
      check(st.tool === tool && st.isDrawingMode === drawing,
        `pressing '${key}' must activate '${tool}' (drawing=${drawing}), got tool=${st.tool} drawing=${st.isDrawingMode}`);
    }

    // ---- C: [ / ] change the brush size (slider + session stay in sync) ----
    await exec(keyJs('b', false, false)); // pen
    await sleep(10);
    const size0 = await exec(`Number(window.__ieCtrl.ui.sizeSlider.value)`);
    await exec(keyJs(']', false, false));
    await sleep(10);
    st = await exec(READ_STATE);
    check(Number(st.sizeVal) === size0 + 2 && st.brushSize === size0 + 2,
      `']' must grow the brush by 2 (slider+session), got slider=${st.sizeVal} session=${st.brushSize} (start ${size0})`);
    await exec(keyJs('[', false, false));
    await exec(keyJs('[', false, false));
    await sleep(10);
    st = await exec(READ_STATE);
    check(Number(st.sizeVal) === size0 - 2 && st.brushSize === size0 - 2,
      `'[' must shrink the brush by 2 each press, got slider=${st.sizeVal} session=${st.brushSize} (start ${size0})`);

    // ---- D: X swaps FG/BG, D resets to black/white ----
    await exec(`(() => { const s = window.__ieCtrl.queue[window.__ieCtrl.activeIndex].session; s.fg = '#000000'; s.bg = '#ffffff'; return true; })()`);
    await exec(keyJs('x', false, false));
    await sleep(10);
    st = await exec(READ_STATE);
    check(st.fg === '#ffffff' && st.bg === '#000000', `X must swap FG/BG, got fg=${st.fg} bg=${st.bg}`);
    await exec(keyJs('d', false, false));
    await sleep(10);
    st = await exec(READ_STATE);
    check(st.fg === '#000000' && st.bg === '#ffffff', `D must reset FG/BG to black/white, got fg=${st.fg} bg=${st.bg}`);

    // ---- E: zoom levels — Ctrl+1 100%, Ctrl+= in, Ctrl+- out, Ctrl+0 fit ----
    await exec(keyJs('1', true, false)); // Ctrl+1 -> 100%
    await sleep(20);
    st = await exec(READ_STATE);
    check(Math.abs(st.zoom - 1) < 1e-6, `Ctrl+1 must set zoom to exactly 100% (1.0), got ${st.zoom}`);
    await exec(keyJs('=', true, false)); // Ctrl+= -> zoom in x1.25
    await sleep(20);
    let st2 = await exec(READ_STATE);
    check(st2.zoom > 1.0001, `Ctrl+= must zoom in past 100%, got ${st2.zoom}`);
    await exec(keyJs('-', true, false));
    await exec(keyJs('-', true, false)); // zoom out twice
    await sleep(20);
    st = await exec(READ_STATE);
    check(st.zoom < st2.zoom, `Ctrl+- must zoom out (got ${st.zoom}, was ${st2.zoom})`);
    await exec(keyJs('0', true, false)); // Ctrl+0 -> fit
    await sleep(20);
    st = await exec(READ_STATE);
    check(st.zoom > 0 && isFinite(st.zoom), `Ctrl+0 fit must produce a positive finite zoom, got ${st.zoom}`);

    // ---- F: pipette samples the real pixel colour under the cursor ----
    await exec(keyJs('i', false, false)); // pipette
    await sleep(10);
    await exec(`(() => { const cv = window.__ieCtrl.queue[window.__ieCtrl.activeIndex].session.canvas;
      cv.fire('mouse:down', { e: { button: 0 }, scenePoint: { x: 20, y: 15 } }); return true; })()`);
    await sleep(30);
    st = await exec(READ_STATE);
    check(String(st.fg).toLowerCase() === '#3366cc',
      `pipette must sample the base colour #3366cc into FG, got ${st.fg}`);

    // ---- G: undo after a tool change restores tool AND drawing mode ----
    // Regression guard for the Fabric v6 loadFromJSON migration bug.
    await exec(keyJs('b', false, false)); // pen (drawing mode)
    await sleep(10);
    const before = await exec(READ_STATE);
    check(before.tool === 'pen' && before.isDrawingMode === true, 'precondition: pen tool active');
    // snapshot (tool=pen, current objects), then add an object, then switch tool
    await exec(`(() => {
      const c = window.__ieCtrl; const s = c.queue[c.activeIndex].session;
      window.ImageEditorTools.pushUndo(s);
      const r = new s.fabric.Rect({ left: 5, top: 5, width: 8, height: 8, fill: '#ff00ff' });
      s.canvas.add(r);
      return s.canvas.getObjects().length;
    })()`);
    await exec(keyJs('v', false, false)); // move (object mode) -> isDrawingMode false
    await sleep(10);
    const mid = await exec(READ_STATE);
    check(mid.tool === 'move' && mid.isDrawingMode === false && mid.objCount === before.objCount + 1,
      `precondition: moved to object mode with one extra object, got tool=${mid.tool} drawing=${mid.isDrawingMode} objs=${mid.objCount}/${before.objCount}`);
    await exec(keyJs('z', true, false)); // Ctrl+Z undo
    await sleep(120);
    const after = await exec(READ_STATE);
    check(after.tool === 'pen', `undo must restore the pen tool, got ${after.tool}`);
    check(after.isDrawingMode === true,
      `undo must re-apply the pen drawing mode (Fabric v6 fixup), got drawing=${after.isDrawingMode}`);
    check(after.objCount === before.objCount,
      `undo must remove the added object (objs ${after.objCount}, expected ${before.objCount})`);
    check(after.baseIsObj0 === true,
      `undo must re-link baseObject to the back-most object (Fabric v6 fixup), got baseIsObj0=${after.baseIsObj0}`);

    // ---- no uncaught renderer errors throughout ----
    const errs = await exec(`(window.__smoke && window.__smoke.errors) || []`);
    const rejDetail = await exec(`(window.__rejDetail) || []`);
    check(Array.isArray(errs) && errs.length === 0,
      `editor-tools produced renderer errors: ${JSON.stringify(errs)} | detail: ${JSON.stringify(rejDetail)}`);

    // ---- teardown: mark clean so the dirty-confirm never blocks, then close ----
    await exec(`(() => { const c = window.__ieCtrl; if (c && c.queue) c.queue.forEach((s) => { s.modified = false; }); if (c && typeof c.requestClose === 'function') { try { Promise.resolve(c.requestClose('ui')).catch(() => {}); } catch (_) {} } return true; })()`);
    await sleep(120);
    await closeModals();
  },
};
