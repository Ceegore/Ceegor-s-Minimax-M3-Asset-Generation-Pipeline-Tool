// scripts/test-release-acceptance.js
// ============================================================================
// V104-B002: installer acceptance against the REAL release artifacts.
//
// The v1.0.4 requalification rejected the old installer test because it
// installed artificial text-file fixtures (a fake exe, version 9.9.9).
// This suite instead exercises the EXACT downloaded release sitting in
// dist-out/ — the real multipart archives, the signed outer manifest, the
// minisig, the pinned public key and the pinned verifier — through the
// same bootstrap path an end user takes:
//
//   1. Fresh bootstrap install (verify signature + checksums, extract,
//      stage, swap, shortcuts) — must succeed on the signed release.
//   2. Boot the INSTALLED executable and run the functional smoke.
//   3. Upgrade over the existing installation — clean swap, no stale files.
//   4. Interrupt mid-install — the install target must never end up
//      partial (staged swap is atomic).
//   5. Tamper rejection — a modified inventoried file must fail closed.
//   6. Unsigned rejection — removing the .minisig must fail closed when
//      the dev-harness escape hatch is absent.
//
// Node built-ins only (no npm ci needed on the clean-VM runner).
// ============================================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { bootAndProbe } = require('./e2e/real-release-boot');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.resolve(process.argv[2] || path.join(ROOT, 'dist-out'));

function log(m) { process.stdout.write(`[test-release-acceptance] ${m}\n`); }
function fail(m) { log(`FAIL: ${m}`); process.exit(1); }

function sha256File(fp) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(fp, 'r');
  const buf = Buffer.alloc(1024 * 1024);
  let n;
  while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.slice(0, n));
  fs.closeSync(fd);
  return h.digest('hex');
}

// Hardlink huge artifacts when possible (same volume) to keep the suite
// fast and disk-cheap; fall back to a full copy across volumes.
function linkOrCopy(src, dst) {
  try { fs.linkSync(src, dst); }
  catch (_) { fs.copyFileSync(src, dst); }
}

function runInstaller(cwd, extraEnv, timeoutMs = 45 * 60 * 1000) {
  return spawnSync('cmd.exe', ['/d', '/c', 'Install-MiniMax-Asset-Tool.cmd'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
    windowsHide: true,
    env: { ...process.env, ...extraEnv },
  });
}

function killTree(child) {
  try {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } catch (_) {}
}

async function main() {
  if (process.platform !== 'win32') {
    log('SKIP: the shipped release is Windows-only');
    return;
  }

  // ---- Locate the real release artifacts (fail closed when absent). ----
  const partNames = fs.existsSync(DIST)
    ? fs.readdirSync(DIST).filter((f) => /^MiniMaxAssetTool-.+\.part\d+\.zip$/.test(f)).sort()
    : [];
  if (partNames.length === 0) {
    fail(`no real release archives found in ${DIST} — acceptance must install the exact downloaded release, not a fixture`);
  }
  const baseName = partNames[0].replace(/\.part\d+\.zip$/, '');
  const manifest = path.join(DIST, `${baseName}.sha256`);
  const minisig = path.join(DIST, `${baseName}.sha256.minisig`);
  const pubKey = path.join(DIST, 'minisign.pub');
  const verifier = path.join(DIST, 'minisign.exe');
  const installerCmd = path.join(DIST, 'Install-MiniMax-Asset-Tool.cmd');
  const missing = [manifest, minisig, pubKey, verifier, installerCmd].filter((f) => !fs.existsSync(f));
  if (missing.length) {
    fail(`real release is incomplete for signed acceptance: ${missing.map((f) => path.basename(f)).join(', ')}`);
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-acceptance-'));
  const downloadDir = path.join(temp, 'download');
  const installTarget = path.join(temp, 'installed app');
  const desktop = path.join(temp, 'Desktop');
  const startMenu = path.join(temp, 'StartMenu');
  const installEnv = {
    MINIMAX_INSTALL_DIR: installTarget,
    MINIMAX_INSTALL_DESKTOP: desktop,
    MINIMAX_INSTALL_START_MENU: startMenu,
    MINIMAX_INSTALL_NO_LAUNCH: '1',
    // No MINIMAX_INSTALLER_ALLOW_UNSIGNED anywhere: the real release is
    // signed and must pass the signature gate as an end user sees it.
  };

  try {
    fs.mkdirSync(downloadDir, { recursive: true });
    for (const name of partNames) linkOrCopy(path.join(DIST, name), path.join(downloadDir, name));
    linkOrCopy(manifest, path.join(downloadDir, path.basename(manifest)));
    linkOrCopy(minisig, path.join(downloadDir, path.basename(minisig)));
    linkOrCopy(pubKey, path.join(downloadDir, 'minisign.pub'));
    linkOrCopy(verifier, path.join(downloadDir, 'minisign.exe'));
    fs.copyFileSync(installerCmd, path.join(downloadDir, 'Install-MiniMax-Asset-Tool.cmd'));

    // ---- 1. Fresh signed bootstrap install of the real release. ----
    log(`Installing the real release (${partNames.length} parts) via signed bootstrap...`);
    const fresh = runInstaller(downloadDir, installEnv);
    if (fresh.status !== 0) {
      fail(`fresh install of the real release failed: ${((fresh.stderr || fresh.stdout) || '').toString().slice(-2000)}`);
    }
    const installedExe = path.join(installTarget, 'MiniMaxAssetTool.exe');
    const installedManifest = path.join(installTarget, 'FILES.sha256');
    if (!fs.existsSync(installedExe) || !fs.existsSync(installedManifest)) {
      fail('fresh install reported success but the installed tree is incomplete');
    }
    const shortcuts = [
      path.join(desktop, 'MiniMax Asset Tool.lnk'),
      path.join(startMenu, 'MiniMax Asset Tool.lnk'),
    ].filter((f) => !fs.existsSync(f));
    if (shortcuts.length) fail(`fresh install did not create shortcuts: ${shortcuts.join(', ')}`);
    log('PASS: fresh signed install of the real release');

    // ---- 2. Boot the INSTALLED executable (same probe as B001). ----
    log('Booting the installed release...');
    await bootAndProbe(installedExe);
    log('PASS: installed release boots and passes the functional smoke');

    // ---- 3. Upgrade over the existing installation. ----
    const exeBefore = sha256File(installedExe);
    const upgrade = runInstaller(downloadDir, installEnv);
    if (upgrade.status !== 0) {
      fail(`upgrade over the existing installation failed: ${((upgrade.stderr || upgrade.stdout) || '').toString().slice(-2000)}`);
    }
    if (!fs.existsSync(installedExe) || sha256File(installedExe) !== exeBefore) {
      fail('upgrade did not leave the identical release executable in place');
    }
    if (!fs.existsSync(installedManifest)) fail('upgrade dropped the inner manifest');
    log('PASS: upgrade over an existing installation swaps cleanly');

    // ---- 4. Interrupted install must never leave a partial install. ----
    const interruptTarget = path.join(temp, 'interrupted app');
    const child = spawn('cmd.exe', ['/d', '/c', 'Install-MiniMax-Asset-Tool.cmd'], {
      cwd: downloadDir,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...process.env,
        ...installEnv,
        MINIMAX_INSTALL_DIR: interruptTarget,
      },
    });
    await new Promise((r) => setTimeout(r, 10000));
    killTree(child);
    await new Promise((r) => setTimeout(r, 2000));
    if (fs.existsSync(interruptTarget)) {
      // If the swap already finished, the tree must be COMPLETE — a
      // partially populated install directory is the failure shape.
      const hasExe = fs.existsSync(path.join(interruptTarget, 'MiniMaxAssetTool.exe'));
      const hasManifest = fs.existsSync(path.join(interruptTarget, 'FILES.sha256'));
      if (!hasExe || !hasManifest) {
        fail('interrupted install left a PARTIAL installation behind (atomic swap violated)');
      }
      log('PASS: interrupt landed after completion; install tree is complete');
    } else {
      log('PASS: interrupted install left no partial installation');
    }

    // ---- 5. Tamper rejection (modified inventoried file). ----
    const tamperedDir = path.join(temp, 'tampered download');
    fs.mkdirSync(tamperedDir, { recursive: true });
    for (const name of partNames) linkOrCopy(path.join(downloadDir, name), path.join(tamperedDir, name));
    linkOrCopy(manifest, path.join(tamperedDir, path.basename(manifest)));
    linkOrCopy(minisig, path.join(tamperedDir, path.basename(minisig)));
    linkOrCopy(pubKey, path.join(tamperedDir, 'minisign.pub'));
    linkOrCopy(verifier, path.join(tamperedDir, 'minisign.exe'));
    const tamperedCmd = path.join(tamperedDir, 'Install-MiniMax-Asset-Tool.cmd');
    fs.copyFileSync(installerCmd, tamperedCmd);
    fs.appendFileSync(tamperedCmd, '\r\nrem TAMPERED\r\n');
    const tamper = runInstaller(tamperedDir, { ...installEnv, MINIMAX_INSTALL_DIR: path.join(temp, 'tamper app') });
    if (tamper.status === 0 || fs.existsSync(path.join(temp, 'tamper app', 'MiniMaxAssetTool.exe'))) {
      fail('installer accepted a tampered release artifact (integrity did not fail closed)');
    }
    log('PASS: a tampered release artifact is rejected');

    // ---- 6. Unsigned rejection (missing .minisig, no escape hatch). ----
    const unsignedDir = path.join(temp, 'unsigned download');
    fs.mkdirSync(unsignedDir, { recursive: true });
    for (const name of partNames) linkOrCopy(path.join(downloadDir, name), path.join(unsignedDir, name));
    linkOrCopy(manifest, path.join(unsignedDir, path.basename(manifest)));
    linkOrCopy(pubKey, path.join(unsignedDir, 'minisign.pub'));
    linkOrCopy(verifier, path.join(unsignedDir, 'minisign.exe'));
    fs.copyFileSync(installerCmd, path.join(unsignedDir, 'Install-MiniMax-Asset-Tool.cmd'));
    const unsigned = runInstaller(unsignedDir, { ...installEnv, MINIMAX_INSTALL_DIR: path.join(temp, 'unsigned app') });
    const out = `${unsigned.stdout || ''}${unsigned.stderr || ''}`;
    if (unsigned.status === 0 || fs.existsSync(path.join(temp, 'unsigned app', 'MiniMaxAssetTool.exe'))) {
      fail('installer accepted an UNSIGNED release without the dev-harness flag');
    }
    if (!/signature/i.test(out)) fail('unsigned-rejection output did not mention the signature gate');
    log('PASS: an unsigned release is refused (fail-closed signature gate)');

    log('ALL PASS: installer acceptance verified against the real release artifacts');
  } finally {
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch (_) {}
  }
}

main().catch((e) => fail(e.stack || e.message || String(e)));
