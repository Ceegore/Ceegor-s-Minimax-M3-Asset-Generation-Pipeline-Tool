// renderer/services/fbIntentBridge.js
// ============================================================================
// B-007 (hhhhu3 audit): confirmation bridge for destructive file-browser
// operations. Main requires a one-shot intent token for fb:rename /
// fb:delete / fb:move; the token is minted by fb:confirmDestructive, which
// authorizes the grant, canonicalizes the paths through the grant service,
// binds the current file identity, and shows the native OS dialog.
//
// Every renderer destructive call site MUST go through window.FbIntent:
//
//   const r = await window.FbIntent.del(path, grantId);
//   const r = await window.FbIntent.rename(path, newName, grantId);
//   const r = await window.FbIntent.move(src, destDir, srcGrant, destGrant);
//
// Each returns the mutation envelope ({ok:true,...} / {ok:false,error}).
// A user cancel returns { ok: false, canceled: true } — callers should
// treat that as a quiet no-op, not an error.
// ============================================================================
(function () {
  'use strict';

  // Minimal renderer-side path shim (the sandboxed renderer has no node
  // path module). Mirrors the pipelineFileOps.js shim.
  const path = {
    sep(p) { return String(p).includes('\\') ? '\\' : '/'; },
    dirname(p) { const s = path.sep(p); return String(p).split(s).slice(0, -1).join(s); },
    basename(p) { const s = path.sep(p); return String(p).split(s).pop() || ''; },
    join(dir, name) {
      const s = path.sep(dir);
      const d = String(dir).replace(/[\\/]+$/, '');
      return d ? d + s + name : String(name);
    },
  };

  /**
   * Call fb:confirmDestructive and return its envelope.
   * @param {{operation:string, sourcePath:string, destinationPath?:string,
   *          sourceGrantId:string, destinationGrantId?:string}} spec
   * @returns {Promise<{ok:true, intentId:string} | {ok:false, canceled?:true, error?:string}>}
   */
  async function requestIntent(spec) {
    if (!window.api || typeof window.api.fbConfirmDestructive !== 'function') {
      return { ok: false, error: 'fbConfirmDestructive is not available.' };
    }
    try {
      return await window.api.fbConfirmDestructive(spec);
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  /**
   * Confirm + rename. The destination (parent + newName) is included in
   * the confirmation so Main can authorize it before prompting and bind
   * the exact target into the one-shot token.
   * @returns {Promise<object>} the fb:rename envelope (or canceled envelope)
   */
  async function rename(p, newName, grantId) {
    const destinationPath = path.join(path.dirname(p), newName);
    const c = await requestIntent({
      operation: 'rename',
      sourcePath: p,
      destinationPath,
      sourceGrantId: grantId,
    });
    if (!c || c.ok !== true) return c || { ok: false, error: 'confirmation failed' };
    return window.api.fbRename(p, newName, grantId, c.intentId);
  }

  /**
   * Confirm + delete.
   * @returns {Promise<object>} the fb:delete envelope (or canceled envelope)
   */
  async function del(p, grantId) {
    const c = await requestIntent({ operation: 'delete', sourcePath: p, sourceGrantId: grantId });
    if (!c || c.ok !== true) return c || { ok: false, error: 'confirmation failed' };
    return window.api.fbDelete(p, grantId, c.intentId);
  }

  /**
   * Confirm + move. The destination is destDir + basename(src), matching
   * the path Main computes and binds into the token.
   * @returns {Promise<object>} the fb:move envelope (or canceled envelope)
   */
  async function move(src, destDir, grantId, destGrantId) {
    const destinationPath = path.join(destDir, path.basename(src));
    const c = await requestIntent({
      operation: 'move',
      sourcePath: src,
      destinationPath,
      sourceGrantId: grantId,
      destinationGrantId: destGrantId || grantId,
    });
    if (!c || c.ok !== true) return c || { ok: false, error: 'confirmation failed' };
    return window.api.fbMove(src, destDir, grantId, destGrantId, c.intentId);
  }

  /** True for envelopes produced by the user pressing Cancel. */
  function isCanceled(r) { return !!(r && r.ok === false && r.canceled === true); }

  window.FbIntent = { confirm: requestIntent, rename, del, move, isCanceled, path };
})();
