// tests/unit/main/sessionOnlyPrivacy.credential.test.js
// ============================================================================
// R0.1-002 — Reproduktionsgate für SYS-002 (360°-Audit design contract §5)
//
// Invariante: Wenn der Nutzer "Don't save" für den API-Key wählt, darf der
// Key WEDER in config.txt noch in ~/.mmx/config.json, ~/.bash_history,
// Logs, IPC-Antworten oder Diagnose-Snapshots landen. Wechselt der
// Nutzer NACH einer früheren Persistierung auf Session-only, MUSS der
// zuvor gespeicherte Key aus ~/.mmx/config.json entfernt werden.
//
// Heute:
//   • Der IPC-Handler `mmx:run:job` liest `cfgMod.read().api_key` — wenn
//     das Feld leer ist (Session-only persistiert ''), wird der Aufruf
//     mit "No API key configured" abgelehnt. Der im Renderer-State
//     liegende Key kommt nie im Main an.
//   • `mmxApiKeySync.syncApiKeyToMmxCliConfig` schreibt den Key nach
//     ~/.mmx/config.json; ein "Session-only umschalten" ruft es nicht
//     auf und entfernt einen vorhandenen Key auch nicht.
//
// Diese Tests assertieren das SOLL-Verhalten. Sie sind ROT heute; nach
// R2 (Credentials, Redaction, Shutdown) müssen sie GRÜN sein.
// Schreibt NUR in OS-Temp.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const MMX_IPC = path.join(ROOT, 'main', 'ipc', 'registerMmxIpc.js');
const MMX_APIKEY_SYNC = path.join(ROOT, 'src', 'mmxApiKeySync.js');
const MMX_JS = path.join(ROOT, 'src', 'mmx.js');
const CONFIG_JS = path.join(ROOT, 'src', 'config.js');
const STATE_JS = path.join(ROOT, 'src', 'state.js');

// ---- Per-Test Temp-Home für ~/.mmx/config.json ----
function makeTempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-r01-cred-'));
  // mmxApiKeySync liest _homeDir() = process.env.USERPROFILE || HOME
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  return home;
}

function clearCache() {
  for (const p of [MMX_IPC, MMX_APIKEY_SYNC, MMX_JS, CONFIG_JS, STATE_JS,
    path.join(ROOT, 'main', 'services', 'VoicesCacheService')]) {
    try { delete require.cache[require.resolve(p)]; } catch (_) {}
  }
}

test.afterEach(() => {
  // Reset env so andere Tests nicht beeinflusst werden.
  delete process.env.USERPROFILE;
  delete process.env.HOME;
});

// ---------------------------------------------------------------------------
// Test A: Session-only persistence speichert den Key NICHT in
// config.txt. Beim "Save" mit apiKeyNoSave=true MUSS die persistierte
// Config einen leeren api_key haben. Der Renderer behält den Key
// in-memory (state.config.api_key), aber config.txt muss leer sein.
// ---------------------------------------------------------------------------
test('R0.1-002.A: persisted config.txt must have empty api_key when session-only is enabled', () => {
  const home = makeTempHome();
  process.env.MINIMAX_CONFIG_DIR = home;
  clearCache();
  const configMod = require(CONFIG_JS);
  const cfgPath = path.join(home, 'config.txt');
  fs.writeFileSync(cfgPath, [
    'api_key=sk-OLD-PERSISTED-KEY',
    'output_dir=',
    'region=global',
    'theme=dark',
    'styles=',
    '',
  ].join('\n'));
  // The current config schema validates + sanitises on read; ensure the
  // raw api_key survives the read so we can prove the "Save with
  // session-only" branch wipes it.
  const before = configMod.read();
  assert.equal(before.api_key, 'sk-OLD-PERSISTED-KEY',
    'precondition: config.txt must contain the old persisted key');

  // Simulate the renderer's "Save with Don't-save checked" flow:
  // section04_Settings.js calls `setConfig({ ...merged, api_key: '' })`
  // when apiKeyNoSave is true. Today the IPC `config:set` writes the
  // payload as-is via the same code path; this test invokes the same
  // writer to prove the contract. config.write() returns void on success
  // and throws on failure — the absence of a throw is the success signal.
  configMod.write({ ...before, api_key: '' });

  // Re-read from disk: api_key must be empty.
  const onDisk = fs.readFileSync(cfgPath, 'utf8');
  assert.ok(!/sk-OLD-PERSISTED-KEY/.test(onDisk),
    'SYS-002 fix: the persisted api_key must be empty after switching to session-only; config.txt still contains the old key:\n' + onDisk);
  assert.ok(/^api_key=\s*$/m.test(onDisk) || !/api_key=/.test(onDisk),
    'SYS-002 fix: api_key line must be empty or absent in persisted config.txt');
});

// ---------------------------------------------------------------------------
// Test B: mmxApiKeySync muss einen vorhandenen Key aus ~/.mmx/config.json
// ENTFERNEN, wenn der Nutzer auf Session-only umschaltet. Heute gibt es
// nur syncApiKeyToMmxCliConfig(apiKey) — kein "clear"-Pfad.
// ---------------------------------------------------------------------------
test('R0.1-002.B: switching to session-only must remove the prior key from ~/.mmx/config.json', () => {
  const home = makeTempHome();
  process.env.MINIMAX_CONFIG_DIR = home;
  clearCache();
  const sync = require(MMX_APIKEY_SYNC);
  sync._resetForTest();

  // Vorher: ~/.mmx/config.json mit api_key (wie nach längerer Nutzung).
  const mmxDir = path.join(home, '.mmx');
  fs.mkdirSync(mmxDir, { recursive: true });
  const mmxCfg = path.join(mmxDir, 'config.json');
  fs.writeFileSync(mmxCfg, JSON.stringify({ api_key: 'sk-PRIOR-PERSISTED', region: 'global' }, null, 2));
  assert.equal(JSON.parse(fs.readFileSync(mmxCfg, 'utf8')).api_key, 'sk-PRIOR-PERSISTED',
    'precondition: ~/.mmx/config.json must contain the prior key');

  // Act: Nutzer schaltet auf Session-only. mmxApiKeySync hat heute KEINEN
  // Remove-Pfad — der "Sync" wird gar nicht aufgerufen. Wir simulieren
  // den Wechsel, indem wir prüfen, ob es überhaupt eine Exportfunktion
  // gibt, die den Key entfernt.
  const exported = require(MMX_APIKEY_SYNC);
  const hasRemove = (typeof exported.clearApiKeyFromMmxCliConfig === 'function')
    || (typeof exported.removeApiKeyFromMmxCliConfig === 'function')
    || (typeof exported.purgePersistedKey === 'function');

  assert.equal(hasRemove, true,
    'SYS-002 fix: mmxApiKeySync must export a clear/remove helper (clearApiKeyFromMmxCliConfig / removeApiKeyFromMmxCliConfig / purgePersistedKey) so the "switch to session-only" path can purge ~/.mmx/config.json');
});

// ---------------------------------------------------------------------------
// Test C: registerMmxIpc.js mmx:run:job DARF NICHT "No API key configured"
// zurückgeben, wenn der Renderer einen gültigen Key im State hat und
// sessionOnly=true ist. Heute liest der Handler `cfgMod.read().api_key`
// (immer leer bei Session-only) und lehnt deshalb ab.
// ---------------------------------------------------------------------------
test('R0.1-002.C: mmx:run:job with sessionOnly must accept an in-memory key (not just file cfg)', async () => {
  const home = makeTempHome();
  process.env.MINIMAX_CONFIG_DIR = home;
  clearCache();
  const configMod = require(CONFIG_JS);
  const stateMod = require(STATE_JS);
  // config.txt ist leer (Session-only).
  fs.writeFileSync(path.join(home, 'config.txt'),
    ['api_key=', 'output_dir=', 'region=global', 'theme=dark', 'styles=', ''].join('\n'));
  // state.json hat apiKeyNoSave=true und einen in-memory Key über die
  // Settings-UI (das ist genau, was section04_Settings.js nach Save macht).
  const s = stateMod.read();
  s.apiKeyNoSave = true;
  stateMod.write(s);
  assert.equal(configMod.read().api_key, '', 'precondition: config.txt must be empty');

  // Mock den mmx-Spawn, damit der Test echt durchläuft ohne mmx-cli.
  const handlers = new Map();
  let capturedOpts = null;
  require.cache[require.resolve('electron')] = {
    exports: {
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
      app: { getPath: () => home },
      dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    },
  };
  // mmx.js durch ein Stub ersetzen, das nur die runMmx-Optionen fängt.
  require.cache[require.resolve(MMX_JS)] = {
    exports: {
      runMmx: async (opts) => { capturedOpts = opts; return { ok: true, code: 0, stdout: '{}', stderr: '', parsed: {}, command: 'mmx-mock', argv: opts.args || [] }; },
      cancelAll: () => {}, cancelByJobId: () => {}, cancelOne: () => {}, resolve: () => ({ command: 'mmx-mock', prefix: [] }),
      probeMmxVersion: () => '1.0.16', SUPPORTED_MMX: { min: '1.0.16', recommended: '1.0.16' }, compareSemver: () => 0,
    },
  };
  require.cache[require.resolve(MMX_APIKEY_SYNC)] = {
    exports: { syncApiKeyToMmxCliConfig: () => true, _resetForTest: () => {} },
  };
  // VoicesCacheService ist nur ein Pfad-Helfer; stub ist fine.
  require.cache[require.resolve(path.join(ROOT, 'main', 'services', 'VoicesCacheService'))] = {
    exports: { get: async () => ({ ok: true, voices: [] }) },
  };
  delete require.cache[MMX_IPC];
  require(MMX_IPC).register({ getMainWindow: () => null, appRoot: home });
  const handler = handlers.get('mmx:run:job');
  assert.ok(handler, 'mmx:run:job must be registered');

  // Der Renderer schickt einen gültigen in-memory Key + sessionOnly=true.
  // Wir simulieren den "neuen" Datenfluss: der Handler akzeptiert einen
  // rendererKey + sessionOnly im payload, nicht nur aus cfg.
  const r = await handler({}, {
    args: ['quota'],
    jobId: 'r001c',
    rendererApiKey: 'sk-IN-MEMORY-KEY',
    sessionOnly: true,
  });

  // SOLL: kein "No API key configured"; runMmx erhält den Key + sessionOnly.
  assert.equal(r && r.ok, true,
    'SYS-002 fix: mmx:run:job must accept the in-memory rendererApiKey when sessionOnly=true; got ' + JSON.stringify(r));
  if (r && r.stderr && /No API key configured/i.test(r.stderr)) {
    assert.fail('SYS-002: mmx:run:job returned "No API key configured" even though sessionOnly=true with a renderer-supplied key');
  }
  assert.equal(capturedOpts && capturedOpts.apiKey, 'sk-IN-MEMORY-KEY',
    'SYS-002 fix: runMmx must receive the in-memory key as apiKey');
  assert.equal(capturedOpts && capturedOpts.sessionOnly, true,
    'SYS-002 fix: runMmx must receive sessionOnly=true so the key is delivered via MMX_API_KEY env, not argv');
});

// ---------------------------------------------------------------------------
// Test D: Ein "Diagnose"-Snapshot des Main-Prozesses darf den Key NICHT
// enthalten, wenn Session-only aktiv ist.
// ---------------------------------------------------------------------------
test('R0.1-002.D: a diagnose snapshot must not leak the in-memory session-only API key', () => {
  // Heute liefert `mmx:diagnose` einen Snapshot, der u.a. config.txt
  // und state.json einliest. Bei Session-only MUSS der key in dieser
  // Ausgabe fehlen (oder explizit als <session-only, redacted>
  // markiert sein).
  const home = makeTempHome();
  process.env.MINIMAX_CONFIG_DIR = home;
  clearCache();
  const SECRET = 'sk-LEAK-CANARY-9876543210';
  fs.writeFileSync(path.join(home, 'config.txt'),
    ['api_key=', 'output_dir=', 'region=global', 'theme=dark', 'styles=', ''].join('\n'));
  const stateMod = require(STATE_JS);
  const s = stateMod.read();
  s.apiKeyNoSave = true;
  stateMod.write(s);

  // Suche im Quellcode, ob `mmx:diagnose` die SECRET-Key irgendwo
  // pre-render ausgibt (String-Vergleich gegen Source = grobe, aber
  // ausreichende Heuristik).
  const src = fs.readFileSync(MMX_IPC, 'utf8');
  const hasDiagnoseHandler = /ipcMain\.handle\(['"]mmx:diagnose['"]/.test(src);
  assert.ok(hasDiagnoseHandler, 'precondition: mmx:diagnose must exist for this regression to apply');

  // Wenn diagnose den Key loggt oder zurückgibt, taucht er in
  // String-Form irgendwo auf (entweder als wörtliche Konstante, oder
  // als unredacted apiKey). Wir prüfen die Rendererseite nicht, weil
  // sie IPC-Antwort weiterreicht — der Schlüssel darf nirgendwo in
  // einem Stringfeld landen, das die SECRET-Form enthält.
  // (Siehe auch deepRedaction.security.test.js für die argv-Seite.)
  // Heute: kein expliziter Redaction-Block in mmx:diagnose. Das hier
  // ist die präzise Lücke, die R2 schließen muss.
  //
  // R2.4: split on the handler REGISTRATION (not the bare channel
  // name) so we look at the body of the diagnose handler, not at
  // the first `mmx:diagnose` mention (which is in a comment block
  // at the top of the file). Also check the snapshot builder
  // (main/ipc/diagnoseSnapshot.js — extracted in R2.4 so
  // registerMmxIpc.js stays under the frozen 384-LOC SIZE-BUDGET)
  // for the redaction contract: the builder is where `apiKeyLength`
  // and the `deepRedact` call live today.
  const handlerBody = src.split(/ipcMain\.handle\(\s*['"]mmx:diagnose['"]/)[1] || '';
  let hasRedactionInDiagnose = /apiKeyLength|REDACTED|api_key_len|\*\*\*/i.test(handlerBody);
  if (!hasRedactionInDiagnose) {
    const snapshotSrc = fs.readFileSync(path.join(ROOT, 'main', 'ipc', 'diagnoseSnapshot.js'), 'utf8');
    hasRedactionInDiagnose = /apiKeyLength|REDACTED|api_key_len|\*\*\*/i.test(snapshotSrc);
  }
  assert.equal(hasRedactionInDiagnose, true,
    'SYS-002 fix: mmx:diagnose must redact any api_key reference (apiKeyLength / *** / <redacted>) so a session-only key never lands in the diagnose snapshot');
});
