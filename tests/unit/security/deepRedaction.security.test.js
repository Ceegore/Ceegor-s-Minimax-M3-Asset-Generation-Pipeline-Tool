// tests/unit/security/deepRedaction.security.test.js
// ============================================================================
// R0.1-003 — Reproduktionsgate für SYS-003 (360°-Audit design contract §5)
//
// Invariante: API-Keys und sonstige Geheimnisse dürfen in keinem
// Main-seitigen Pfad auftauchen, der sie an den Renderer, das Log oder
// den Diagnose-Snapshot weitergibt. Konkret: argv, stdout, stderr,
// JSON-Resultobjekte, Chunks, Spawn-Errors.
//
// Heute redigiert mmx.js nur argv (`redactedArgs`) — und auch das nur,
// wenn `keyInArgv` true ist. stdout/stderr werden ungeprüft an
// `onLog`/`onChunk` weitergereicht und am Ende in der IPC-Antwort
// zurückgegeben. Ein Child-Prozess, der `Authorization: Bearer <secret>`
// in stderr schreibt, bringt das Secret so in Logs, IPC und Diagnose.
//
// Diese Tests beweisen die Lücke. Sie sind ROT heute; nach R2.4
// (DeepRedactor) müssen sie GRÜN sein.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const MMX_JS = path.join(ROOT, 'src', 'mmx.js');
const MMX_APIKEY_SYNC = path.join(ROOT, 'src', 'mmxApiKeySync.js');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-r01-redact-'));
process.env.MINIMAX_CONFIG_DIR = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
process.env.HOME = TMP_HOME;

function freshMmx() {
  for (const p of [MMX_JS, MMX_APIKEY_SYNC]) {
    try { delete require.cache[require.resolve(p)]; } catch (_) {}
  }
  return require(MMX_JS);
}

test.after(() => {
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch (_) {}
});

// ---------------------------------------------------------------------------
// Test A: Ein Child, das `Authorization: Bearer <secret>` in stderr
// schreibt, darf das Secret weder im onLog-Callback noch in der
// IPC-Antwort (`r.stderr` oder `r.stdout`) hinterlassen.
// ---------------------------------------------------------------------------
test('R0.1-003.A: a child printing "Authorization: Bearer <secret>" in stderr leaks the secret to onLog + IPC', async () => {
  const cp = require('child_process');
  const SECRET = 'sk-leak-canary-DEEP-REDACTION-1';
  const LEAK = `Authorization: Bearer ${SECRET}`;
  const logSink = [];
  const chunkSink = [];
  const origSpawn = cp.spawn;
  cp.spawn = () => {
    const fakeProc = {
      stdout: { on() {}, resume() {} },
      stderr: { on(ev, cb) { if (ev === 'data') setImmediate(() => cb(Buffer.from(LEAK + '\n'))); } },
      on(ev, cb) { if (ev === 'close') setImmediate(() => cb(0)); },
      kill() {}, killed: false, pid: -1, unref() {},
    };
    return fakeProc;
  };

  const mmx = freshMmx();
  let ipcStderr = null;
  try {
    const r = await mmx.runMmx({
      args: ['image', 'generate', '--prompt', 'x'],
      apiKey: 'sk-route',
      sessionOnly: true,
      onLog: (line) => logSink.push(String(line)),
      onChunk: (c) => chunkSink.push(c),
    });
    ipcStderr = r && r.stderr;
  } finally {
    cp.spawn = origSpawn;
  }

  const joined = (logSink.join('\n') + '\n' + (ipcStderr || '') + '\n' + chunkSink.map(c => c && c.line).filter(Boolean).join('\n'));
  assert.ok(!joined.includes(SECRET),
    'SYS-003 fix: stderr carrying "Authorization: Bearer <secret>" must be redacted in onLog, onChunk, and the IPC stderr; leaked into:\n' + joined);
});

// ---------------------------------------------------------------------------
// Test B: Wenn der Renderer selbst ein `--api-key=<value>` in den args
// mitschickt (z.B. via argvBuilders), muss runMmx das in der
// zurückgegebenen argv-Liste UND in stdout/stderr-Chunks redigieren.
// Heute prüft mmx.js nur das zweitokenige `--api-key VALUE`; ein
// single-token `--api-key=VALUE` oder ein User-arg mit dem Key landet
// unredigiert in `r.argv`, `cmdLine` und den onLog-Chunks.
// ---------------------------------------------------------------------------
test('R0.1-003.B: a renderer-supplied "--api-key=<value>" arg must be redacted in argv + cmdLine', async () => {
  const cp = require('child_process');
  const SECRET = 'sk-equals-form-canary-2';
  let capturedArgv = null;
  const logSink = [];
  const origSpawn = cp.spawn;
  cp.spawn = (cmd, args) => {
    capturedArgv = args ? args.slice() : null;
    const fakeProc = {
      stdout: { on() {}, resume() {} },
      stderr: { on() {}, resume() {} },
      on(ev, cb) { if (ev === 'close') setImmediate(() => cb(0)); },
      kill() {}, killed: false, pid: -1, unref() {},
    };
    return fakeProc;
  };

  const mmx = freshMmx();
  try {
    // sessionOnly=true: argv trägt den Key NICHT, aber wir schleusen
    // ihn über die args selbst ein (das ist exakt der Bug: jeder
    // vom Renderer übergebene String landet ungeprüft im finalen argv).
    const r = await mmx.runMmx({
      args: ['image', 'generate', '--prompt', 'x', `--api-key=${SECRET}`],
      apiKey: 'sk-route',
      sessionOnly: true,
      onLog: (line) => logSink.push(String(line)),
    });
    assert.ok(capturedArgv, 'spawn must have been called');
    const joinedArgv = capturedArgv.join(' ');
    const joinedLogs = logSink.join('\n');
    const joinedResult = (r && r.argv ? r.argv.join(' ') : '') + '\n' + (r && r.stderr || '');
    assert.ok(!joinedArgv.includes(SECRET),
      'SYS-003 fix: a renderer-supplied --api-key=<value> in args must NOT appear in the spawned argv; leaked:\n' + joinedArgv);
    assert.ok(!joinedLogs.includes(SECRET),
      'SYS-003 fix: the same arg must NOT appear in the onLog cmdLine; leaked:\n' + joinedLogs);
    assert.ok(!joinedResult.includes(SECRET),
      'SYS-003 fix: the same arg must NOT appear in r.argv or r.stderr; leaked:\n' + joinedResult);
  } finally {
    cp.spawn = origSpawn;
  }
});

// ---------------------------------------------------------------------------
// Test C: Ein Spawn-ENOENT-Fehler darf den API-Key (über env oder argv)
// NICHT in der Fehlermeldung oder dem IPC-Result enthalten. Wir
// erzwingen den argv-Fallback (sessionOnly=false, sync fehlt), damit
// der Key tatsächlich in argv steht und im Fehlerpfad erscheinen könnte.
// ---------------------------------------------------------------------------
test('R0.1-003.C: a spawn ENOENT error must not leak the api key in argv/stderr/result', async () => {
  const cp = require('child_process');
  const SECRET = 'sk-spawn-error-canary-3';
  const origSpawn = cp.spawn;
  cp.spawn = () => {
    const fakeProc = {
      stdout: { on() {}, resume() {} },
      stderr: { on() {}, resume() {} },
      on(ev, cb) {
        if (ev === 'error') {
          const e = new Error('spawn ENOENT');
          e.code = 'ENOENT';
          setImmediate(() => cb(e));
        }
      },
      kill() {}, killed: false, pid: -1, unref() {},
    };
    return fakeProc;
  };

  // Erzwinge argv-Fallback.
  require.cache[require.resolve(MMX_APIKEY_SYNC)] = {
    exports: { syncApiKeyToMmxCliConfig: () => false, _resetForTest: () => {} },
  };
  const mmx = freshMmx();
  let r = null;
  try {
    r = await mmx.runMmx({
      args: ['quota'],
      apiKey: SECRET,
      sessionOnly: false,
    });
  } finally {
    cp.spawn = origSpawn;
  }

  // Der Fehlerpfad enthält command/argv (redacted) und stderr. Er darf
  // den Key weder in argv noch in stderr noch im error-String haben.
  const joined = [r && r.stderr, r && r.argv && r.argv.join(' '), r && (r.command || '')].filter(Boolean).join('\n');
  assert.ok(!joined.includes(SECRET),
    'SYS-003 fix: a spawn ENOENT must not leak the api key via stderr/argv/command; leaked into:\n' + joined);
});

// ---------------------------------------------------------------------------
// Test D: Es muss einen exportierten DeepRedactor-Helper geben, der
// rekursiv Strings/Arrays/Objekte/Errors nach bekannten Secret-Mustern
// (api_key, Authorization, Bearer, MMX_API_KEY) durchsucht und ersetzt.
// Heute gibt es KEINEN solchen Helper.
// ---------------------------------------------------------------------------
test('R0.1-003.D: a shared DeepRedactor helper must exist and recursively scrub secret patterns', () => {
  // Suche im src/-Tree nach einer Exportfunktion mit "redact" oder
  // "scrub" oder "sanitize" im Namen.
  const srcDir = path.join(ROOT, 'src');
  const found = [];
  function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.js')) {
        const body = fs.readFileSync(full, 'utf8');
        if (/(?:module\.exports|exports\.\w+)\s*=.*?(?:redact|scrub|sanitizeSecret|deepRedact)/i.test(body)
          || /function\s+(?:redact|scrub|deepRedact)\w*/i.test(body)) {
          found.push(full);
        }
      }
    }
  }
  walk(srcDir);
  assert.ok(found.length > 0,
    'SYS-003 fix: src/ must export a DeepRedactor / scrubSecret / redact helper that recursively walks strings/arrays/objects/errors. ' +
    'Today no such helper exists; logs/IPC carry raw secrets.');
});
