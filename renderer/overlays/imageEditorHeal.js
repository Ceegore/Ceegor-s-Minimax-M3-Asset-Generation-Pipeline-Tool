// renderer/overlays/imageEditorHeal.js (pixel editor)
// Heal / inpaint UI: a small options popover (engine + mode + Start) and the
// mask-builder + IPC call for the pure-JS Telea tier (small fixes).
//
// The AI tier (LaMa / MI-GAN) is wired in imageEditorHealAi.js.
//
// Three GIMP-equivalent operations:
//   - Heal Selection    : fill a user-dragged rectangle from surrounding texture
//   - Heal Transparency : fill alpha=0 holes left by background removal
//   - Resynthesize      : stronger AI fill (handled by the AI tier when present)
//
// Mask flow (selection mode): the editor keeps a "heal selection" rectangle on
// the session; the rectangle is rasterized into a 1-channel mask PNG at
// the source's native resolution and sent to inpaint:runTelea alongside the
// (current, possibly baked) source path. The main process synthesises + writes
// a sibling _healed.png; the healed result is reloaded as the new base image.

(function () {
  'use strict';

  function activeSession(ctrl) {
    // H8-F2 C8: heal follows the FOCUSED canvas (main or asset panel).
    // Fall back to the main slot for older controllers (test mocks) that
    // don't expose focusedSession().
    if (typeof ctrl.focusedSession === 'function') {
      const h = ctrl.focusedSession();
      if (h) return h;
    }
    const slot = ctrl.queue[ctrl.activeIndex];
    return slot && slot.handle ? slot.handle : null;
  }
  function activeSlot(ctrl) { return ctrl.queue[ctrl.activeIndex]; }

  // ---- selection rectangle (canvas/image coordinates) ----
  // Stored on the session so it survives tool switches. The overlay's canvas
  // 'mouse:down/move/up' in 'zoom' or a dedicated 'heal-select' mode draws it.
  function ensureSelection(session) {
    if (!session._healSel) session._healSel = null;
    return session._healSel;
  }
  function setSelection(session, sel) { session._healSel = sel; }
  function getSelection(session) { return session._healSel; }

  // ---- mask PNG builder ----
  // Build a base64 PNG (alpha=luma mask) of size w×h: white where the selection
  // rectangle is, transparent elsewhere. Used as the inpaint mask.
  function maskB64FromRect(w, h, sel) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    if (sel) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(sel.x, sel.y, sel.w, sel.h);
    }
    return c.toDataURL('image/png').split(',')[1];
  }

  // ---- the Heal menu (footer 🩹 Heal ▾) ----
  // Presents the three GIMP-equivalent operations as a tiny menu; each opens
  // the options popover above.
  function openMenu(ctrl) {
    const h = activeSession(ctrl);
    if (!h) { toast('Load an image first.', 'warn', 2500); return; }
    showModal((m, close) => {
      m.style.width = 'min(320px, 92vw)';
      m.appendChild(el('h2', {}, '🩹 Heal / Inpaint'));
      const mk = (label, op, desc) => {
        const b = el('button', { class: 'ie-btn', style: 'width:100%;text-align:left;margin-bottom:6px;' },
          [el('div', {}, label), el('div', { class: 'meta', style: 'font-size:11px;color:var(--fg-2);' }, desc)]);
        b.addEventListener('click', () => { close(); openPopover(ctrl, op); });
        m.appendChild(b);
      };
      mk('🩹 Heal Selection', 'selection', 'Fill a selected rectangle from surrounding texture. Good for small fixes (fast, local).');
      mk('🩹 Heal Transparency', 'transparency', 'Fill all transparent holes left by background removal.');
      mk('✨ Resynthesize', 'resynthesize', 'Stronger AI content-aware fill of the selection (LaMa/MI-GAN). Best for larger regions.');
      // model management (Settings-style swap) — opens the dedicated overlay.
      const modelsBtn = el('button', { class: 'ie-btn', style: 'width:100%;text-align:left;margin-bottom:6px;' },
        [el('div', {}, '🧠 Manage heal models…'), el('div', { class: 'meta', style: 'font-size:11px;color:var(--fg-2);' }, 'Check status, or replace MI-GAN / LaMa with a newer model file.')]);
      modelsBtn.addEventListener('click', () => { close(); if (window.ImageEditorSettings) window.ImageEditorSettings.openModelsOverlay(); });
      m.appendChild(modelsBtn);
      m.appendChild(el('div', { class: 'footer' }, [el('button', { onclick: close }, 'Cancel')]));
    }, { id: 'ie-heal-menu' });
  }

  // ---- the popover ----
  // op: 'selection' | 'transparency' | 'resynthesize'
  function openPopover(ctrl, op) {
    const h = activeSession(ctrl);
    if (!h) { toast('Load an image first.', 'warn', 2500); return; }

    const sel = getSelection(h.session);
    const needsSel = (op === 'selection' || op === 'resynthesize');

    showModal((m, close) => {
      m.style.width = 'min(440px, 92vw)';
      const title = { selection: '🩹 Heal Selection', transparency: '🩹 Heal Transparency', resynthesize: '✨ Resynthesize (AI)' }[op] || 'Heal';
      m.appendChild(el('h2', {}, title));

      let hint = '';
      if (op === 'transparency') hint = 'Fills ENCLOSED transparent holes with synthesised surrounding colour. Transparency connected to the image border (the background) is left untouched. Best for sealing the seams left after background removal.';
      else if (op === 'selection') hint = 'Fills the selected rectangle from the surrounding texture. Drag a box on the canvas first — use the ▭ Select (M) or 🩹 Heal (H) tool to drag the box.';
      else hint = 'Stronger AI content-aware fill of the selection (LaMa / MI-GAN). Best for larger regions.';
      m.appendChild(el('p', { class: 'meta', style: 'color: var(--fg-2); font-size: 12px;' }, hint));

      if (needsSel) {
        if (!sel) {
          m.appendChild(el('p', { style: 'color: var(--accent); font-size: 12px;' }, '⚠ No selection yet. Drag a rectangle on the canvas to choose the region to heal.'));
        } else {
          m.appendChild(el('p', { class: 'meta', style: 'font-size:12px;' }, 'Selection: ' + sel.w + '×' + sel.h + ' at (' + sel.x + ', ' + sel.y + ')'));
        }
      }

      // radius slider (Telea neighbourhood) + numeric input (H8-006)
      const radiusIn = el('input', { type: 'range', min: '1', max: '12', value: '4' });
      const radiusNum = el('input', { type: 'number', min: '1', max: '12', step: '1', value: '4', style: 'width:54px;' });
      const radiusLbl = el('span', { class: 'meta', style: 'min-width:24px;text-align:right;' }, '4');
      const applyRadius = (val) => {
        const n = Math.max(1, Math.min(12, Math.round(Number(val) || 4)));
        radiusIn.value = String(n); radiusNum.value = String(n); radiusLbl.textContent = String(n);
      };
      radiusIn.addEventListener('input', () => applyRadius(radiusIn.value));
      radiusNum.addEventListener('input', () => applyRadius(radiusNum.value));
      radiusNum.addEventListener('change', () => applyRadius(radiusNum.value));
      m.appendChild(el('div', { class: 'row' }, [el('label', {}, 'Neighbourhood radius'), radiusIn, radiusNum, radiusLbl]));

      // PE-009: transparency mask options (enclosed-holes mask). Only
      // relevant for Heal Transparency — selection/resynthesize use the
      // user-drawn rectangle mask.
      let thrIn = null, maxHoleIn = null, growIn = null;
      if (op === 'transparency') {
        thrIn = el('input', { type: 'number', min: '0', max: '255', step: '1', value: '0', style: 'width:60px;', 'aria-label': 'Alpha threshold' });
        maxHoleIn = el('input', { type: 'number', min: '0', max: '10000000', step: '1', value: '0', style: 'width:84px;', 'aria-label': 'Max hole size in pixels' });
        growIn = el('input', { type: 'number', min: '0', max: '16', step: '1', value: '1', style: 'width:54px;', 'aria-label': 'Grow mask in pixels' });
        m.appendChild(el('div', { class: 'row' }, [el('label', {}, 'Alpha threshold'), thrIn, el('span', { class: 'meta', style: 'font-size:11px;' }, 'alpha ≤ this counts as transparent')]));
        m.appendChild(el('div', { class: 'row' }, [el('label', {}, 'Max hole size'), maxHoleIn, el('span', { class: 'meta', style: 'font-size:11px;' }, 'px — larger holes stay open (0 = fill all)')]));
        m.appendChild(el('div', { class: 'row' }, [el('label', {}, 'Grow mask'), growIn, el('span', { class: 'meta', style: 'font-size:11px;' }, 'px — also heal the rim around each hole')]));
      }

      // PE-024: capability = bridge present + at least one AI model on disk.
      // Async probe — update the note once the answer arrives.
      const aiNoteEl = el('p', { style: 'color: var(--fg-2); font-size: 12px;' }, 'Checking AI model availability…');
      if (op === 'resynthesize') m.appendChild(aiNoteEl);
      let aiModelPresent = false;
      if (window.api && window.api.inpaintModelsAvailable) {
        window.api.inpaintModelsAvailable().then((res) => {
          if (res && res.ok && res.models) {
            aiModelPresent = Object.values(res.models).some((mm) => mm && mm.present);
          }
          if (op === 'resynthesize') {
            aiNoteEl.textContent = aiModelPresent
              ? 'AI models found — LaMa/MI-GAN will be used for this fill.'
              : 'No AI models on disk — the fast Telea synthesizer will be used instead.';
          }
        }).catch(() => {
          if (op === 'resynthesize') aiNoteEl.textContent = 'AI model check failed — falling back to Telea synthesizer.';
        });
      } else if (op === 'resynthesize') {
        aiNoteEl.textContent = 'AI inpaint bridge not available — using Telea synthesizer.';
      }

      const startBtn = el('button', { class: 'primary' }, 'Start');
      const cancelBtn = el('button', { onclick: close }, 'Cancel');
      startBtn.addEventListener('click', async () => {
        if (needsSel && !sel) { toast('Drag a selection rectangle on the canvas first.', 'warn', 3000); close(); return; }
        startBtn.disabled = true; startBtn.textContent = 'Healing…';
        // PE-009: transparency mask options travel on ctrl (the runHeal
        // signature is gate-pinned to (ctrl, op, radius) by R5.2.Heal).
        ctrl._healOpts = (op === 'transparency') ? {
          alphaThreshold: parseInt(thrIn.value, 10) || 0,
          maxHolePx: parseInt(maxHoleIn.value, 10) || 0,
          growPx: parseInt(growIn.value, 10) || 0,
        } : null;
        try {
          const rr = await runHeal(ctrl, op, parseInt(radiusIn.value, 10));
          if (rr && rr.stale) {
            toast('Heal discarded — the image changed while healing.', 'warn', 4000);
          } else if (rr && rr.noop) {
            toast('No enclosed transparent holes found — nothing to heal.', 'warn', 4000);
          } else if (rr && rr.aiFallback) {
            toast('Healed with Telea fallback (AI model failed).', 'warn', 5000);
          } else if (rr && typeof rr.maskShare === 'number' && rr.maskShare > 0.5) {
            toast('Healed — but ' + Math.round(rr.maskShare * 100) + '% of the image was synthesised. Check the result.', 'warn', 6000);
          } else {
            toast('Healed.', 'ok', 2500);
          }
          close();
        } catch (e) {
          toast('Heal failed: ' + (e && e.message || e), 'err', 6000);
          startBtn.disabled = false; startBtn.textContent = 'Start';
        }
      });
      m.appendChild(el('div', { class: 'footer' }, [cancelBtn, startBtn]));
    }, { id: 'ie-heal-popover' });
  }

  // ---- run a heal op ----
  // 1. Bake the current scene (so painted/placed pixels are part of the source).
  // 2. Capture the source path (the baked image, written to a temp file).
  // 3. Build the mask + call inpaintRunTelea.
  // 4. Reload the healed result as the new base image.
  async function runHeal(ctrl, op, radius) {
    const slot = activeSlot(ctrl); const h = activeSession(ctrl); if (!h) return;
    // H8-F2 C8: when the ASSET canvas is focused, heal runs on the asset
    // session (h === asset handle). The temp dir then prefers the asset's
    // backing path; slot may even be absent (empty queue) — allowed for
    // asset-focused heals only.
    const onAsset = !!(ctrl.assetPanel && ctrl.assetPanel.handle === h);
    if (!slot && !onAsset) return;
    const s = h.session;

    // PE-010: capture the slot revision (or the asset panel's revision)
    // BEFORE the await so the async result can only commit to the SAME
    // slot/base it started from — a heal started on slot A must never
    // land on slot B after a mid-flight user switch.
    const Tools010 = window.ImageEditorTools;
    const revCap = (Tools010 && Tools010.captureSlotRev) ? Tools010.captureSlotRev(slot) : null;
    const assetRevCap = (onAsset && ctrl.assetPanel) ? (ctrl.assetPanel.revision || 0) : 0;

    // Bake current scene to a PNG data URL → needed on disk for the IPC.
    // R4.2.follow-up (PE-001 migration): use `renderSceneAtNaturalSize`
    // + a `toDataURL` call on the TEMP canvas (not the legacy
    // `h.toDataURL('png')` which uses the LIVE canvas's VPT). The
    // temp canvas has identity VPT so the baked PNG is at the
    // natural pixel coordinates — NOT zoom/pan/fit-corrupted.
    // Otherwise a user zoomed-in would inpaint a partial image and
    // the result would be wrong.
    // R4.2.follow-up.AuditFix P-R42FU-01: wrap temp in try/finally
    // (per the R4.2 canvasHasAlpha/flattenOntoMatte/doSave pattern)
    // so a throw from temp.toDataURL or any subsequent line doesn't
    // leak the temp canvas. Previously: `try { temp.dispose(); }`
    // was BEFORE the grant-mint await; if ensurePathGrant threw,
    // the dispose was bypassed AND the error was swallowed.
    let temp;
    // R5.2 Heal: track the pre-snapshot so the catch path can
    // pop it on failure (cancel-cleanup per R5.2.AuditFix
    // P-R52T-F1 / R5.2 Stroke pattern). Without this, a
    // reloadBaseFromPath throw would leave the pre-snapshot
    // orphan in the undo stack, and the user would have to undo
    // TWICE to get back to the pre-heal state.
    let pushedPreSnapshot = false;
    // R4 fix: hoist tmpPath ABOVE the try so the catch block's temp-file
    // cleanup can reference it. It was previously a `const` declared INSIDE
    // the try, so the `typeof tmpPath === 'string'` check in the sibling
    // catch threw a ReferenceError (swallowed by that cleanup's own
    // try/catch) and the `.ie_heal_src_*.png` temp leaked on every heal error.
    let tmpPath = null;
    // P5 (DA-M-005): hoist the healed OUTPUT path too. If the base reload
    // (or any later step) throws AFTER inpaint wrote its result, the catch
    // must delete that output — otherwise an orphaned `_healed.png` leaks
    // in the work dir on every failed heal. Mirrors the tmpPath hoist above.
    let healOutPath = null;
    try {
      temp = h.session.renderSceneAtNaturalSize();
      const bakedB64 = temp.toDataURL({ format: 'image/png', multiplier: 1 }).split(',')[1];
      // QA-009 fix: use a fallback session key when slot is null (asset-only state).
      const sessionKey = slot ? slot.id : ('asset_' + ((ctrl.assetPanel && ctrl.assetPanel.revision) || 0));
      const wf = window.ImageEditorWorkDir
        ? await window.ImageEditorWorkDir.getWorkFilePath(sessionKey, '.ie_heal_src_', '.png')
        : { path: ((window.state && window.state.config && window.state.config.output_dir) ? window.state.config.output_dir : 'image') + '/.ie_heal_' + Date.now() + '.png', grantId: undefined };
      tmpPath = wf.path;
      const wg = wf.grantId;
      if (wg && wg.ok === false) throw new Error('bake: ' + (wg.error || 'mintGrant failed'));
      // R4 fix: check the write result. These IPC calls return an
      // {ok:false,error} envelope on failure (they do NOT throw), so without
      // this check heal would run against a temp file that was never written
      // (pattern lifted from imageEditorActions.js's save-as path).
      const tmpW = await ((window.api && window.api.writeImageBase64) ? window.api.writeImageBase64(tmpPath, bakedB64, wg) : window.api.fbWrite(tmpPath, bakedB64, wg));
      if (!tmpW || tmpW.ok === false) throw new Error('bake: ' + ((tmpW && tmpW.error) || 'temp write failed'));

    const mode = (op === 'transparency') ? 'transparency' : 'selection';
    const args = { srcPath: tmpPath, mode, radius };
    // PE-009: thread the transparency mask options (enclosed-holes mask:
    // alpha threshold, max hole size, grow). Set by the popover on
    // ctrl._healOpts (the runHeal signature is gate-pinned).
    if (mode === 'transparency') {
      const to = ctrl._healOpts;
      if (to && typeof to === 'object') {
        if (typeof to.alphaThreshold === 'number') args.alphaThreshold = to.alphaThreshold;
        if (typeof to.maxHolePx === 'number') args.maxHolePx = to.maxHolePx;
        if (typeof to.growPx === 'number') args.growPx = to.growPx;
      }
    }
    let sel = null;
    if (mode === 'selection') {
      sel = getSelection(s) || { x: 0, y: 0, w: s.imgW, h: s.imgH };
      args.maskB64 = maskB64FromRect(s.imgW, s.imgH, sel);
    }
    // R1.5a.follow-up Phase 2: mint grant for tmpPath before mutation (graceful fallthrough).
    // R1.5a.follow-up Phase 6: directory-grant on the PARENT of
    // tmpPath with both 'read' AND 'write' capabilities. The
    // inpaint handler reads from tmpPath AND writes to outPath
    // (a sibling); a file-grant on tmpPath with 'read' would
    // FAIL the handler's write-check on outPath.
    // PRE-1: use window.GrantCache + window.api.pathDirname (no require in sandbox).
    if (window.api && window.api.mintGrant) {
      const tmpGrantId = await window.GrantCache.ensurePathGrant(
        window.api.pathDirname(tmpPath), 'read',
        { kind: 'directory', capabilities: ['read', 'write'] }
      );
      if (tmpGrantId && tmpGrantId.ok === false) {
        throw new Error('inpaint: ' + (tmpGrantId.error || 'mintGrant failed'));
      }
      args.grantId = tmpGrantId;
    }
    // PE-024: AI resynthesize with automatic Telea fallback. Capability =
    // bridge present + model on disk (probed via inpaintModelsAvailable).
    // If the AI call fails at runtime (contract error, corrupt model, etc.)
    // we transparently fall back to Telea and report it in the result.
    let r;
    let usedAiFallback = false;
    if (op === 'resynthesize' && window.api && window.api.inpaintRunOnnx) {
      let canAi = false;
      if (window.api.inpaintModelsAvailable) {
        try {
          const cap = await window.api.inpaintModelsAvailable();
          canAi = !!(cap && cap.ok && cap.models && Object.values(cap.models).some((mm) => mm && mm.present));
        } catch (_) { canAi = false; }
      }
      if (canAi) {
        const aiArgs = Object.assign({}, args, { model: 'auto' });
        if (sel) {
          const share = (sel.w * sel.h) / Math.max(1, s.imgW * s.imgH);
          aiArgs.areaShare = share;
        }
        try {
          r = await window.api.inpaintRunOnnx(aiArgs);
          if (!r || !r.ok) throw new Error((r && r.error) || 'AI inpaint failed');
        } catch (_aiErr) {
          // PE-024: AI tier failed — fall back to Telea (visible to user via result flag).
          r = null;
          usedAiFallback = true;
        }
      }
    }
    if (!r) {
      r = await window.api.inpaintRunTelea(args);
    }
    if (!r || !r.ok) throw new Error((r && r.error) || 'inpaint failed');
    if (usedAiFallback) r.aiFallback = true;
    healOutPath = (r && r.path) ? r.path : null; // P5 (DA-M-005): track for catch-path cleanup

    // PE-010: slot-revision guard. If the editor closed, the originating
    // slot vanished, or its base was replaced (revision bumped) while the
    // IPC ran, DISCARD the result + temps — the now-active slot must stay
    // byte-identical. Otherwise the commit below is routed to the captured
    // handle (ctrl._commitHandle) so it lands on the right session even if
    // the user switched to another slot meanwhile.
    let stale010 = !!ctrl.closed;
    if (!stale010) {
      if (onAsset) {
        stale010 = !ctrl.assetPanel || ctrl.assetPanel.handle !== h || (ctrl.assetPanel.revision || 0) !== assetRevCap;
      } else {
        stale010 = (Tools010 && Tools010.slotRevValid) ? !Tools010.slotRevValid(ctrl, revCap) : (ctrl.queue[ctrl.activeIndex] !== slot);
      }
    }
    if (stale010) {
      try {
        if (window.FbIntent) {
          // BGR-009 fix: mint delete grant (R1.3 gate).
          // B-007 (hhhhu3 audit): delete via native confirmation (window.FbIntent).
          const dg = (window.GrantHelper) ? await window.GrantHelper.ensureDelete(tmpPath) : undefined;
          await window.FbIntent.del(tmpPath, dg);
          if (r.path && r.path !== tmpPath) await window.FbIntent.del(r.path, dg);
        }
      } catch (_) { /* temp cleanup is best-effort */ }
      return { stale: true };
    }

    // PE-009: a transparency run with zero enclosed holes produced an
    // output identical to the source — skip the undo entry + base reload
    // (a no-op heal must not dirty the slot / consume an undo step) and
    // tidy both temp files. The caller toasts the explanation.
    if (mode === 'transparency' && r.holesFilled === 0) {
      try {
        if (window.FbIntent) {
          // BGR-009 fix: mint delete grant (R1.3 gate).
          // B-007 (hhhhu3 audit): delete via native confirmation (window.FbIntent).
          const dg = (window.GrantHelper) ? await window.GrantHelper.ensureDelete(tmpPath) : undefined;
          await window.FbIntent.del(tmpPath, dg);
          if (r.path && r.path !== tmpPath) await window.FbIntent.del(r.path, dg);
        }
      } catch (_) { /* temp cleanup is best-effort */ }
      return { noop: true };
    }

    // H8-001/H8 fix: push the undo snapshot BEFORE replacing the base image (the
    // Pre-fix order pushed AFTER reload, which made Ctrl+Z a no-op for the
    // pre-heal state). Same fix applied to onRemoveBg.
    // R5.2 Heal: wrap pushUndo in try/catch (defensive) and set
    // pushedPreSnapshot flag so the catch path can pop on
    // reloadBaseFromPath failure. Post-R5.2: pre-snapshot BEFORE
    // mutation + cancel-cleanup (PE-005-Pixelvertrag).
    try {
      if (window.ImageEditorTools && typeof window.ImageEditorTools.pushUndo === 'function') {
        window.ImageEditorTools.pushUndo(s);
        pushedPreSnapshot = true;
      }
    } catch (_) { /* defensive: pre-snapshot push failed — proceed without undo for this heal */ }

    // Reload the healed image as the new base.
    // PE-010: route the reload to the CAPTURED session (not whichever
    // canvas is focused now) so the result lands on the right slot.
    ctrl._commitHandle = h;
    await reloadBaseFromPath(ctrl, r.path);
    ctrl._commitHandle = null;
    if (slot && !onAsset) {
      slot.modified = true;
      if (Tools010 && Tools010.bumpSlotRev) Tools010.bumpSlotRev(slot); // PE-010: base replaced
      window.ImageEditorSource.refreshQueueBar(ctrl);
    } else if (onAsset && ctrl.assetPanel) {
      ctrl.assetPanel.revision = (ctrl.assetPanel.revision || 0) + 1; // PE-010: asset base replaced
    }
    // tidy the temp source
    // BGR-009 fix: mint delete grant (R1.3 gate).
    try { if (window.FbIntent) { const dg = (window.GrantHelper) ? await window.GrantHelper.ensureDelete(tmpPath) : undefined; await window.FbIntent.del(tmpPath, dg); } } catch (_) {} // B-007 (hhhhu3 audit): delete via native confirmation
    return r; // PE-009: stats (holesFilled/maskShare) for the caller's toast
    } catch (e) {
      // R5.2 Heal: cancel-cleanup. If we pushed the pre-snapshot
      // but the reloadBaseFromPath or any subsequent step threw,
      // the undo stack has an entry that doesn't correspond to an
      // actual heal — pop it so the user doesn't have to undo
      // twice. Wrapped in try/catch defensive (per R5.2 Transform
      // .AuditFix P-R52T-F1 pattern).
      if (pushedPreSnapshot) {
        try {
          if (s && Array.isArray(s._undo) && s._undo.length) {
            s._undo.pop();
          }
        } catch (_) { /* defensive: malformed _undo shouldn't crash the catch */ }
        pushedPreSnapshot = false;
      }
      ctrl._commitHandle = null; // PE-010: clear commit routing on failure
      // PE-026: tidy temps on failure too (best-effort).
      try {
        if (window.FbIntent) {
          // BGR-009 fix: mint delete grant (R1.3 gate).
          // B-007 (hhhhu3 audit): delete via native confirmation (window.FbIntent).
          if (typeof tmpPath === 'string') { const dg = (window.GrantHelper) ? await window.GrantHelper.ensureDelete(tmpPath) : undefined; await window.FbIntent.del(tmpPath, dg); }
          // P5 (DA-M-005): also remove the healed output if it was written
          // before the failure — a reload throw must not orphan it on disk.
          if (typeof healOutPath === 'string' && healOutPath !== tmpPath) { const dg2 = (window.GrantHelper) ? await window.GrantHelper.ensureDelete(healOutPath) : undefined; await window.FbIntent.del(healOutPath, dg2); }
        }
      } catch (_) { /* temp cleanup is best-effort */ }
      throw e;  // re-throw so the caller can handle
    } finally { try { temp && temp.dispose(); } catch (_) {} }
  }

  // Replace the base image with the file at `outPath` (used after a heal).
  // PE-026: build the new Fabric image object FIRST, then do the atomic
  // swap (clear + add). If the decode/fabric step fails, the old canvas
  // content stays intact — the user never sees an empty editor.
  function reloadBaseFromPath(ctrl, outPath) {
    // PE-010: prefer the caller's captured commit handle so an async
    // result lands on the session that started the job — never on the
    // slot/canvas that happens to be focused now.
    const h = (ctrl && ctrl._commitHandle) ? ctrl._commitHandle : activeSession(ctrl);
    if (!h) return Promise.resolve();
    const fabric = h.session.fabric;
    return loadImageFromFile(outPath).then((img) => {
      // Build the new Fabric image BEFORE clearing the canvas.
      return fabric.Image.fromURL(img.src, { crossOrigin: 'anonymous' }).then((fImg) => {
        fImg.set({ selectable: false, evented: false, lockMovementX: true, lockMovementY: true });
        // Atomic swap: clear + add in one synchronous block.
        h.session.canvas.clear();
        h.session.canvas.add(fImg);
        h.session.canvas.sendObjectToBack(fImg);
        h.session.baseObject = fImg;
        h.session.canvas.renderAll();
        if (window.ImageEditorSource) window.ImageEditorSource.refreshObjectsList(ctrl);
      });
    });
  }

  function dirnameOf(p) {
    const norm = String(p || '').replace(/\\/g, '/');
    const slash = norm.lastIndexOf('/');
    return slash >= 0 ? norm.slice(0, slash) : '.';
  }

  window.ImageEditorHeal = {
    // openMenu is the footer 🩹 Heal button's entry point (imageEditorActions
    // onHeal). It was implemented but missing from this export object, so the
    // button always toasted "Heal module not loaded."
    openMenu,
    openPopover,
    setSelection,
    getSelection,
    ensureSelection,
    maskB64FromRect,
    reloadBaseFromPath, // H8-001: shared by the editor's Remove BG button
    dirnameOf,
  };
})();
