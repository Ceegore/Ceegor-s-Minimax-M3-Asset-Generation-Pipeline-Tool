// RR2-H007 (release requalification 1.0.4 recheck-2): the Authenticode
// gate must cover output-ROOT PEs (e.g. the bundled minisign.exe) and the
// staged publication tree — not only the app exe + win-unpacked.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { evaluate } = require('../../../scripts/verify-release');

test('RR2-H007: an unsigned output-root PE fails the Authenticode gate', { timeout: 60000 }, () => {
  if (process.platform !== 'win32') return; // Authenticode is Windows-only
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rr2-h007-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'fixture', version: '9.8.7',
      build: { productName: 'FixtureTool', directories: { output: 'out' } },
    }));
    const out = path.join(root, 'out');
    fs.mkdirSync(out, { recursive: true });
    // Minimal MZ header so PowerShell treats it as a binary candidate.
    const mz = Buffer.alloc(128);
    mz.write('MZ', 0, 'ascii');
    fs.writeFileSync(path.join(out, 'minisign.exe'), mz);
    const report = evaluate(root, { requireAuthenticode: true });
    assert.ok(
      report.errors.some((e) => /Authenticode check failed for output-root binary minisign\.exe/.test(e)),
      `expected an output-root Authenticode failure, got: ${report.errors.join(' | ')}`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
