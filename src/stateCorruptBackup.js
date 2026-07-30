// src/stateCorruptBackup.js
// P5 (M-044): preserve a corrupt state.json as `state.json.corrupt-<ts>` for
// recovery instead of silently discarding it. Called (lazily required) from
// state.js read()'s catch — that file and stateSanitizers.js both have frozen
// size budgets. Best-effort: a read-only fs must not turn the recovery path
// itself into a crash.
const fs = require('fs');

function backupCorruptState(p, e) {
  try {
    const backup = p + '.corrupt-' + Date.now();
    fs.copyFileSync(p, backup);
    console.error('[state] parse failed, backed up to', backup, e);
  } catch (_) { /* backup may fail (read-only fs), continue with default */ }
}

module.exports = { backupCorruptState };
