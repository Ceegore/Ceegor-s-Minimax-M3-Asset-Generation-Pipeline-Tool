// scratch_verify/live_verify_launch.js
// Node launcher: spawns the real Electron binary with live_verify.js as the
// main entry (mirrors scripts/e2e/launch.js).
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const electronPath = require('electron'); // resolves to the binary path in node
const entry = path.join(__dirname, 'live_verify.js');
const r = spawnSync(electronPath, [entry], { stdio: 'inherit', cwd: path.join(__dirname, '..') });
process.exit(r.status == null ? 1 : r.status);
