// scripts/build-dev-zip.js
//
// Dev-Build-Zip with node_modules.
//
// Instead of building a signed MiniMaxAssetTool.exe for a development handoff,
// this package uses the Electron runtime from node_modules. This can reduce
// reputation friction, but it does not guarantee that security software will
// allow every download or launch. This packs the entire project including
// node_modules into a
// zip. The user extracts it and double-clicks start.cmd, which launches
// the official Electron runtime from node_modules. It is widely deployed,
// but neither this repository nor Electron's npm package can promise that a
// particular Windows security product will trust every download or launch.
//
// Advantages over a built .exe:
//   1. No custom application executable is introduced
//   2. No code-signing required
//   3. start.cmd is a text file — its hash never changes
//   4. Recipients need no node.js — everything is in the zip
//
// Disadvantages:
//   1. The zip is ~1.1 GB (node_modules + bin + source)
//   2. The user cannot easily sign the zip
//
// Usage:
//   node scripts/build-dev-zip.js

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const STAGE = path.join(ROOT, '.dev-zip-stage');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
// QA-024 fix: output to the same dist-out/ directory used by releasePaths()
// and the verifier, so `npm run status` and `verify-release.js` inspect the
// same artifact family as the builder produces.
const DIST_OUT = path.resolve(ROOT, PKG.build?.directories?.output || 'dist-out');
const ZIP_PATH = path.join(DIST_OUT, `MiniMaxAssetTool-Dev-${PKG.version}-x64.zip`);

// What goes into the zip: node_modules + bin + source + start.cmd.
// NOT included: build output and temporary staging directories.
// H7-005: dev-only dirs (tests/, .githooks, linter) are excluded by default
// to shrink the artifact — the end user never runs the test suite. Set
// DEVZIP_INCLUDE_TESTS=1 to bundle them (useful for a QA hand-off).
const DEV_EXTRAS = (process.env.DEVZIP_INCLUDE_TESTS === '1')
  ? ['tests', '.githooks', 'linter']
  : [];
const FILES_TO_INCLUDE = [
  'package.json',
  'package-lock.json',
  'main.js',
  'preload.js',
  'main',
  'src',
  'renderer',
  'scripts',
  'start.cmd',
  'bin',
  'node_modules',
  '.gitignore',
  'README.md',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'IMAGE_STYLE_PRESETS_ENGLISH_v2.0.md',
  ...DEV_EXTRAS,
];

const SEVEN_ZIP = path.join(ROOT, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');

function rimraf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function copyDir(src, dst) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const sp = path.join(src, entry.name);
    const dp = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(sp, dp);
    else fs.copyFileSync(sp, dp);
  }
}
function copyFile(src, dst) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function writeChecksum() {
  if (!fs.existsSync(ZIP_PATH)) throw new Error(`Archive not found: ${ZIP_PATH}`);
  const sha256 = await sha256File(ZIP_PATH);
  const manifestPath = ZIP_PATH + '.sha256';
  fs.writeFileSync(manifestPath, `${sha256}  ${path.basename(ZIP_PATH)}\n`, 'utf8');
  return { manifestPath, sha256 };
}

async function main() {
  if (process.argv.includes('--checksum-only')) {
    const { manifestPath, sha256 } = await writeChecksum();
    console.log(`SHA-256: ${sha256}`);
    console.log(`Manifest: ${manifestPath}`);
    return;
  }
  console.log('=== Dev-Zip Builder ===');
  console.log();
  console.log('Packs the whole project including node_modules into a zip.');
  console.log('       Extract and double-click start.cmd — it launches the');
  console.log('       official Electron runtime. Security software may still prompt.');
  console.log();

  // 1. Build the stage
  rimraf(STAGE);
  fs.mkdirSync(STAGE, { recursive: true });

  let totalSize = 0;
  for (const f of FILES_TO_INCLUDE) {
    const src = path.join(ROOT, f);
    const dst = path.join(STAGE, f);
    if (!fs.existsSync(src)) {
      console.log('  [skip] ' + f + ' (not present)');
      continue;
    }
    const st = fs.statSync(src);
    if (st.isDirectory()) {
      copyDir(src, dst);
      const size = (function dirSize(dir) {
        let s = 0;
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) s += dirSize(p);
          else s += fs.statSync(p).size;
        }
        return s;
      })(src);
      totalSize += size;
      console.log('  [dir ] ' + f + ' (' + (size / 1024 / 1024).toFixed(1) + ' MB)');
    } else {
      copyFile(src, dst);
      totalSize += st.size;
      console.log('  [file] ' + f + ' (' + (st.size / 1024).toFixed(1) + ' KB)');
    }
  }

  console.log();
  console.log('Stage size: ' + (totalSize / 1024 / 1024).toFixed(1) + ' MB');
  console.log();

  // H7-005: GitHub release attachments are capped at 2 GB per file. The dev
  // zip (full project + node_modules + models) regularly exceeds that. We
  // decide up front whether to split: the compressed archive is ~60-70% of
  // the raw stage size for this mix, so a stage over ~2.9 GB reliably
  // produces a >2 GB zip. Build with `-v1990m` (1990 MiB volumes, safely
  // under the 2 GB cap) in that case; otherwise produce a single archive.
  // Set DEVZIP_NO_SPLIT=1 to force a single archive even when large.
  const TWO_GB = 2 * 1024 * 1024 * 1024;
  const willLikelyExceed = totalSize > 2.9 * 1024 * 1024 * 1024;
  const wantSplit = willLikelyExceed && process.env.DEVZIP_NO_SPLIT !== '1';
  const zipArgs = ['a', '-snl-', '-mx=7'];
  if (wantSplit) zipArgs.push('-v1990m');
  zipArgs.push(ZIP_PATH, STAGE + '/*');

  // 2. Build the zip
  try { fs.unlinkSync(ZIP_PATH); } catch (_) {}
  // Also clear any stale split volumes from a previous run.
  try {
    for (const name of fs.readdirSync(path.dirname(ZIP_PATH))) {
      if (new RegExp('^' + escapeRegExp(path.basename(ZIP_PATH)) + '\\.\\d{3}$').test(name)) {
        fs.unlinkSync(path.join(path.dirname(ZIP_PATH), name));
      }
    }
  } catch (_) {}
  await new Promise((resolve, reject) => {
    const proc = spawn(SEVEN_ZIP, zipArgs, { stdio: 'inherit', windowsHide: true });
    proc.on('close', (code) => code === 0 ? resolve() : reject(new Error('exit ' + code)));
    proc.on('error', (error) => reject(new Error(`Could not start 7-Zip at ${SEVEN_ZIP}: ${error.message}`)));
  });

  rimraf(STAGE);
  // Determine the final artifact(s): either a single .zip or a .001/.002/… set.
  let finalPaths;
  if (wantSplit) {
    finalPaths = fs.readdirSync(path.dirname(ZIP_PATH))
      .filter((name) => new RegExp('^' + escapeRegExp(path.basename(ZIP_PATH)) + '\\.\\d{3}$').test(name))
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
      .map((name) => path.join(path.dirname(ZIP_PATH), name));
  } else {
    finalPaths = [ZIP_PATH];
  }
  const manifestPath = await writeChecksumMulti(finalPaths);
  console.log();
  console.log('=== DONE ===');
  for (const p of finalPaths) {
    console.log('  ' + p + '  (' + (fs.statSync(p).size / 1024 / 1024).toFixed(1) + ' MB)');
  }
  console.log('  SHA-256 manifest: ' + manifestPath);
  console.log();
  console.log('Usage:');
  console.log('  1. Extract the zip into any folder (if split: download all .001/.002/… parts');
  console.log('     into the same folder, then extract from the .001 part with 7-Zip).');
  console.log('  2. Double-click start.cmd');
  console.log('  3. The tool launches; follow any Windows security prompt if one appears.');
}

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Write a checksum manifest covering the final archive(s). For a single zip
// the manifest lives at <zip>.sha256 (back-compat with the old writeChecksum).
// For a split set it covers every .NNN part. Each line is
// "<sha256>  <basename>".
async function writeChecksumMulti(paths) {
  const lines = [];
  for (const p of paths) {
    const hash = await sha256File(p);
    lines.push(hash + '  ' + path.basename(p));
  }
  const manifestPath = paths[0] + '.sha256';
  fs.writeFileSync(manifestPath, lines.join('\n') + '\n', 'utf8');
  return manifestPath;
}

main().catch((e) => { console.error(e); process.exit(1); });
