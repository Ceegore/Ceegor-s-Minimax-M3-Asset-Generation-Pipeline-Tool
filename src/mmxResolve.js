// src/mmxResolve.js
// Extracted H11-5: pure path resolution for the mmx-cli runtime.
//
// findNodeExe() — find a node executable, preferring Electron's own
//   process.execPath (run with ELECTRON_RUN_AS_NODE=1) so the tool works
//   out-of-the-box without a system node install. Falls back to system node.
// findMmxEntry() — find the mmx-cli dist/mmx.mjs entry, preferring the
//   BUNDLED copy (in node_modules) so the tool works out-of-the-box without a
//   global mmx-cli install. Falls back to the global npm install.
// needsRunAsNode(node) — true when the resolved node is Electron's binary and
//   the child env must set ELECTRON_RUN_AS_NODE=1.
//
// Kept as a standalone module so src/mmx.js stays within its frozen size budget.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function isWindows() { return process.platform === 'win32'; }

function findNodeExe() {
  const candidates = [];
  if (process.execPath) candidates.push(process.execPath);
  if (process.env.MINIMAX_NODE_PATH) candidates.push(process.env.MINIMAX_NODE_PATH);
  if (isWindows()) {
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const programFiles86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    candidates.push(path.join(programFiles, 'nodejs', 'node.exe'), path.join(programFiles86, 'nodejs', 'node.exe'));
    try {
      const r = spawnSync('where', ['node'], { encoding: 'utf8', windowsHide: true });
      if (r.status === 0 && r.stdout) {
        for (const line of r.stdout.split(/\r?\n/)) {
          const t = line.trim();
          if (t && t.toLowerCase().endsWith('node.exe')) candidates.push(t);
        }
      }
    } catch { /* ignore */ }
  } else {
    try {
      const r = spawnSync('which', ['node'], { encoding: 'utf8' });
      if (r.status === 0 && r.stdout) candidates.push(r.stdout.trim());
    } catch { /* ignore */ }
  }
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch { /* ignore */ } }
  return null;
}

function findMmxEntry() {
  const roots = [];
  // Bundled-first (dev + packaged).
  if (process.resourcesPath) roots.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'mmx-cli'));
  roots.push(path.join(__dirname, '..', 'node_modules', 'mmx-cli'));
  roots.push(path.join(__dirname, 'node_modules', 'mmx-cli'));
  if (isWindows()) {
    const appdata = process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming');
    roots.push(path.join(appdata, 'npm', 'node_modules', 'mmx-cli'));
  } else {
    roots.push('/usr/lib/node_modules/mmx-cli', '/usr/local/lib/node_modules/mmx-cli');
  }
  for (const r of roots) {
    const entry = path.join(r, 'dist', 'mmx.mjs');
    if (fs.existsSync(entry)) return entry;
  }
  return null;
}

function needsRunAsNode(node) {
  return !!(node && process.execPath && node === process.execPath);
}

module.exports = { findNodeExe, findMmxEntry, needsRunAsNode, isWindows };
