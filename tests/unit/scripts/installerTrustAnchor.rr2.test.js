// RR2-C001 (release requalification 1.0.4 recheck-2): the installer's
// trust anchor must be EMBEDDED at build time, not the neighbouring
// minisign.pub from the same untrusted download folder. finalize stamps
// the pinned public key + verifier SHA-256 into the published installer.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { stampInstallerTrustAnchor } = require('../../../scripts/finalize-release-inventory');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const INSTALLER_SRC = path.join(ROOT, 'Install MiniMax Asset Tool.cmd');

function sha256File(fp) {
  return crypto.createHash('sha256').update(fs.readFileSync(fp)).digest('hex');
}

function fixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr2-c001-'));
  const output = path.join(tmp, 'out');
  fs.mkdirSync(output, { recursive: true });
  fs.copyFileSync(INSTALLER_SRC, path.join(output, 'Install-MiniMax-Asset-Tool.cmd'));
  const pubSrc = path.join(tmp, 'pinned.pub');
  fs.writeFileSync(pubSrc, 'untrusted comment: minimax pinned key\nRWQExampleKeyLine1234567890\n');
  fs.writeFileSync(path.join(output, 'minisign.exe'), 'FAKE-VERIFIER-BYTES');
  return { tmp, paths: { output }, pubSrc };
}

function withCapturedExit(fn) {
  const origExit = process.exit;
  process.exit = (c) => { throw new Error(`__EXIT__${c}`); };
  try {
    fn();
    return { exited: false };
  } catch (e) {
    if (String(e.message).startsWith('__EXIT__')) return { exited: true };
    throw e;
  } finally {
    process.exit = origExit;
  }
}

test('RR2-C001: finalize embeds the pinned key + verifier hash into the published installer', () => {
  const { tmp, paths, pubSrc } = fixture();
  try {
    stampInstallerTrustAnchor(paths, pubSrc);
    const stamped = fs.readFileSync(path.join(paths.output, 'Install-MiniMax-Asset-Tool.cmd'), 'utf8');
    // Every non-empty key line became an embedded array append.
    assert.ok(stamped.includes("$embeddedKeyLines+='untrusted comment: minimax pinned key';"), 'comment line embedded');
    assert.ok(stamped.includes("$embeddedKeyLines+='RWQExampleKeyLine1234567890';"), 'key line embedded');
    // The verifier placeholder is replaced by the real SHA-256.
    assert.ok(!stamped.includes('RR2-C001-VERIFIER-SHA256'), 'placeholder replaced');
    assert.ok(stamped.includes(sha256File(path.join(paths.output, 'minisign.exe'))), 'verifier hash embedded');
    // Idempotence: a second stamp must not double-embed.
    stampInstallerTrustAnchor(paths, pubSrc);
    const again = fs.readFileSync(path.join(paths.output, 'Install-MiniMax-Asset-Tool.cmd'), 'utf8');
    assert.equal(again, stamped);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('RR2-C001: an installer without the markers fails closed', () => {
  const { tmp, paths, pubSrc } = fixture();
  try {
    const p = path.join(paths.output, 'Install-MiniMax-Asset-Tool.cmd');
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/RR2-C001-BEGIN-EMBEDDED-MINISIGN-PUBKEY/g, 'X'));
    const r = withCapturedExit(() => stampInstallerTrustAnchor(paths, pubSrc));
    assert.equal(r.exited, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('RR2-C001: single quotes in key material are PowerShell-escaped', () => {
  const { tmp, paths, pubSrc } = fixture();
  try {
    fs.writeFileSync(pubSrc, "untrusted comment: it's pinned\nRWQX\n");
    stampInstallerTrustAnchor(paths, pubSrc);
    const stamped = fs.readFileSync(path.join(paths.output, 'Install-MiniMax-Asset-Tool.cmd'), 'utf8');
    assert.ok(stamped.includes("$embeddedKeyLines+='untrusted comment: it''s pinned';"), 'quote escaped');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('RR2-C001: the repository installer template still carries the markers', () => {
  const template = fs.readFileSync(INSTALLER_SRC, 'utf8');
  assert.ok(template.includes('# RR2-C001-BEGIN-EMBEDDED-MINISIGN-PUBKEY'));
  assert.ok(template.includes('# RR2-C001-END-EMBEDDED-MINISIGN-PUBKEY'));
  assert.ok(template.includes('RR2-C001-VERIFIER-SHA256'));
  // The template must NOT ship a pre-embedded key.
  assert.ok(!template.includes("$embeddedKeyLines+='"), 'template must stay unstamped in the repo');
});
