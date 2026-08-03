// renderer/pipeline/pipelineFileOps.js
// P3.5 (DA-H-010): file-placement helpers (copy-first / validate / swap-last)
// extracted from pipelineOps.js so it stays inside its frozen size budget
// (scripts/lint.js SIZE_BUDGETS ratchet). Must load BEFORE pipelineOps.js,
// which destructures window.PipelineFileOps at module load.
(function () {
  const path = {
    sep(p) { return (String(p).includes('\\')) ? '\\' : '/'; },
    // KGO-021 fix: return '' (not '.') for a separator-less input so callers
    // like ensureDirFor/fbEnsureDir fail loudly instead of resolving to CWD.
    dirname(p) { const s = path.sep(p); return String(p).split(s).slice(0, -1).join(s); },
    basename(p) { const s = path.sep(p); return String(p).split(s).pop() || ''; },
    join(...parts) { const s = path.sep(parts[0] || ''); return parts.map((x, i) => i > 0 ? String(x).replace(/^[\\/]+/, '') : String(x).replace(/[\\/]+$/, '')).filter(Boolean).join(s); },
  };

  // Ensure dst's parent folder exists before handing the path to a writer
  // that does NOT create directories (the sharp resize/optimize IPCs, the
  // Real-ESRGAN and IS-Net binaries). Without this, the first real op into a
  // fresh column folder failed with ENOENT — the no-op copy paths go through
  // copyFileIntoPlace (which ensures the folder), masking the gap.
  async function ensureDirFor(dst) {
    // BGR-009 fix: mint mkdir grant for fbEnsureDir (R1.3 gate).
    const dirGrant = (window.GrantHelper) ? await window.GrantHelper.ensureDir(path.dirname(dst)) : undefined;
    const r = await window.api.fbEnsureDir(path.dirname(dst), dirGrant);
    if (!r || !r.ok) throw new Error('Could not create destination folder: ' + ((r && r.error) || 'unknown'));
  }

  // Copy src to dst (which may be in a different folder), creating the dst
  // folder if needed. fbCopy copies into a DIRECTORY and auto-renames on
  // collision (returning the actual destination in c.path), so use that path
  // as the rename source rather than assuming the source basename.
  const same = (a, b) => String(a || '').replace(/[\\/]+/g, '\\').toLowerCase() === String(b || '').replace(/[\\/]+/g, '\\').toLowerCase(); // R7: NTFS is case-insensitive — treat a case-only difference as the SAME file (else a case-only rename deletes the source / renames a file onto itself).
  async function copyFileIntoPlace(src, dst) {
    if (same(src, dst)) return;
    const dstDir = path.dirname(dst);
    // BGR-009 fix: mint grants for fbEnsureDir/fbCopy/fbRename (R1.3 gate).
    const dirGrant = (window.GrantHelper) ? await window.GrantHelper.ensureDir(dstDir) : undefined;
    const r = await window.api.fbEnsureDir(dstDir, dirGrant);
    if (!r || !r.ok) throw new Error('Could not create destination folder: ' + (r && r.error));
    // P3.5 (DA-H-010): copy FIRST (fbCopy auto-renames on collision, so an
    // existing dst is never overwritten mid-copy), VALIDATE the copy landed,
    // and only THEN remove the old dst + rename into place. Pre-fix the old
    // dst was deleted before the copy — a failed copy destroyed the previous
    // output with nothing to replace it.
    // gewv2 GEW-002 fix: ensureCopy returns { ok, srcGrant, destGrant }.
    const cp = (window.GrantHelper) ? await window.GrantHelper.ensureCopy(src, dstDir) : undefined;
    const c = await window.api.fbCopy(src, dstDir, cp && cp.srcGrant, cp && cp.destGrant);
    if (!c || !c.ok) throw new Error('Copy failed: ' + ((c && c.error) || 'unknown'));
    const copiedAs = (c.path && typeof c.path === 'string') ? c.path : path.join(dstDir, path.basename(src));
    if (same(copiedAs, dst)) return; // landed directly on the final path
    // Validate the staged copy actually exists before touching the old dst.
    if (window.api.fbExists) {
      try {
        const vg = (window.GrantHelper) ? await window.GrantHelper.ensureRead(copiedAs) : undefined;
        const v = await window.api.fbExists(copiedAs, vg);
        if (!v || !v.exists) throw new Error('Copy validation failed: staged file missing.');
      } catch (e) {
        if (e && /validation/.test(String(e.message))) throw e;
        // existence check itself unavailable — proceed (fbCopy reported ok)
      }
    }
    try {
      await removeExistingOutput(dst, copiedAs);
      const renameGrant = (window.GrantHelper) ? await window.GrantHelper.ensureRename(copiedAs) : undefined;
      // B-007 (hhhhu3 audit): rename needs a one-shot intent token minted
      // by the native confirmation (window.FbIntent).
      const rn = await window.FbIntent.rename(copiedAs, path.basename(dst), renameGrant);
      if (!rn || !rn.ok) throw new Error('Rename failed: ' + ((rn && (rn.canceled ? 'canceled by user' : rn.error)) || 'unknown'));
    } catch (e) {
      // Swap failed — tidy the staged copy so no stray temp accumulates.
      try {
        const dg = (window.GrantHelper) ? await window.GrantHelper.ensureDelete(copiedAs) : undefined;
        if (!dg || dg.ok !== false) window.FbIntent.del(copiedAs, dg).catch(() => {});
      } catch (_) { /* best-effort */ }
      throw e;
    }
  }

  async function moveFileIntoPlace(src, dst) {
    const dstDir = path.dirname(dst);
    const dstName = path.basename(dst);
    await ensureDirFor(dst);
    // Replace a previous deterministic result so Back → Run is repeatable.
    // fb:move auto-renames on collision, while fb:rename correctly rejects a
    // collision; remove the old canonical output before placing the new one.
    await removeExistingOutput(dst, src);
    // BGR-009 fix: mint move grant (R1.3 gate).
    // gewv2 GEW-002 fix: ensureMove returns { ok, srcGrant, destGrant }.
    const mv = (window.GrantHelper) ? await window.GrantHelper.ensureMove(src, dstDir) : undefined;
    // B-007 (hhhhu3 audit): move needs a one-shot intent token minted by
    // the native confirmation (window.FbIntent).
    const r = await window.FbIntent.move(src, dstDir, mv && mv.srcGrant, mv && mv.destGrant);
    if (!r || !r.ok) throw new Error((r && (r.canceled ? 'Move canceled by user' : r.error)) || 'Failed to move file');
    const movedAs = r.path || path.join(dstDir, path.basename(src));
    if (!same(movedAs, dst)) {
      const renameGrant = (window.GrantHelper) ? await window.GrantHelper.ensureRename(movedAs) : undefined;
      const rn = await window.FbIntent.rename(movedAs, dstName, renameGrant);
      if (!rn || !rn.ok) throw new Error((rn && (rn.canceled ? 'Rename canceled by user' : rn.error)) || 'Rename failed');
    }
  }

  async function removeExistingOutput(dst, src) {
    if (!window.api.fbExists) return;
    // BGR-009 fix: mint read+delete grants (R1.3 gate).
    const existsGrant = (window.GrantHelper) ? await window.GrantHelper.ensureRead(dst) : undefined;
    const exists = await window.api.fbExists(dst, existsGrant).catch(() => null);
    if (!exists || !exists.exists || same(src, dst)) return;
    const deleteGrant = (window.GrantHelper) ? await window.GrantHelper.ensureDelete(dst) : undefined;
    // B-007 (hhhhu3 audit): delete needs a one-shot intent token minted
    // by the native confirmation (window.FbIntent).
    const deleted = await window.FbIntent.del(dst, deleteGrant);
    if (!deleted || !deleted.ok) throw new Error((deleted && (deleted.canceled ? 'Replace canceled by user' : deleted.error)) || 'Failed to replace existing output');
  }

  window.PipelineFileOps = { same, ensureDirFor, copyFileIntoPlace, moveFileIntoPlace, removeExistingOutput, path };
})();
