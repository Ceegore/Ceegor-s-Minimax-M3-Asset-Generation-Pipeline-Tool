// tests/unit/security/setActiveDir.security.test.js
// ============================================================================
// R0.1-001 — Reproduktionsgate für SYS-001 (360°-Audit design contract §5)
//
// Invariante: Rendererinput darf NIEMALS einen neuen Write-Root im Dateisystem
// erzeugen.
//
// Heute akzeptiert `fb:set-active-dir` jeden Pfad und macht ihn über
// `PathSecurityService.setActiveDir` zum erlaubten Root. Über `state:set`
// kann ein kompromittierter Renderer `pipeline.image.workspace` auf einen
// beliebigen Pfad setzen; `state:get` re-trustet diesen Pfad via
// `addTrusted`. Damit ist die Trust-Allowlist vom Renderer kontrollierbar.
//
// Diese Tests assertieren das SOLL-Verhalten. Heute sind sie ROT (jeder
// Test schlägt fehl, weil die Implementierung genau den dokumentierten
// Bug hat). Nach R1 (S1-Designreview) müssen sie GRÜN sein.
//
// Schreibt NUR in OS-Temp. Kein Schreibzugriff auf Produktcode.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const FB_IPC = path.join(ROOT, 'main', 'ipc', 'registerFileBrowserIpc.js');
const STATE_IPC = path.join(ROOT, 'main', 'ipc', 'registerStateIpc.js');

// ---- Isolierte Temp-Wurzel für alle Tests ----
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-r01-sys001-'));
process.env.MINIMAX_CONFIG_DIR = TMP_HOME;
const TMP_FAKEWIN = path.join(TMP_HOME, 'fake-C');  // Stellvertreter für C:\Windows

function loadHandlers() {
  for (const p of [FB_IPC, STATE_IPC,
    path.join(ROOT, 'src', 'config'),
    path.join(ROOT, 'src', 'pathUtils'),
    path.join(ROOT, 'main', 'services', 'PathSecurityService'),
    path.join(ROOT, 'src', 'state')]) {
    try { delete require.cache[require.resolve(p)]; } catch (_) {}
  }
  const handlers = new Map();
  require.cache[require.resolve('electron')] = {
    exports: {
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
      app: { getPath: () => TMP_HOME },
      dialog: { showMessageBox: async () => ({ response: 1 }) },
    },
  };
  require.cache[require.resolve('child_process')] = {
    exports: { spawn: () => { throw new Error('spawn should not be called in R0.1 security repros'); } },
  };
  require(FB_IPC).register({ appRoot: TMP_HOME });
  require(STATE_IPC).register({ appRoot: TMP_HOME });
  return handlers;
}

test.after(() => {
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch (_) {}
});

// ---------------------------------------------------------------------------
// Test 1: setActiveDir('C:\\Windows\\System32') DARF System32 NICHT
// schreibbar machen. Der Renderer darf keinen neuen Trust-Root setzen, der
// nicht aus einem nativen Picker, einer gültigen Config oder einem intern
// erzeugten Workspace stammt.
//
// R1.3 update: the handler is now a navigation-ACK only (S1 §4 File Browser
// §3). The actual security invariant is "the trust gate is NOT widened",
// which is verified by the post-condition assertion (isPathUnderAny === false
// after the call). The old "r.ok === false" assertion tested the pre-R1.3
// rejection semantics that no longer exist; the navigation-ACK is the
// correct R1.3 contract (the renderer's Up button still needs an ack so the
// next fb:list call lands in the right place).
// ---------------------------------------------------------------------------
test('R0.1-001.A: fb:set-active-dir must NOT widen the trust gate for an arbitrary path', () => {
  const handlers = loadHandlers();
  const pathSecurity = require(path.join(ROOT, 'main', 'services', 'PathSecurityService'));
  const setActive = handlers.get('fb:set-active-dir');
  assert.ok(setActive, 'fb:set-active-dir handler must be registered');
  const fakeSystem = path.join(TMP_FAKEWIN, 'Windows', 'System32');
  fs.mkdirSync(fakeSystem, { recursive: true });

  // Vorher: System32 ist nicht erlaubt.
  assert.equal(pathSecurity.isPathUnderAny(path.join(fakeSystem, 'evil.dll')), false,
    'precondition: fake-C\\Windows\\System32 must NOT be writable');

  // Act: any path is acceptable as a navigation hint. The R1.3 handler
  // is a nav-ACK; the security invariant is what the handler DIDN'T do.
  const r = setActive({}, fakeSystem);
  assert.ok(r && r.ok === true,
    'R1.3 contract: fb:set-active-dir returns a navigation ACK (got ' + JSON.stringify(r) + ')');
  // activeDir is null after the call (R1.3 returns no trust widening).
  assert.equal(r.activeDir, null,
    'R1.3 contract: the handler does NOT alter the activeDir (returns null)');

  // The real invariant: the trust gate is NOT widened.
  assert.equal(pathSecurity.isPathUnderAny(path.join(fakeSystem, 'evil.dll')), false,
    'SYS-001 fix: the refused path must remain outside the trust gate after fb:set-active-dir');
  // And no `addTrusted` was called for the path.
  assert.equal(pathSecurity.getActiveDir && pathSecurity.getActiveDir(), null,
    'R1.3: getActiveDir() must return null — the nav-ACK does not store the dir');
});

// ---------------------------------------------------------------------------
// Test 2: state:set mit beliebigem workspace DARF den Pfad NICHT zum
// Trust-Root machen. state:get re-trustet heute jeden absoluten
// workspace-Pfad via addTrusted; das muss validiert werden.
// ---------------------------------------------------------------------------
test('R0.1-001.B: state:set must not let a renderer widen the trust gate via pipeline.workspace', () => {
  const handlers = loadHandlers();
  const stateSet = handlers.get('state:set');
  const stateGet = handlers.get('state:get');
  const pathSecurity = require(path.join(ROOT, 'main', 'services', 'PathSecurityService'));
  assert.ok(stateSet && stateGet, 'state:set and state:get handlers must be registered');

  const fakeEvil = path.join(TMP_FAKEWIN, 'evil');
  fs.mkdirSync(fakeEvil, { recursive: true });
  assert.equal(pathSecurity.isPathUnderAny(path.join(fakeEvil, 'loot.dll')), false,
    'precondition: fake-C\\evil must NOT be writable');

  // Act: kompromittierter Renderer setzt einen beliebigen workspace.
  const r = stateSet({}, { pipeline: { image: { workspace: fakeEvil } } });
  // SOLL: state:set verwirft den payload ODER state:get re-trustet NUR,
  // wenn der Pfad bereits Main-seitig validiert ist. Heute wird jeder
  // absolute Pfad re-getrustet.
  stateGet({});

  assert.equal(pathSecurity.isPathUnderAny(path.join(fakeEvil, 'loot.dll')), false,
    'SYS-001 fix: a renderer-supplied pipeline.workspace must NOT silently widen the trust gate ' +
    '(state:get re-trusts any absolute workspace path via addTrusted today)');
});

// ---------------------------------------------------------------------------
// Test 3: state:set + state:get DARF NICHT dazu führen, dass ein Renderer-
// Pfad nachträglich getrustet wird. Auch das gehört zum Capability-Bruch:
// ein Set + ein Get = Trust-Erweiterung. R1.3 + R1.4 entfernt sowohl
// `fb:trust-ancestors` als auch das `addTrusted`-Wiedervertrauen in
// `state:get`; der Test verifiziert jetzt nur die state:get-Seite des
// Vertrags (trust-ancestors ist im R1.3-Vertrag gelöscht).
// ---------------------------------------------------------------------------
test('R0.1-001.C: state:set + state:get must not bootstrap trust for a renderer path', () => {
  const handlers = loadHandlers();
  const stateSet = handlers.get('state:set');
  const stateGet = handlers.get('state:get');
  const pathSecurity = require(path.join(ROOT, 'main', 'services', 'PathSecurityService'));
  // R1.3: fb:trust-ancestors is REMOVED (S1 §4 File Browser). The 3-step
  // renderer attack (state:set → state:get → trust-ancestors) is no
  // longer possible because the third step no longer exists. The 2-step
  // attack (state:set → state:get) is the one we still need to verify.
  assert.ok(stateSet && stateGet, 'state:set and state:get handlers must be registered');
  assert.equal(handlers.get('fb:trust-ancestors'), undefined,
    'R1.3 contract: fb:trust-ancestors is removed — a compromised renderer can no longer chain-widen the trust gate');

  const fakeOutside = path.join(TMP_FAKEWIN, 'outside-output');
  fs.mkdirSync(fakeOutside, { recursive: true });

  // Schritt 1: Renderer schreibt workspace = fakeOutside in state.
  stateSet({}, { pipeline: { image: { workspace: fakeOutside } } });
  // Schritt 2: state:get würde den Pfad heute re-trusten.
  stateGet({});

  // SOLL: nichts davon darf einen Pfad außerhalb des Output-Dirs /
  // eines Picker-Pfads trusten. R1.4 entfernt das `addTrusted` aus
  // state:get; der Pfad bleibt deshalb untrusted.
  const stillOutside = pathSecurity.isPathUnderAny(path.join(fakeOutside, 'x.png'));
  assert.equal(stillOutside, false,
    'SYS-001 fix: a 3-step renderer attack (state:set → state:get → trust-ancestors) must NOT bootstrap trust for an arbitrary path');
});

// ---------------------------------------------------------------------------
// Test 4 (R1.1-Update): Root-Delete-Invariante mit Main-minted Grant.
// R1.1 hat das fb:set-active-dir-Setup durch ein PathGrantService-
// mintDirectoryGrant + authorize ersetzt. Der Test beweist jetzt
// stärker als vorher: auch ein GÜLTIGER Directory-Grant (mit
// 'delete'-Capability) autorisiert das eigene Root nicht. Das
// deckt S1 §2.5 ab: "Ein Directory-Grant darf nie sein eigenes
// Root löschen, umbenennen oder als Move-Quelle verwenden."
// ---------------------------------------------------------------------------
test('R0.1-001.D (R1.1): a Main-minted directory grant must NOT authorize deletion of its own root', () => {
  // Lade den Service (kein Module._load-Override nötig; der Service
  // ist ein neuer, sauberer Pfad-Sicherheits-Service).
  const { PathGrantService } = require(path.join(ROOT, 'main', 'services', 'PathGrantService'));
  const svc = new PathGrantService();

  const victim = fs.mkdtempSync(path.join(TMP_HOME, 'victim-'));
  fs.writeFileSync(path.join(victim, 'precious.txt'), 'must survive');

  // Act: Main mintet einen Directory-Grant für das victim-Dir,
  // inklusive 'delete'-Capability. (Der Renderer kann das nicht —
  // dieser Aufruf ist hier absichtlich Main-seitig.)
  const minted = svc.mintDirectoryGrant({
    origin: 'picker-browser-dir',
    purpose: 'test root-delete invariant',
    path: victim,
    capabilities: ['read', 'write', 'delete', 'mkdir', 'rename', 'move', 'copy'],
  });
  assert.equal(minted.ok, true, 'mint must succeed for a real directory');
  const grantId = minted.grantId;

  // 1) Ein Child darf gelöscht werden (positiv-Kontrolle).
  const childOk = svc.authorize(grantId, { operation: 'delete', path: path.join(victim, 'precious.txt') });
  assert.equal(childOk.ok, true, 'sanity: a child of the grant root IS authorized for delete');

  // 2) Der Root selbst darf NICHT gelöscht werden (Hauptinvariante).
  const rootDenied = svc.authorize(grantId, { operation: 'delete', path: victim });
  assert.equal(rootDenied.ok, false,
    'S1 §2.5: a directory grant must NEVER authorize deletion of its own root (root-delete is forbidden). Got: ' +
    JSON.stringify(rootDenied));
  assert.match(rootDenied.error, /root itself|descendant/i);

  // 3) Auch rename/move/copy auf den Root sind verboten.
  for (const op of ['rename', 'move', 'copy']) {
    const denied = svc.authorize(grantId, { operation: op, path: victim });
    assert.equal(denied.ok, false, op + ' on the grant root must be denied');
  }

  // 4) Die Datei existiert noch (der fehlgeschlagene Versuch hat
  // keine Daten zerstört).
  assert.equal(fs.existsSync(path.join(victim, 'precious.txt')), true,
    'a file inside the grant root must survive a denied delete attempt on the root');
});
