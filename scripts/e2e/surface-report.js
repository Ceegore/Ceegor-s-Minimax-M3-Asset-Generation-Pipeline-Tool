// scripts/e2e/surface-report.js
// ============================================================================
// Turns the set of touched ui_map elements (see uimap.js) into a concrete,
// honest coverage metric: what % of the automatable UI surface the suite
// exercised, plus the list of never-touched elements (the actionable gap
// list) and the manual-only elements (the "cannot automate" boundary).
//
// Writes coverage/surface.json and renders a human-readable table.
// ============================================================================

const fs = require('fs');
const path = require('path');
const { flatten } = require('./uimap');

function buildReport(touchedIds) {
  const { automatable, manual } = flatten();
  const touched = touchedIds instanceof Set ? touchedIds : new Set(touchedIds);
  const covered = automatable.filter((e) => touched.has(e.id));
  const untouched = automatable.filter((e) => !touched.has(e.id));
  const pct = automatable.length ? (100 * covered.length / automatable.length) : 0;
  return {
    generated: new Date().toISOString(),
    automatable_total: automatable.length,
    touched: covered.length,
    coverage_pct: Math.round(pct * 10) / 10,
    manual_total: manual.length,
    untouched: untouched.map((e) => ({ id: e.id, screen: e.screen, dom: e.dom })),
    manual: manual.map((e) => ({ id: e.id, screen: e.screen })),
  };
}

/**
 * @param {object} report
 * @param {string} [outDir]
 * @param {{ partial?: boolean }} [opts] KGO7-012: a FILTERED run (--only=X)
 *   must not overwrite the canonical artifact. `node scripts/e2e/launch.js
 *   --only=real-image` rewrote coverage/surface.json with
 *   `"coverage_pct": 2.2, "touched": 2` — so the next reader (a dashboard,
 *   a badge, the next engineer) saw 2.2 % UI coverage for the project.
 */
function writeReport(report, outDir, opts) {
  const dir = outDir || path.join(process.cwd(), 'coverage');
  fs.mkdirSync(dir, { recursive: true });
  const partial = !!(opts && opts.partial);
  const file = path.join(dir, partial ? 'surface.partial.json' : 'surface.json');
  fs.writeFileSync(file, JSON.stringify(Object.assign({ partial }, report), null, 2));
  return file;
}

function printTable(report) {
  const bar = '='.repeat(64);
  const lines = [];
  lines.push(bar);
  lines.push(`UI SURFACE COVERAGE  ${report.touched}/${report.automatable_total} automatable elements  (${report.coverage_pct}%)`);
  lines.push(`Manual-only (visual, not automatable via ui_map): ${report.manual_total}`);
  lines.push(bar);
  // Per-screen breakdown of the untouched gap.
  const byScreen = new Map();
  for (const u of report.untouched) {
    if (!byScreen.has(u.screen)) byScreen.set(u.screen, []);
    byScreen.get(u.screen).push(u.id);
  }
  if (report.untouched.length) {
    lines.push(`Untouched automatable elements (${report.untouched.length}):`);
    for (const [screen, ids] of byScreen) {
      lines.push(`  [${screen}] ${ids.join(', ')}`);
    }
  } else {
    lines.push('Every automatable ui_map element was exercised. 🎉');
  }
  lines.push(bar);
  return lines.join('\n');
}

module.exports = { buildReport, writeReport, printTable };
