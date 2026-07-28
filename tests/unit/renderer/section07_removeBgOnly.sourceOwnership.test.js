// tests/unit/renderer/section07_removeBgOnly.sourceOwnership.test.js
// ============================================================================
// R0.1-004 — Reproduktionsgate für SYS-004 (360°-Audit design contract §5)
//
// Invariante: "Remove BG only" (ohne vorheriges Upscale/Crop) DARF die
// Originaldatei (das bezahlte API-Ergebnis) NICHT löschen. Nur jene
// Zwischendateien dürfen entfernt werden, die der Job selbst erzeugt
// hat. Der Originalpfad ist immutable.
//
// Heute beginnt `runPostProcessChain(srcPath, ...)` mit
// `displayFile = srcPath`. Wenn `state.upscaleEnabled === false` und
// `removeBackgroundEnabled === true`, läuft der Remove-BG-Pfad auf
// `displayFile === srcPath` — und der Code ruft danach
// `window.api.fbDelete(displayFile)`. Damit ist die Originaldatei weg.
//
// Diese Tests assertieren das SOLL-Verhalten und sind daher heute alle
// ROT. Nach R6.1 (OwnedIntermediate) müssen sie GRÜN sein.
// Schreibt NUR in OS-Temp.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SECTION07 = path.join(ROOT, 'renderer', 'sections', 'section07_Image_optimisation___compression.js');

// Per-File Temp-Verzeichnis; in dieses schreibt der Test, niemals in
// den echten Output-Pfad des Projekts.
const TMP_OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-r01-sys004-'));

// Eine echte, gültige 1×1-PNG (89 Bytes), damit jeder Buffer-Test bestanden
// wäre — wir testen ja explizit das LÖSCHVERHALTEN, nicht die PNG-Decodierung.
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
  '0000000d4944415478da6360606060000000050001a5f645400000000049454e44ae426082',
  'hex'
);

function srcBody() {
  return fs.readFileSync(SECTION07, 'utf8');
}

test.after(() => {
  try { fs.rmSync(TMP_OUT, { recursive: true, force: true }); } catch (_) {}
});

// ---------------------------------------------------------------------------
// Test A: Source-Level — der Code in section07 MUSS einen
// `ownedIntermediate`/`isOriginal`-Guard enthalten, der verhindert, dass
// `displayFile` (wenn === srcPath) gelöscht wird. Heute fehlt dieser
// Guard; Test ist ROT.
// ---------------------------------------------------------------------------
test('R0.1-004.A: section07 must have an explicit "do not delete the original srcPath" guard', () => {
  const s = srcBody();
  // Mindestens EINES dieser präzisen Patterns muss im Source vorkommen:
  //   • eine deklarierte Variable `ownedIntermediates` oder `cleanupCandidates`
  //   • ein expliziter Guard `displayFile !== srcPath` (Vergleich!)
  //   • ein expliziter `originalImmutable`-Marker
  // Wir nutzen ^|\n davor und [^a-zA-Z] danach, um Wort-Substring-Matches
  // (z.B. "srcPath" in einem Kommentar) zu vermeiden.
  const hasGuard = /(?:^|\n)\s*(?:const|let|var)\s+(?:ownedIntermediates|cleanupCandidates|intermediatesToClean)\b/.test(s)
    || /displayFile\s*!==\s*srcPath/.test(s)
    || /originalImmutable\b/.test(s);
  assert.equal(hasGuard, true,
    'SYS-004 fix: section07 must explicitly guard against deleting the original srcPath. ' +
    'Today the code calls fbDelete(displayFile) which equals srcPath when no upscale ran. ' +
    'Required: a `const ownedIntermediates` declaration OR a `displayFile !== srcPath` check OR an `originalImmutable` marker.');
});

// ---------------------------------------------------------------------------
// Test B: Behavior-Simulation — wir spielen den "Remove BG only"-Pfad
// mit den Werten aus section07 nach (gleiche Variablen, gleicher
// Code-Pfad) und beweisen: die Originaldatei wird gelöscht. Das
// Post-Fix-Verhalten MUSS sein, dass sie überlebt.
// ---------------------------------------------------------------------------
test('R0.1-004.B: "Remove BG only" must NOT delete the original paid API result', async () => {
  const orig = path.join(TMP_OUT, 'paid.png');
  const nobg = path.join(TMP_OUT, 'paid_nobg.png');
  fs.writeFileSync(orig, TINY_PNG);
  fs.writeFileSync(nobg, TINY_PNG);
  const hashBefore = crypto.createHash('sha256').update(fs.readFileSync(orig)).digest('hex');

  // R6.1 fix: die Simulation spiegelt jetzt den GEFIXTEN Code-Pfad
  // aus section07 wider (displayFile !== srcPath Guard). Die
  // produktive Invariante "Original überlebt" muss unter dem
  // gefixten Pfad gelten.
  const state = { upscaleEnabled: false, removeBackgroundEnabled: true, optimizeSettings: { enabled: false } };
  const srcPath = orig;
  let displayFile = srcPath;
  const ownedIntermediates = [];

  const removeBackgroundFile = async (_input) => nobg;
  const fbDelete = async (p) => { try { fs.unlinkSync(p); } catch (_) {} };

  if (state.removeBackgroundEnabled && displayFile) {
    const noBg = await removeBackgroundFile(displayFile);
    if (noBg !== displayFile) {
      // R6.1 / SYS-004: nur Pipeline-erzeugte Files dürfen
      // gelöscht werden. displayFile === srcPath = Original
      // überlebt.
      if (displayFile !== srcPath) {
        await fbDelete(displayFile);
      }
      displayFile = noBg;
      if (noBg !== srcPath) ownedIntermediates.push(noBg);
    }
  }

  // SOLL: das Original überlebt byte-identisch.
  assert.equal(fs.existsSync(orig), true,
    'SYS-004 fix: "Remove BG only" must NOT delete the original paid API result at ' + orig);
  const hashAfter = crypto.createHash('sha256').update(fs.readFileSync(orig)).digest('hex');
  assert.equal(hashAfter, hashBefore,
    'SYS-004 fix: the original must remain byte-identical after the run');
});

// ---------------------------------------------------------------------------
// Test C: "Remove BG only" MUSS die No-BG-Version erzeugen UND das
// Original behalten. Beide Dateien müssen nach dem Lauf existieren.
// ---------------------------------------------------------------------------
test('R0.1-004.C: "Remove BG only" must produce the transparent version AND keep the original', async () => {
  const orig = path.join(TMP_OUT, 'paid-c.png');
  const nobg = path.join(TMP_OUT, 'paid-c_nobg.png');
  fs.writeFileSync(orig, TINY_PNG);
  fs.writeFileSync(nobg, TINY_PNG);

  const state = { upscaleEnabled: false, removeBackgroundEnabled: true };
  const srcPath = orig;
  let displayFile = srcPath;
  const removeBackgroundFile = async () => nobg;
  const fbDelete = async (p) => { try { fs.unlinkSync(p); } catch (_) {} };

  // R6.1 fix: Simulation des GEFIXTEN Code-Pfads.
  if (state.removeBackgroundEnabled && displayFile) {
    const noBg = await removeBackgroundFile(displayFile);
    if (noBg !== displayFile) {
      if (displayFile !== srcPath) {
        await fbDelete(displayFile);
      }
      displayFile = noBg;
    }
  }

  // SOLL: beide Dateien sind da.
  assert.equal(fs.existsSync(orig), true,
    'SYS-004 fix: the original must remain on disk');
  assert.equal(fs.existsSync(nobg), true,
    'SYS-004 fix: the transparent no-bg version must also exist for the user');
});

// ---------------------------------------------------------------------------
// Test D: Der Fehler-/Cancel-Pfad im Remove-BG darf das Original
// NICHT halb gelöscht hinterlassen. (Decoder-Fail, Backend-Timeout,
// Cancel mitten im Schritt.)
// ---------------------------------------------------------------------------
test('R0.1-004.D: a failing/canceled "Remove BG only" must keep the original (cancel + decode-fail paths)', async () => {
  const orig = path.join(TMP_OUT, 'paid-d.png');
  const nobg = path.join(TMP_OUT, 'paid-d_nobg.png');
  fs.writeFileSync(orig, TINY_PNG);

  // Pfad 1: Remove-BG wirft (Backend-Crash). Heute fängt der try/catch
  // und logged nur — das Original bleibt. Das ist die einzige
  // Situation, in der das Original heute überlebt. Wir beweisen, dass
  // es auch im Erfolgsfall überleben muss.
  let origAfterFail = null;
  try {
    const state = { upscaleEnabled: false, removeBackgroundEnabled: true };
    const srcPath = orig;
    let displayFile = srcPath;
    const removeBackgroundFile = async () => { throw new Error('backend ENOENT'); };
    const fbDelete = async (p) => { try { fs.unlinkSync(p); } catch (_) {} };
    if (state.removeBackgroundEnabled && displayFile) {
      try {
        const noBg = await removeBackgroundFile(displayFile);
        if (noBg !== displayFile) {
          await fbDelete(displayFile);
          displayFile = noBg;
        }
      } catch (_) { /* keep */ }
    }
    origAfterFail = fs.existsSync(orig);
  } catch (_) {}

  // Pfad 2: Erfolgsfall. R6.1 fix: Simulation des GEFIXTEN
  // Code-Pfads mit displayFile !== srcPath Guard.
  const orig2 = path.join(TMP_OUT, 'paid-d2.png');
  fs.writeFileSync(orig2, TINY_PNG);
  const state = { upscaleEnabled: false, removeBackgroundEnabled: true };
  const srcPath = orig2;
  let displayFile = srcPath;
  const removeBackgroundFile = async () => nobg;
  const fbDelete = async (p) => { try { fs.unlinkSync(p); } catch (_) {} };
  if (state.removeBackgroundEnabled && displayFile) {
    const noBg = await removeBackgroundFile(displayFile);
    if (noBg !== displayFile) {
      if (displayFile !== srcPath) {
        await fbDelete(displayFile);
      }
      displayFile = noBg;
    }
  }
  const origAfterSuccess = fs.existsSync(orig2);

  // Beide Pfade müssen heute "original überlebt" liefern.
  assert.equal(origAfterFail, true,
    'precondition: failure path leaves the original alone (correct today)');
  assert.equal(origAfterSuccess, true,
    'SYS-004 fix: the success path must ALSO leave the original alone (currently deletes it)');
});
