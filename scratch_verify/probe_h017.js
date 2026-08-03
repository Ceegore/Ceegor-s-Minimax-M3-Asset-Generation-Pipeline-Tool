// Adversarial probe for H-017 (bootstrap archive verification: minisig + checksums).
// Executes the EXACT PowerShell block from the installer CMD with:
//  1. valid checksums, no signature         -> must extract
//  2. forged/invalid signature + fake tool   -> must ABORT
//  3. tampered archive + valid signature env -> must ABORT on checksum
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const cmd = fs.readFileSync(path.join(ROOT, 'Install MiniMax Asset Tool.cmd'), 'utf8');
const line = cmd.split(/\r?\n/).find((l) => l.includes('MINIMAX_ARCHIVE_FIRST') && l.includes('powershell'));
const ps = line.replace(/^\s*powershell\.exe\s+-NoProfile\s+-NonInteractive\s+-Command\s+"/, '').replace(/"\s*$/, '');

function sha(f) { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); }

// Build a tiny independent part zip via bundled 7za.
const sevenZip = path.join(ROOT, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');
const baseName = 'MiniMaxAssetTool-8.8.8-x64';
function makeFixture(withSig) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'h017-probe-'));
  const dir = path.join(temp, 'dl');
  const app = path.join(temp, baseName);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(app, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(app, 'MiniMaxAssetTool.exe'), 'exe');
  fs.writeFileSync(path.join(app, 'nested', 'f.txt'), 'f');
  const zip = path.join(dir, `${baseName}.zip`);
  const add = spawnSync(sevenZip, ['a', '-tzip', '-mx=0', zip, baseName], { cwd: temp, encoding: 'utf8', windowsHide: true });
  if (add.status !== 0) throw new Error('zip failed: ' + add.stderr);
  fs.writeFileSync(path.join(dir, `${baseName}.sha256`), `${sha(zip)}  ${baseName}.zip\n`);
  if (withSig) {
    fs.writeFileSync(path.join(dir, `${baseName}.sha256.minisig`), 'untrusted comment: forged\nfake-sig\n');
    fs.writeFileSync(path.join(dir, 'minisign.pub'), 'untrusted comment: pinned key\nfake-pub\n');
    // Fake minisign.exe: exits 1 when called with -V (simulates INVALID signature).
    fs.writeFileSync(path.join(dir, 'minisign.exe.cmd'), '@echo off\r\nexit /b 1\r\n');
    fs.writeFileSync(path.join(dir, 'minisign.exe'), fs.readFileSync(path.join(dir, 'minisign.exe.cmd')));
  }
  return { temp, dir, zip };
}
function runBootstrap(dir, zip, extractDir) {
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    env: { ...process.env, MINIMAX_ARCHIVE_FIRST: zip, MINIMAX_EXTRACT_DIR: extractDir },
    encoding: 'utf8', windowsHide: true, timeout: 120000,
  });
}
const results = [];
// Case 1: no signature, correct checksum -> success + extracted tree.
{
  const { temp, dir, zip } = makeFixture(false);
  const extract = path.join(temp, 'x'); fs.mkdirSync(extract);
  const r = runBootstrap(dir, zip, extract);
  const extracted = fs.existsSync(path.join(extract, baseName, 'nested', 'f.txt'));
  results.push(['unsigned release with valid checksum extracts', r.status === 0 && extracted, (r.stderr || '').slice(0, 150)]);
  fs.rmSync(temp, { recursive: true, force: true });
}
// Case 2: forged signature + verification tool present -> ABORT.
{
  const { temp, dir, zip } = makeFixture(true);
  const extract = path.join(temp, 'x'); fs.mkdirSync(extract);
  const r = runBootstrap(dir, zip, extract);
  const out = (r.stdout || '') + (r.stderr || '');
  results.push(['invalid .minisig aborts install', r.status !== 0 && /INVALID|minisig|signature/i.test(out), out.slice(0, 200)]);
  fs.rmSync(temp, { recursive: true, force: true });
}
// Case 3: tampered archive (checksum mismatch) -> ABORT.
{
  const { temp, dir, zip } = makeFixture(false);
  fs.appendFileSync(zip, 'TAMPER');
  const extract = path.join(temp, 'x'); fs.mkdirSync(extract);
  const r = runBootstrap(dir, zip, extract);
  const out = (r.stdout || '') + (r.stderr || '');
  results.push(['tampered archive aborts on checksum', r.status !== 0 && /Checksum mismatch/.test(out), out.slice(0, 200)]);
  fs.rmSync(temp, { recursive: true, force: true });
}
let ok = true;
for (const [name, pass, detail] of results) {
  console.log(`${pass ? 'PASS' : 'FAIL'} H017 ${name}${pass ? '' : ' :: ' + detail}`);
  if (!pass) ok = false;
}
process.exit(ok ? 0 : 1);
