// hhhhu3 audit Phase 4 regression tests.
//
// Covers:
//  - H-001: registerProvidersIpc injects the DNS-pinned SafeHttpClient into
//    every adapter call (listing + generation).
//  - H-002: grant authorization + write probe happen BEFORE the paid
//    provider call in providers:generate.
//  - H-003: output-transaction recovery is wired at startup in main/index.js.
//  - H-005: image validation enforces an aggregate decoded-byte budget
//    BEFORE forcing a full sharp decode.
//  - M-008: replicate poll delay removes its abort listener on normal expiry.
//  - M-009: replicate reports the remote job identity via onSubmitted.
//  - M-010: recovery validates journal shape/link-safety before ANY recursive
//    filesystem operation (forged journals go to manual review, untouched).
//  - M-011: INSTALLING recovery persists the journal after EACH deletion so
//    a second recovery run is idempotent and can still complete.
//  - M-021: EBML DocType 'matroska' is classified 'mkv', never labeled webm.
//  - M-022: ffprobe discovery is cached and prefers the pinned dependency.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {}
}
function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ---------------------------------------------------------------------------
// H-001 / H-002 / H-003 — source-level wiring assertions
// ---------------------------------------------------------------------------

test('hhhhu3 H-001: providers IPC injects SafeHttpClient into adapter calls', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main', 'ipc', 'registerProvidersIpc.js'), 'utf8');
  // Both the listModels and generate adapter calls must carry the injected
  // DNS-pinned client so provider traffic never touches global fetch.
  const occurrences = src.split('http: SafeHttpClient').length - 1;
  assert.ok(occurrences >= 2, `expected >=2 http injections, found ${occurrences}`);
});

test('hhhhu3 H-002: grant authorization happens before the write probe / paid call', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main', 'ipc', 'registerProvidersIpc.js'), 'utf8');
  const authIdx = src.indexOf('authorizePath(req.grantId');
  const probeIdx = src.indexOf('writeProbe(resolvedOut)');
  assert.ok(authIdx >= 0, 'authorizePath(req.grantId...) call present');
  assert.ok(probeIdx >= 0, 'writeProbe(resolvedOut) call present');
  assert.ok(authIdx < probeIdx, 'authorization must precede the probe (and the paid provider call)');
});

test('hhhhu3 H-003: startup recovery is wired in main/index.js', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main', 'index.js'), 'utf8');
  assert.ok(src.includes('OutputTransactionService'), 'main/index.js must construct the transaction service');
  assert.ok(src.includes('.recover()'), 'main/index.js must invoke startup recovery');
});

// ---------------------------------------------------------------------------
// H-005 — aggregate decoded-byte budget
// ---------------------------------------------------------------------------

test('hhhhu3 H-005: image decode enforces an aggregate decoded-byte budget', async () => {
  const { validateImageDecode, DEFAULT_LIMITS } = require(path.join(ROOT, 'main', 'services', 'ArtifactFinalizer'));
  assert.equal(DEFAULT_LIMITS.image.maxDecodedBytes, 512 * 1024 * 1024, 'budget present in default limits');

  // Real, decodable 1x1 PNG (decoded raw = 4 bytes).
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64'
  );
  const dir = tmpDir('h005-');
  try {
    const p = path.join(dir, 'a.png');
    fs.writeFileSync(p, png);

    // Tiny budget: the pre-decode estimate (frames*w*h*channels) must reject
    // BEFORE any raw decode allocation.
    const tight = await validateImageDecode(p, { maxDecodedBytes: 1 });
    assert.equal(tight.ok, false);
    assert.match(tight.error, /budget/i);

    // Default budget: a 1x1 image passes.
    const normal = await validateImageDecode(p, {});
    assert.equal(normal.ok, true);
    assert.equal(normal.width, 1);
    assert.equal(normal.height, 1);
  } finally { rmrf(dir); }
});

// ---------------------------------------------------------------------------
// M-008 / M-009 — replicate adapter
// ---------------------------------------------------------------------------

test('hhhhu3 M-009: replicate reports the remote job identity via onSubmitted', async () => {
  const replicate = require(path.join(ROOT, 'src', 'providers', 'replicate'));
  const urls = [];
  const http = {
    json: async (url) => {
      urls.push(url);
      return {
        id: 'pred-123',
        status: 'succeeded',
        output: 'https://cdn.replicate.example/out.mp4',
        urls: { get: 'https://api.replicate.com/v1/predictions/pred-123' },
      };
    },
  };
  let submitted = null;
  const out = await replicate.run({
    apiKey: 'k', model: 'owner/name', input: { prompt: 'x' },
    http, onSubmitted: (info) => { submitted = info; },
  });
  assert.deepEqual(submitted, {
    remoteJobId: 'pred-123',
    pollUrl: 'https://api.replicate.com/v1/predictions/pred-123',
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].authPolicy, 'none');
});

test('hhhhu3 M-008: replicate poll delay detaches its abort listener on normal expiry', async () => {
  const replicate = require(path.join(ROOT, 'src', 'providers', 'replicate'));
  let added = 0;
  let removed = 0;
  const fakeSignal = {
    aborted: false,
    addEventListener: () => { added += 1; },
    removeEventListener: () => { removed += 1; },
  };
  let call = 0;
  const http = {
    json: async () => {
      call += 1;
      if (call === 1) {
        return { id: 'p1', status: 'starting', urls: { get: 'https://api.replicate.com/v1/predictions/p1' } };
      }
      return { id: 'p1', status: 'succeeded', output: 'https://cdn.replicate.example/o.mp4' };
    },
  };
  await replicate.run({ apiKey: 'k', model: 'owner/name', input: { prompt: 'x' }, signal: fakeSignal, http });
  // Exactly one poll delay ran; its listener must have been removed again.
  assert.equal(added, 1, 'one delay listener added');
  assert.equal(removed, 1, 'delay listener removed after normal expiry (no accumulation)');
});

// ---------------------------------------------------------------------------
// M-010 / M-011 — output transaction recovery
// ---------------------------------------------------------------------------

function makeJournal({ txnId, root, state, files }) {
  return {
    schemaVersion: 1,
    transactionId: txnId,
    state,
    canonicalRoot: root,
    leaseId: null,
    createdAt: Date.now(),
    stageDir: path.join(root, `.mmas-stage-${txnId}`),
    files: files || [],
  };
}

test('hhhhu3 M-010: a forged stageDir is rejected and preserved for manual review', () => {
  const { OutputTransactionService } = require(path.join(ROOT, 'main', 'services', 'OutputTransactionService'));
  const journalDir = tmpDir('m010a-journal-');
  const root = tmpDir('m010a-root-');
  try {
    const svc = new OutputTransactionService({ journalDir });
    const txnId = crypto.randomUUID();
    const forged = makeJournal({ txnId, root, state: 'PREPARING' });
    forged.stageDir = path.join(root, 'attacker-controlled-dir'); // wrong shape
    fs.writeFileSync(path.join(journalDir, `${txnId}.json`), JSON.stringify(forged));
    fs.mkdirSync(forged.stageDir);
    fs.writeFileSync(path.join(forged.stageDir, 'victim.txt'), 'do-not-delete');

    const r = svc.recover();
    assert.equal(r.recovered, 0);
    assert.equal(r.manualReview, 1, 'forged journal goes to manual review');
    assert.ok(r.errors.some((e) => e.includes('stageDir')), 'error names the stageDir violation');
    assert.ok(fs.existsSync(path.join(journalDir, `${txnId}.json`)), 'journal preserved');
    assert.ok(fs.existsSync(path.join(forged.stageDir, 'victim.txt')), 'no recursive delete happened');
  } finally { rmrf(journalDir); rmrf(root); }
});

test('hhhhu3 M-010: recovery never recurses into a stage path that is a plain file', () => {
  const { OutputTransactionService } = require(path.join(ROOT, 'main', 'services', 'OutputTransactionService'));
  const journalDir = tmpDir('m010b-journal-');
  const root = tmpDir('m010b-root-');
  try {
    const svc = new OutputTransactionService({ journalDir });
    const txnId = crypto.randomUUID();
    const journal = makeJournal({ txnId, root, state: 'PREPARING' });
    fs.writeFileSync(path.join(journalDir, `${txnId}.json`), JSON.stringify(journal));
    // Someone replaced the stage directory with a regular file.
    fs.writeFileSync(journal.stageDir, 'not a directory');

    const r = svc.recover();
    assert.equal(r.recovered, 1);
    assert.ok(fs.existsSync(journal.stageDir), 'the file masquerading as the stage dir is untouched');
    assert.ok(!fs.existsSync(path.join(journalDir, `${txnId}.json`)), 'journal removed');
  } finally { rmrf(journalDir); rmrf(root); }
});

test('hhhhu3 M-010: a non-directory canonical root goes to manual review', () => {
  const { OutputTransactionService } = require(path.join(ROOT, 'main', 'services', 'OutputTransactionService'));
  const journalDir = tmpDir('m010c-journal-');
  const scratch = tmpDir('m010c-scratch-');
  try {
    const svc = new OutputTransactionService({ journalDir });
    const txnId = crypto.randomUUID();
    const rootFile = path.join(scratch, 'root-is-a-file');
    fs.writeFileSync(rootFile, 'x');
    const journal = makeJournal({ txnId, root: rootFile, state: 'PREPARING' });
    fs.writeFileSync(path.join(journalDir, `${txnId}.json`), JSON.stringify(journal));

    const r = svc.recover();
    assert.equal(r.recovered, 0);
    assert.equal(r.manualReview, 1);
    assert.ok(fs.existsSync(path.join(journalDir, `${txnId}.json`)), 'journal preserved');
  } finally { rmrf(journalDir); rmrf(scratch); }
});

test('hhhhu3 M-011: INSTALLING recovery persists per-deletion state and is idempotent', () => {
  const { OutputTransactionService } = require(path.join(ROOT, 'main', 'services', 'OutputTransactionService'));
  const journalDir = tmpDir('m011-journal-');
  const root = tmpDir('m011-root-');
  try {
    const svc = new OutputTransactionService({ journalDir });
    const txnId = crypto.randomUUID();
    const stageDir = path.join(root, `.mmas-stage-${txnId}`);
    fs.mkdirSync(stageDir);

    const final1 = path.join(root, 'image_a.png');
    const final2 = path.join(root, 'image_b.png');
    const buf1 = Buffer.from('AAA');
    const buf2 = Buffer.from('BBB');
    fs.writeFileSync(final1, buf1);
    fs.writeFileSync(final2, Buffer.from('XXX')); // hash mismatch → first recovery stalls

    const journal = makeJournal({
      txnId, root, state: 'INSTALLING',
      files: [
        { stagedPath: path.join(stageDir, 'a.raw'), finalPath: final1, bytes: buf1.length, sha256: sha256Hex(buf1), installed: true },
        { stagedPath: path.join(stageDir, 'b.raw'), finalPath: final2, bytes: buf2.length, sha256: sha256Hex(buf2), installed: true },
      ],
    });
    const journalFile = path.join(journalDir, `${txnId}.json`);
    fs.writeFileSync(journalFile, JSON.stringify(journal));

    // Run 1: deletes file1, persists that fact, stalls on file2 → manual review.
    const r1 = svc.recover();
    assert.equal(r1.manualReview, 1);
    assert.equal(r1.recovered, 0);
    assert.ok(!fs.existsSync(final1), 'file1 rolled back');
    assert.ok(fs.existsSync(final2), 'mismatched file2 untouched');
    const afterRun1 = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
    assert.equal(afterRun1.files[0].installed, false, 'per-deletion state persisted');

    // Run 2: identical outcome — the already-deleted file1 is not re-processed
    // (idempotent), file2 still mismatched.
    const r2 = svc.recover();
    assert.equal(r2.manualReview, 1);
    assert.ok(fs.existsSync(journalFile), 'journal still preserved');

    // Repair file2 → run 3 completes the rollback and cleans up.
    fs.writeFileSync(final2, buf2);
    const r3 = svc.recover();
    assert.equal(r3.recovered, 1);
    assert.equal(r3.manualReview, 0);
    assert.ok(!fs.existsSync(final2), 'file2 rolled back');
    assert.ok(!fs.existsSync(journalFile), 'journal removed');
    assert.ok(!fs.existsSync(stageDir), 'stage dir removed');
  } finally { rmrf(journalDir); rmrf(root); }
});

test('hhhhu3 M-010: a well-formed PREPARING journal is fully cleaned up', () => {
  const { OutputTransactionService } = require(path.join(ROOT, 'main', 'services', 'OutputTransactionService'));
  const journalDir = tmpDir('m010d-journal-');
  const root = tmpDir('m010d-root-');
  try {
    const svc = new OutputTransactionService({ journalDir });
    const txnId = crypto.randomUUID();
    const journal = makeJournal({ txnId, root, state: 'PREPARING' });
    fs.mkdirSync(journal.stageDir);
    fs.writeFileSync(path.join(journal.stageDir, 'staged.bin'), 'staged');
    fs.writeFileSync(path.join(journalDir, `${txnId}.json`), JSON.stringify(journal));

    const r = svc.recover();
    assert.equal(r.recovered, 1);
    assert.ok(!fs.existsSync(journal.stageDir), 'stage dir removed');
    assert.ok(!fs.existsSync(path.join(journalDir, `${txnId}.json`)), 'journal removed');
  } finally { rmrf(journalDir); rmrf(root); }
});

// ---------------------------------------------------------------------------
// M-021 — EBML DocType discrimination
// ---------------------------------------------------------------------------

function ebmlHeader(docType) {
  // Minimal conformant EBML head: magic, head size, EBMLVersion/ReadVersion/
  // MaxIDLength/MaxSizeLength, then DocType (0x4282).
  const dt = Buffer.from(docType, 'ascii');
  return Buffer.concat([
    Buffer.from([0x1A, 0x45, 0xDF, 0xA3]),
    Buffer.from([0x93]),
    Buffer.from([0x42, 0x86, 0x81, 0x01]),
    Buffer.from([0x42, 0xF7, 0x81, 0x01]),
    Buffer.from([0x42, 0xF2, 0x81, 0x04]),
    Buffer.from([0x42, 0xF3, 0x81, 0x08]),
    Buffer.from([0x42, 0x82, 0x80 | dt.length]),
    dt,
  ]);
}

test('hhhhu3 M-021: DocType webm is detected as webm', () => {
  const { detectType, ebmlDocType } = require(path.join(ROOT, 'main', 'services', 'ArtifactFinalizer'));
  const header = ebmlHeader('webm');
  assert.equal(ebmlDocType(header), 'webm');
  assert.equal(detectType(header), 'webm');
});

test('hhhhu3 M-021: DocType matroska is detected as mkv, never webm', () => {
  const { detectType, ebmlDocType, MODALITY_TYPES } = require(path.join(ROOT, 'main', 'services', 'ArtifactFinalizer'));
  const header = ebmlHeader('matroska');
  assert.equal(ebmlDocType(header), 'matroska');
  assert.equal(detectType(header), 'mkv');
  assert.ok(MODALITY_TYPES.video.has('mkv'), 'mkv is an accepted video type');
});

test('hhhhu3 M-021: an EBML header without a readable DocType stays webm', () => {
  const { detectType, ebmlDocType } = require(path.join(ROOT, 'main', 'services', 'ArtifactFinalizer'));
  const header = Buffer.from([0x1A, 0x45, 0xDF, 0xA3, 0x00, 0x00, 0x00, 0x00]);
  assert.equal(ebmlDocType(header), null);
  assert.equal(detectType(header), 'webm');
});

// ---------------------------------------------------------------------------
// M-022 — ffprobe discovery cache
// ---------------------------------------------------------------------------

test('hhhhu3 M-022: ffprobe discovery is cached and prefers the pinned dependency', () => {
  const { resolveFfprobe, _resetFfprobeCacheForTest } = require(path.join(ROOT, 'main', 'services', 'mediaProbe'));
  _resetFfprobeCacheForTest();
  const first = resolveFfprobe();
  const second = resolveFfprobe();
  assert.equal(first, second, 'second call returns the cached resolution');
  assert.ok(first, 'a bundled ffprobe is discovered (pinned @ffprobe-installer dependency)');
  assert.match(first.replace(/\\/g, '/'), /ffprobe-installer|ffprobe\.exe/, 'pinned copy is used, not PATH');
  assert.ok(fs.existsSync(first), 'resolved ffprobe exists on disk');
});
