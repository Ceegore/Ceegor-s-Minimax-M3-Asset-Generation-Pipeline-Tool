// Adversarial probe for H-018 (installer manifest completeness checker).
// Runs the EXACT PowerShell logic embedded in "Install MiniMax Asset Tool.cmd"
// against doctored trees. Expectation: every attack shape must be REJECTED.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const cmd = fs.readFileSync(path.join(ROOT, 'Install MiniMax Asset Tool.cmd'), 'utf8');
const line = cmd.split(/\r?\n/).find((l) => l.includes('MINIMAX_INSTALL_DIR_FOR_HASH') && l.includes('powershell'));
if (!line) { console.log('H018-EXTRACT FAIL: powershell verification line not found'); process.exit(1); }
const ps = line.replace(/^\s*powershell\.exe\s+-NoProfile\s+-NonInteractive\s+-Command\s+"/, '').replace(/"\s*$/, '');

function sha(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function makeTree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h018-probe-'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'AAA');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), 'BBB');
  const lines = [`${sha('AAA')}  a.txt`, `${sha('BBB')}  sub/b.txt`].sort();
  fs.writeFileSync(path.join(dir, 'FILES.sha256'), lines.join('\n') + '\n');
  return dir;
}
function runCheck(dir) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    env: { ...process.env, MINIMAX_INSTALL_DIR_FOR_HASH: dir, MINIMAX_MANIFEST_MIN_ENTRIES: '1' },
    encoding: 'utf8', windowsHide: true,
  });
  return { status: r.status, out: ((r.stdout || '') + (r.stderr || '')).trim() };
}
const cases = [];
// Baseline: valid tree must PASS.
{ const d = makeTree(); const r = runCheck(d); cases.push(['baseline valid tree accepted', r.status === 0, r.out]); fs.rmSync(d, { recursive: true, force: true }); }
// Attack 1: tamper a file.
{ const d = makeTree(); fs.appendFileSync(path.join(d, 'a.txt'), 'X'); const r = runCheck(d); cases.push(['tampered file rejected', r.status !== 0 && /TAMPERED/.test(r.out), r.out]); fs.rmSync(d, { recursive: true, force: true }); }
// Attack 2: extra unlisted file.
{ const d = makeTree(); fs.writeFileSync(path.join(d, 'sub', 'evil.dll'), 'MZ'); const r = runCheck(d); cases.push(['extra unlisted file rejected', r.status !== 0 && /UNLISTED/.test(r.out), r.out]); fs.rmSync(d, { recursive: true, force: true }); }
// Attack 3: duplicate manifest entry.
{ const d = makeTree(); const m = path.join(d, 'FILES.sha256'); fs.writeFileSync(m, fs.readFileSync(m, 'utf8') + `${sha('AAA')}  a.txt\n`); const r = runCheck(d); cases.push(['duplicate entry rejected', r.status !== 0 && /DUPLICATE/.test(r.out), r.out]); fs.rmSync(d, { recursive: true, force: true }); }
// Attack 4: malformed line.
{ const d = makeTree(); const m = path.join(d, 'FILES.sha256'); fs.writeFileSync(m, fs.readFileSync(m, 'utf8') + 'not-a-hash-line\n'); const r = runCheck(d); cases.push(['malformed line rejected', r.status !== 0 && /MALFORMED/.test(r.out), r.out]); fs.rmSync(d, { recursive: true, force: true }); }
// Attack 5: manifest lists a file that is missing on disk.
{ const d = makeTree(); const m = path.join(d, 'FILES.sha256'); fs.writeFileSync(m, fs.readFileSync(m, 'utf8') + `${sha('CCC')}  ghost.txt\n`); const r = runCheck(d); cases.push(['missing listed file rejected', r.status !== 0 && /MISSING/.test(r.out), r.out]); fs.rmSync(d, { recursive: true, force: true }); }
// Attack 6: nearly-empty manifest (min entries gate).
{ const d = makeTree(); fs.writeFileSync(path.join(d, 'FILES.sha256'), `${sha('AAA')}  a.txt\n`); const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { env: { ...process.env, MINIMAX_INSTALL_DIR_FOR_HASH: d, MINIMAX_MANIFEST_MIN_ENTRIES: '50' }, encoding: 'utf8', windowsHide: true }); const out = ((r.stdout || '') + (r.stderr || '')).trim(); cases.push(['too-small manifest rejected (min 50)', r.status !== 0 && /TOO SMALL/.test(out), out]); fs.rmSync(d, { recursive: true, force: true }); }

let ok = true;
for (const [name, pass, out] of cases) {
  console.log(`${pass ? 'PASS' : 'FAIL'} H018 ${name}${pass ? '' : ` :: ${out.slice(0, 200)}`}`);
  if (!pass) ok = false;
}
process.exit(ok ? 0 : 1);
