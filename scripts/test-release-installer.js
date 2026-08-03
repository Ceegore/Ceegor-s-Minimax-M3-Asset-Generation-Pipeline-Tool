'use strict';

const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const releaseDir = path.resolve(process.argv[2] || path.join(ROOT, 'dist-out', 'win-unpacked'));
// H-015/M-002 (hhhhu3 audit): always test the CURRENT installer from the repo
// root — a stale copy inside an old build output (dist-out) would silently
// validate the previous release's installer instead of the fixed one.
const installer = path.join(ROOT, 'Install MiniMax Asset Tool.cmd');
const executable = path.join(releaseDir, 'MiniMaxAssetTool.exe');

function fail(message) {
  process.stderr.write(`[test-release-installer] FAIL: ${message}\n`);
  process.exitCode = 1;
}

// B-001/M-002 (hhhhu3 audit): the installer fails closed when the inner
// FILES.sha256 manifest is absent, so every test fixture must generate a
// complete manifest for its mock release tree â€” exactly the way
// zip-portable.js does for the real release (relative paths, '/' separated,
// FILES.sha256 itself excluded, sorted by path).
function writeInnerManifest(treeDir) {
  const lines = [];
  (function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(full); continue; }
      if (ent.name === 'FILES.sha256') continue;
      const digest = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
      lines.push(`${digest}  ${path.relative(treeDir, full).replace(/\\/g, '/')}`);
    }
  })(treeDir);
  lines.sort((a, b) => a.slice(66).localeCompare(b.slice(66)));
  fs.writeFileSync(path.join(treeDir, 'FILES.sha256'), lines.join('\n') + '\n', 'utf8');
}

function runInstaller(cwd, extraEnv) {
  return spawnSync('cmd.exe', ['/d', '/c', path.join(cwd, path.basename(installer))], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      // The fixtures are tiny stand-ins for the real tree; relax the
      // production minimum-entry count (50) for the completeness check.
      MINIMAX_MANIFEST_MIN_ENTRIES: '1',
      ...extraEnv,
    },
  });
}

if (process.platform !== 'win32') {
  process.stdout.write('[test-release-installer] SKIP: Windows-only installer\n');
  process.exit(0);
}
if (!fs.existsSync(installer) || !fs.existsSync(executable)) {
  fail(`complete release not found at ${releaseDir}`);
} else {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-installer-test-'));
  const mockSource = path.join(temp, 'source with spaces');
  const installTarget = path.join(temp, 'installed app');
  const desktop = path.join(temp, 'Desktop');
  const startMenu = path.join(temp, 'StartMenu');
  try {
    const mockFiles = [
      'MiniMaxAssetTool.exe',
      path.join('resources', 'app.asar'),
      path.join('resources', 'bin', 'models', 'isnet-general-use.onnx'),
      path.join('resources', 'bin', 'models', 'birefnet-general.onnx'),
      path.join('resources', 'bin', 'models', 'lama-big.onnx'),
      path.join('resources', 'bin', 'realesrgan-ncnn-vulkan.exe'),
      path.join('nested', 'copy-sentinel.txt'),
    ];
    fs.mkdirSync(mockSource, { recursive: true });
    fs.copyFileSync(installer, path.join(mockSource, path.basename(installer)));
    for (const item of mockFiles) {
      const target = path.join(mockSource, item);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'installer test', 'utf8');
    }
    // M-002 (hhhhu3 audit): the fixture carries the mandatory inner manifest.
    writeInnerManifest(mockSource);

    const result = runInstaller(mockSource, {
      MINIMAX_INSTALL_DIR: installTarget,
      MINIMAX_INSTALL_DESKTOP: desktop,
      MINIMAX_INSTALL_START_MENU: startMenu,
      MINIMAX_INSTALL_NO_LAUNCH: '1',
    });
    if (result.status !== 0) {
      fail(`installer exited with ${result.status}: ${(result.stderr || result.stdout || '').trim()}`);
    } else {
      const links = [
        path.join(desktop, 'MiniMax Asset Tool.lnk'),
        path.join(startMenu, 'MiniMax Asset Tool.lnk'),
      ];
      const copiedSentinel = path.join(installTarget, 'nested', 'copy-sentinel.txt');
      const missing = [...links, copiedSentinel].filter((item) => !fs.existsSync(item));
      if (missing.length) {
        fail(`shortcut creation failed: ${missing.join(', ')}`);
      } else {
        const escaped = links[0].replace(/'/g, "''");
        const probe = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${escaped}'); [Console]::Write($s.TargetPath)`], {
          encoding: 'utf8', windowsHide: true,
        });
        const installedExecutable = path.join(installTarget, 'MiniMaxAssetTool.exe');
        if (probe.status !== 0 || path.resolve(probe.stdout.trim()) !== installedExecutable) {
          fail('shortcut does not point to the packaged executable');
        } else {
          process.stdout.write('[test-release-installer] PASS: no-admin install validation and shortcuts work\n');
        }
      }
    }

    // M-002 (hhhhu3 audit): UPGRADE over an existing installation. The old
    // swap used `ren` with full destination paths (invalid in Windows) â€” this
    // case exercises the exact code path that broke upgrades (H-015).
    const upgradeTarget = path.join(temp, 'upgrade app');
    fs.mkdirSync(path.join(upgradeTarget, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(upgradeTarget, 'MiniMaxAssetTool.exe'), 'OLD RELEASE', 'utf8');
    fs.writeFileSync(path.join(upgradeTarget, 'nested', 'old-release-marker.txt'), 'old', 'utf8');
    const upgradeResult = runInstaller(mockSource, {
      MINIMAX_INSTALL_DIR: upgradeTarget,
      MINIMAX_INSTALL_DESKTOP: desktop,
      MINIMAX_INSTALL_START_MENU: startMenu,
      MINIMAX_INSTALL_NO_LAUNCH: '1',
    });
    const upgradedSentinel = path.join(upgradeTarget, 'nested', 'copy-sentinel.txt');
    const staleMarker = path.join(upgradeTarget, 'nested', 'old-release-marker.txt');
    if (upgradeResult.status !== 0) {
      fail(`upgrade over an existing installation failed: ${(upgradeResult.stderr || upgradeResult.stdout || '').trim()}`);
    } else if (!fs.existsSync(upgradedSentinel)) {
      fail('upgrade did not install the new release files');
    } else if (fs.existsSync(staleMarker)) {
      fail('upgrade left stale files from the previous installation behind');
    } else {
      process.stdout.write('[test-release-installer] PASS: upgrade over an existing installation swaps cleanly\n');
    }

    // M-002 (hhhhu3 audit): SOURCE-EQUALS-INSTALL path. Re-running the
    // installer inside the installed directory used to jump to a missing
    // :shortcuts label (H-016); it must refresh shortcuts and exit cleanly.
    const sameDirResult = runInstaller(upgradeTarget, {
      MINIMAX_INSTALL_DIR: upgradeTarget,
      MINIMAX_INSTALL_DESKTOP: desktop,
      MINIMAX_INSTALL_START_MENU: startMenu,
      MINIMAX_INSTALL_NO_LAUNCH: '1',
    });
    if (sameDirResult.status !== 0) {
      fail(`source-equals-install path failed: ${(sameDirResult.stderr || sameDirResult.stdout || '').trim()}`);
    } else {
      process.stdout.write('[test-release-installer] PASS: running the installer inside the install directory refreshes shortcuts\n');
    }

    // M-002 (hhhhu3 audit): TAMPER REJECTION. A file modified after the
    // manifest was written must fail the integrity check (fail closed).
    const tamperSource = path.join(temp, 'tampered source');
    fs.cpSync(mockSource, tamperSource, { recursive: true });
    fs.appendFileSync(path.join(tamperSource, 'MiniMaxAssetTool.exe'), 'TAMPERED');
    const tamperResult = runInstaller(tamperSource, {
      MINIMAX_INSTALL_DIR: path.join(temp, 'tamper install'),
      MINIMAX_INSTALL_DESKTOP: desktop,
      MINIMAX_INSTALL_START_MENU: startMenu,
      MINIMAX_INSTALL_NO_LAUNCH: '1',
    });
    if (tamperResult.status === 0) {
      fail('installer accepted a tampered release tree (integrity check did not fail closed)');
    } else {
      process.stdout.write('[test-release-installer] PASS: a tampered release tree is rejected by the integrity check\n');
    }
  } finally {
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch (_) {}
  }
}

// Exercise the end-user path before publishing: the CMD sits beside a small
// multipart archive and must verify, extract, and install it without an
// external archiver. Each part is an INDEPENDENT zip whose entries live under
// the same MiniMaxAssetTool-<version>-x64 top folder (mirrors zip-portable.js).
// This fixture stays tiny; the release payload is checked separately by
// check-bundled-deps.js and runtime-assets.json.
const bootstrapInstaller = path.join(ROOT, 'Install MiniMax Asset Tool.cmd');
if (process.platform === 'win32' && fs.existsSync(bootstrapInstaller)) {
  const sevenZip = path.join(ROOT, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');
  if (!fs.existsSync(sevenZip)) {
    fail('bundled 7za is missing; cannot create the multipart installer fixture');
  } else {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-bootstrap-test-'));
    const downloadDir = path.join(temp, 'download with spaces');
    const baseName = 'MiniMaxAssetTool-9.9.9-x64';
    const appDir = path.join(temp, baseName);
    const installTarget = path.join(temp, 'installed app');
    const desktop = path.join(temp, 'Desktop');
    const startMenu = path.join(temp, 'StartMenu');
    try {
      fs.mkdirSync(downloadDir, { recursive: true });
      fs.mkdirSync(appDir, { recursive: true });
      fs.copyFileSync(bootstrapInstaller, path.join(downloadDir, path.basename(bootstrapInstaller)));
      fs.copyFileSync(bootstrapInstaller, path.join(appDir, path.basename(bootstrapInstaller)));
      const mockFiles = [
        'MiniMaxAssetTool.exe',
        path.join('resources', 'app.asar'),
        path.join('resources', 'bin', 'models', 'isnet-general-use.onnx'),
        path.join('resources', 'bin', 'models', 'birefnet-general.onnx'),
        path.join('resources', 'bin', 'models', 'lama-big.onnx'),
        path.join('resources', 'bin', 'realesrgan-ncnn-vulkan.exe'),
        path.join('nested', 'bootstrap-sentinel.bin'),
      ];
      for (const item of mockFiles) {
        const target = path.join(appDir, item);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, item.endsWith('.bin') ? crypto.randomBytes(16384) : 'installer test');
      }
      // M-002 (hhhhu3 audit): the inner tree inside the archive also carries
      // the mandatory FILES.sha256 manifest.
      writeInnerManifest(appDir);
      // Two independent part zips, each holding a slice of the SAME top folder
      // (extracting both into one destination must merge into that folder).
      const partContents = [
        [`${baseName}\\MiniMaxAssetTool.exe`, `${baseName}\\resources`],
        [`${baseName}\\nested`, `${baseName}\\FILES.sha256`, `${baseName}\\${path.basename(bootstrapInstaller)}`],
      ];
      let madeOk = true;
      for (let i = 0; i < partContents.length; i++) {
        const partPath = path.join(downloadDir, `${baseName}.part${i + 1}.zip`);
        const made = spawnSync(sevenZip, ['a', '-tzip', '-mx=0', partPath, ...partContents[i]], {
          cwd: temp, encoding: 'utf8', windowsHide: true,
        });
        if (made.status !== 0) {
          fail(`could not create multipart installer fixture: ${(made.stderr || made.stdout || '').trim()}`);
          madeOk = false;
          break;
        }
      }
      if (madeOk) {
        const parts = fs.readdirSync(downloadDir)
          .filter((name) => /^MiniMaxAssetTool-9\.9\.9-x64\.part\d+\.zip$/.test(name))
          .sort();
        const lines = parts.map((name) => {
          const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(downloadDir, name))).digest('hex');
          return `${digest}  ${name}`;
        });
        fs.writeFileSync(path.join(downloadDir, `${baseName}.sha256`), `${lines.join('\n')}\n`, 'utf8');
        const result = runInstaller(downloadDir, {
          MINIMAX_INSTALL_DIR: installTarget,
          MINIMAX_INSTALL_DESKTOP: desktop,
          MINIMAX_INSTALL_START_MENU: startMenu,
          MINIMAX_INSTALL_NO_LAUNCH: '1',
        });
        const expected = [
          path.join(installTarget, 'nested', 'bootstrap-sentinel.bin'),
          path.join(desktop, 'MiniMax Asset Tool.lnk'),
          path.join(startMenu, 'MiniMax Asset Tool.lnk'),
        ];
        const missing = expected.filter((item) => !fs.existsSync(item));
        if (result.status !== 0 || missing.length) {
          fail(`multipart easy install failed: ${(result.stderr || result.stdout || '').trim()}${missing.length ? `; missing ${missing.join(', ')}` : ''}`);
        } else {
          process.stdout.write(`[test-release-installer] PASS: multipart checksum, built-in extraction, and install work (${parts.length} independent parts)\n`);
        }
      }
    } finally {
      try { fs.rmSync(temp, { recursive: true, force: true }); } catch (_) {}
    }
  }
}


