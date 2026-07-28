// renderer/utils/fbColumns.js
// FB_COLUMNS array + normalizeFbColumns helper.

var { humanSize } = window.PureFuncs;

// ----------------- File-browser columns -----------------
// Each column is a self-describing object that tells the renderer
//   1. its stable id (key into state.fbColumns),
//   2. its user-visible label (header + overlay checkbox),
//   3. the CSS grid template it occupies in the row,
//   4. a render(item) function that produces the cell's DOM
//      children (text + optional title for the full value).
// The "name" column is mandatory and is NOT in this list — the
// row always renders it. Adding it here would let the user turn
// it off, which would make the row unscannable.

const FB_COLUMNS = [
  {
    id: 'size',
    label: 'Size',
    gridTemplate: 'minmax(60px, auto)',
    render: (it) => {
      if (it.isDir) return ['—', 'folder'];
      return [humanSize(it.size), humanSize(it.size)];
    },
  },
  {
    id: 'type',
    label: 'Type',
    gridTemplate: 'minmax(60px, auto)',
    render: (it) => {
      if (it.isDir) return ['—', 'folder'];
      const ext = (it.ext || '').replace(/^\./, '').toUpperCase();
      return [ext || '—', ext];
    },
  },
  {
    id: 'mtime',
    label: 'Modified',
    gridTemplate: 'minmax(130px, auto)',
    render: (it) => {
      const ms = Number(it.mtimeMs) || 0;
      if (!ms) return ['—', ''];
      const d = new Date(ms);
      const text = d.toLocaleString();
      return [text, d.toISOString()];
    },
  },
  {
    id: 'btime',
    label: 'Created',
    gridTemplate: 'minmax(130px, auto)',
    render: (it) => {
      const ms = Number(it.birthtimeMs) || 0;
      if (!ms) return ['—', ''];
      const d = new Date(ms);
      const text = d.toLocaleString();
      return [text, d.toISOString()];
    },
  },
  {
    id: 'path',
    label: 'Path',
    gridTemplate: 'minmax(220px, 1fr)',
    render: (it) => {
      return [it.path || '', it.path || ''];
    },
  },
];

// Sanitise state.fbColumns: coerce every known id to a boolean,
// and ignore any unknown id (corrupted state.json / future
// version). The "name" column is always implicitly on.
function normalizeFbColumns(cols) {
  const out = {};
  for (const c of FB_COLUMNS) {
    out[c.id] = !!(cols && cols[c.id]);
  }
  return out;
}

window.FbColumns = { FB_COLUMNS, normalizeFbColumns };
