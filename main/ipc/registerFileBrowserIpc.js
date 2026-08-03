// main/ipc/registerFileBrowserIpc.js
// IPC handlers: `fb:*` (list, mkdir, rename, delete, move, copy, reveal,
// read, exists, write). R1.3: every mutating handler requires a
// grantId; the renderer must present a Main-minted grant for the
// directory it wants to mutate in. The renderer's navigation
// (`fb:list`, `fb:listDrives`, `fb:set-active-dir` as a no-op
// navigation signal) stays OS-gated and does not mint or widen
// any grant.
//
// S1 §4 File Browser rules:
//   • `fb:set-active-dir` becomes a navigation signal only. It no
//     longer widens the trust set or alters the allow-list.
//   • `fb:trust-ancestors` is removed (Up-climb no longer mints).
//   • `mkdir`, `ensureDir`, `rename`, `delete`, `move`, `copy`,
//     `write`, `image:writeBase64` each accept a `grantId`. The
//     service authorizes the path against the grant before touching
//     the filesystem.
//   • Move/copy authorize the source AND the destination
//     separately. A directory-root grant (the config-output use
//     case) covers the root; a plain directory grant covers only
//     strict descendants.
//   • A grant for a directory is never authorized for the grant
//     root itself (S1 §2.5) UNLESS the grant is `directory-root`
//     (coversRoot:true).
//   • The renderer's `fb:set-active-dir` is kept as a no-op so the
//     renderer's existing navigation code still gets an ack; the
//     mutating handlers no longer read the activeDir at all.

const { ipcMain } = require('electron');
const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const fb = require('../../src/fileBrowser');
const pathUtils = require('../../src/pathUtils');
const { authorizePath: _authorizePath } = require('./grantAuthorizer');
// P1-A (360° Audit H-001): secure IPC wrapper.
const { secureHandle } = require('./secureHandle');
// H-013 (hhhhu2 audit): native destructive-operation intent confirmation
// (fb:confirmDestructive + consumeIntent) — split into its own module.
const { registerConfirmDestructive, consumeIntent, captureIdentity } = require('./fileBrowserDestructiveIntent');
// M-014 (hhhhu2 audit): paginated directory listing handlers
// (fb:listStart / fb:listNext / fb:listClose / fb:listDrives).
const { registerListingHandlers } = require('./fileBrowserListingIpc');

const MAX_WRITE_BYTES = 25 * 1024 * 1024;

/**
 * @param {{ appRoot: string }} deps
 */
function register(deps) {
  const getMainWindow = (deps && typeof deps.getMainWindow === 'function') ? deps.getMainWindow : () => null;
  // ---- Read side: grant-gated (KGO4-009). -------------------------
  // fb:list now requires a grantId so the renderer cannot enumerate
  // arbitrary directories outside the allowed roots. The grant model
  // is consistent with fb:read / fb:write / fb:rename etc.

  secureHandle('fb:list', { getMainWindow }, async (_e, dir, grantId) => {
    if (!dir || typeof dir !== 'string') return { ok: false, error: 'Path is required.' };
    if (!grantId) return { ok: false, error: 'grantId is required for directory listing.' };
    const authz = _authorizePath(grantId, 'read', dir);
    if (!authz.ok) return authz;
    try { return { ok: true, ...(await fb.list(dir)) }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  });

  // M-014 (hhhhu2 audit): cursor-based paginated directory listing
  // (fb:listStart / fb:listNext / fb:listClose) + fb:listDrives live in
  // fileBrowserListingIpc.js.
  registerListingHandlers({ getMainWindow });

  // R1.3: `fb:set-active-dir` is now a navigation ACK only. It does
  // NOT alter any trust set, the activeDir, or any global state. The
  // renderer may still call it after navigating to a new folder so
  // the main process has the latest view (purely informational, not
  // used for authorization). A subsequent mutating call requires the
  // renderer to present a grantId — the path that the renderer is
  // showing in the UI is no longer sufficient to authorize a write.
  secureHandle('fb:set-active-dir', { getMainWindow }, (_e, _dir) => {
    return { ok: true, activeDir: null, note: 'R1.3: navigation-only; mutations require a grantId' };
  });

  // H-013 (hhhhu2 audit): Native confirmation for destructive operations.
  // The renderer calls this BEFORE fb:delete/fb:move/fb:rename. It shows a
  // native OS dialog and returns a single-use intentId bound to the exact
  // operation, paths, and sender. The subsequent mutation handler consumes
  // it (see fileBrowserDestructiveIntent.js).
  registerConfirmDestructive({ getMainWindow });

  // ---- Mutating handlers: each requires a grantId. --------------------

  // fb:mkdir creates a named child of `dir` (fb.mkdir validates
  // `name` is non-empty). Authorize a `mkdir` operation on the
  // parent directory.
  secureHandle('fb:mkdir', { getMainWindow }, async (_e, dir, name, grantId) => {
    if (typeof dir !== 'string' || typeof name !== 'string' || !dir || !name) {
      return { ok: false, error: 'dir and name are required.' };
    }
    const childPath = pathUtils.normalize(path.join(dir, name));
    if (!childPath) return { ok: false, error: 'computed child path is invalid.' };
    const authz = _authorizePath(grantId, 'mkdir', childPath);
    if (!authz.ok) return authz;
    try { return { ok: true, path: await fb.mkdir(dir, name) }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  });

  // fb:ensureDir creates `dir` itself (when missing). Authorize
  // `mkdir` on the exact path. A `directory-root` grant covers
  // the path; a plain `directory` grant does NOT (the root itself
  // is never covered per S1 §2.5).
  secureHandle('fb:ensureDir', { getMainWindow }, async (_e, dir, grantId) => {
    if (!dir || typeof dir !== 'string') return { ok: false, error: 'dir is required.' };
    const authz = _authorizePath(grantId, 'mkdir', dir);
    if (!authz.ok) return authz;
    try {
      const st = await fsp.stat(dir).catch(() => null);
      if (st && st.isDirectory()) return { ok: true, path: dir };
      if (st && !st.isDirectory()) return { ok: false, error: '"' + dir + '" exists but is not a folder.' };
      await fsp.mkdir(dir, { recursive: true });
      return { ok: true, path: dir };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  });

  // fb:rename renames `p` to `newName`. The source `p` is what the
  // grant covers; the new name is a string, not a path. The new
  // path is computed (dir of p + newName) and must still be inside
  // the grant scope.
  // H-013: requires a consumed intent token for the destructive operation.
  secureHandle('fb:rename', { getMainWindow }, async (e, p, newName, grantId, intentId) => {
    if (typeof p !== 'string' || typeof newName !== 'string' || !p || !newName) {
      return { ok: false, error: 'p and newName are required.' };
    }
    // BUG-R2-04 (validate before intent consumption): a newName with path
    // separators is a traversal attempt — reject it BEFORE the one-shot
    // intent token is consumed, so the rejection is pure validation and
    // the token stays usable for a corrected retry.
    if (/[/\\]/.test(newName) || newName === '..' || newName === '.') {
      return { ok: false, error: 'newName cannot contain path separators.' };
    }
    // The grant must authorise the source path (a write/rename op).
    const authz = _authorizePath(grantId, 'rename', p);
    if (!authz.ok) return authz;
    // The target path is the source's parent + newName.
    const dirOfP = path.dirname(p);
    const targetPath = pathUtils.normalize(path.join(dirOfP, newName));
    const targetAuthz = _authorizePath(grantId, 'write', targetPath);
    if (!targetAuthz.ok) return targetAuthz;
    // M-014 (hhhhu3 audit): canonical realpath + re-observed identity reject
    // a target swap between confirmation and execution.
    const renameIdentity = await captureIdentity(authz.canonicalPath);
    // H-013: consume the intent token.
    const renameIntentErr = consumeIntent(e, intentId, {
      operation: 'rename',
      canonicalSource: authz.canonicalPath,
      canonicalDestination: targetAuthz.canonicalPath,
      sourceGrantId: grantId,
      sourceIdentity: renameIdentity,
    });
    if (renameIntentErr) return renameIntentErr;
    try { return { ok: true, ...(await fb.rename(p, newName)) }; }
    catch (err) { return { ok: false, error: String(err.message || err) }; }
  });

  // fb:delete deletes `p`. For a directory grant, the path must be
  // a strict descendant (the grant root itself is never covered per
  // S1 §2.5). A `directory-root` grant (coversRoot:true) covers
  // the root itself.
  // H-013: requires a consumed intent token for the destructive operation.
  secureHandle('fb:delete', { getMainWindow }, async (e, p, grantId, intentId) => {
    if (typeof p !== 'string' || !p) return { ok: false, error: 'p is required.' };
    const authz = _authorizePath(grantId, 'delete', p);
    if (!authz.ok) return authz;
    // M-014 (hhhhu3 audit): canonical realpath + re-observed identity.
    const deleteIdentity = await captureIdentity(authz.canonicalPath);
    // H-013: consume the intent token.
    const deleteIntentErr = consumeIntent(e, intentId, {
      operation: 'delete',
      canonicalSource: authz.canonicalPath,
      sourceGrantId: grantId,
      sourceIdentity: deleteIdentity,
    });
    if (deleteIntentErr) return deleteIntentErr;
    try { return { ok: true, path: await fb.deletePath(p) }; }
    catch (err) { return { ok: false, error: String(err.message || err) }; }
  });

  // fb:move moves `src` into `destDir`. The source needs a `read`
  // capability (or `move` — see PathGrantService). The destination
  // needs a `write` capability. Authorize both.
  // H-013: requires a consumed intent token for the destructive operation.
  secureHandle('fb:move', { getMainWindow }, async (e, src, destDir, grantId, destGrantId, intentId) => {
    if (typeof src !== 'string' || typeof destDir !== 'string' || !src || !destDir) {
      return { ok: false, error: 'src and destDir are required.' };
    }
    const destPath = pathUtils.normalize(path.join(destDir, path.basename(src)));
    const srcAuthz = _authorizePath(grantId, 'move', src);
    if (!srcAuthz.ok) return srcAuthz;
    const destAuthz = _authorizePath(destGrantId || grantId, 'write', destPath);
    if (!destAuthz.ok) return destAuthz;
    // M-014 (hhhhu3 audit): canonical realpath + re-observed identity.
    const moveIdentity = await captureIdentity(srcAuthz.canonicalPath);
    // H-013: consume the intent token.
    const moveIntentErr = consumeIntent(e, intentId, {
      operation: 'move',
      canonicalSource: srcAuthz.canonicalPath,
      canonicalDestination: destAuthz.canonicalPath,
      sourceGrantId: grantId,
      destinationGrantId: destGrantId || grantId,
      sourceIdentity: moveIdentity,
    });
    if (moveIntentErr) return moveIntentErr;
    try { return { ok: true, ...(await fb.moveTo(src, destDir)) }; }
    catch (err) { return { ok: false, error: String(err.message || err) }; }
  });

  // fb:copy copies `src` into `destDir`. The source needs `read`
  // (or `copy`); the destination needs `write`. Authorize both.
  secureHandle('fb:copy', { getMainWindow }, async (_e, src, destDir, grantId, destGrantId) => {
    if (typeof src !== 'string' || typeof destDir !== 'string' || !src || !destDir) {
      return { ok: false, error: 'src and destDir are required.' };
    }
    const destPath = pathUtils.normalize(path.join(destDir, path.basename(src)));
    // gewv2 GEW-002 fix: same common-ancestor mint gap as fb:move — accept
    // an OPTIONAL 5th arg `destGrantId` minted separately for the
    // destination so each endpoint is authorized by its own valid grant.
    const srcAuthz = _authorizePath(grantId, 'copy', src);
    if (!srcAuthz.ok) return srcAuthz;
    const destAuthz = _authorizePath(destGrantId || grantId, 'write', destPath);
    if (!destAuthz.ok) return destAuthz;
    // R8: copyTo auto-renames on collision (writes a sibling like "file (1).png").
    // Authorising destPath is still sufficient: the renderer mints a DIRECTORY
    // grant (GrantHelper.ensureCopy — common ancestor, or destDir coversRoot),
    // which covers every descendant of destDir, so the renamed sibling is in
    // scope. No separate re-auth of the actual returned path is required.
    try { return { ok: true, path: await fb.copyTo(src, destDir) }; }
    catch (e) { return { ok: false, error: String(e.message || e) }; }
  });

  // HIGH-015: fb:reveal requires a read-grant and blocks UNC paths.
  // MED-024: pre-check existence before calling shell.showItemInFolder.
  secureHandle('fb:reveal', { getMainWindow }, async (_e, p, grantId) => {
    if (!p || typeof p !== 'string') return { ok: false, error: 'p is required.' };
    // HIGH-015: block UNC paths (\\server\share) — shell operations on
    // remote paths can leak credentials or hang on unreachable hosts.
    if (/^\\\\/.test(p)) return { ok: false, error: 'UNC paths are not allowed.' };
    const authz = _authorizePath(grantId, 'read', p);
    if (!authz.ok) return authz;
    // MED-024: pre-check existence so we report a useful error instead of
    // silently doing nothing.
    try { await fsp.access(p, fs.constants.F_OK); } catch {
      return { ok: false, error: 'File does not exist (it may have been moved or deleted).' };
    }
    const revealed = fb.reveal(p);
    if (!revealed) return { ok: false, error: 'Could not reveal the file.' };
    return { ok: true };
  });

  // HIGH-015: fb:openInExplorer requires a read-grant and blocks UNC paths.
  // MED-023: detect file vs directory — open directories directly, files via
  // their parent folder.
  secureHandle('fb:openInExplorer', { getMainWindow }, async (_e, p, grantId) => {
    if (!p || typeof p !== 'string') return { ok: false, error: 'p is required.' };
    if (/^\\\\/.test(p)) return { ok: false, error: 'UNC paths are not allowed.' };
    const authz = _authorizePath(grantId, 'read', p);
    if (!authz.ok) return authz;
    try {
      await fb.openInExplorer(p);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  });

  // fb:read reads a file's bytes into base64. The S1 §3 says
  // "Inhaltliches Lesen, Importieren, Kopieren aus einer externen
  // Quelle, Existenz-Probes und das Starten eines External Tools
  // mit einer Datei benötigen dagegen einen Read-Grant oder einen
  // privaten App-Root." So this handler IS gated, but with a
  // `read` grant rather than a `write` one.
  secureHandle('fb:read', { getMainWindow }, async (_e, p, grantId) => {
    if (!p || typeof p !== 'string') return { ok: false, error: 'p is required.' };
    const authz = _authorizePath(grantId, 'read', p);
    if (!authz.ok) return authz;
    const MAX_READ_BYTES = MAX_WRITE_BYTES;
    try {
      const st = await fs.promises.stat(p);
      if (st.size > MAX_READ_BYTES) {
        return { ok: false, error: 'File is too large to read into memory (' + st.size + ' bytes; cap is ' + MAX_READ_BYTES + '). Use a file:// URL in the renderer instead.' };
      }
      // R4 fix: pass the SAME cap into readFile. Its default is 2 MB, so a
      // 2–25 MB file passed the stat check above but then always failed inside
      // readFile with a misleading "too large to preview" error.
      const buf = await fb.readFile(p, MAX_READ_BYTES);
      return { ok: true, base64: buf.toString('base64') };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  });

  // fb:exists probes whether a path exists. Per S1 §3, "Existenz-
  // Probes" require a Read-Grant. So fb:exists IS gated.
  secureHandle('fb:exists', { getMainWindow }, async (_e, p, grantId) => {
    if (!p || typeof p !== 'string') return { ok: false, exists: false, error: 'p is required.' };
    const authz = _authorizePath(grantId, 'read', p);
    if (!authz.ok) return { ok: false, exists: false, error: authz.error };
    try {
      await fsp.access(p, fs.constants.F_OK);
      return { ok: true, exists: true };
    } catch {
      return { ok: true, exists: false };
    }
  });

  // fb:write writes base64 bytes to a file. The grant must authorise
  // the write operation on the target path. The size cap is the
  // same as the previous implementation.
  secureHandle('fb:write', { getMainWindow, maxPayloadBytes: 64 * 1024 * 1024 }, async (_e, outPath, base64Data, grantId) => {
    try {
      if (!outPath || typeof outPath !== 'string') return { ok: false, error: 'Output path is required.' };
      if (!base64Data || typeof base64Data !== 'string') return { ok: false, error: 'Base64 data is required.' };
      const outAbs = pathUtils.normalize(outPath);
      if (!outAbs) return { ok: false, error: 'Output path is invalid.' };
      const authz = _authorizePath(grantId, 'write', outAbs);
      if (!authz.ok) return authz;
      const MAX_BASE64_CHARS = Math.ceil(MAX_WRITE_BYTES * 4 / 3) + 16;
      if (base64Data.length > MAX_BASE64_CHARS) {
        return { ok: false, error: 'Refusing to write more than ' + MAX_WRITE_BYTES + ' bytes at once.' };
      }
      const buf = Buffer.from(base64Data, 'base64');
      if (buf.length > MAX_WRITE_BYTES) {
        return { ok: false, error: 'Refusing to write more than ' + MAX_WRITE_BYTES + ' bytes at once.' };
      }
      const tmp = outAbs + '.tmp-' + randomUUID();
      await fsp.writeFile(tmp, buf);
      try {
        await fsp.rename(tmp, outAbs);
      } catch (renameErr) {
        try { await fsp.unlink(tmp); } catch {}
        throw renameErr;
      }
      return { ok: true, path: outAbs };
    } catch (e) { return { ok: false, error: String(e.message || e) }; }
  });
}

module.exports = { register };
