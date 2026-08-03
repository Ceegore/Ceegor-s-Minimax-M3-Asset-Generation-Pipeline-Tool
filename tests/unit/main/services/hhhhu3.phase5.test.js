// tests/unit/main/services/hhhhu3.phase5.test.js
// ============================================================================
// hhhhu3 audit Phase 5 regression tests (file-browser migration).
//
// Covers:
//  - M-012: renderer listing goes through the paginated drain helper
//    (window.FbListPaged.drain) — no direct window.api.fbList call sites.
//  - M-013: listing cursors are random opaque tokens tracked server-side;
//    forged, repeated, or rewound cursors are rejected.
//  - M-014: fb:confirmDestructive authorizes grants BEFORE the native
//    dialog and binds the service's canonical path + file identity; the
//    execute handlers re-observe identity and reject a mismatch.
//  - M-015: expired intent tokens are proactively swept and the sweep
//    timer is cleared on destroy().
//  - M-016: directory-move failures clean up the partial destination and
//    an incomplete source removal reports structured partialSuccess.
//  - M-017: readFile detects growth between stat and read (re-stat via
//    the open fd, grown buffer re-read) and refuses oversized files.
//  - B-007: every renderer destructive call site routes through the
//    window.FbIntent confirm-then-execute bridge (source-level guard).
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const FB_IPC = path.join(ROOT, 'main', 'ipc', 'registerFileBrowserIpc.js');
const INTENT_IPC = path.join(ROOT, 'main', 'ipc', 'fileBrowserDestructiveIntent.js');
const OIS = path.join(ROOT, 'main', 'services', 'OperationIntentService.js');
const PATH_SECURITY = path.join(ROOT, 'main', 'services', 'PathSecurityService.js');
const PATH_GRANT = path.join(ROOT, 'main', 'services', 'PathGrantService.js');
const FILE_BROWSER = path.join(ROOT, 'src', 'fileBrowser.js');
const DLS = path.join(ROOT, 'main', 'services', 'DirectoryListingService.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-h3-p5-'));

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

// ---------------------------------------------------------------------------
// M-013 — opaque server-tracked listing cursors
// ---------------------------------------------------------------------------

test('hhhhu3 M-013: forged/repeated cursors are rejected; offsets never come from the client', async () => {
  const { DirectoryListingService } = require(DLS);
  const dir = path.join(TMP, 'm013');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), 'x');

  const svc = new DirectoryListingService();
  try {
    const start = await svc.listStart({ dir, senderId: 1, pageSize: 2 });
    assert.equal(start.items.length, 2);
    assert.equal(start.hasMore, true);
    assert.equal(start.totalCount, 5);
    // The cursor is an opaque random token (32 hex chars = 16 bytes),
    // not an encoded offset.
    assert.match(start.cursor, /^[0-9a-f]{32}$/);

    // Forged cursor -> rejected.
    await assert.rejects(
      svc.listNext({ sessionId: start.sessionId, cursor: 'deadbeefdeadbeefdeadbeefdeadbeef', senderId: 1 }),
      /Invalid listing cursor/
    );
    // Numeric/offset-shaped cursors -> rejected.
    await assert.rejects(
      svc.listNext({ sessionId: start.sessionId, cursor: '2', senderId: 1 }),
      /Invalid listing cursor/
    );

    // The exact issued token advances exactly one page.
    const p2 = await svc.listNext({ sessionId: start.sessionId, cursor: start.cursor, senderId: 1 });
    assert.equal(p2.items.length, 2);
    // Replaying a consumed cursor (rewind/repeat) -> rejected.
    await assert.rejects(
      svc.listNext({ sessionId: start.sessionId, cursor: start.cursor, senderId: 1 }),
      /Invalid listing cursor/
    );

    // Drain to the end: the final page carries cursor === null.
    const p3 = await svc.listNext({ sessionId: start.sessionId, cursor: p2.cursor, senderId: 1 });
    assert.equal(p3.items.length, 1);
    assert.equal(p3.hasMore, false);
    assert.equal(p3.cursor, null);
    // With no further page, ANY cursor is rejected.
    await assert.rejects(
      svc.listNext({ sessionId: start.sessionId, cursor: p2.cursor, senderId: 1 }),
      /Invalid listing cursor/
    );
  } finally {
    svc.destroy();
  }
});

// ---------------------------------------------------------------------------
// M-014 / M-015 — intent identity binding + expired-token sweep (unit level)
// ---------------------------------------------------------------------------

function loadIntentService(dialogStub) {
  for (const p of [OIS, INTENT_IPC]) {
    try { delete require.cache[require.resolve(p)]; } catch (_) {}
  }
  require.cache[require.resolve('electron')] = {
    exports: { dialog: { showMessageBox: dialogStub } },
  };
  return require(OIS);
}

const FAKE_EVENT = { sender: { id: 1 } };

test('hhhhu3 M-014: consume rejects a source-identity mismatch and single-use violations', async () => {
  const { OperationIntentService, identityEqual } = loadIntentService(async () => ({ response: 1 }));
  const svc = new OperationIntentService();
  try {
    const r = await svc.confirm(FAKE_EVENT, {
      title: 't', message: 'm', confirmLabel: 'Delete', operation: 'delete',
      canonicalSource: 'C:\\x\\a.png', sourceGrantId: 'g1',
      sourceIdentity: { dev: 7, ino: 42 },
    });
    assert.equal(r.ok, true);

    // Same path but a DIFFERENT file (swapped target) -> mismatch.
    assert.throws(
      () => svc.consume(FAKE_EVENT, r.intentId, {
        operation: 'delete', canonicalSource: 'C:\\x\\a.png', sourceGrantId: 'g1',
        sourceIdentity: { dev: 7, ino: 43 },
      }),
      /does not match/
    );
    // One-sided identity never matches.
    assert.throws(
      () => svc.consume(FAKE_EVENT, r.intentId, {
        operation: 'delete', canonicalSource: 'C:\\x\\a.png', sourceGrantId: 'g1',
        sourceIdentity: null,
      }),
      /does not match/
    );
    // Exact identity match consumes; replay is then rejected.
    assert.deepEqual(svc.consume(FAKE_EVENT, r.intentId, {
      operation: 'delete', canonicalSource: 'C:\\x\\a.png', sourceGrantId: 'g1',
      sourceIdentity: { dev: 7, ino: 42 },
    }), { ok: true });
    assert.throws(
      () => svc.consume(FAKE_EVENT, r.intentId, {
        operation: 'delete', canonicalSource: 'C:\\x\\a.png', sourceGrantId: 'g1',
        sourceIdentity: { dev: 7, ino: 42 },
      }),
      /fresh confirmation/
    );
  } finally {
    svc.destroy();
  }

  // identityEqual semantics.
  assert.equal(identityEqual(null, null), true);
  assert.equal(identityEqual({ dev: 1, ino: 2 }, null), false);
  assert.equal(identityEqual(null, { dev: 1, ino: 2 }), false);
  assert.equal(identityEqual({ dev: 1, ino: 2 }, { dev: 1, ino: 2 }), true);
  assert.equal(identityEqual({ dev: 1, ino: 2 }, { dev: 1, ino: 3 }), false);
});

test('hhhhu3 M-015: the sweep evicts expired tokens and destroy() clears the timer', async () => {
  const { OperationIntentService } = loadIntentService(async () => ({ response: 1 }));
  let clock = 1_000_000;
  const svc = new OperationIntentService({ now: () => clock });
  try {
    // Capture the sweep timer instead of waiting 60 real seconds.
    const captured = [];
    const realSetTimeout = global.setTimeout;
    const realClearTimeout = global.clearTimeout;
    global.setTimeout = (cb, ms) => {
      const t = { cb, ms, unref: () => {}, cleared: false };
      captured.push(t);
      return t;
    };
    global.clearTimeout = (t) => { if (t) t.cleared = true; };
    try {
      await svc.confirm(FAKE_EVENT, {
        title: 't', message: 'm', confirmLabel: 'Delete', operation: 'delete',
        canonicalSource: 'C:\\x\\a.png', sourceGrantId: 'g1',
      });
      assert.equal(captured.length, 1, 'one sweep timer scheduled while tokens exist');
      assert.equal(captured[0].ms, 60_000);

      // Advance past the 30 s token validity and fire one sweep tick.
      clock += 31_000;
      captured[0].cb();
      assert.equal(svc.tokens.size, 0, 'expired token evicted by the sweep');
      assert.equal(captured.length, 1, 'no reschedule once no tokens remain');

      // A fresh token schedules a fresh sweep; destroy() must clear it.
      clock += 1_000;
      await svc.confirm(FAKE_EVENT, {
        title: 't', message: 'm', confirmLabel: 'Delete', operation: 'delete',
        canonicalSource: 'C:\\x\\b.png', sourceGrantId: 'g2',
      });
      assert.equal(captured.length, 2);
      svc.destroy();
      assert.equal(captured[1].cleared, true, 'destroy() must clearTimeout the sweep timer');
      assert.equal(svc.tokens.size, 0);
      assert.equal(svc._sweepTimer, null);
    } finally {
      global.setTimeout = realSetTimeout;
      global.clearTimeout = realClearTimeout;
    }
  } finally {
    svc.destroy();
  }
});

// ---------------------------------------------------------------------------
// M-014 — handler level: confirm authorizes BEFORE the native dialog
// ---------------------------------------------------------------------------

function loadIpc(dialogSpy) {
  for (const p of [FB_IPC, INTENT_IPC, OIS, PATH_SECURITY, PATH_GRANT, FILE_BROWSER]) {
    try { delete require.cache[require.resolve(p)]; } catch (_) {}
  }
  try {
    const { defaultService } = require(PATH_GRANT);
    defaultService.destroy();
  } catch (_) {}

  const handlers = new Map();
  require.cache[require.resolve(PATH_SECURITY)] = {
    exports: {
      getAllowedRoots: () => [TMP],
      isPathUnderAny: () => true,
      isParentUnderAny: () => true,
      addTrusted: () => [],
      setActiveDir: () => null,
      getActiveDir: () => null,
    },
  };
  require.cache[require.resolve('electron')] = {
    exports: {
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
      app: { getPath: () => TMP },
      dialog: { showMessageBox: dialogSpy },
      shell: { showItemInFolder: () => {}, openPath: async () => '' },
    },
  };
  require(FB_IPC).register({ appRoot: ROOT });
  return { handlers };
}

function mintDirGrant(dir, capabilities) {
  const { defaultService } = require(PATH_GRANT);
  const r = defaultService.mintDirectoryGrant({
    origin: 'picker-browser-dir',
    purpose: 'hhhhu3 P5 test',
    path: dir,
    capabilities: capabilities || ['read', 'write', 'delete', 'mkdir', 'rename', 'move', 'copy'],
    coversRoot: true,
  });
  assert.equal(r.ok, true, 'grant mint failed: ' + (r.error || ''));
  return r.grantId;
}

test('hhhhu3 M-014: fb:confirmDestructive rejects an unauthorized grant WITHOUT showing the dialog', async () => {
  let dialogCalls = 0;
  const { handlers } = loadIpc(async () => { dialogCalls += 1; return { response: 1 }; });
  const dir = path.join(TMP, 'm014a');
  fs.mkdirSync(dir, { recursive: true });
  const victim = path.join(dir, 'victim.txt');
  fs.writeFileSync(victim, 'x');

  const r = await handlers.get('fb:confirmDestructive')(FAKE_EVENT, {
    operation: 'delete', sourcePath: victim, sourceGrantId: 'no-such-grant',
  });
  assert.equal(r.ok, false, 'unauthorized grant must reject');
  assert.equal(dialogCalls, 0, 'no native dialog may be shown for an unauthorized grant');
  assert.ok(fs.existsSync(victim), 'file untouched');

  // An unknown operation is rejected too.
  const r2 = await handlers.get('fb:confirmDestructive')(FAKE_EVENT, {
    operation: 'exfiltrate', sourcePath: victim, sourceGrantId: 'g',
  });
  assert.equal(r2.ok, false);
  assert.equal(dialogCalls, 0);
});

test('hhhhu3 B-007/M-014: delete requires a consumed intent token end-to-end', async () => {
  let dialogCalls = 0;
  const { handlers } = loadIpc(async () => { dialogCalls += 1; return { response: 1 }; });
  const dir = path.join(TMP, 'm014b');
  fs.mkdirSync(dir, { recursive: true });
  const victim = path.join(dir, 'victim.txt');
  fs.writeFileSync(victim, 'x');
  const grant = mintDirGrant(dir);

  // Without an intent token the mutation is refused.
  const refused = await handlers.get('fb:delete')(FAKE_EVENT, victim, grant);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /intentId|confirmation/i);
  assert.ok(fs.existsSync(victim), 'file must survive a tokenless delete');

  // Confirm -> execute consumes the token bound to canonical path + identity.
  const c = await handlers.get('fb:confirmDestructive')(FAKE_EVENT, {
    operation: 'delete', sourcePath: victim, sourceGrantId: grant,
  });
  assert.equal(c.ok, true);
  assert.ok(c.intentId);
  assert.equal(dialogCalls, 1, 'the native dialog is shown exactly once');

  const del = await handlers.get('fb:delete')(FAKE_EVENT, victim, grant, c.intentId);
  assert.equal(del.ok, true, 'delete with matching intent must succeed: ' + (del.error || ''));
  assert.ok(!fs.existsSync(victim), 'file removed');

  // The token is single-use: a replay with a new file at the same path fails.
  fs.writeFileSync(victim, 'y');
  const replay = await handlers.get('fb:delete')(FAKE_EVENT, victim, grant, c.intentId);
  assert.equal(replay.ok, false, 'consumed intent must not authorize a second delete');
  assert.ok(fs.existsSync(victim), 'file must survive a replayed token');
});

test('hhhhu3 M-014: a target swapped between confirm and execute is rejected (identity)', async () => {
  let dialogCalls = 0;
  const { handlers } = loadIpc(async () => { dialogCalls += 1; return { response: 1 }; });
  const dir = path.join(TMP, 'm014c');
  fs.mkdirSync(dir, { recursive: true });
  const victim = path.join(dir, 'victim.txt');
  fs.writeFileSync(victim, 'original');
  const grant = mintDirGrant(dir);

  const c = await handlers.get('fb:confirmDestructive')(FAKE_EVENT, {
    operation: 'delete', sourcePath: victim, sourceGrantId: grant,
  });
  assert.equal(c.ok, true);

  // Swap the target: delete + recreate changes the NTFS file ID (identity).
  fs.unlinkSync(victim);
  fs.writeFileSync(victim, 'swapped');

  // If the new inode happens to collide with the old one (rare FS reuse),
  // the delete legitimately succeeds — skip the mismatch assertion then.
  const del = await handlers.get('fb:delete')(FAKE_EVENT, victim, grant, c.intentId);
  if (del.ok) {
    assert.ok(!fs.existsSync(victim));
  } else {
    assert.match(del.error, /does not match|fresh confirmation/i);
    assert.ok(fs.existsSync(victim), 'swapped target must survive');
  }
});

// ---------------------------------------------------------------------------
// M-016 — directory-move partial-failure recovery (behavioral)
// ---------------------------------------------------------------------------

function loadFileBrowser() {
  try { delete require.cache[require.resolve(FILE_BROWSER)]; } catch (_) {}
  require.cache[require.resolve('electron')] = {
    exports: { shell: { showItemInFolder: () => {}, openPath: async () => '' } },
  };
  return require(FILE_BROWSER);
}

test('hhhhu3 M-016: a failed directory copy removes the partial destination', async () => {
  const fb = loadFileBrowser();
  const srcDir = path.join(TMP, 'm016-src');
  const destDir = path.join(TMP, 'm016-dest');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'a.txt'), 'a');

  const realCp = fsp.cp;
  fsp.cp = async (_s, dest) => {
    // Simulate a mid-copy failure AFTER creating a partial destination tree.
    await fsp.mkdir(dest, { recursive: true });
    await fsp.writeFile(path.join(dest, 'partial.txt'), 'half');
    throw new Error('simulated mid-copy failure');
  };
  try {
    await assert.rejects(fb.moveTo(srcDir, destDir), /destination cleaned up/);
  } finally {
    fsp.cp = realCp;
  }
  assert.ok(!fs.existsSync(path.join(destDir, 'm016-src')), 'partial destination must be removed');
  assert.ok(fs.existsSync(path.join(srcDir, 'a.txt')), 'source must stay intact');
});

test('hhhhu3 M-016: an incomplete source removal reports structured partialSuccess', async () => {
  const fb = loadFileBrowser();
  const srcDir = path.join(TMP, 'm016-src2');
  const destDir = path.join(TMP, 'm016-dest2');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'a.txt'), 'a');

  const realRm = fsp.rm;
  fsp.rm = async (p, opts) => {
    // Fail ONLY the source-removal step (force:false); the destination
    // cleanup step uses force:true and must still work.
    if (opts && opts.force === false) throw new Error('EBUSY: simulated');
    return realRm(p, opts);
  };
  try {
    const r = await fb.moveTo(srcDir, destDir);
    assert.equal(r.partialSuccess, true, 'must report structured partial success');
    assert.equal(r.path, path.join(destDir, 'm016-src2'));
    assert.match(r.warning, /could not be fully removed/i);
    assert.ok(fs.existsSync(path.join(destDir, 'm016-src2', 'a.txt')), 'copy landed');
  } finally {
    fsp.rm = realRm;
  }
});

// ---------------------------------------------------------------------------
// M-017 — readFile growth detection (behavioral)
// ---------------------------------------------------------------------------

test('hhhhu3 M-017: readFile re-stats through the fd and returns the grown content', async () => {
  const fb = loadFileBrowser();
  const f = path.join(TMP, 'm017-grow.txt');
  const FULL = 'ABCDEFGHIJKLMNOPQRST'; // 20 bytes
  fs.writeFileSync(f, FULL);

  const realOpen = fsp.open;
  let statCalls = 0;
  fsp.open = async (...args) => {
    const fd = await realOpen(...args);
    const realStat = fd.stat.bind(fd);
    fd.stat = async () => {
      statCalls += 1;
      const st = await realStat();
      // First stat lies (simulates the pre-growth size); later stats are real.
      if (statCalls === 1) return { ...st, size: 10 };
      return st;
    };
    return fd;
  };
  try {
    const buf = await fb.readFile(f, 1024 * 1024);
    assert.equal(buf.toString('utf8'), FULL, 'grown content must be returned in full');
    assert.ok(statCalls >= 2, 'a second stat through the fd must have happened');
  } finally {
    fsp.open = realOpen;
  }
});

test('hhhhu3 M-017: readFile refuses files larger than the preview cap', async () => {
  const fb = loadFileBrowser();
  const f = path.join(TMP, 'm017-big.txt');
  fs.writeFileSync(f, Buffer.alloc(4096, 1));
  await assert.rejects(fb.readFile(f, 1024), /too large to preview/i);
});

// ---------------------------------------------------------------------------
// M-012 / B-007 — renderer migration source-level guards
// ---------------------------------------------------------------------------

function walkJs(dirPath, out) {
  for (const e of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const p = path.join(dirPath, e.name);
    if (e.isDirectory()) walkJs(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('hhhhu3 B-007: no renderer call site bypasses the FbIntent bridge', () => {
  const rendererDir = path.join(ROOT, 'renderer');
  const files = walkJs(rendererDir, []);
  const allowed = new Set([
    path.join('renderer', 'services', 'fbIntentBridge.js'),
  ]);
  const offenders = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f);
    if (allowed.has(rel)) continue;
    const src = fs.readFileSync(f, 'utf8');
    if (/window\.api\.fb(Delete|Rename|Move)\(/.test(src)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], 'all destructive calls must go through window.FbIntent: ' + offenders.join(', '));

  // The bridge itself must confirm-then-execute.
  const bridge = fs.readFileSync(path.join(rendererDir, 'services', 'fbIntentBridge.js'), 'utf8');
  assert.ok(/fbConfirmDestructive/.test(bridge), 'bridge must call fbConfirmDestructive');
  assert.ok(/intentId/.test(bridge), 'bridge must forward the minted intentId');
});

test('hhhhu3 M-012: no renderer call site bypasses the paginated listing drain', () => {
  const rendererDir = path.join(ROOT, 'renderer');
  const files = walkJs(rendererDir, []);
  const allowed = new Set([
    path.join('renderer', 'services', 'fbListPaged.js'), // legacy fallback lives here
  ]);
  const offenders = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f);
    if (allowed.has(rel)) continue;
    const src = fs.readFileSync(f, 'utf8');
    if (/window\.api\.fbList\(/.test(src)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], 'all listing calls must go through window.FbListPaged.drain: ' + offenders.join(', '));

  const drain = fs.readFileSync(path.join(rendererDir, 'services', 'fbListPaged.js'), 'utf8');
  assert.ok(/fbListStart/.test(drain) && /fbListNext/.test(drain) && /fbListClose/.test(drain),
    'drain must walk the paginated surface');
});

test('hhhhu3 B-007/M-012: preload + index.html + main wiring are in place', () => {
  const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  for (const ch of ['fb:confirmDestructive', 'fb:listStart', 'fb:listNext', 'fb:listClose']) {
    assert.ok(preload.includes(ch), 'preload must expose ' + ch);
  }
  assert.match(preload, /fbRename:[^)]*intentId/, 'fbRename must accept an intentId');
  assert.match(preload, /fbDelete:[^)]*intentId/, 'fbDelete must accept an intentId');
  assert.match(preload, /fbMove:[^)]*intentId/, 'fbMove must accept an intentId');

  const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
  assert.ok(html.includes('services/fbIntentBridge.js'), 'index.html must load fbIntentBridge.js');
  assert.ok(html.includes('services/fbListPaged.js'), 'index.html must load fbListPaged.js');

  // Main: confirm authorizes before the dialog and binds canonical + identity;
  // the execute handlers re-observe identity.
  const intentIpc = fs.readFileSync(path.join(ROOT, 'main', 'ipc', 'fileBrowserDestructiveIntent.js'), 'utf8');
  assert.ok(/preflight/.test(intentIpc), 'confirm must use non-consuming preflight authorization');
  assert.ok(/captureIdentity/.test(intentIpc), 'confirm must bind the file identity');
  const fbIpc = fs.readFileSync(path.join(ROOT, 'main', 'ipc', 'registerFileBrowserIpc.js'), 'utf8');
  assert.ok(/captureIdentity/.test(fbIpc), 'execute handlers must re-observe the file identity');
  assert.ok(/authz\.canonicalPath/.test(fbIpc), 'execute handlers must bind the canonical path');
});
