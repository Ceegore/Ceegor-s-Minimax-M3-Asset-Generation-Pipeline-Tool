// src/fileBrowser.js
// File-system operations for the right-pane browser.
const fs = require('fs').promises;
const fssync = require('fs');
const path = require('path');
const { shell } = require('electron');
// AUD-018 fix: Use centralized Windows name policy instead of incomplete local regex.
const { assertSinglePathSegment } = require('./windowsNamePolicy');

async function safeStat(p) {
  try { return await fs.stat(p); } catch { return null; }
}

// AUD-018 fix: Delegate to the centralized windowsNamePolicy module which
// correctly handles device stems with extensions (CON.txt, NUL.png),
// superscript aliases (COM¹.txt), and trailing dot/space rejection.
function validateName(name) {
  assertSinglePathSegment(name);
}

async function list(dir) {
  const target = dir || '.';
  const resolved = path.resolve(target);
  const entries = await fs.readdir(resolved, { withFileTypes: true });
  const items = [];
  // R7: cap pathological directories — each entry costs a stat call and the IPC payload would balloon.
  const LIST_CAP = 5000;
  const truncated = entries.length > LIST_CAP;
  const capped = truncated ? entries.slice(0, LIST_CAP) : entries;
  for (const e of capped) {
    const full = path.join(resolved, e.name);
    const st = await safeStat(full);
    if (!st) continue;
    items.push({
      name: e.name,
      path: full,
      isDir: e.isDirectory(),
      size: st.size,
      mtimeMs: st.mtimeMs,
      // Creation time. On some filesystems (notably FAT32 and
      // some non-NTFS volumes) the value is 0 / not available;
      // the renderer-side sort falls back to mtimeMs in that case
      // so the user still gets a sensible "newest first" order
      // instead of all-zero ties.
      birthtimeMs: st.birthtimeMs || 0,
      ctimeMs: st.ctimeMs || 0,
      ext: path.extname(e.name).toLowerCase(),
    });
  }
  items.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { dir: resolved, parent: path.dirname(resolved), items, truncated, totalCount: entries.length }; // R8: surface the cap so the renderer can tell the listing is partial
}

async function mkdir(dir, name) {
  validateName(name);
  const target = path.join(dir, name);
  // Defense in depth: ensure the resolved target is still inside `dir`.
  const dirResolved = path.resolve(dir);
  const targetResolved = path.resolve(target);
  // When `dir` is a DRIVE ROOT (e.g. `D:\`, a common output_dir),
  // path.resolve already returns it WITH a trailing separator ("D:\"), so
  // `dirResolved + path.sep` would become "D:\\" (double sep) and a
  // legitimate child like "D:\speech" would fail the startsWith() check,
  // causing mkdir to throw "escapes the parent directory" and leaving no
  // folder for mmx to write to. Normalise so a root that already ends in a
  // separator isn't doubled.
  const dirWithSep = dirResolved.endsWith(path.sep) ? dirResolved : dirResolved + path.sep;
  if (targetResolved !== dirResolved && !targetResolved.startsWith(dirWithSep)) {
    throw new Error('Resolved path escapes the parent directory.');
  }
  // recursive + force-ok-on-EEXIST: lets us call this to "ensure" a dir exists.
  await fs.mkdir(target, { recursive: true });
  return target;
}

async function rename(p, newName) {
  validateName(newName);
  const dir = path.dirname(p);
  const dest = path.join(dir, newName);
  // H-032 (_5 audit): atomic no-clobber rename. The old existsSync() +
  // fs.rename() had a TOCTOU window where a parallel job could create
  // the destination between check and rename, causing silent overwrite.
  // Strategy: try fs.link() first (atomic, fails with EEXIST if dest
  // exists), then remove source. Fall back to existsSync + rename for
  // directories (hard links don't work on directories).
  const st = await fs.stat(p);
  if (st.isDirectory()) {
    // Directories: no atomic no-clobber primitive exists. Use the
    // existsSync guard (TOCTOU window is minimal for directory renames
    // since parallel jobs don't create same-named directories).
    if (fssync.existsSync(dest)) throw new Error('A file/folder with that name already exists.');
    await fs.rename(p, dest);
  } else {
    // Files: atomic link + unlink. fs.link() fails with EEXIST if dest
    // already exists — no TOCTOU window.
    try {
      await fs.link(p, dest);
    } catch (e) {
      if (e && e.code === 'EEXIST') throw new Error('A file/folder with that name already exists.');
      // Cross-device or permission issue — fall back to guarded rename.
      if (fssync.existsSync(dest)) throw new Error('A file/folder with that name already exists.');
      await fs.rename(p, dest);
      return dest;
    }
    await fs.unlink(p);
  }
  return dest;
}

async function moveTo(src, destDir) {
  const name = path.basename(src);
  let dest = path.join(destDir, name);
  if (fssync.existsSync(dest)) {
    // Auto-rename to avoid clobber
    const { name: base, ext } = path.parse(name);
    let i = 1;
    while (fssync.existsSync(dest)) {
      if (i > 10000) throw new Error('Too many name collisions for "' + name + '".');
      dest = path.join(destDir, `${base} (${i})${ext}`);
      i++;
    }
  }
  // H-032 (_5 audit): atomic no-clobber move. The existsSync loop above
  // picks a free name, but a concurrent writer could claim it between the
  // check and the commit. Use platform no-replace primitives so the
  // operation fails loudly instead of silently overwriting.
  const st = await fs.stat(src);
  if (st.isDirectory()) {
    // Directories: no atomic no-clobber primitive exists. Re-check +
    // cp with errorOnExist is the best available guard.
    if (fssync.existsSync(dest)) {
      throw new Error('Destination "' + dest + '" appeared during the move — refusing to overwrite.');
    }
    await fs.cp(src, dest, { recursive: true, force: false, errorOnExist: true });
    await fs.rm(src, { recursive: true, force: true });
  } else {
    // Files: try atomic link+unlink (same-device). fs.link() fails with
    // EEXIST if dest was claimed between name-finding and commit — no
    // TOCTOU window. Cross-device (EXDEV) falls back to COPYFILE_EXCL.
    try {
      await fs.link(src, dest);
    } catch (e) {
      if (e && e.code === 'EEXIST') {
        throw new Error('Destination "' + dest + '" appeared during the move — refusing to overwrite.');
      }
      if (e && (e.code === 'EXDEV' || /cross-device|spans devices/i.test(String(e.message || '')))) {
        // Cross-device: copy with exclusive flag (atomic no-clobber),
        // then remove source.
        await fs.copyFile(src, dest, fssync.constants.COPYFILE_EXCL);
        await fs.rm(src, { force: true });
        return dest;
      }
      throw e;
    }
    await fs.unlink(src);
  }
  return dest;
}

async function copyTo(src, destDir) {
  const name = path.basename(src);
  let dest = path.join(destDir, name);
  if (fssync.existsSync(dest)) {
    // Auto-rename to avoid clobber
    const { name: base, ext } = path.parse(name);
    let i = 1;
    while (fssync.existsSync(dest)) {
      if (i > 10000) throw new Error('Too many name collisions for "' + name + '".');
      dest = path.join(destDir, `${base} (${i})${ext}`);
      i++;
    }
  }
  const st = await fs.stat(src);
  if (st.isDirectory()) {
    // MED-022: async recursive directory copy. The previous fssync.cpSync
    // blocked the main-process event loop for large trees.
    // H-033 (_5 audit): explicit force:false + errorOnExist:true so a
    // TOCTOU race on the destination directory fails loudly instead of
    // silently merging/overwriting an existing tree.
    await fs.cp(src, dest, { recursive: true, force: false, errorOnExist: true });
  } else {
    // R8: COPYFILE_EXCL — if a file appears at `dest` between the rename-loop
    // above and this copy (TOCTOU), fail instead of silently overwriting it.
    await fs.copyFile(src, dest, fssync.constants.COPYFILE_EXCL);
  }
  return dest;
}

async function deletePath(p) {
  const st = await fs.stat(p);
  if (st.isDirectory()) await fs.rm(p, { recursive: true, force: false });
  else await fs.unlink(p);
  return p;
}

function reveal(p) {
  // Return a boolean so the IPC handler can report a real failure instead
  // of always ok:true. Electron's shell.showItemInFolder returns void, so
  // catch any throw (e.g. the file was deleted/moved between the user's
  // click and this call) and report false.
  try { shell.showItemInFolder(p); return true; } catch (_) { return false; }
}

// Open a NEW Windows Explorer window at the file's parent folder. This is
// the standard "explore" shell verb — `shell.showItemInFolder` (above) only
// highlights the file in an existing window, whereas `shell.openPath(parentDir)`
// opens a fresh Explorer window. The caller passes a file path; the parent
// dir is resolved here so the renderer doesn't have to know the platform-
// specific separator logic.
// MED-023: detect file vs directory. If `p` is a directory, open it
// directly; if it's a file, open its parent folder. The previous code
// always opened path.dirname(p), which for a directory path opened the
// grandparent — confusing when the user right-clicks a folder.
async function openInExplorer(p) {
  if (!p || typeof p !== 'string') {
    throw new Error('Path is required.');
  }
  const path = require('path');
  let target;
  try {
    const st = await fs.stat(p);
    target = st.isDirectory() ? p : path.dirname(p);
  } catch {
    // If stat fails (deleted?), fall back to parent-of-p.
    target = path.dirname(p);
  }
  // shell.openPath returns a Promise<string> ('' on success,
  // an error string on failure).
  return shell.openPath(target).then((err) => {
    if (err) throw new Error(String(err));
  });
}

async function readFile(p, maxBytes = 2 * 1024 * 1024) {
  const st = await fs.stat(p);
  if (st.size > maxBytes) throw new Error(`File too large to preview (${st.size} bytes).`);
  return fs.readFile(p);
}

module.exports = { list, mkdir, rename, moveTo, copyTo, deletePath, reveal, openInExplorer, readFile, validateName };
