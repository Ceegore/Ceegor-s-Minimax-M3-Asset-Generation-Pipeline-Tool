// scripts/zip-portable.js
// The "build" wrapper. Produces a portable .zip the end user can
// extract and run without installing anything.
//
// Why a wrapper instead of `electron-builder --win zip` or
// `electron-builder --win portable`? electron-builder's zip /
// portable / nsis / msi / appx / dir targets all depend on the
// winCodeSign toolchain (signtool.exe + rcedit.exe + osslsigncode)
// which it downloads + extracts via 7-Zip. The 7-Zip extraction
// fails on Windows accounts without `SeCreateSymbolicLinkPrivilege`
// because the winCodeSign archive ships macOS code-signing
// symlinks (darwin/10.12/lib/*.dylib) that 7-Zip tries to recreate
// on Windows.
//
// There is no build-config workaround for this — the
// extraction command is hardcoded inside electron-builder. The
// only fixes are operating-system level:
//   1. Enable Windows Developer Mode (one-time, 30s).
//   2. Run the build from an elevated PowerShell.
//   3. Or just run as admin.
//
// This script detects the failure and prints the exact fix. It
// also bundles the winCodeSign archive with `-snl-` (skip
// symlinks) and re-uses it via `ELECTRON_BUILDER_CACHE` when
// possible, so the build succeeds without privileges in some
// cases (it depends on which electron-builder internals trip
// over the symlinks first).

const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { verifyRuntimeAssets } = require('./lib/runtimeAssets');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist-out');
const UNPACKED = path.join(DIST, 'win-unpacked');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = PKG.version;
// The user-facing release folder name. Every archive stores its files under
// this single top-level folder, so "Extract here" yields exactly one folder.
const BASE_NAME = `MiniMaxAssetTool-${VERSION}-x64`;
const STAGE = path.join(DIST, BASE_NAME);
const ZIP_PATH = path.join(DIST, `${BASE_NAME}.zip`);
const MANIFEST_PATH = path.join(DIST, `${BASE_NAME}.sha256`);
const REQUIRE_CODE_SIGNING = process.env.REQUIRE_CODE_SIGNING === '1';

function log(m) { process.stdout.write(m + '\n'); }
function fail(m) { process.stderr.write('✖  ' + m + '\n'); process.exit(1); }

// Detect the winCodeSign symlink extraction failure in a chunk of
// stderr from electron-builder. The exact string we look for:
//   ERROR: Cannot create symbolic link : ... : libcrypto.dylib
// (with `SeCreateSymbolicLinkPrivilege` missing, the error code
// is 1314 / "Dem Client fehlt ein erforderliches Recht" on
// German Windows, "A required privilege is not held by the
// client" on English Windows).
function looksLikeSymlinkPrivilegeError(text) {
  if (!text) return false;
  return /Cannot create symbolic link/i.test(text)
      || /fehlt ein erforderliches Recht/i.test(text)
      || /required privilege is not held/i.test(text);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(cmd, args, { stdio: ['inherit', 'pipe', 'pipe'], windowsHide: true, ...opts });
    } catch (err) { reject(err); return; }
    let combined = '';
    proc.stdout.on('data', (b) => { process.stdout.write(b); combined += b.toString('utf8'); });
    proc.stderr.on('data', (b) => { process.stderr.write(b); combined += b.toString('utf8'); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(combined);
      else reject(Object.assign(new Error(`${path.basename(cmd)} exited with code ${code}`), { combined, code }));
    });
  });
}

function find7za() {
  const candidates = [
    path.join(ROOT, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe'),
    path.join(ROOT, 'node_modules', '7zip-bin', 'mac', '7za'),
    path.join(ROOT, 'node_modules', '7zip-bin', 'linux', '7za'),
    '/usr/bin/7z',
    '/usr/local/bin/7z',
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return null;
}

// Write a build provenance record next to the release archive. The verifier
// (scripts/verify-release.js) reads it back and refuses to PASS a stale or
// tampered release whose asar/Electron version no longer matches the recorded
// build. This closes the H7-003 gap where a stale dist-out shipped as if it
// were the current source.
function writeProvenance() {
  const provPath = path.join(DIST, `MiniMaxAssetTool-${VERSION}-x64.provenance.json`);
  let electronVersion = null;
  try {
    const elPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8'));
    electronVersion = elPkg.version || null;
  } catch (_) { /* electron not installed (unexpected mid-build) */ }
  let commit = null, commitDirty = null;
  try {
    const r = spawnSync('git', ['-C', ROOT, 'rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8', windowsHide: true });
    if (r.status === 0) commit = r.stdout.trim();
    const d = spawnSync('git', ['-C', ROOT, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true });
    if (d.status === 0) commitDirty = d.stdout.trim().length > 0;
  } catch (_) { /* git not available */ }
  let asarSha256 = null;
  const asarPath = path.join(UNPACKED, 'resources', 'app.asar');
  try {
    if (fs.existsSync(asarPath)) {
      asarSha256 = crypto.createHash('sha256').update(fs.readFileSync(asarPath)).digest('hex');
    }
  } catch (_) { /* best-effort */ }
  const record = {
    version: VERSION,
    electronVersion,
    nodeVersion: process.version,
    commit,
    commitDirty,
    asarSha256,
    builtAt: new Date().toISOString(),
  };
  fs.writeFileSync(provPath, JSON.stringify(record, null, 2) + '\n', 'utf8');
  log('  provenance: ' + provPath);
  return provPath;
}

function printPrivilegeFix() {
  log('');
  log('═══════════════════════════════════════════════════════════════════');
  log('  Build failed: missing SeCreateSymbolicLinkPrivilege');
  log('═══════════════════════════════════════════════════════════════════');
  log('');
  log('electron-builder needs to recreate macOS code-signing symlinks');
  log('inside the winCodeSign archive. On Windows, this requires the');
  log('`SeCreateSymbolicLinkPrivilege` which is OFF by default for normal');
  log('user accounts.');
  log('');
  log('Fixes (pick one, one-time):');
  log('');
  log('  1. Enable Windows Developer Mode (recommended, 30 seconds):');
  log('       Settings → Privacy & security → For developers');
  log('       → Developer Mode → On');
  log('     (Or run the one-liner below from an admin PowerShell:');
  log('       reg add "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion');
  log('         \\AppModelUnlock" /t REG_DWORD /f /v');
  log('         "AllowDevelopmentWithoutDevLicense" /d "1" )');
  log('');
  log('  2. Run the build from an elevated PowerShell:');
  log('       Start-Process powershell -Verb RunAs');
  log('       # then re-run: npm run build');
  log('');
  log('  3. Run the build as the local administrator:');
  log('       # only works if the build runs under an admin account.');
  log('');
  log('After enabling Developer Mode, just re-run `npm run build` — no');
  log('code change required.');
  log('═══════════════════════════════════════════════════════════════════');
}

(async () => {
  log('Step 0: verifying the complete offline runtime...');
  const sourceRuntime = verifyRuntimeAssets(path.join(ROOT, 'bin'));
  if (!sourceRuntime.ok) {
    fail('offline runtime is incomplete or changed:\n  ' + sourceRuntime.issues.join('\n  ') + '\nRun `npm run setup` and retry.');
  }
  log(`  ${sourceRuntime.count} files verified (${(sourceRuntime.totalBytes / 1073741824).toFixed(2)} GiB)`);

  // Clean dist/ so a previous failure state doesn't leak in.
  await fsp.rm(UNPACKED, { recursive: true, force: true });
  await fsp.rm(STAGE, { recursive: true, force: true });
  await fsp.rm(ZIP_PATH, { force: true });
  const staleBase = path.basename(ZIP_PATH).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const stalePartBase = BASE_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const name of await fsp.readdir(DIST).catch(() => [])) {
    if (new RegExp(`^${staleBase}\\.\\d{3}$`).test(name) // legacy raw-split volumes
      || new RegExp(`^${stalePartBase}\\.part\\d+\\.zip$`).test(name)
      || name === `${path.basename(ZIP_PATH)}.sha256` // legacy manifest name
      || name === `${BASE_NAME}.sha256`
      || name === `MiniMaxAssetTool-${VERSION}-x64.provenance.json`
      || name === 'Install MiniMax Asset Tool.cmd'
      || name === 'Install-MiniMax-Asset-Tool.cmd') {
      await fsp.rm(path.join(DIST, name), { force: true });
    }
  }

  // ---- Step 1: build the unpacked directory ----
  log('Step 1/2: building dist/win-unpacked/ via electron-builder --win dir...');
  const isWin = process.platform === 'win32';
  const electronBuilder = path.join(ROOT, 'node_modules', '.bin', isWin ? 'electron-builder.cmd' : 'electron-builder');
  let step1Output = '';
  try {
    if (isWin) {
      step1Output = await run('cmd.exe', ['/c', electronBuilder, '--win', 'dir', '--x64', ...(REQUIRE_CODE_SIGNING ? ['-c.forceCodeSigning=true'] : [])], { cwd: ROOT });
    } else {
      step1Output = await run(electronBuilder, ['--win', 'dir', '--x64', ...(REQUIRE_CODE_SIGNING ? ['-c.forceCodeSigning=true'] : [])], { cwd: ROOT });
    }
  } catch (e) {
    if (looksLikeSymlinkPrivilegeError(e.combined)) {
      printPrivilegeFix();
      process.exit(1);
    }
    fail('electron-builder --win dir failed: ' + (e && e.message || e));
  }

  if (!fs.existsSync(UNPACKED)) {
    fail('electron-builder did not produce ' + UNPACKED);
  }

  // Keep the end-user license and third-party obligations visible next to
  // the executable instead of burying them inside app.asar.
  for (const name of ['START HERE.txt', 'Install MiniMax Asset Tool.cmd', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    const source = path.join(ROOT, name);
    if (!fs.existsSync(source)) fail(`required end-user file is missing: ${name}`);
    await fsp.copyFile(source, path.join(UNPACKED, name));
  }
  await fsp.copyFile(
    path.join(ROOT, 'scripts', 'runtime-assets.json'),
    path.join(UNPACKED, 'OFFLINE_RUNTIME_MANIFEST.json'),
  );
  if (REQUIRE_CODE_SIGNING) {
    const verify = path.join(ROOT, 'scripts', 'verify-release.js');
    try {
      await run(process.execPath, [verify, '--require-signature'], { cwd: ROOT });
    } catch (_) {
      fail('release build did not produce a validly signed executable. Configure WIN_CSC_LINK/WIN_CSC_KEY_PASSWORD or Azure Trusted Signing.');
    }
  }

  // ---- Step 1.5: copy ./bin/ into dist/win-unpacked/resources/bin/ ----
  // Copy the verified source assets into `resources/bin/`, which is the
  // standard Electron location used by the runtime wrappers. This explicit
  // step avoids electron-builder copying untracked developer fixtures and
  // makes the manifest the one source of truth for the release payload.
  //
  // We do a SELECTIVE copy rather than a blanket `cpSync` of the
  // whole bin/ — the source dir often contains Real-ESRGAN test
  // fixtures (input.jpg, onepiece_demo.mp4, README_windows.md) that
  // are useful for the developer but bloat the end-user .zip by
  // 5+ MB and confuse users ("why is there a pirate video in my
  // installer?"). Only the runtime-essential files ship.
  const sourceBin = path.join(ROOT, 'bin');
  const destBin = path.join(UNPACKED, 'resources', 'bin');
  // Each entry is a source relative path (file or directory) that
  // the end-user's app needs at runtime. Models directory is
  // copied wholesale — IS-Net + Real-ESRGAN model files all live
  // there. The `vcomp140*.dll` are the VC++ 2015 Redistributable
  // Real-ESRGAN links against at runtime; without them the
  // binary fails to start on a clean machine.
  const SHIP_ENTRIES = [
    'models',
    'realesrgan-ncnn-vulkan.exe',
    'realesrgan-ncnn-vulkan',
    'vcomp140.dll',
    'vcomp140d.dll',
  ];
  if (fs.existsSync(sourceBin)) {
    log('');
    log('Step 1.5: copying runtime assets into dist/win-unpacked/resources/bin/...');
    // Wipe dest first so files from a previous build (e.g. a
    // full cpSync of the source bin/ that included test fixtures)
    // don't leak into the new .zip. fs.rmSync with {recursive,
    // force} is the no-throw variant we want here.
    fs.rmSync(destBin, { recursive: true, force: true });
    fs.mkdirSync(destBin, { recursive: true });
    let total = 0;
    let copied = 0;
    for (const entry of SHIP_ENTRIES) {
      const src = path.join(sourceBin, entry);
      const dst = path.join(destBin, entry);
      if (!fs.existsSync(src)) {
        // Real-ESRGAN exe is the only required entry here; the
        // rest are optional. The C# isnetbg.exe (if the developer
        // built one) is also optional and won't be in source bin/
        // unless they explicitly copied it there.
        if (entry === 'realesrgan-ncnn-vulkan.exe' || entry === 'realesrgan-ncnn-vulkan') {
          log('  (skip) ' + entry + ' — not present in source bin/');
        }
        continue;
      }
      const stat = fs.statSync(src);
      if (stat.isDirectory()) {
        fs.cpSync(src, dst, { recursive: true, dereference: false });
      } else {
        fs.copyFileSync(src, dst);
      }
      copied++;
      total += (function walk(p) {
        if (!fs.statSync(p).isDirectory()) return fs.statSync(p).size;
        let s = 0;
        function w(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const pp = path.join(d, e.name); if (e.isDirectory()) w(pp); else s += fs.statSync(pp).size; } }
        w(p);
        return s;
      })(dst);
      log('  + ' + entry + '  (' + (function (p) {
        if (!fs.statSync(p).isDirectory()) return (fs.statSync(p).size / 1024 / 1024).toFixed(1) + ' MB';
        let s = 0; function w(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const pp = path.join(d, e.name); if (e.isDirectory()) w(pp); else s += fs.statSync(pp).size; } } w(p); return (s / 1024 / 1024).toFixed(1) + ' MB'; })(dst) + ')');
    }
    log('  copied ' + copied + ' entries (' + (total / 1024 / 1024).toFixed(1) + ' MB total)');
    const packagedRuntime = verifyRuntimeAssets(destBin);
    if (!packagedRuntime.ok) {
      fail('packaged offline runtime is incomplete or changed:\n  ' + packagedRuntime.issues.join('\n  '));
    }
    log(`  verified ${packagedRuntime.count} packaged runtime files by SHA-256`);
  } else {
    fail('./bin/ is missing. Run `npm run setup` before building a release.');
  }

  log('');
  log('Step 1.6: checking the exact packaged dependency tree...');
  try {
    await run(process.execPath, [
      path.join(ROOT, 'scripts', 'check-bundled-deps.js'),
      `--release-dir=${UNPACKED}`,
    ], { cwd: ROOT });
  } catch (e) {
    fail('packaged dependency check failed: ' + ((e && e.message) || e));
  }

  log('');
  log('Step 1.7: testing the no-admin installer and its shortcuts...');
  try {
    await run(process.execPath, [path.join(ROOT, 'scripts', 'test-release-installer.js'), UNPACKED], { cwd: ROOT });
  } catch (e) {
    fail('installer test failed: ' + ((e && e.message) || e));
  }

  // ---- Step 2: zip the release folder ----
  log('');
  log('Step 2/2: zipping the release into ' + BASE_NAME + ' archive(s)...');
  const sevenZip = find7za();
  if (!sevenZip) {
    fail('7-Zip binary not found. Reinstall electron-builder (`npm install`).');
  }
  // QA-023 fix: GitHub release attachments are capped at 2 GiB per file.
  // When the unpacked directory is large enough that a single archive would
  // exceed the cap, produce INDEPENDENT part zips (.part1.zip, .part2.zip,
  // ...) instead of a raw 7-Zip volume split. Raw .zip.001 volumes forced the
  // user through a join step: extracting .001 yielded a nested inner .zip
  // (renamed "...zip(1)" by Windows) that had to be extracted AGAIN. Each
  // part here is a complete, standalone zip whose entries all live under the
  // top-level `MiniMaxAssetTool-<version>-x64/` folder — extracting every
  // part into the same destination merges them into that one folder.
  const unpackedSize = (function dirSize(d) {
    let s = 0;
    function w(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) w(p); else s += fs.statSync(p).size; } }
    w(d); return s;
  })(UNPACKED);
  const SPLIT_THRESHOLD = 2.9 * 1024 * 1024 * 1024; // ~2.9 GB raw → >1.9 GB compressed
  // Raw-size cap per part. Compressed output is ≤ raw size for deflate (plus
  // negligible header overhead), so 1900 MiB raw stays safely under 2 GiB.
  const PART_RAW_CAP = 1900 * 1024 * 1024;
  const wantSplit = unpackedSize > SPLIT_THRESHOLD && process.env.ZIP_NO_SPLIT !== '1';
  if (wantSplit) {
    log('  Unpacked size: ' + (unpackedSize / 1024 / 1024).toFixed(0) + ' MB — producing independent part zips (≤ 1900 MiB raw each).');
  }
  // Zip from a staging folder named like the release so the archive's single
  // top-level folder is `MiniMaxAssetTool-<version>-x64/` (NOT `win-unpacked`).
  // Renamed back afterwards so verify-release.js and the provenance asar path
  // keep working against dist-out/win-unpacked/.
  fs.renameSync(UNPACKED, STAGE);
  let finalPaths = [];
  try {
    // -snl- to skip symbolic links (defensive; the unpacked dir
    // shouldn't contain any, but if it does we want the zip to
    // succeed on accounts without SeCreateSymbolicLinkPrivilege).
    if (!wantSplit) {
      await run(sevenZip, ['a', '-snl-', '-bb', '-mx=7', ZIP_PATH, BASE_NAME], { cwd: DIST });
      finalPaths = [ZIP_PATH];
    } else {
      // Partition the files greedily by raw size, then zip each partition as
      // its own archive via a 7za listfile (paths relative to DIST so the
      // stored entries keep the `MiniMaxAssetTool-<version>-x64/` prefix).
      const files = [];
      (function walk(dir) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) walk(p); else files.push(p);
        }
      })(STAGE);
      const partitions = [[]];
      let partSize = 0;
      for (const f of files) {
        const size = fs.statSync(f).size;
        if (partSize + size > PART_RAW_CAP && partitions[partitions.length - 1].length > 0) {
          partitions.push([]);
          partSize = 0;
        }
        partitions[partitions.length - 1].push(f);
        partSize += size;
      }
      for (let i = 0; i < partitions.length; i++) {
        const partPath = path.join(DIST, `${BASE_NAME}.part${i + 1}.zip`);
        const listFile = path.join(DIST, `.zip-part${i + 1}.list.txt`);
        fs.writeFileSync(listFile, partitions[i].map((f) => path.relative(DIST, f)).join('\r\n') + '\r\n', 'utf8');
        try {
          await run(sevenZip, ['a', '-snl-', '-mx=7', '-scsUTF-8', partPath, '@' + listFile], { cwd: DIST });
        } finally {
          fs.rmSync(listFile, { force: true });
        }
        finalPaths.push(partPath);
        log('  part ' + (i + 1) + '/' + partitions.length + ': ' + path.basename(partPath) + '  (' + (fs.statSync(partPath).size / 1024 / 1024).toFixed(1) + ' MB)');
      }
    }
  } catch (e) {
    // Restore the standard folder name before failing so a re-run (and the
    // verifier) still find dist-out/win-unpacked/.
    try { fs.renameSync(STAGE, UNPACKED); } catch (_) { /* best-effort */ }
    if (looksLikeSymlinkPrivilegeError(e.combined)) {
      printPrivilegeFix();
      process.exit(1);
    }
    fail('7-Zip zipping failed: ' + (e && e.message || e));
  }
  fs.renameSync(STAGE, UNPACKED);

  // Publish the same dual-purpose installer beside the archive. It can verify
  // and extract the part zips using built-in Windows tools, or install
  // directly when it is run from inside the extracted release.
  const easyInstallerPath = path.join(DIST, 'Install-MiniMax-Asset-Tool.cmd');
  await fsp.copyFile(path.join(ROOT, 'Install MiniMax Asset Tool.cmd'), easyInstallerPath);
  // Write a .sha256 checksum manifest alongside the archive(s).
  const checksumLines = [];
  for (const fp of [...finalPaths, easyInstallerPath]) {
    const h = crypto.createHash('sha256');
    const fd = fs.openSync(fp, 'r');
    const buf = Buffer.alloc(64 * 1024);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.slice(0, n));
    fs.closeSync(fd);
    checksumLines.push(h.digest('hex') + '  ' + path.basename(fp));
  }
  fs.writeFileSync(MANIFEST_PATH, checksumLines.join('\n') + '\n', 'utf8');

  log('');
  log('Step 3: writing build provenance...');
  writeProvenance();
  log('');
  log('Done. Output:');
  for (const fp of finalPaths) {
    log('  ' + fp + '  (' + (fs.statSync(fp).size / 1024 / 1024).toFixed(1) + ' MB)');
  }
  log('  Checksums: ' + MANIFEST_PATH);
  log('');
  if (wantSplit) {
    log('To install: download the CMD, checksum, and all .part1.zip/.part2.zip/...');
    log('parts into the same folder, then double-click the CMD. No archiver is needed.');
    log('(Manual route: extract EVERY part into the same folder — they merge into');
    log('one ' + BASE_NAME + ' folder.)');
  } else {
    log('To install on a target machine, extract the .zip and run MiniMaxAssetTool.exe inside the extracted ' + BASE_NAME + ' folder.');
  }
})().catch((e) => {
  fail(String((e && e.stack) || e));
});
