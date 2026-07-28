// renderer/utils/fbSort.js
// File-browser sort logic.

/** Allowed sort modes for the file browser. */
const FB_SORT_MODES = new Set([
  'name-asc', 'name-desc',
  'size-desc', 'size-asc',
  'mtime-desc', 'mtime-asc',
  'created-desc', 'created-asc',
  'type-asc',
]);

/** Whitelist check: invalid modes fall back to 'name-asc'. */
function normalizeFbSort(mode) {
  return (typeof mode === 'string' && FB_SORT_MODES.has(mode)) ? mode : 'name-asc';
}

/**
 * Natural string comparison with numeric awareness.
 * "file2" < "file10" (not "file10" < "file2" as with a plain <).
 */
function naturalCompare(a, b) {
  // Pure implementation.
  const re = /(\d+|\D+)/g;
  const ax = [], bx = [];
  let m;
  while ((m = re.exec(String(a))) !== null) ax.push(m[1]);
  while ((m = re.exec(String(b))) !== null) bx.push(m[1]);
  while (ax.length && bx.length) {
    const a0 = ax.shift(), b0 = bx.shift();
    const an = parseInt(a0, 10), bn = parseInt(b0, 10);
    if (!isNaN(an) && !isNaN(bn) && String(an) === a0.trim() && String(bn) === b0.trim()) {
      if (an !== bn) return an - bn;
    } else if (a0 !== b0) {
      return a0 < b0 ? -1 : 1;
    }
  }
  return ax.length - bx.length;
}

/**
 * Sort a file-browser item list by the chosen mode.
 * Directories always come first (Windows Explorer convention).
 * @param {Array<object>} items  fs items with {name, isDir, size, mtimeMs, birthtimeMs, ext}
 * @param {string} mode
 * @returns {Array<object>}  New sorted list (input is not mutated)
 */
function sortFbItems(items, mode) {
  const m = normalizeFbSort(mode);
  const arr = Array.isArray(items) ? items.slice() : [];
  const cmp = (a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    switch (m) {
      case 'name-desc':     return naturalCompare(b.name, a.name);
      case 'size-desc':     return (Number(b.size) || 0) - (Number(a.size) || 0);
      case 'size-asc':      return (Number(a.size) || 0) - (Number(b.size) || 0);
      case 'mtime-desc':    return (Number(b.mtimeMs) || 0) - (Number(a.mtimeMs) || 0);
      case 'mtime-asc':     return (Number(a.mtimeMs) || 0) - (Number(b.mtimeMs) || 0);
      case 'created-desc': {
        const av = Number(a.birthtimeMs) || Number(a.mtimeMs) || 0;
        const bv = Number(b.birthtimeMs) || Number(b.mtimeMs) || 0;
        return bv - av;
      }
      case 'created-asc': {
        const av = Number(a.birthtimeMs) || Number(a.mtimeMs) || 0;
        const bv = Number(b.birthtimeMs) || Number(b.mtimeMs) || 0;
        return av - bv;
      }
      case 'type-asc': {
        const ae = (a.ext || '').toLowerCase();
        const be = (b.ext || '').toLowerCase();
        if (ae !== be) return ae.localeCompare(be);
        return naturalCompare(a.name, b.name);
      }
      case 'name-asc':
      default:
        return naturalCompare(a.name, b.name);
    }
  };
  arr.sort(cmp);
  return arr;
}

window.FbSort = { FB_SORT_MODES, normalizeFbSort, naturalCompare, sortFbItems };
