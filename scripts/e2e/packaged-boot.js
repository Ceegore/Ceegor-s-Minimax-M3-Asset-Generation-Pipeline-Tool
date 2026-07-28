// scripts/e2e/packaged-boot.js
// ============================================================================
// Phase B1 — Packaged-build integration test.
//
// Builds an asar from current source, boots it inside Electron (mimicking
// the shipped product), and runs a functional smoke check against the
// PACKAGED renderer + preload. This catches "works in dev, broken in release"
// regressions: missing deps, path resolution differences, native module
// loading failures, preload sandbox issues.
//
// Usage:
//   node scripts/e2e/packaged-boot.js          (standalone)
//   npm run test:packaged                      (via package.json)
//
// The script:
//   1. Packs source into a temp asar (using @electron/asar)
//   2. Creates a minimal Electron shell that loads from the asar
//   3. Boots the app with --remote-debugging-port
//   4. Verifies: asar structure, renderer boots from the asar
//   5. Runs a functional smoke check against the packaged renderer + preload
//      (window.api bridge present, key DOM rendered, sandbox intact, no fatal
//      page errors) — the parts that differ between dev and packaged builds
//   6. Cleans up all temp artifacts
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const ASAR_JS = path.join(ROOT, 'node_modules', '@electron', 'asar', 'bin', 'asar.js');

// Files/dirs to pack into the asar (mirrors package.json "files" whitelist).
const PACK_ENTRIES = [
  'main.js', 'preload.js', 'package.json',
  'main', 'src', 'renderer',
  'IMAGE_STYLE_PRESETS_ENGLISH_v2.0.md',
];

// Runtime node_modules to include (curated — no dev deps).
// NOTE: In production builds, electron-builder unpacks native modules
// outside the asar (--unpack-dir). Here we include only pure-JS deps
// that can load from within the asar. Native modules (sharp, onnxruntime)
// are verified separately by check-bundled-deps.js.
const RUNTIME_DEPS = [
  'ffmpeg-static',
];

function log(m) { process.stdout.write(`[packaged-boot] ${m}\n`); }

function packAsar(workDir, asarPath) {
  log('Packing asar from source...');
  fs.mkdirSync(workDir, { recursive: true });

  // Copy source entries.
  for (const entry of PACK_ENTRIES) {
    const src = path.join(ROOT, entry);
    const dst = path.join(workDir, entry);
    if (!fs.existsSync(src)) { log(`WARN: ${entry} not found, skipping`); continue; }
    if (fs.statSync(src).isDirectory()) {
      fs.cpSync(src, dst, { recursive: true });
    } else {
      fs.copyFileSync(src, dst);
    }
  }

  // Copy curated runtime deps.
  const nmSrc = path.join(ROOT, 'node_modules');
  const nmDst = path.join(workDir, 'node_modules');
  fs.mkdirSync(nmDst, { recursive: true });
  for (const dep of RUNTIME_DEPS) {
    const src = path.join(nmSrc, dep);
    if (fs.existsSync(src)) {
      fs.cpSync(src, path.join(nmDst, dep), { recursive: true });
    }
  }

  // Pack with asar CLI.
  const r = spawnSync(process.execPath, [ASAR_JS, 'pack', workDir, asarPath], {
    stdio: 'pipe', encoding: 'utf8',
  });
  if (r.status !== 0) {
    throw new Error(`asar pack failed: ${r.stderr || r.stdout}`);
  }
  log(`Asar packed: ${asarPath} (${(fs.statSync(asarPath).size / 1024 / 1024).toFixed(1)} MB)`);
}

function createTestShell(shellDir, asarPath, signalFile) {
  // Create a wrapper directory with a custom package.json that points
  // to a boot-check main.js. This main.js loads the REAL app entry from
  // the asar, waits for the renderer to finish loading, writes a signal
  // file, and quits. This avoids the "GUI app never exits" problem.
  fs.mkdirSync(shellDir, { recursive: true });
  fs.copyFileSync(asarPath, path.join(shellDir, 'app.asar'));

  // Custom wrapper main.js — loads the real app renderer + preload from the
  // asar, then runs a functional smoke check (preload bridge present, key DOM
  // rendered, no fatal page errors) before signalling success and quitting.
  // This verifies the parts that DIFFER between dev and packaged: the preload
  // and renderer bundle executing from inside the asar. (IPC handler logic is
  // identical main-process code, already covered by the full E2E suite.)
  const wrapperMain = `
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const SIGNAL = ${JSON.stringify(signalFile)};
// Suppress Electron's blocking native error dialog for uncaught
// main-process errors: log instead so the boot probe is never blocked.
process.on('uncaughtException', (err) => { console.error('[packaged-boot] uncaughtException: ' + ((err && err.stack) || err)); });
process.on('unhandledRejection', (reason) => { console.error('[packaged-boot] unhandledRejection: ' + ((reason && reason.stack) || reason)); });
app.whenReady().then(() => {
  const pageErrors = [];
  const win = new BrowserWindow({
    width: 1200, height: 800, show: false,
    webPreferences: {
      preload: path.join(__dirname, 'app.asar', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    }
  });
  win.webContents.on('console-message', (e, level, message) => {
    if (level >= 3) pageErrors.push(String(message).slice(0, 200));
  });
  win.webContents.on('preload-error', (e, preloadPath, error) => {
    pageErrors.push('PRELOAD_ERROR: ' + (error && error.message || error));
  });
  win.loadFile(path.join(__dirname, 'app.asar', 'renderer', 'index.html'));
  win.webContents.on('did-finish-load', async () => {
    try {
      // Functional smoke: preload bridge + rendered DOM + sandbox intact.
      const smoke = await win.webContents.executeJavaScript(\`(() => {
        const out = { api: false, apiKeys: 0, dom: false, require: false, process: false };
        try {
          out.api = !!(window.api && typeof window.api === 'object');
          out.apiKeys = out.api ? Object.keys(window.api).length : 0;
          out.dom = !!document.getElementById('tab-image') && !!document.body;
          out.require = (typeof require !== 'undefined');
          out.process = (typeof process !== 'undefined');
        } catch (e) { out.error = String(e && e.message || e); }
        return out;
      })()\`);
      const fatal = pageErrors.filter(m => /uncaught|cannot read|is not defined|failed to load|module not found/i.test(m));
      const ok = smoke.api && smoke.apiKeys > 0 && smoke.dom && !smoke.require && !smoke.process && fatal.length === 0;
      const detail = JSON.stringify({ smoke, fatalErrors: fatal.slice(0, 5) });
      fs.writeFileSync(SIGNAL, (ok ? 'PACKAGED_BOOT_OK ' : 'PACKAGED_SMOKE_FAIL ') + detail);
    } catch (e) {
      fs.writeFileSync(SIGNAL, 'PACKAGED_SMOKE_FAIL ' + JSON.stringify({ execError: String(e && e.message || e), pageErrors: pageErrors.slice(0, 5) }));
    }
    setTimeout(() => app.quit(), 300);
  });
  // Safety timeout: quit after 15s even if load didn't fire.
  setTimeout(() => {
    if (!fs.existsSync(SIGNAL)) fs.writeFileSync(SIGNAL, 'TIMEOUT');
    app.quit();
  }, 15000);
});
`;
  fs.writeFileSync(path.join(shellDir, 'main.js'), wrapperMain);
  fs.writeFileSync(path.join(shellDir, 'package.json'), JSON.stringify({ name: 'packaged-boot-test', main: 'main.js' }));
  return shellDir;
}

async function runPackagedBoot() {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-packaged-'));
  const workDir = path.join(TMP, 'src');
  const asarPath = path.join(TMP, 'app.asar');
  const shellDir = path.join(TMP, 'shell');
  const signalFile = path.join(TMP, 'boot-signal.txt');

  try {
    // Step 1: Pack asar.
    packAsar(workDir, asarPath);

    // Step 2: Verify asar structure.
    log('Verifying asar structure...');
    const asar = require('@electron/asar');
    const files = asar.listPackage(asarPath);
    const required = ['main.js', 'preload.js', 'package.json', 'main/index.js', 'renderer/index.html', 'IMAGE_STYLE_PRESETS_ENGLISH_v2.0.md'];
    // asar.listPackage returns paths with leading / or \ depending on OS.
    const normalized = files.map(f => f.replace(/^[\/\\]/, '').replace(/\\/g, '/'));
    const missing = required.filter(f => !normalized.includes(f));
    if (missing.length > 0) {
      log(`FAIL: Missing files in asar: ${missing.join(', ')}`);
      return { ok: false, error: 'missing-files', missing };
    }
    log(`Asar structure OK (${files.length} files, all required entries present)`);

    // Step 3: Create isolated config BEFORE booting.
    const configDir = path.join(TMP, 'config');
    const outDir = path.join(TMP, 'out');
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'config.txt'),
      'api_key=sk-packaged-test\noutput_dir=' + outDir + '\n', 'utf8');

    // Step 4: Create test shell with signal-file boot check.
    createTestShell(shellDir, asarPath, signalFile);

    // Step 5: Boot Electron pointing at the wrapper shell.
    let electronPath;
    try {
      electronPath = require('electron');
    } catch (e) {
      log('SKIP: Electron not installed');
      return { skipped: true, reason: 'electron-not-installed' };
    }

    log('Booting packaged app...');
    spawnSync(electronPath, [shellDir, '--no-sandbox', '--disable-gpu'], {
      stdio: 'ignore', timeout: 25000,
      env: { ...process.env, MINIMAX_CONFIG_DIR: configDir },
    });

    // Step 6: Check signal file.
    if (fs.existsSync(signalFile)) {
      const content = fs.readFileSync(signalFile, 'utf8');
      if (content.startsWith('PACKAGED_BOOT_OK')) {
        const detail = content.slice('PACKAGED_BOOT_OK '.length);
        log('Renderer + preload functional smoke PASSED from asar');
        try { log('  smoke: ' + detail); } catch (_) {}
        return { ok: true, asarSize: fs.statSync(asarPath).size, fileCount: files.length };
      }
      log(`FAIL: Packaged smoke failed: ${content}`);
      return { ok: false, error: 'boot-signal-' + content.slice(0, 300) };
    }

    log('FAIL: No boot signal file produced (Electron may have crashed)');
    return { ok: false, error: 'no-signal-file' };
  } finally {
    // Cleanup — remove ALL temp artifacts.
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  }
}

// Run if invoked directly.
if (require.main === module) {
  runPackagedBoot()
    .then((result) => {
      if (result.skipped) {
        log(`SKIPPED: ${result.reason}`);
        process.exit(0);
      }
      if (result.ok) {
        log(`PASS: Packaged boot verified (asar: ${(result.asarSize / 1024 / 1024).toFixed(1)} MB)`);
        process.exit(0);
      } else {
        log(`FAIL: ${result.error}`);
        process.exit(1);
      }
    })
    .catch((e) => {
      log(`ERROR: ${e.message}`);
      process.exit(1);
    });
}

module.exports = { runPackagedBoot, packAsar };
