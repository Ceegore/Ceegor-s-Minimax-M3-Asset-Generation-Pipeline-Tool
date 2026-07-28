// scripts/enable-devmode.js
// Cross-platform wrapper around scripts/enable-devmode.ps1.
// On Windows, this re-launches the .ps1 with admin elevation
// (UAC prompt) and sets the registry key that enables
// SeCreateSymbolicLinkPrivilege for the current user. On other
// platforms, the Windows-specific fix doesn't apply — print a
// short note and exit.
//
// Run with:  npm run enable-devmode

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

if (process.platform !== 'win32') {
  process.stdout.write('enable-devmode only applies to Windows. Skipping.\n');
  process.exit(0);
}

const scriptPath = path.join(__dirname, 'enable-devmode.ps1');
if (!fs.existsSync(scriptPath)) {
  process.stderr.write('scripts/enable-devmode.ps1 is missing. Re-clone the repo.\n');
  process.exit(1);
}

// `powershell -NoProfile -ExecutionPolicy Bypass -File <script>`.
// The .ps1 self-elevates via Start-Process -Verb RunAs, so we
// don't need to be admin to launch it — Windows pops the UAC
// prompt itself.
const result = spawnSync('powershell.exe', [
  '-NoProfile', '-ExecutionPolicy', 'Bypass',
  '-File', scriptPath,
], { stdio: 'inherit', windowsHide: true });

if (result.error) {
  process.stderr.write('Failed to launch PowerShell: ' + result.error.message + '\n');
  process.exit(1);
}
process.exit(result.status ?? 1);
