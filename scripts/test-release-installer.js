'use strict';

const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const releaseDir = path.resolve(process.argv[2] || path.join(ROOT, 'dist-out', 'win-unpacked'));
const installer = path.join(releaseDir, 'Install MiniMax Asset Tool.cmd');
const executable = path.join(releaseDir, 'MiniMaxAssetTool.exe');

function fail(message) {
  process.stderr.write(`[test-release-installer] FAIL: ${message}\n`);
  process.exitCode = 1;
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

    const result = spawnSync('cmd.exe', ['/d', '/c', path.join(mockSource, path.basename(installer))], {
      cwd: mockSource,
      encoding: 'utf8',
      windowsHide: true,
      env: {
        ...process.env,
        MINIMAX_INSTALL_DIR: installTarget,
        MINIMAX_INSTALL_DESKTOP: desktop,
        MINIMAX_INSTALL_START_MENU: startMenu,
        MINIMAX_INSTALL_NO_LAUNCH: '1',
      },
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
      // Two independent part zips, each holding a slice of the SAME top folder
      // (extracting both into one destination must merge into that folder).
      const partContents = [
        [`${baseName}\\MiniMaxAssetTool.exe`, `${baseName}\\resources`],
        [`${baseName}\\nested`, `${baseName}\\${path.basename(bootstrapInstaller)}`],
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
        const result = spawnSync('cmd.exe', ['/d', '/c', path.join(downloadDir, path.basename(bootstrapInstaller))], {
          cwd: downloadDir,
          encoding: 'utf8',
          windowsHide: true,
          env: {
            ...process.env,
            MINIMAX_INSTALL_DIR: installTarget,
            MINIMAX_INSTALL_DESKTOP: desktop,
            MINIMAX_INSTALL_START_MENU: startMenu,
            MINIMAX_INSTALL_NO_LAUNCH: '1',
          },
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
