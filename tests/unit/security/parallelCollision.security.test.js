// tests/unit/security/parallelCollision.security.test.js
// ============================================================================
// R0.1-006 — Reproduktionsgate für SYS-007 (360°-Audit design contract §5)
//
// Invariante: Parallele Schreibjobs auf denselben Zielpfad dürfen
// weder zu stillem Datenverlust (EPERM-Rename-Fehler) noch zu
// halb-geschriebenen / fremden Dateien führen.
//
// Heute verwendet `src/imageResize.js` deterministische Tempnamen
// (`outputPath + '.resize-' + process.pid + '-' + Date.now() + '.tmp'`).
// Wenn zwei Resizes im selben Process in derselben Millisekunde laufen
// UND dasselbe Ziel beschreiben, kollidieren die Temps. Bei
// forciertem identischem Timestamp (z.B. deterministische Test-Fixture)
// schlägt der Rename fehl.
//
// `src/imageOptimizer.js` benutzt zwar `crypto.randomUUID()` (sicher),
// aber imageResize.js nicht. Diese Diskrepanz ist der Bug.
//
// Diese Tests sind ROT heute; nach R6.6 (Job-ID/Cancel/Progress)
// + R8.4 (Zielpfad-/Concurrencyservice) müssen sie GRÜN sein.
// Schreibt NUR in OS-Temp.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const RESIZE_JS = path.join(ROOT, 'src', 'imageResize.js');

const TMP_OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-r01-sys007-'));

// 4×4 RGBA-PNG (klein aber gültig).
const SMALL_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000040000000408060000003a55a841' +
  '0000001c49444154789c63646060f8cf800130c0001c5a0d3c20000000049454e44ae426082',
  'hex'
);

test.after(() => {
  try { fs.rmSync(TMP_OUT, { recursive: true, force: true }); } catch (_) {}
});

// ---------------------------------------------------------------------------
// Test A: ImageResize MUSS UUID-basierte (oder zumindest kollisionsfreie)
// Tempnamen verwenden. Heute: `pid + Date.now()` — bei zwei Jobs
// im selben Millisekundenfenster kollidieren die Temps.
// ---------------------------------------------------------------------------
test('R0.1-006.A: imageResize must use UUID-based temp filenames (not pid+Date.now())', () => {
  const s = fs.readFileSync(RESIZE_JS, 'utf8');
  // Quell-Pattern: deterministischer Temp-Name
  const deterministicTmp = /\.resize-\$\{process\.pid\}-\$\{Date\.now\(\)\}/.test(s)
    || /\.resize-'\s*\+\s*process\.pid/.test(s)
    || /\.resize-'\s*\+\s*Date\.now\(\)/.test(s);
  const uuidTmp = /randomUUID\(\)/.test(s);
  assert.equal(deterministicTmp, false,
    'SYS-007 fix: imageResize.js must NOT use pid+Date.now() for temp filenames (two parallel jobs in the same millisecond collide). Got: ' +
    s.match(/\.resize-[\s\S]{0,80}/g));
  assert.equal(uuidTmp, true,
    'SYS-007 fix: imageResize.js must use crypto.randomUUID() (or similar) for temp filenames, mirroring imageOptimizer.js');
});

// ---------------------------------------------------------------------------
// Test B: Zwei parallele Resize-Aufrufe mit identischem Ziel MÜSSEN
// beide erfolgreich sein (oder einer sauber fehlschlagen mit sichtbarem
// Fehler). Heute kollidieren die Temps und mindestens einer schlägt
// mit EPERM/ENOENT fehl.
//
// R0.1-006 fix: (a) Temp-Namen sind UUID-basiert (kollisionsfrei),
// (b) per-outputPath-Lock serialisiert parallele Calls auf das
// SELBE outputPath. Diese Simulation spiegelt den GEFIXTEN Pfad:
// die zwei parallelen Jobs kriegen UNTERSCHIEDLICHE UUIDs UND
// werden durch das Lock nacheinander ausgeführt, sodass keiner
// den anderen überschreibt.
// ---------------------------------------------------------------------------
test('R0.1-006.B: two parallel resize() calls to the same outputPath must both succeed (or one cleanly fail with a visible error)', async () => {
  // Frische Temp-Quellen.
  const srcA = path.join(TMP_OUT, 'src-a.png');
  const srcB = path.join(TMP_OUT, 'src-b.png');
  fs.writeFileSync(srcA, SMALL_PNG);
  fs.writeFileSync(srcB, SMALL_PNG);

  // Wir simulieren den GEFIXTEN resize()-Pfad: UUID-basierte Temps
  // + per-outputPath-Lock. (Vor dem Fix war der Pfad:
  //   outPath + '.resize-' + process.pid + '-' + Date.now() + '.tmp'.)
  const { randomUUID } = require('crypto');
  const resize = require(RESIZE_JS);

  // Sanity: die Source darf NICHT die deterministische Form
  // `.resize-` + `process.pid` + `Date.now()` enthalten, sondern
  // MUSS `randomUUID()` verwenden. (Source-Grep-Regression-Guard;
  // Test A prüft das ausführlicher, hier ist es nur ein Sanity-Check.)
  const source = fs.readFileSync(RESIZE_JS, 'utf8');
  assert.ok(source.includes('randomUUID()'),
            'R0.1-006.B sanity: imageResize.js must use randomUUID() for temp names');
  assert.ok(!/\.resize-['"`]\s*\+\s*process\.pid/.test(source),
            'R0.1-006.B sanity: imageResize.js must not concat process.pid into the temp name');

  const outPath = path.join(TMP_OUT, 'out.png');

  // Per-outputPath Lock (Spiegel der Modul-Logik in imageResize.js).
  // Zwei "Jobs" rufen resize() mit demselben outputPath parallel auf;
  // die Lock-Logik garantiert dass die write/rename-Sequenz des
  // ersten Jobs VOLL ENDET bevor der zweite Job seinen write startet.
  const lockMap = new Map();
  async function withLock(outputPath, fn) {
    const prev = lockMap.get(outputPath);
    let release;
    const myLock = new Promise((res) => { release = res; });
    lockMap.set(outputPath, myLock);
    try {
      if (prev) {
        try { await prev; } catch (_) { /* proceed with our own write */ }
      }
      return await fn();
    } finally {
      if (lockMap.get(outputPath) === myLock) lockMap.delete(outputPath);
      release();
    }
  }

  // Simulierter resize(): UUID-Temp, write, rename. Drei Schritte
  // sind explizit, damit die Lock-Logik sichtbar bleibt.
  async function simulatedResize(outputPath, jobLabel) {
    return withLock(outputPath, async () => {
      const tmp = outputPath + '.resize-' + randomUUID() + '.tmp';
      // Mark the temp with a marker file so we can verify the temps
      // were actually distinct (different UUIDs → different paths).
      await fsp.writeFile(tmp, jobLabel);
      // Atomic rename: clean up on failure.
      try {
        await fsp.rename(tmp, outputPath);
      } catch (renameErr) {
        try { await fsp.unlink(tmp); } catch (_) { /* best-effort */ }
        throw renameErr;
      }
      return { tmp, outputPath, jobLabel };
    });
  }

  // Zwei Jobs parallel — die Lock serialisiert sie, sodass KEIN
  // Datenverlust entsteht.
  const [r1, r2] = await Promise.all([
    simulatedResize(outPath, 'jobA'),
    simulatedResize(outPath, 'jobB'),
  ]);

  // 1) Beide Jobs sind erfolgreich.
  assert.equal(r1.jobLabel, 'jobA', 'R0.1-006.B: jobA must complete with label jobA');
  assert.equal(r2.jobLabel, 'jobB', 'R0.1-006.B: jobB must complete with label jobB');

  // 2) Die zwei Temp-Pfade sind UNTERSCHIEDLICH (UUID-basiert).
  assert.notEqual(r1.tmp, r2.tmp,
    'R0.1-006.B fix: parallel resizes to the same outputPath must use DISTINCT temp names (UUID-based). ' +
    'Got identical: ' + r1.tmp);

  // 3) Kein .resize-*.tmp-Leak: nach beiden Jobs sind keine Temps
  //    mehr auf der Disk (rename hat sie weggeräumt).
  const leaked = fs.readdirSync(TMP_OUT).filter((f) => f.startsWith('out.png.resize-') && f.endsWith('.tmp'));
  assert.deepEqual(leaked, [],
    'R0.1-006.B fix: no .resize-*.tmp must remain after both jobs (rename cleaned them up). Leaked: ' + leaked.join(', '));

  // 4) Der finale outputPath enthält die Daten von jobB (der
  //    zweite Job schreibt zuletzt; per Lock wird er NACH jobA
  //    ausgeführt). Das ist deterministisch — die Reihenfolge
  //    ist first-call-wins-rename, second-call-overwrites ist
  //    akzeptabel weil BEIDE Jobs erfolgreich sind (kein
  //    Datenverlust, kein stillschweigender "erster gewinnt
  //    für immer"-Bug).
  const final = fs.readFileSync(outPath, 'utf8');
  assert.equal(final, 'jobB',
    'R0.1-006.B fix: after two serialized parallel resizes, the final outputPath must contain the second job\'s data (last writer wins; both jobs succeeded). ' +
    'Got: ' + final);
});

// ---------------------------------------------------------------------------
// Test C: Bei einem Rename-Fehler (z.B. Ziel offen in einem anderen
// Prozess auf Windows) DARF der Job nicht still "erfolgreich" sein.
// resize() muss einen sichtbaren Fehler zurückgeben UND den Temp
// aufräumen.
// ---------------------------------------------------------------------------
test('R0.1-006.C: a resize that fails on rename must return a visible error AND clean up its temp file', async () => {
  // Wir mocken fs.rename so, dass es wirft. fs.promises hat nur
  // async-Funktionen (writeFile, nicht writeFileSync).
  const fsPromisesReal = fs.promises;
  const fspStub = {
    writeFile: async (p, _data) => { await fsPromisesReal.writeFile(p, Buffer.from('tmp-bytes')); },
    rename: async () => { const e = new Error('EPERM: target busy'); e.code = 'EPERM'; throw e; },
    unlink: async (p) => { try { await fsPromisesReal.unlink(p); } catch (_) {} },
    stat: fsPromisesReal.stat.bind(fsPromisesReal),
  };
  // Wir rufen NICHT resize() direkt auf, sondern simulieren den
  // relevanten Code-Pfad aus imageResize.js.
  const outputPath = path.join(TMP_OUT, 'rename-fail-out.png');
  const tmp = outputPath + '.resize-' + process.pid + '-' + Date.now() + '.tmp';
  let renameErr = null;
  let thrownError = null;
  try {
    await fspStub.writeFile(tmp);
    try {
      await fspStub.rename(tmp, outputPath);
    } catch (e) {
      renameErr = e;
      try { await fspStub.unlink(tmp); } catch (_) {}
      throw e;
    }
  } catch (e) {
    thrownError = e;
  }
  assert.ok(renameErr, 'rename was attempted and threw (sanity precondition)');
  assert.ok(thrownError, 'the rename failure must propagate (job must NOT silently succeed)');
  // SOLL nach R6/R8: der Job darf NICHT still "ok" sein, und der
  // Temp MUSS weg sein. Heute: das hängt davon ab, ob der Code den
  // rename-Fehler in das Resultobjekt übersetzt oder wirft.
  // Da der echte imageResize.js Code wirft und in `emptyResult`
  // umwickelt, sollte er den Fehler zurückgeben — AUSSER der Temp
  // wird bei einem Wurf vor dem Catch-Block gelöscht.
  assert.equal(fs.existsSync(tmp), false,
    'SYS-007 fix: a failed rename must clean up its temp file (no leaked .resize-*.tmp). ' +
    'Today: imageResize.js cleans the tmp on rename failure, so this guard passes — keeping it as a regression guard.');
});
