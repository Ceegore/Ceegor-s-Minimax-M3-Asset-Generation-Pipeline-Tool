// main/utils/PowerShellSpawner.js
// Wrapper for the Windows PowerShell Expand-Archive cmdlet.
// The hidden-window flag + Bypass execution policy + NoProfile are
// required, otherwise a console window flashes and/or Expand-Archive
// fails under a restrictive policy.

const { spawn } = require('child_process');

/**
 * Extracts a ZIP file into a destination folder.
 * @param {string} zipPath     Absolute path to the .zip file.
 * @param {string} destDir     Destination folder (created if needed).
 * @returns {Promise<void>}    Resolves on exit code 0; rejects otherwise.
 */
function expandArchive(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    // Pass the paths as environment variables and reference them as
    // `$env:…` instead of interpolating them into the -Command string.
    // PowerShell expands $env:FOO to the exact value with no quoting
    // hazards, so a `"`/backtick in either path can't break the command
    // or smuggle extra arguments. Both paths are app-controlled
    // (os.tmpdir() zip + appRoot/bin), but this also avoids breakage for
    // any path containing a `"`.
    const ps = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-Command',
        'Expand-Archive -Path $env:MMX_SRC_ZIP -DestinationPath $env:MMX_DEST_DIR -Force',
      ],
      {
        windowsHide: true,
        env: { ...process.env, MMX_SRC_ZIP: zipPath, MMX_DEST_DIR: destDir },
      }
    );
    let stderr = '';
    ps.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
    // Hard timeout. Antivirus / locked-file / UAC scenarios can hang
    // ps.on('close') forever, freezing the install UI. 5 min is a
    // generous ceiling — Expand-Archive of the 200 MB Real-ESRGAN zip
    // takes <30 s on any modern disk. SIGKILL escalation mirrors the
    // isnetbg pattern.
    let killed = false;
    const killTimer = setTimeout(() => {
      killed = true;
      try { ps.kill(); } catch (_) {}
      setTimeout(() => { try { ps.kill('SIGKILL'); } catch (_) {} }, 2000).unref();
      reject(new Error(`Expand-Archive timed out after 5 min and was killed. ${stderr ? 'Last stderr: ' + stderr : ''}`));
    }, 5 * 60 * 1000).unref();
    ps.on('close', (code) => {
      if (killed) return;
      clearTimeout(killTimer);
      if (code === 0) resolve();
      else reject(new Error(`Expand-Archive failed (code ${code}): ${stderr}`));
    });
    ps.on('error', (err) => {
      if (killed) return;
      clearTimeout(killTimer);
      reject(err);
    });
  });
}

module.exports = { expandArchive };
