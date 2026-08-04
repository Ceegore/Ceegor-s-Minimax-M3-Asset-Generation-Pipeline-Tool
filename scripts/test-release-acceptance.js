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
//   3. Upgrade: a REAL old->new upgrade when MINIMAX_PREV_RELEASE_DIR
//      points at a complete previous signed release (stale-file removal
//      included); otherwise a same-version reinstall (RR2-H003).
//   4. Deterministic interrupt: the installer's MINIMAX_INSTALL_FAULT_
//      BEFORE_SWAP hook aborts exactly between staging-verify and swap;
//      the existing installation must stay byte-identical (RR2-H003).
//   5. Tamper rejection — a modified inventoried file must fail closed.
//   6. Unsigned rejection — removing the .minisig must fail closed when
//      the dev-harness escape hatch is absent.
//
// RR2-H002: archive discovery reuses releaseArtifacts.archiveFiles(), so
// BOTH the unsplit <base>.zip and the .partN.zip forms are accepted.
// Node built-ins only (no npm ci needed on the clean-VM runner).
// ============================================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { bootAndProbe } = require('./e2e/real-release-boot');
const { archiveFiles, releasePaths, validateArchiveSequence } = require('./releaseArtifacts');

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

// RR2-H002: shared discovery for BOTH release forms (unsplit .zip wins,
// otherwise the .partN.zip sequence), in any directory.
function discoverRelease(dir, baseNameHint) {
  if (!fs.existsSync(dir)) return { ok: false, error: `directory not found: ${dir}` };
  let baseName = baseNameHint;
  if (!baseName) {
    // Unknown version (e.g. a previous release dir): derive from the files.
    const unsplit = fs.readdirSync(dir).filter((f) => /^MiniMaxAssetTool-.+-x64\.zip$/.test(f)).sort();
    const part1 = fs.readdirSync(dir).filter((f) => /^MiniMaxAssetTool-.+-x64\.part1\.zip$/.test(f)).sort();
    if (unsplit.length) baseName = unsplit[0].replace(/\.zip$/, '');
    else if (part1.length) baseName = part1[0].replace(/\.part1\.zip$/, '');
    else return { ok: false, error: `no release archive found in ${dir}` };
  }
  const paths = { output: dir, baseName, archive: path.join(dir, `${baseName}.zip`) };
  const archives = archiveFiles(paths);
  if (archives.length === 0) return { ok: false, error: `no release archive found in ${dir}` };
  const seq = validateArchiveSequence(paths);
  if (!seq.ok) return { ok: false, error: `archive sequence invalid in ${dir}: ${seq.error}` };
  const required = [
    path.join(dir, `${baseName}.sha256`),
    path.join(dir, `${baseName}.sha256.minisig`),
    path.join(dir, 'minisign.pub'),
    path.join(dir, 'minisign.exe'),
    path.join(dir, 'Install-MiniMax-Asset-Tool.cmd'),
  ];
  const missing = required.filter((f) => !fs.existsSync(f)).map((f) => path.basename(f));
  if (missing.length) return { ok: false, error: `release in ${dir} is incomplete: ${missing.join(', ')}` };
  return { ok: true, dir, baseName, archives, paths };
}

// RR2-H003: full-tree fingerprint (relative path -> sha256) for the
// byte-identical rollback assertion.
function snapshotTree(dir) {
  const out = {};
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs, r);
      else if (e.isFile()) out[r] = sha256File(abs);
    }
  };
  walk(dir, '');
  return out;
}

// Copy a complete release (archives + manifest + sig + key + verifier +
// installer) into a download directory exactly as an end user has it.
function materializeDownload(rel, downloadDir) {
  fs.mkdirSync(downloadDir, { recursive: true });
  for (const a of rel.archives) linkOrCopy(a, path.join(downloadDir, path.basename(a)));
  for (const f of [
    path.join(rel.dir, `${rel.baseName}.sha256`),
    path.join(rel.dir, `${rel.baseName}.sha256.minisig`),
    path.join(rel.dir, 'minisign.pub'),
    path.join(rel.dir, 'minisign.exe'),
  ]) linkOrCopy(f, path.join(downloadDir, path.basename(f)));
  fs.copyFileSync(path.join(rel.dir, 'Install-MiniMax-Asset-Tool.cmd'), path.join(downloadDir, 'Install-MiniMax-Asset-Tool.cmd'));
}

async function main() {
  if (process.platform !== 'win32') {
    log('SKIP: the shipped release is Windows-only');
    return;
  }

  // ---- Locate the real release artifacts (fail closed when absent). ----
  // RR2-H002: shared releaseArtifacts discovery — unsplit .zip AND parts.
  const rp = releasePaths(ROOT);
  const rel = discoverRelease(DIST, rp.baseName);
  if (!rel.ok) {
    fail(`${rel.error} — acceptance must install the exact downloaded release, not a fixture`);
  }
  const baseName = rel.baseName;
  const partNames = rel.archives.map((f) => path.basename(f));
  const manifest = path.join(DIST, `${baseName}.sha256`);
  const minisig = path.join(DIST, `${baseName}.sha256.minisig`);
  const pubKey = path.join(DIST, 'minisign.pub');
  const verifier = path.join(DIST, 'minisign.exe');
  const installerCmd = path.join(DIST, 'Install-MiniMax-Asset-Tool.cmd');

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
    materializeDownload(rel, downloadDir);

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

    // ---- 3. Upgrade: real old->new when a previous release is given. ----
    // RR2-H003: MINIMAX_PREV_RELEASE_DIR points at a COMPLETE previous
    // signed release. The scenario then is: install OLD -> plant a stale
    // file -> upgrade to NEW -> the whole tree is replaced (stale file
    // gone, new exe + new inner manifest in place). Without a previous
    // release the same-version reinstall still proves the swap mechanics.
    const prevDirEnv = process.env.MINIMAX_PREV_RELEASE_DIR;
    const upgradeTarget = path.join(temp, 'upgrade app');
    if (prevDirEnv) {
      const prevRel = discoverRelease(path.resolve(prevDirEnv));
      if (!prevRel.ok) fail(`MINIMAX_PREV_RELEASE_DIR is set but unusable: ${prevRel.error}`);
      if (prevRel.baseName === baseName) {
        fail('MINIMAX_PREV_RELEASE_DIR points at the SAME version — a real upgrade test needs an older release');
      }
      const prevDownload = path.join(temp, 'prev download');
      materializeDownload(prevRel, prevDownload);
      const upgradeEnv = { ...installEnv, MINIMAX_INSTALL_DIR: upgradeTarget };
      log(`Installing the previous release ${prevRel.baseName}...`);
      const prevInstall = runInstaller(prevDownload, upgradeEnv);
      if (prevInstall.status !== 0) {
        fail(`install of the previous release failed: ${((prevInstall.stderr || prevInstall.stdout) || '').toString().slice(-2000)}`);
      }
      // Plant a stale file that only the old installation has.
      const stale = path.join(upgradeTarget, 'stale-old-release-file.txt');
      fs.writeFileSync(stale, 'leftover from the old release');
      log(`Upgrading ${prevRel.baseName} -> ${baseName}...`);
      const upgrade = runInstaller(downloadDir, upgradeEnv);
      if (upgrade.status !== 0) {
        fail(`real old->new upgrade failed: ${((upgrade.stderr || upgrade.stdout) || '').toString().slice(-2000)}`);
      }
      const upgradedExe = path.join(upgradeTarget, 'MiniMaxAssetTool.exe');
      if (!fs.existsSync(upgradedExe)) fail('upgrade lost the executable');
      if (sha256File(upgradedExe) !== sha256File(installedExe)) {
        fail('upgrade did not land the NEW release executable (still the old bytes)');
      }
      if (fs.existsSync(stale)) fail('upgrade kept a stale file from the old release (the swap must replace the whole tree)');
      if (!fs.existsSync(path.join(upgradeTarget, 'FILES.sha256'))) fail('upgrade dropped the inner manifest');
      log(`PASS: real old->new upgrade ${prevRel.baseName} -> ${baseName} replaces the tree and removes stale files`);
    } else {
      const exeBefore = sha256File(installedExe);
      const upgrade = runInstaller(downloadDir, installEnv);
      if (upgrade.status !== 0) {
        fail(`reinstall over the existing installation failed: ${((upgrade.stderr || upgrade.stdout) || '').toString().slice(-2000)}`);
      }
      if (!fs.existsSync(installedExe) || sha256File(installedExe) !== exeBefore) {
        fail('reinstall did not leave the identical release executable in place');
      }
      if (!fs.existsSync(installedManifest)) fail('reinstall dropped the inner manifest');
      log('PASS: same-version reinstall swaps cleanly (set MINIMAX_PREV_RELEASE_DIR for a real old->new upgrade)');
    }

    // ---- 4. Deterministic interrupt exactly before the swap. ----
    // RR2-H003: the installer honours MINIMAX_INSTALL_FAULT_BEFORE_SWAP=1
    // by aborting AFTER staging verification and BEFORE the swap. With an
    // existing installation in place this is the critical moment: the old
    // tree must remain BYTE-IDENTICAL and no staging/old dirs may linger.
    const beforeFault = snapshotTree(installTarget);
    const fault = runInstaller(downloadDir, { ...installEnv, MINIMAX_INSTALL_FAULT_BEFORE_SWAP: '1' });
    if (fault.status === 0) fail('fault-injected install must abort before the swap');
    const afterFault = snapshotTree(installTarget);
    const drifted = Object.keys(beforeFault).filter((k) => afterFault[k] !== beforeFault[k])
      .concat(Object.keys(afterFault).filter((k) => !(k in beforeFault)));
    if (drifted.length) {
      fail(`pre-swap fault changed the existing installation: ${drifted.slice(0, 8).join(', ')}${drifted.length > 8 ? '...' : ''}`);
    }
    const targetName = path.basename(installTarget);
    const leftovers = fs.readdirSync(path.dirname(installTarget))
      .filter((f) => f.startsWith(`${targetName}.staging-`) || f.startsWith(`${targetName}.old-`));
    if (leftovers.length) fail(`pre-swap fault left staging debris behind: ${leftovers.join(', ')}`);
    log('PASS: deterministic pre-swap fault leaves the existing installation byte-identical');

    // ---- 5. Tamper rejection (modified archive byte). ----
    // RR2 note: the tamper flips a real byte in the archive itself, so the
    // published checksums no longer match — the bootstrap must refuse it.
    const tamperedDir = path.join(temp, 'tampered download');
    materializeDownload(rel, tamperedDir);
    const victimName = path.basename(rel.archives[0]);
    const victim = path.join(tamperedDir, victimName);
    // materializeDownload may hardlink; never mutate a link to the source.
    fs.rmSync(victim, { force: true });
    fs.copyFileSync(rel.archives[0], victim);
    // Flip ONE byte in the middle of the archive via positional I/O (parts
    // can be multi-GB — never buffer them whole).
    const fd = fs.openSync(victim, 'r+');
    try {
      const pos = Math.floor(fs.fstatSync(fd).size / 2);
      const one = Buffer.alloc(1);
      fs.readSync(fd, one, 0, 1, pos);
      one[0] ^= 0xff;
      fs.writeSync(fd, one, 0, 1, pos);
    } finally {
      fs.closeSync(fd);
    }
    const tamper = runInstaller(tamperedDir, { ...installEnv, MINIMAX_INSTALL_DIR: path.join(temp, 'tamper app') });
    if (tamper.status === 0 || fs.existsSync(path.join(temp, 'tamper app', 'MiniMaxAssetTool.exe'))) {
      fail('installer accepted a tampered release archive (integrity did not fail closed)');
    }
    log('PASS: a tampered release archive is rejected');

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
