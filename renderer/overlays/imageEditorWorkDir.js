// renderer/overlays/imageEditorWorkDir.js
// Dedicated work directory allocator for Image Editor temporary files (EFH-010).
// Creates transient files under <output_dir>/image/.editor-work/<session-id>/
// using least-privilege directory grants without side-effects on file browser state.

(function () {
  'use strict';

  const _activeGrants = new Map();
  let _cleaned = false;

  // EFH2-007c fix: clear stale grants (e.g. on config change or grant failure).
  function clearGrants() { _activeGrants.clear(); }

  async function ensureEditorWorkDir(sessionKey) {
    sessionKey = String(sessionKey || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
    const configOut = (window.state && window.state.config && window.state.config.output_dir)
      ? window.state.config.output_dir
      : (window.api && typeof window.api.defaultOutputDir === 'function' ? await window.api.defaultOutputDir() : 'output');

    const baseDir = configOut.replace(/\\/g, '/').replace(/\/+$/, '') + '/image/.editor-work/' + sessionKey;

    if (_activeGrants.has(baseDir)) {
      return { dir: baseDir, grantId: _activeGrants.get(baseDir) };
    }

    const grantId = (window.GrantHelper) ? await window.GrantHelper.ensureDir(baseDir) : undefined;
    if (window.api && typeof window.api.fbEnsureDir === 'function') {
      const r = await window.api.fbEnsureDir(baseDir, grantId);
      // EFH2-007c fix: if the dir creation fails, don't cache a stale grant.
      if (!r || !r.ok) { _activeGrants.delete(baseDir); return { dir: baseDir, grantId }; }
    }
    _activeGrants.set(baseDir, grantId);
    // EFH2-007b fix: lazily clean up stale work dirs on first use.
    if (!_cleaned) { _cleaned = true; cleanupStaleWorkDirs(configOut); }
    return { dir: baseDir, grantId };
  }

  async function getWorkFilePath(sessionKey, prefix, ext) {
    const { dir, grantId } = await ensureEditorWorkDir(sessionKey);
    const filename = (prefix || '.ie_work_') + Date.now() + '_' + Math.random().toString(36).slice(2, 6) + (ext || '.png');
    const fullPath = dir + '/' + filename;
    const pathGrant = (window.GrantCache && typeof window.GrantCache.ensurePathGrant === 'function')
      ? await window.GrantCache.ensurePathGrant(fullPath, 'write', { kind: 'file', capabilities: ['read', 'write', 'delete'] })
      : grantId;
    return { path: fullPath, grantId: pathGrant || grantId };
  }

  // EFH2-007b fix: age-based cleanup of abandoned session dirs at first use.
  // Removes .editor-work/ subdirectories older than 24 hours.
  // KGO-010 fix: use fbList (which exists) instead of the non-existent
  // fbReaddir/fbStat/fbDeleteDir. fbList returns { ok, items: [{ name, path, isDir, mtimeMs }] }
  // and fbDelete can remove directories recursively.
  async function cleanupStaleWorkDirs(configOut) {
    try {
      const base = configOut.replace(/\\/g, '/').replace(/\/+$/, '') + '/image/.editor-work';
      if (!window.api) return;
      const _g = (window.GrantHelper && window.GrantHelper.ensureDirList) ? await window.GrantHelper.ensureDirList(base) : undefined;
      // M-012 (hhhhu3 audit): paginated listing drain.
      const listing = (_g && _g.ok === false) ? _g : await window.FbListPaged.drain(base, _g);
      if (!listing || !listing.ok || !Array.isArray(listing.items)) return;
      const cutoff = Date.now() - 24 * 60 * 60 * 1000; // 24h ago
      // QA-010 fix: never delete directories that are currently active.
      const activeKeys = Array.from(_activeGrants.keys());
      for (const entry of listing.items) {
        if (!entry.isDir) continue;
        if (activeKeys.some((k) => k.endsWith('/' + entry.name))) continue;
        if (entry.mtimeMs && entry.mtimeMs < cutoff) {
          const delGrant = (window.GrantHelper) ? await window.GrantHelper.ensureDelete(entry.path) : undefined;
          // B-007 (hhhhu3 audit): delete via native confirmation (window.FbIntent).
          if (window.FbIntent) await window.FbIntent.del(entry.path, delGrant).catch(() => {});
        }
      }
    } catch (_) { /* best-effort cleanup */ }
  }

  window.ImageEditorWorkDir = {
    ensureEditorWorkDir,
    getWorkFilePath,
    clearGrants,
  };
})();
