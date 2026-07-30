// main/ipc/registerPipelineIpc.js
// Main-process handlers for the column-based image Pipeline. These do the
// on-disk work the renderer can't (cross-volume copies, atomic moves,
// thumbnail generation via Sharp). All destination paths are validated
// against the path-security allow-list.
//
// P0-D (360° Audit C-006, C-007): SOURCE paths on import now require a
// Main-minted read grant per file. A compromised renderer can no longer
// read arbitrary files by passing their paths to pipeline:import.
// pipeline:thumb requires the source to be a registered workspace item.
//
// R1.4 (S1 §4 "Pipeline und State"): the per-call `workspace` STRING is
// no longer accepted as an authority. Handlers now require a Main-minted
// `workspaceId` and resolve it through WorkspaceService. A renderer-
// supplied `workspace` path is IGNORED (a compromised renderer cannot
// steer pipeline writes to an arbitrary directory by passing a path).
// The canonical workspace root is Main-derived; a missing/unknown
// workspaceId returns reauthorizationRequired so the renderer can
// re-prompt via the native folder flow.
//
// Registered from main/index.js alongside the other domain registrars.

const { ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// P0-D (360° Audit C-006): grant-based read authorisation for source files.
const { authorizePath: _authorizePath } = require('./grantAuthorizer');
// P1-A (360° Audit H-001): secure IPC wrapper with sender/frame/origin validation.
const { secureHandle } = require('./secureHandle');

function register(deps) {
  const { appRoot, getMainWindow } = deps;
  const pathSecurity = require('../services/PathSecurityService');
  const pathUtils = require('../../src/pathUtils');
  const cfgMod = require('../../src/config');
  const model = require('../../src/pipeline/pipelineModel');
  const { defaultService: workspaceService } = require('../services/WorkspaceService');

  // Fallback workspace root when no workspaceId is provided: the Main-
  // registered Config output_dir. This is the canonical "app-output"
  // workspace. Minting a one-shot id for it lets us keep the
  // workspaceId-only contract while still working in a fresh session
  // that hasn't yet been re-prompted for a custom workspace.
  function appOutputRoot() {
    return path.join(cfgMod.effectiveOutputDir(cfgMod.read()), 'pipeline', 'image');
  }

  /**
   * Resolve the workspace for a pipeline call. Accepts ONLY a
   * `workspaceId` from the renderer; the legacy `workspace` STRING
   * is ignored. If no workspaceId is provided, the call falls back
   * to the Main-derived app-output root (auto-minting a workspaceId
   * for it so the resolver stays consistent). If a workspaceId is
   * provided but does not resolve, returns {ok:false,
   * reauthorizationRequired:true} so the renderer can re-prompt.
   *
   * @param {{workspaceId?: string, workspace?: string}} payload
   * @returns {{ok:true, ws:string} | {ok:false, error:string, reauthorizationRequired?:boolean}}
   */
  function resolveWorkspace(payload) {
    if (payload && typeof payload.workspaceId === 'string' && payload.workspaceId) {
      const canonical = workspaceService.resolve(payload.workspaceId);
      if (canonical == null) {
        return { ok: false, error: 'workspaceId is unknown or its folder no longer exists', reauthorizationRequired: true };
      }
      return { ok: true, ws: canonical };
    }
    // No workspaceId: fall back to the Main-derived app-output
    // workspace. Mint a one-shot id for it (idempotent so a second
    // call in the same session returns the same id).
    const root = appOutputRoot();
    try { fs.mkdirSync(root, { recursive: true }); } catch (_) { /* may already exist */ }
    const m = workspaceService.mint({
      origin: 'app-output',
      purpose: 'pipeline fall-back workspace',
      path: root,
    });
    if (!m.ok) {
      return { ok: false, error: 'app-output workspace mint failed: ' + m.error };
    }
    return { ok: true, ws: m.workspace.canonicalPath };
  }

  // Gate a destination path against the allow-list. Returns true if safe.
  // For R1.4, the destination is ALWAYS Main-derived (the workspace root
  // is resolved through WorkspaceService and the imageId is sanitised),
  // so this is a sanity check, not the load-bearing security gate.
  function dstOk(p) {
    return typeof p === 'string' && !!p && pathUtils.isPathUnderAny(p, pathSecurity.getAllowedRoots());
  }

  // ---- pipeline:mintWorkspace ----
  // QA-001 fix: allow the renderer to mint a workspaceId for a user-chosen
  // pipeline folder. The path is validated against the allow-list so a
  // compromised renderer cannot mint arbitrary directories.
  secureHandle('pipeline:mintWorkspace', { getMainWindow }, async (_e, payload) => {
    const p = payload && typeof payload.path === 'string' ? payload.path : null;
    if (!p) return { ok: false, error: 'path required' };
    if (!dstOk(p)) return { ok: false, error: 'path is not under an allowed root' };
    try { fs.mkdirSync(p, { recursive: true }); } catch (_) { /* may already exist */ }
    const m = workspaceService.mint({ origin: 'renderer', purpose: 'pipeline custom workspace', path: p });
    if (!m.ok) return { ok: false, error: m.error };
    return { ok: true, workspaceId: m.id, canonicalPath: m.workspace.canonicalPath };
  });

  // ---- pipeline:import ----
  // Copy (NOT move — the user's source files are precious) one or more files
  // from arbitrary OS locations into the workspace's "original" (or chosen)
  // column folder, with the img_<id>_<name> naming. Source paths are reads;
  // destination paths are gated. Returns [{ ok, src, dst, error? }] per item.
  //
  // R1.4: the per-call `workspace` STRING is ignored. A `workspaceId` is
  // accepted (resolved through WorkspaceService); if neither is given,
  // the Main-derived app-output root is used.
  secureHandle('pipeline:import', { getMainWindow }, async (_e, payload) => {
    const items = payload && Array.isArray(payload.items) ? payload.items : [];
    const wsRes = resolveWorkspace(payload);
    if (!wsRes.ok) {
      // R3: envelope compliance — the workspace-failure path previously returned
      // a bare { results } with no top-level ok. Add ok:false + error so the
      // envelope convention ({ok:true,…}|{ok:false,error}) holds; the per-item
      // results are preserved for the renderer's existing r.results handling.
      return { ok: false, error: wsRes.error, reauthorizationRequired: !!wsRes.reauthorizationRequired, results: items.map((it) => ({ ok: false, src: it && it.srcAbsPath, error: wsRes.error, reauthorizationRequired: !!wsRes.reauthorizationRequired })) };
    }
    const ws = wsRes.ws;
    const results = [];
    for (const it of items) {
      try {
        if (!it || typeof it.srcAbsPath !== 'string' || !it.srcAbsPath) {
          results.push({ ok: false, error: 'Invalid source path.' });
          continue;
        }
        // P0-D (360° Audit C-006): require a read grant for each source file.
        // The renderer must mint a grant via pathGrant:mint before calling
        // pipeline:import. Without a valid grant, the read is rejected.
        const readGrantId = it.readGrantId || payload.readGrantId;
        const readAuthz = _authorizePath(readGrantId, 'read', it.srcAbsPath);
        if (!readAuthz.ok) {
          results.push({ ok: false, src: it.srcAbsPath, error: 'Read grant required: ' + readAuthz.error });
          continue;
        }
        const column = model.STORAGE_COLUMNS.includes(it.destColumn) ? it.destColumn : 'original';
        // Validate a caller-supplied imageId charset (no path separators) so a
        // hostile/buggy payload can't create nested subdirs under the column.
        const id = (typeof it.imageId === 'string' && /^[^\\/]+$/.test(it.imageId)) ? it.imageId : model.newItemId();
        const name = it.displayName || path.basename(it.srcAbsPath);
        const dstDir = path.join(ws, column);
        const dst = model.outPath(ws, id, name, column, { ext: path.extname(it.srcAbsPath).slice(1) || undefined });
        if (!dstOk(dst)) {
          results.push({ ok: false, src: it.srcAbsPath, error: 'Destination is outside the allowed directories.' });
          continue;
        }
        try { fs.mkdirSync(dstDir, { recursive: true }); } catch (_) { /* may already exist */ }
        // P5 (M-014): COPYFILE_EXCL prevents silent overwrite. If the
        // destination exists, retry with a UUID suffix.
        let finalDst = dst;
        try {
          await fs.promises.copyFile(it.srcAbsPath, finalDst, fs.constants.COPYFILE_EXCL);
        } catch (copyErr) {
          if (copyErr.code === 'EEXIST') {
            const ext = path.extname(dst);
            const base = dst.slice(0, dst.length - ext.length);
            finalDst = base + '_' + crypto.randomUUID() + ext;
            await fs.promises.copyFile(it.srcAbsPath, finalDst, fs.constants.COPYFILE_EXCL);
          } else {
            throw copyErr;
          }
        }
        results.push({ ok: true, src: it.srcAbsPath, dst: finalDst, imageId: id });
      } catch (e) {
        results.push({ ok: false, src: it && it.srcAbsPath, error: String((e && e.message) || e) });
      }
    }
    return { ok: true, results };
  });

  // ---- pipeline:replace ----
  // Replace a card's current file with one chosen from disc (the GIMP
  // round-trip). Copies the chosen file into the column folder with a
  // _replaceN infix so an existing file is never silently overwritten.
  secureHandle('pipeline:replace', { getMainWindow }, async (_e, payload) => {
    try {
      if (!payload || typeof payload.srcAbsPath !== 'string' || !payload.srcAbsPath) {
        return { ok: false, error: 'Source path is required.' };
      }
      // Validate imageId charset (no path separators) so a hostile payload can't
      // create arbitrary nested subdirs under the column folder.
      const id = (typeof payload.imageId === 'string' && /^[^\\/]+$/.test(payload.imageId)) ? payload.imageId : model.newItemId();
      const wsRes = resolveWorkspace(payload);
      if (!wsRes.ok) {
        return { ok: false, error: wsRes.error, reauthorizationRequired: !!wsRes.reauthorizationRequired };
      }
      const ws = wsRes.ws;
      const column = model.STORAGE_COLUMNS.includes(payload.column) ? payload.column : 'original';
      const name = payload.displayName || path.basename(payload.srcAbsPath);
      const ext = path.extname(payload.srcAbsPath).slice(1) || undefined;
      // Validate the destination directory up front so the existsSync
      // loop doesn't spin for paths that dstOk would reject anyway.
      const probeDst = model.outPath(ws, id, name, column, { ext, replaceN: 1 });
      if (!dstOk(probeDst)) return { ok: false, error: 'Destination is outside the allowed directories.' };
      await fs.promises.mkdir(path.dirname(probeDst), { recursive: true }).catch(() => {});
      // Find the next free _replaceN suffix with a hard cap (DoS guard), and use
      // COPYFILE_EXCL for an atomic create — two concurrent replaces that both
      // see existsSync=false would otherwise both copyFile to the same path and
      // the second silently overwrites the first (TOCTOU).
      let n = 0;
      let dst = null;
      while (n < 9999) {
        n += 1;
        const candidate = model.outPath(ws, id, name, column, { ext, replaceN: n });
        try {
          await fs.promises.copyFile(payload.srcAbsPath, candidate, fs.constants.COPYFILE_EXCL);
          dst = candidate;
          break;
        } catch (e) {
          if (e && e.code === 'EEXIST') continue; // try next suffix
          throw e; // real error (ENOENT/EACCES/etc.)
        }
      }
      if (!dst) return { ok: false, error: 'Too many replace collisions (9999).' };
      return { ok: true, dst };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  // ---- pipeline:trash ----
  // Soft-delete: move a card's files into <workspace>/.trash/<imageId>/ for the
  // session-undo. Best-effort (a missing source is skipped, not fatal). The
  // renderer purges .trash on board close.
  secureHandle('pipeline:trash', { getMainWindow }, async (_e, payload) => {
    try {
      if (!payload || typeof payload.imageId !== 'string' || !/^[^\\/]+$/.test(payload.imageId)) {
        return { ok: false, error: 'A valid imageId is required.' };
      }
      const wsRes = resolveWorkspace(payload);
      if (!wsRes.ok) {
        return { ok: false, error: wsRes.error, reauthorizationRequired: !!wsRes.reauthorizationRequired };
      }
      const ws = wsRes.ws;
      const trashDir = path.join(ws, '.trash', payload.imageId);
      if (!dstOk(trashDir)) return { ok: false, error: 'Trash dir is outside the allowed directories.' };
      const files = Array.isArray(payload.files) ? payload.files : [];
      const moved = [];
      const failed = [];
      await fs.promises.mkdir(trashDir, { recursive: true }).catch(() => {});
      // De-dup basenames: two source files in different column folders can share
      // a basename (img_x_hero.png in original/ and upscale/). Append a counter
      // so the second doesn't overwrite the first in the trash bin.
      const usedNames = new Set();
      for (const f of files) {
        if (typeof f !== 'string' || !f || !dstOk(f)) {
          // P3.5 (DA-H-007): report (not silently skip) invalid entries; they
          // block success so the renderer never drops a card whose files
          // were not actually trashed.
          failed.push({ from: String(f || ''), error: 'invalid path', blocking: true });
          continue;
        }
        // P3.5 (DA-H-007): workspace membership — pipeline:trash may only move
        // files that live INSIDE the resolved workspace. The workspaceId (minted
        // via the native folder picker) is the move authorization; a path
        // outside the workspace is rejected, never moved.
        const rel = path.relative(ws, f);
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
          failed.push({ from: f, error: 'outside workspace', blocking: true });
          continue;
        }
        let base = path.basename(f);
        let dstName = base;
        let c = 0;
        while (usedNames.has(dstName)) { c += 1; dstName = `${base}.${c}`; }
        usedNames.add(dstName);
        const dst = path.join(trashDir, dstName);
        try {
          let okMove = false;
          try {
            await fs.promises.rename(f, dst);
            okMove = true;
          } catch (_) {
            // cross-volume rename fails → copy then delete. Only delete the
            // source AFTER the copy succeeds (the prior code unlinked
            // unconditionally, deleting the file even when the copy failed).
            try {
              await fs.promises.copyFile(f, dst);
              await fs.promises.unlink(f);
              okMove = true;
            } catch (e2) {
              // copy failed — DO NOT delete the source. Report failure.
            }
          }
          if (okMove) moved.push({ from: f, to: dst });
          // P3.5 (DA-H-009): a failure only blocks success when the source
          // still exists on disk (locked file etc.). An already-missing
          // source stays best-effort — there is nothing left to lose.
          else failed.push({ from: f, error: 'move/copy failed', blocking: fs.existsSync(f) });
        } catch (_) { failed.push({ from: f, error: 'exception', blocking: fs.existsSync(f) }); }
      }
      // KGO2-021 fix: prune cached thumbnails in .thumbs for moved files
      try {
        const thumbsDir = path.join(ws, '.thumbs');
        if (fs.existsSync(thumbsDir)) {
          for (const m of moved) {
            try {
              const stat = fs.statSync(m.to);
              const key = crypto.createHash('sha1').update(`${m.from}:${stat.size}:${stat.mtimeMs}`).digest('hex').slice(0, 24);
              const thumbFile = path.join(thumbsDir, `${key}.webp`);
              if (fs.existsSync(thumbFile)) await fs.promises.unlink(thumbFile).catch(() => {});
            } catch (_) {}
          }
        }
      } catch (_) {}
      // P3.5 (DA-H-009): partial trash is NOT a success — any blocking failure
      // (source still on disk) flips ok:false so the renderer keeps the card
      // instead of stranding untracked files in the workspace.
      const blocked = failed.some((x) => x.blocking);
      if (blocked) {
        return { ok: false, moved, failed, error: failed.filter((x) => x.blocking).length + ' file(s) could not be trashed.' };
      }
      return { ok: true, moved, failed };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  // ---- pipeline:thumb ----
  // Generate (or return) a cached thumbnail for a source image, resized to
  // ~320px wide via Sharp and stored as webp under <workspace>/.thumbs/. The
  // cache key is sha1(srcPath) so a changed file (Replace/Run) gets a fresh
  // thumb automatically. Lazily requires sharp so the handler doesn't crash
  // startup if sharp is somehow missing.
  secureHandle('pipeline:thumb', { getMainWindow }, async (_e, payload) => {
    try {
      if (!payload || typeof payload.srcPath !== 'string' || !payload.srcPath) {
        return { ok: false, error: 'srcPath required.' };
      }
      const wsRes = resolveWorkspace(payload);
      if (!wsRes.ok) {
        return { ok: false, error: wsRes.error, reauthorizationRequired: !!wsRes.reauthorizationRequired };
      }
      const ws = wsRes.ws;
      // P0-D (360° Audit C-007): the source file must be a registered
      // workspace item (i.e. its path is under the workspace root) OR
      // the caller provides a valid read grant. This prevents a
      // compromised renderer from thumbnailing arbitrary OS files.
      const srcResolved = path.resolve(payload.srcPath);
      const isUnderWorkspace = srcResolved.startsWith(ws + path.sep) || srcResolved === ws;
      if (!isUnderWorkspace) {
        const readGrantId = payload.readGrantId;
        const readAuthz = _authorizePath(readGrantId, 'read', srcResolved);
        if (!readAuthz.ok) {
          return { ok: false, error: 'Source is not a workspace item and no valid read grant provided: ' + readAuthz.error };
        }
      }
      const thumbsDir = path.join(ws, '.thumbs');
      if (!dstOk(thumbsDir)) return { ok: false, error: 'Thumbs dir is outside the allowed directories.' };
      await fs.promises.mkdir(thumbsDir, { recursive: true }).catch(() => {});
      // Content-sensitive cache keys intentionally create a new thumbnail
      // when a pipeline result is replaced. Keep that cache bounded.
      const oldThumbs = await fs.promises.readdir(thumbsDir, { withFileTypes: true }).catch(() => []);
      if (oldThumbs.length > 500) {
        const dated = await Promise.all(oldThumbs.filter((e) => e.isFile() && e.name.endsWith('.webp')).map(async (e) => {
          const p = path.join(thumbsDir, e.name);
          const stat = await fs.promises.stat(p).catch(() => null);
          return stat ? { p, mtimeMs: stat.mtimeMs } : null;
        }));
        await Promise.all(dated.filter(Boolean).sort((a, b) => a.mtimeMs - b.mtimeMs).slice(0, -500)
          .map((entry) => fs.promises.unlink(entry.p).catch(() => {})));
      }
      let mtimeMs = 0;
      let size = 0;
      try {
        const stat = fs.statSync(payload.srcPath);
        mtimeMs = stat.mtimeMs;
        size = stat.size;
      } catch (_) {}
      // DoS/OOM guard: refuse to buffer absurdly large sources into the main
      // process (a multi-GB "image" would OOM Electron). The renderer already
      // falls back to the raw file:// URL when ok is falsy.
      const MAX_THUMB_SOURCE = 256 * 1024 * 1024; // 256 MB
      if (size > MAX_THUMB_SOURCE) {
        return { ok: false, error: 'Source too large for thumbnailing (' + Math.round(size / 1048576) + ' MB, cap 256 MB).' };
      }
      const key = crypto.createHash('sha1').update(`${payload.srcPath}:${size}:${mtimeMs}`).digest('hex').slice(0, 24);
      const thumbPath = path.join(thumbsDir, `${key}.webp`);
      if (fs.existsSync(thumbPath)) return { ok: true, thumbPath };
      let sharp;
      try { sharp = require('sharp'); require('../../src/cpuGuard').applySharpThreadCap(sharp); } catch (_) { return { ok: false, error: 'sharp unavailable' }; }
      // KGO-002 fix: read the source into a Buffer BEFORE passing to sharp.
      // sharp/libvips holds a file handle open on webp files when given a path,
      // making them unrenameable/undeletable for the process lifetime (EBUSY).
      // Reading into a Buffer first avoids the path-based mmap lock.
      const srcBuf = await fs.promises.readFile(payload.srcPath);
      // Write to a temp file then atomically rename, so a partial/truncated
      // webp (from a corrupt source, OOM, or process kill mid-write) is never
      // served from the cache — sharp's toFile could otherwise leave a partial
      // file at thumbPath that subsequent calls would return.
      const tmpPath = `${thumbPath}.tmp-${crypto.randomUUID()}`;
      // P5 (M-021): cleanup temp in finally block so a partial webp is
      // never left behind on error (previously leaked on rename failure).
      try {
        await sharp(srcBuf)
          .resize({ width: 320, withoutEnlargement: true })
          .webp({ quality: 80 })
          .toFile(tmpPath);
        await fs.promises.rename(tmpPath, thumbPath);
        return { ok: true, thumbPath };
      } finally {
        // Best-effort: remove the temp if it still exists (rename failure,
        // sharp OOM, etc.). After a successful rename this is a no-op.
        try { await fs.promises.unlink(tmpPath); } catch (_) {}
      }
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
}

module.exports = { register };
