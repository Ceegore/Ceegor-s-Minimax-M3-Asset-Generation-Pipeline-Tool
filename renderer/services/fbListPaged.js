// renderer/services/fbListPaged.js
// ============================================================================
// M-012 (hhhhu3 audit): paginated directory listing for the renderer.
//
// Main registers fb:listStart / fb:listNext / fb:listClose (bounded
// Main-owned sessions, opaque cursors, no silent truncation), but until
// now the renderer only had the legacy fb:list, which truncates at 5,000
// entries before sorting.
//
// window.FbListPaged.drain(dir, grantId) walks the cursor pages and
// returns an envelope shaped like the legacy fb:list result:
//
//   { ok: true, dir, parent, items: [...], truncated: false, totalCount }
//
// Items are normalised to the legacy item shape (path + birthtimeMs /
// ctimeMs defaults) so existing renderer consumers work unchanged. The
// server returns pages pre-sorted (directories first), so concatenation
// preserves order.
// ============================================================================
(function () {
  'use strict';

  const PAGE_SIZE = 500;     // DirectoryListingService MAX_PAGE_SIZE
  const MAX_PAGES = 2_000;   // hard bound: 500 * 2000 = 1M entries

  function sepOf(p) { return String(p).includes('\\') ? '\\' : '/'; }
  function joinPath(dir, name) {
    const s = sepOf(dir);
    const d = String(dir).replace(/[\\/]+$/, '');
    return d ? d + s + name : String(name);
  }
  function dirnameOf(p) {
    const s = sepOf(p);
    return String(p).split(s).slice(0, -1).join(s);
  }

  // Map a DirectoryListingService item to the legacy fb:list item shape.
  function normalise(item, dir) {
    return {
      name: item.name,
      path: joinPath(dir, item.name),
      isDir: !!item.isDir,
      isSymlink: !!item.isSymlink,
      size: item.size || 0,
      mtimeMs: item.mtimeMs || 0,
      // The paginated session does not stat birth/ctime; renderer sorts
      // fall back to mtimeMs when these are 0.
      birthtimeMs: 0,
      ctimeMs: 0,
      ext: item.ext || '',
    };
  }

  /**
   * List a directory through the paginated session and drain every page.
   * @param {string} dir
   * @param {string|undefined} grantId
   * @param {{sort?:string, direction?:string}} [opts]
   * @returns {Promise<{ok:true, dir:string, parent:string, items:object[], truncated:false, totalCount:number} | {ok:false, error:string}>}
   */
  async function drain(dir, grantId, opts = {}) {
    if (!window.api || typeof window.api.fbListStart !== 'function') {
      // Preload without the paginated surface — fall back to the legacy
      // (truncating) listing rather than breaking entirely.
      return window.api.fbList(dir, grantId);
    }
    let sessionId = null;
    try {
      const start = await window.api.fbListStart({
        dir,
        grantId,
        sort: opts.sort,
        direction: opts.direction,
        pageSize: PAGE_SIZE,
      });
      if (!start || start.ok !== true) {
        return { ok: false, error: (start && start.error) || 'fb:listStart failed' };
      }
      sessionId = start.sessionId;
      const items = (start.items || []).map((it) => normalise(it, start.dir || dir));
      let cursor = start.cursor;
      let hasMore = !!start.hasMore;
      let pages = 0;
      while (hasMore && cursor && pages < MAX_PAGES) {
        const next = await window.api.fbListNext({ sessionId, cursor });
        if (!next || next.ok !== true) {
          return { ok: false, error: (next && next.error) || 'fb:listNext failed' };
        }
        for (const it of (next.items || [])) items.push(normalise(it, start.dir || dir));
        cursor = next.cursor;
        hasMore = !!next.hasMore;
        pages++;
      }
      if (hasMore) {
        // Hit the safety bound — report what we have, flagged.
        return { ok: true, dir: start.dir || dir, parent: dirnameOf(start.dir || dir), items, truncated: true, totalCount: start.totalCount };
      }
      return {
        ok: true,
        dir: start.dir || dir,
        parent: dirnameOf(start.dir || dir),
        items,
        truncated: false,
        totalCount: typeof start.totalCount === 'number' ? start.totalCount : items.length,
      };
    } finally {
      if (sessionId && window.api.fbListClose) {
        window.api.fbListClose({ sessionId }).catch(() => {});
      }
    }
  }

  window.FbListPaged = { drain, PAGE_SIZE };
})();
