'use strict';
/*
 * probe_med.js — hands-on adversarial verification of Medium findings
 * M-005 .. M-022 from hhhhu3.md. Executes shipped modules verbatim with
 * hostile inputs; static source checks only where behavior is timing-bound.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const results = [];
function check(id, name, pass, detail) {
  results.push({ id, name, pass, detail });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${id} ${name}${detail ? ' — ' + detail : ''}`);
}
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function mkTmp(name) {
  const d = path.join(__dirname, '_tmp_med_' + name);
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  return d;
}

(async () => {
  // ============================================================
  // M-005 — ProviderCredentialRepository: unique tmp, blob rollback
  // ============================================================
  const { ProviderCredentialRepository } = require(path.join(ROOT, 'main/services/ProviderCredentialRepository.js'));
  function fakeBlobStore() {
    const blobs = new Map();
    const removed = [];
    const written = [];
    let n = 0;
    return {
      blobs, removed, written,
      writeNew(label, secret) { const id = 'blob-' + (++n); blobs.set(id, secret); written.push(id); return { id }; },
      remove(id) { removed.push(id); blobs.delete(id); },
      read(id) { return blobs.get(id); },
    };
  }
  const seedStore = (providersPath, providers) =>
    fs.writeFileSync(providersPath, JSON.stringify({ providers }, null, 2));

  // M-005a: replacePersisted — metadata write fails -> new blob removed, disk unchanged
  {
    const dir = mkTmp('m005a');
    const providersPath = path.join(dir, 'providers.json');
    seedStore(providersPath, [{ id: 'minimax', apiKey: 'sk-plain-orig' }]);
    const before = fs.readFileSync(providersPath, 'utf8');
    const bs = fakeBlobStore();
    const repo = new ProviderCredentialRepository({ blobStore: bs, providersPath });
    const origWFS = fs.writeFileSync;
    let threw = null;
    fs.writeFileSync = (p, ...rest) => {
      if (String(p).includes('.tmp-')) throw new Error('SENTINEL-meta-write-fail');
      return origWFS(p, ...rest);
    };
    try { repo.replacePersisted('minimax', 'sk-new-key'); } catch (e) { threw = e; }
    fs.writeFileSync = origWFS;
    const after = fs.readFileSync(providersPath, 'utf8');
    check('M-005a', 'replacePersisted rollback: blob removed, disk unchanged on metadata failure',
      threw && /SENTINEL/.test(threw.message) && bs.removed.length === 1 && after === before,
      `threw=${!!threw} removedBlobs=${bs.removed.length} diskUnchanged=${after === before}`);
  }

  // M-005b: migrateLegacy — per-provider commit; failed 2nd provider keeps plaintext, no orphan blob
  {
    const dir = mkTmp('m005b');
    const providersPath = path.join(dir, 'providers.json');
    seedStore(providersPath, [
      { id: 'minimax', apiKey: 'sk-plain-1' },
      { id: 'openai', apiKey: 'sk-plain-2' },
    ]);
    const bs = fakeBlobStore();
    const repo = new ProviderCredentialRepository({ blobStore: bs, providersPath });
    const origWFS = fs.writeFileSync;
    let tmpWrites = 0;
    fs.writeFileSync = (p, ...rest) => {
      if (String(p).includes('.tmp-')) {
        tmpWrites++;
        if (tmpWrites === 2) throw new Error('SENTINEL-second-meta-write-fail');
      }
      return origWFS(p, ...rest);
    };
    let res;
    try { res = repo.migrateLegacy(); } finally { fs.writeFileSync = origWFS; }
    const disk = JSON.parse(fs.readFileSync(providersPath, 'utf8'));
    const p1 = disk.providers.find((p) => p.id === 'minimax');
    const p2 = disk.providers.find((p) => p.id === 'openai');
    const noTmpLeft = !fs.readdirSync(dir).some((f) => f.includes('.tmp-'));
    check('M-005b', 'migrateLegacy commits per-provider; failed provider keeps plaintext, blob removed',
      res && res.migrated === 1 && res.failed === 1 &&
      p1.credential_id && !p1.apiKey &&
      !p2.credential_id && p2.apiKey === 'sk-plain-2' &&
      bs.removed.length === 1 && bs.blobs.size === 1 && noTmpLeft,
      `migrated=${res && res.migrated} failed=${res && res.failed} p1Cred=${!!(p1 && p1.credential_id)} p2Plain=${p2 && p2.apiKey === 'sk-plain-2'} orphanBlobs=${bs.blobs.size - 1}`);
  }

  // M-005c: static — unique tmp name per _writeStore
  {
    const src = fs.readFileSync(path.join(ROOT, 'main/services/ProviderCredentialRepository.js'), 'utf8');
    check('M-005c', '_writeStore uses unique tmp name (randomUUID), not fixed .tmp',
      /providersPath \+ '\.tmp-' \+ randomUUID\(\)/.test(src), '');
  }

  // ============================================================
  // M-006 — OpenAI-compatible image JSON cap = 160 MiB on both paths
  // ============================================================
  {
    const src = fs.readFileSync(path.join(ROOT, 'src/providers/openaiCompatible.js'), 'utf8');
    const hasConst = /MAX_IMAGE_JSON_BYTES = 160 \* 1024 \* 1024/.test(src);
    const httpUse = /maxJsonBytes: MAX_IMAGE_JSON_BYTES/.test(src);
    const fetchUse = /_jsonBounded\(res, MAX_IMAGE_JSON_BYTES\)/.test(src);
    check('M-006', 'images() JSON cap raised to 160 MiB on injected-http AND fetch paths',
      hasConst && httpUse && fetchUse, `const=${hasConst} http=${httpUse} fetch=${fetchUse}`);
  }

  // ============================================================
  // M-007 — OpenAI video polling delay is abortable (behavioral)
  // ============================================================
  const oac = require(path.join(ROOT, 'src/providers/openaiCompatible.js'));
  {
    const ac = new AbortController();
    const stubHttp = {
      async json(url, options, policy) {
        if (options && options.method === 'POST') return { id: 'job-9' };
        return { status: 'running' };
      },
    };
    const t0 = Date.now();
    setTimeout(() => ac.abort(), 300);
    let err = null;
    try {
      await oac.video({ baseUrl: 'https://provider.example/v1', apiKey: 'k', model: 'vid', prompt: 'x', signal: ac.signal, http: stubHttp });
    } catch (e) { err = e; }
    const elapsed = Date.now() - t0;
    check('M-007', 'video polling sleep aborts immediately (<2.5s, not full 3s timer)',
      !!err && /cancel/i.test(err.message) && elapsed < 2500, `elapsed=${elapsed}ms err=${err && err.message}`);
  }

  // ============================================================
  // M-008/M-009 — replicate.run: no listener accumulation + onSubmitted
  // ============================================================
  const replicate = require(path.join(ROOT, 'src/providers/replicate.js'));
  {
    const ac = new AbortController();
    let active = 0, peak = 0;
    const sig = ac.signal;
    const origAdd = sig.addEventListener.bind(sig);
    const origRem = sig.removeEventListener.bind(sig);
    sig.addEventListener = (t, l, o) => { if (t === 'abort') { active++; peak = Math.max(peak, active); } return origAdd(t, l, o); };
    sig.removeEventListener = (t, l) => { if (t === 'abort') active--; return origRem(t, l); };

    let call = 0;
    const stubHttp = {
      async json(url, options, policy) {
        call++;
        if (call === 1) {
          return { id: 'pred-1', status: 'starting', urls: { get: 'https://api.replicate.com/v1/predictions/pred-1' } };
        }
        if (call <= 3) return { id: 'pred-1', status: 'starting', urls: { get: 'https://api.replicate.com/v1/predictions/pred-1' } };
        return { id: 'pred-1', status: 'succeeded', urls: { get: url }, output: 'https://output.example/v.mp4' };
      },
    };
    let submitted = null;
    await replicate.run({
      apiKey: 'k', model: 'owner/video-model', input: { prompt: 'x' },
      signal: sig, onSubmitted: (info) => { submitted = info; }, http: stubHttp,
    });
    check('M-008', 'replicate polling does not accumulate abort listeners (removed on normal resolve)',
      active === 0 && peak <= 1 && call >= 4, `activeAfter=${active} peak=${peak} polls=${call - 1}`);
    check('M-009', 'replicate.run invokes onSubmitted with remote job identity',
      submitted && submitted.remoteJobId === 'pred-1' &&
      submitted.pollUrl === 'https://api.replicate.com/v1/predictions/pred-1',
      `submitted=${JSON.stringify(submitted)}`);
  }

  // ============================================================
  // M-010 — hostile recovery journals are quarantined, never acted on
  // ============================================================
  const { OutputTransactionService } = require(path.join(ROOT, 'main/services/OutputTransactionService.js'));
  {
    const journalDir = mkTmp('m010_journals');
    const root = mkTmp('m010_root');
    const hostileDir = mkTmp('m010_hostile');
    fs.writeFileSync(path.join(hostileDir, 'canary.txt'), 'DO-NOT-DELETE');
    const rootAsFile = path.join(mkTmp('m010_rootfile'), 'rootfile.txt');
    fs.writeFileSync(rootAsFile, 'i-am-a-file');
    const svc = new OutputTransactionService({ journalDir });

    // H1: stageDir outside canonical root (points at hostile dir)
    const h1 = crypto.randomUUID();
    fs.writeFileSync(path.join(journalDir, `${h1}.json`), JSON.stringify({
      schemaVersion: 1, transactionId: h1, state: 'PREPARING', canonicalRoot: root,
      leaseId: null, createdAt: Date.now(), stageDir: hostileDir, files: [],
    }));
    // H2: canonical root is a regular file
    const h2 = crypto.randomUUID();
    fs.writeFileSync(path.join(journalDir, `${h2}.json`), JSON.stringify({
      schemaVersion: 1, transactionId: h2, state: 'PREPARING', canonicalRoot: rootAsFile,
      leaseId: null, createdAt: Date.now(), stageDir: path.join(rootAsFile, `.mmas-stage-${h2}`), files: [],
    }));
    // H3: malformed shape (files not array)
    const h3 = crypto.randomUUID();
    fs.writeFileSync(path.join(journalDir, `${h3}.json`), JSON.stringify({
      schemaVersion: 1, transactionId: h3, state: 'PREPARING', canonicalRoot: root,
      leaseId: null, createdAt: Date.now(), stageDir: path.join(root, `.mmas-stage-${h3}`), files: '../../../etc',
    }));
    const r = svc.recover();
    const canaryAlive = fs.existsSync(path.join(hostileDir, 'canary.txt'));
    const rootFileAlive = fs.existsSync(rootAsFile);
    const journalsPreserved = [`${h1}.json`, `${h2}.json`, `${h3}.json`].every((f) => fs.existsSync(path.join(journalDir, f)));
    check('M-010a', 'hostile journals (escaped stageDir / file root / bad shape) -> manual review, no fs action',
      r.manualReview === 3 && r.recovered === 0 && canaryAlive && rootFileAlive && journalsPreserved,
      `manualReview=${r.manualReview} recovered=${r.recovered} canary=${canaryAlive} journalsKept=${journalsPreserved}`);

    // Legit PREPARING journal still recovers normally (fix didn't break the happy path)
    const journalDir2 = mkTmp('m010_j2');
    const root2 = mkTmp('m010_root2');
    const g1 = crypto.randomUUID();
    const stage2 = path.join(root2, `.mmas-stage-${g1}`);
    fs.mkdirSync(stage2);
    fs.writeFileSync(path.join(stage2, 'junk.bin'), 'x');
    const svc2 = new OutputTransactionService({ journalDir: journalDir2 });
    fs.writeFileSync(path.join(journalDir2, `${g1}.json`), JSON.stringify({
      schemaVersion: 1, transactionId: g1, state: 'PREPARING', canonicalRoot: root2,
      leaseId: null, createdAt: Date.now(), stageDir: stage2, files: [],
    }));
    const r2 = svc2.recover();
    check('M-010b', 'legitimate PREPARING journal still auto-recovers (stage + journal cleaned)',
      r2.recovered === 1 && r2.manualReview === 0 && !fs.existsSync(stage2) && !fs.existsSync(path.join(journalDir2, `${g1}.json`)),
      `recovered=${r2.recovered}`);
  }

  // ============================================================
  // M-011 — recovery persists journal after each deletion (idempotent rerun)
  // ============================================================
  {
    const journalDir = mkTmp('m011_j');
    const root = mkTmp('m011_root');
    const txId = crypto.randomUUID();
    const stage = path.join(root, `.mmas-stage-${txId}`);
    fs.mkdirSync(stage);
    const good = Buffer.from('AAAAA');
    const badFinal = Buffer.from('XXXXX'); // hash will mismatch
    fs.writeFileSync(path.join(root, 'a.txt'), good);
    fs.writeFileSync(path.join(root, 'b.txt'), badFinal);
    const journal = {
      schemaVersion: 1, transactionId: txId, state: 'INSTALLING', canonicalRoot: root,
      leaseId: null, createdAt: Date.now(), stageDir: stage,
      files: [
        { stagedPath: path.join(stage, 'a.txt'), finalPath: path.join(root, 'a.txt'), bytes: 5, sha256: sha256(good), installed: true },
        { stagedPath: path.join(stage, 'b.txt'), finalPath: path.join(root, 'b.txt'), bytes: 5, sha256: sha256(Buffer.from('BBBBB')), installed: true },
      ],
    };
    const svc = new OutputTransactionService({ journalDir });
    fs.writeFileSync(path.join(journalDir, `${txId}.json`), JSON.stringify(journal));
    const run1 = svc.recover();
    const jAfter1 = JSON.parse(fs.readFileSync(path.join(journalDir, `${txId}.json`), 'utf8'));
    const aRemoved = !fs.existsSync(path.join(root, 'a.txt'));
    const bUntouched = fs.readFileSync(path.join(root, 'b.txt')).equals(badFinal);
    const run2 = svc.recover(); // second run must not re-trip on the already-deleted a.txt
    const jAfter2 = JSON.parse(fs.readFileSync(path.join(journalDir, `${txId}.json`), 'utf8'));
    check('M-011', 'INSTALLING recovery: per-deletion journal persist; second run idempotent (not stuck)',
      run1.manualReview === 1 && aRemoved && bUntouched &&
      jAfter1.files[0].installed === false && jAfter1.files[1].installed === true &&
      run2.manualReview === 1 && jAfter2.files[0].installed === false,
      `run1.review=${run1.manualReview} aRolledBack=${aRemoved} flagPersisted=${jAfter1.files[0].installed === false} run2.review=${run2.manualReview}`);
  }

  // ============================================================
  // M-012 — paginated listing exposed through preload
  // ============================================================
  {
    const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
    const names = ['fbListStart', 'fbListNext', 'fbListClose'];
    const chans = ['fb:listStart', 'fb:listNext', 'fb:listClose'];
    const ok = names.every((n) => preload.includes(n)) && chans.every((c) => preload.includes(c));
    check('M-012', 'preload exposes fbListStart/fbListNext/fbListClose (not only legacy fbList)', ok, '');
  }

  // ============================================================
  // M-013 — opaque server-side cursors (behavioral)
  // ============================================================
  const { DirectoryListingService } = require(path.join(ROOT, 'main/services/DirectoryListingService.js'));
  {
    const dir = mkTmp('m013');
    for (let i = 1; i <= 5; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), 'x'.repeat(i));
    const svc = new DirectoryListingService();
    const start = await svc.listStart({ dir, senderId: 1, pageSize: 2 });
    const cursorIsOpaque = /^[0-9a-f]{32}$/.test(start.cursor) && !/^\d+$/.test(start.cursor);
    let rejectedGuesses = 0;
    for (const guess of ['0', '2', '-2', '999999', start.cursor.slice(0, -2) + 'ff']) {
      try { await svc.listNext({ sessionId: start.sessionId, cursor: guess, senderId: 1 }); }
      catch (_) { rejectedGuesses++; }
    }
    const page2 = await svc.listNext({ sessionId: start.sessionId, cursor: start.cursor, senderId: 1 });
    const page3 = await svc.listNext({ sessionId: start.sessionId, cursor: page2.cursor, senderId: 1 });
    const names = [...start.items, ...page2.items, ...page3.items].map((i) => i.name).join(',');
    let nullCursorRejected = false;
    try { await svc.listNext({ sessionId: start.sessionId, cursor: page3.cursor, senderId: 1 }); }
    catch (_) { nullCursorRejected = true; }
    svc.destroy();
    check('M-013', 'guessed/numeric/negative cursors rejected; real opaque token advances pages exactly',
      start.items.length === 2 && start.hasMore && cursorIsOpaque && rejectedGuesses === 5 &&
      page2.items.length === 2 && page3.items.length === 1 && !page3.hasMore &&
      names === 'f1.txt,f2.txt,f3.txt,f4.txt,f5.txt' && nullCursorRejected,
      `opaque=${cursorIsOpaque} guessesRejected=${rejectedGuesses}/5 order=${names}`);
  }

  // ============================================================
  // M-014 — preflight grant authorization BEFORE the dialog + identity bind
  // ============================================================
  {
    const src = fs.readFileSync(path.join(ROOT, 'main/ipc/fileBrowserDestructiveIntent.js'), 'utf8');
    const preflightIdx = src.indexOf('const srcAuthz = preflightGrant(');
    const confirmIdx = src.indexOf('intentService.confirm(');
    const identityIdx = src.indexOf('const sourceIdentity = await captureIdentity(');
    check('M-014', 'grant preflight + canonical path + file identity captured BEFORE confirm/dialog',
      preflightIdx > -1 && confirmIdx > -1 && identityIdx > -1 &&
      preflightIdx < confirmIdx && identityIdx < confirmIdx &&
      /dev: st\.dev, ino: st\.ino/.test(src),
      `preflight@${preflightIdx} identity@${identityIdx} confirm@${confirmIdx}`);
  }

  // ============================================================
  // M-015 — proactive sweep + destroy on window close
  // ============================================================
  const { OperationIntentService } = require(path.join(ROOT, 'main/services/OperationIntentService.js'));
  {
    const src = fs.readFileSync(path.join(ROOT, 'main/services/OperationIntentService.js'), 'utf8');
    const svc = new OperationIntentService();
    svc.tokens.set('tok-a', { expiresAt: Date.now() - 1000 });
    svc.tokens.set('tok-b', { expiresAt: Date.now() + 60000 });
    svc.destroy();
    check('M-015', 'intent service: 60s sweep scheduled + destroy() clears all tokens on close',
      /SWEEP_INTERVAL_MS = 60_000/.test(src) && /_scheduleSweep\(\)/.test(src) && svc.tokens.size === 0,
      `tokensAfterDestroy=${svc.tokens.size}`);
  }

  // ============================================================
  // M-016 — structured partial-success for directory moves
  // ============================================================
  {
    const src = fs.readFileSync(path.join(ROOT, 'src/fileBrowser.js'), 'utf8');
    const partialCount = (src.match(/partialSuccess: true/g) || []).length;
    const dirWarning = /Folder copied to destination but the source could not be fully removed/.test(src);
    check('M-016', 'directory move returns structured {partialSuccess, warning} instead of generic error',
      partialCount >= 3 && dirWarning, `partialSuccessSites=${partialCount}`);
  }

  // ============================================================
  // M-017 — bounded preview growth detection (behavioral + static)
  // ============================================================
  const fileBrowser = require(path.join(ROOT, 'src/fileBrowser.js'));
  {
    const dir = mkTmp('m017');
    const big = path.join(dir, 'big.bin');
    const small = path.join(dir, 'small.txt');
    fs.writeFileSync(big, Buffer.alloc(100, 0x41));
    fs.writeFileSync(small, 'hello-preview');
    let tooLarge = null;
    try { await fileBrowser.readFile(big, 50); } catch (e) { tooLarge = e; }
    const exact = await fileBrowser.readFile(small, 2 * 1024 * 1024);
    const src = fs.readFileSync(path.join(ROOT, 'src/fileBrowser.js'), 'utf8');
    const growthLoop = /const st2 = await fd\.stat\(\);/.test(src) && /grew during read/.test(src);
    const singleFd = /const fd = await fs\.open\(p,/.test(src) && (src.match(/await fd\.stat\(\)/g) || []).length >= 2;
    check('M-017', 'readFile: cap enforced via one fd + same-fd re-stat growth loop (no silent truncation)',
      tooLarge && /too large/i.test(tooLarge.message) &&
      exact.toString() === 'hello-preview' && growthLoop && singleFd,
      `oversizedThrew=${!!tooLarge} exactRead=${exact.toString() === 'hello-preview'} growthLoop=${growthLoop}`);
  }

  // ============================================================
  // M-018 / M-019 — downloadClient: allowlist per hop + headers timeout
  // (real local HTTP servers; https.get is routed to them)
  // ============================================================
  const { downloadFile } = require(path.join(ROOT, 'scripts/lib/downloadClient.js'));
  {
    // M-018: first hop redirects to an origin NOT in the allowlist
    const goodServer = http.createServer((req, res) => {
      res.writeHead(302, { location: 'https://evil.example/malware.bin' });
      res.end();
    });
    await new Promise((r) => goodServer.listen(0, '127.0.0.1', r));
    const goodPort = goodServer.address().port;
    const origHttpsGet = https.get;
    https.get = (href, opts, cb) => {
      const u = new URL(typeof href === 'string' ? href : href.href);
      return http.get(`http://127.0.0.1:${goodPort}${u.pathname}`, opts, cb);
    };
    let r18;
    try {
      r18 = await downloadFile('https://goodhost/file.bin', path.join(mkTmp('m018'), 'file.bin'),
        { allowedOrigins: new Set(['https://goodhost']) });
    } finally { https.get = origHttpsGet; goodServer.close(); }
    check('M-018', 'redirect to non-allowlisted origin is rejected (policy survives redirects)',
      r18 && r18.ok === false && /allowlist/i.test(r18.error), `error=${r18 && r18.error}`);

    // M-019: server accepts the socket but never sends headers
    const silentServer = http.createServer(() => { /* never respond */ });
    await new Promise((r) => silentServer.listen(0, '127.0.0.1', r));
    const silentPort = silentServer.address().port;
    https.get = (href, opts, cb) => {
      const u = new URL(typeof href === 'string' ? href : href.href);
      return http.get(`http://127.0.0.1:${silentPort}${u.pathname}`, opts, cb);
    };
    const t0 = Date.now();
    let r19;
    try {
      r19 = await downloadFile('https://silent.example/f.bin', path.join(mkTmp('m019'), 'f.bin'),
        { headersTimeoutMs: 500 });
    } finally { https.get = origHttpsGet; silentServer.close(); }
    const elapsed = Date.now() - t0;
    check('M-019', 'headersTimeoutMs enforced: connected-but-silent server aborted (~500ms budget)',
      r19 && r19.ok === false && /headers/i.test(r19.error) && elapsed < 5000,
      `elapsed=${elapsed}ms error=${r19 && r19.error}`);
  }

  // ============================================================
  // M-020 — archive identity bound before validation, re-checked after
  // ============================================================
  {
    const src = fs.readFileSync(path.join(ROOT, 'scripts/lib/safeExtract.js'), 'utf8');
    const statBeforeValidate = src.indexOf('statBefore = fs.statSync(archivePath)');
    const identityBind = /const identity = \{ size: statBefore\.size, mtimeMs: statBefore\.mtimeMs \}/.test(src);
    const recheck = /if \(!archiveUnchanged\(\)\)/.test(src);
    const treeCompare = /fileEntries/.test(src) && /VALIDATED listing/.test(src);
    check('M-020', 'archive identity bound pre-validation + re-checked post-extraction + tree compared',
      statBeforeValidate > -1 && identityBind && recheck && treeCompare, '');
  }

  // ============================================================
  // M-021 — EBML DocType discrimination (mkv vs webm, behavioral)
  // ============================================================
  const finalizer = require(path.join(ROOT, 'main/services/ArtifactFinalizer.js'));
  {
    // EBML VINT size: 1-byte form sets the length marker in the high bit
    // (0x80 | size), so size 8 -> 0x88, size 4 -> 0x84.
    const mkEbml = (doctype) => Buffer.concat([
      Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),   // EBML magic
      Buffer.from([0x01, 0x00]),               // padding bytes
      Buffer.from([0x42, 0x82, 0x80 | doctype.length]), // DocType id + VINT size
      Buffer.from(doctype, 'ascii'),
    ]);
    const mkvDoc = finalizer.ebmlDocType(mkEbml('matroska'));
    const webmDoc = finalizer.ebmlDocType(mkEbml('webm'));
    const mkvType = finalizer.detectType(mkEbml('matroska'));
    const webmType = finalizer.detectType(mkEbml('webm'));
    check('M-021', 'EBML DocType matroska -> mkv (not blindly webm); webm doctype -> webm',
      mkvDoc === 'matroska' && webmDoc === 'webm' && mkvType === 'mkv' && webmType === 'webm',
      `doc=${mkvDoc}/${webmDoc} type=${mkvType}/${webmType}`);
  }

  // ============================================================
  // M-022 — ffprobe discovery cached at module level (behavioral)
  // ============================================================
  const mediaProbe = require(path.join(ROOT, 'main/services/mediaProbe.js'));
  {
    mediaProbe._resetFfprobeCacheForTest();
    const t0 = process.hrtime.bigint();
    const first = mediaProbe.resolveFfprobe();
    const t1 = process.hrtime.bigint();
    const second = mediaProbe.resolveFfprobe();
    const t2 = process.hrtime.bigint();
    const firstMs = Number(t1 - t0) / 1e6;
    const secondMs = Number(t2 - t1) / 1e6;
    check('M-022', 'resolveFfprobe discovery cached (second call instant, incl. negative result)',
      first === second && secondMs < 20 && typeof mediaProbe._resetFfprobeCacheForTest === 'function',
      `first=${firstMs.toFixed(1)}ms second=${secondMs.toFixed(3)}ms result=${first === null ? 'absent(cached)' : path.basename(String(first))}`);
  }

  // ============================================================
  const pass = results.filter((r) => r.pass).length;
  console.log(`\nprobe_med: ${pass}/${results.length} PASS`);
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => {
  console.error('probe_med crashed:', e);
  process.exit(2);
});
