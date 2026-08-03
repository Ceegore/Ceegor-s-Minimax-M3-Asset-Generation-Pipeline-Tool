// scratch_verify/live_verify.js
// ============================================================================
// LIVE-APP adversarial verification (hhhhu3 audit fixes) — runs inside a
// REAL Electron boot via the e2e harness (real preload, contextIsolation,
// sandbox, real IPC handlers, auto-accepted native dialogs).
//
// Live checks:
//   LIVE-1 (B-007 / M-014 / M-015): forged intentId refused, real
//            confirm->intentId delete succeeds, REPLAY of a consumed
//            intentId refused (one-shot).
//   LIVE-2 (M-012 / M-013 / L-004): cursor-paginated listing — forged
//            cursors refused, real cursor walks every page in order,
//            session close invalidates the cursor.
//   LIVE-3 (H-009 / L-003 live): config:set wrapped replace stores the key
//            as a credential blob — no plaintext on disk, empty api_key
//            line, api_credential_id set, getConfigPublic secret-free.
//   LIVE-4 (H-002 live): providers:generate with a bogus grant / unknown
//            provider is refused BEFORE touching the outDir.
//
// Launch: node scratch_verify/live_verify_launch.js  (spawns electron)
// ============================================================================

'use strict';

const path = require('path');
const fs = require('fs');
const { createHarness } = require('../scripts/e2e/harness.js');

const results = [];
function check(id, name, pass, detail) {
  results.push({ id, name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} [${id}] ${name}${detail ? ' :: ' + detail : ''}`);
}

async function main() {
  const { app } = require('electron');
  await app.whenReady();
  const h = createHarness({});
  const { exec, OUT, TMP } = h;
  const booted = await h.boot();
  check('LIVE-0', 'electron boot + renderer build', !!booted, booted ? 'harness booted' : 'boot failed');
  if (!booted) {
    console.log('PROBLEMS:', JSON.stringify(h.problems));
    try { await h.cleanup(); } catch (_) {}
    process.exit(1);
  }

  const CFG = path.join(TMP, 'config.txt');

  // ========================================================================
  // LIVE-1 — B-007 one-shot destructive intents (forged + replay attacks)
  // ========================================================================
  try {
    const victim = path.join(OUT, 'live_victim.txt');
    fs.writeFileSync(victim, 'victim');

    const grant = await exec(`(async () => {
      try {
        const r = await window.api.mintGrant(${JSON.stringify(OUT)}, 'write', { kind: 'directory', capabilities: ['read', 'write', 'mkdir', 'rename', 'copy', 'move', 'delete'] });
        return r && r.ok ? r.grantId : null;
      } catch (e) { return null; }
    })()`);
    check('LIVE-1a', 'mint write grant for OUT', !!grant, grant ? 'grantId minted' : 'mint failed');

    // Attack 1: forged intentId
    const forged = await exec(`(async () => {
      try { return await window.api.fbDelete(${JSON.stringify(victim)}, ${JSON.stringify(grant)}, 'forged-intent-12345'); }
      catch (e) { return { ok: false, error: e.message }; }
    })()`);
    check('LIVE-1b', 'forged intentId refused', forged && forged.ok === false, forged && forged.error ? String(forged.error).slice(0, 80) : JSON.stringify(forged));
    check('LIVE-1c', 'file intact after forged attack', fs.existsSync(victim));

    // Attack 2: tokenless delete
    const tokenless = await exec(`(async () => {
      try { return await window.api.fbDelete(${JSON.stringify(victim)}, ${JSON.stringify(grant)}); }
      catch (e) { return { ok: false, error: e.message }; }
    })()`);
    check('LIVE-1d', 'tokenless delete refused', tokenless && tokenless.ok === false);
    check('LIVE-1e', 'file intact after tokenless attack', fs.existsSync(victim));

    // Legit path: confirm -> intentId -> delete
    const confirm = await exec(`(async () => {
      try { return await window.api.fbConfirmDestructive({ operation: 'delete', sourcePath: ${JSON.stringify(victim)}, sourceGrantId: ${JSON.stringify(grant)} }); }
      catch (e) { return { ok: false, error: e.message }; }
    })()`);
    const intentId = confirm && confirm.ok ? confirm.intentId : null;
    check('LIVE-1f', 'confirmDestructive mints intentId', !!intentId, intentId ? String(intentId).slice(0, 12) + '...' : JSON.stringify(confirm));

    const del = await exec(`(async () => {
      try { return await window.api.fbDelete(${JSON.stringify(victim)}, ${JSON.stringify(grant)}, ${JSON.stringify(intentId)}); }
      catch (e) { return { ok: false, error: e.message }; }
    })()`);
    check('LIVE-1g', 'delete with real intentId succeeds', del && del.ok === true, del && del.error ? String(del.error).slice(0, 80) : 'ok');
    check('LIVE-1h', 'file removed on disk', !fs.existsSync(victim));

    // Attack 3: REPLAY the consumed intentId against a fresh file
    const victim2 = path.join(OUT, 'live_victim2.txt');
    fs.writeFileSync(victim2, 'victim2');
    const replay = await exec(`(async () => {
      try { return await window.api.fbDelete(${JSON.stringify(victim2)}, ${JSON.stringify(grant)}, ${JSON.stringify(intentId)}); }
      catch (e) { return { ok: false, error: e.message }; }
    })()`);
    check('LIVE-1i', 'replayed intentId refused (one-shot)', replay && replay.ok === false);
    check('LIVE-1j', 'second file intact after replay attack', fs.existsSync(victim2));
    try { fs.rmSync(victim2, { force: true }); } catch (_) {}
  } catch (e) {
    check('LIVE-1x', 'LIVE-1 completed without crash', false, String(e && e.message).slice(0, 120));
  }

  // ========================================================================
  // LIVE-2 — M-012/M-013/L-004 cursor-paginated listing (live IPC)
  // ========================================================================
  try {
    const listDir = path.join(OUT, 'live_list');
    fs.mkdirSync(listDir, { recursive: true });
    const names = [];
    for (let i = 1; i <= 7; i++) {
      const n = `lf${i}.txt`;
      fs.writeFileSync(path.join(listDir, n), `f${i}`);
      names.push(n);
    }
    names.sort();

    // Grant on the PARENT: a directory grant covers strict descendants,
    // not the root itself, so the listing dir must be a descendant.
    const grant = await exec(`(async () => {
      try {
        const r = await window.api.mintGrant(${JSON.stringify(OUT)}, 'read', { kind: 'directory', capabilities: ['read'] });
        return r && r.ok ? r.grantId : null;
      } catch (e) { return null; }
    })()`);
    check('LIVE-2a', 'mint read grant for listing dir', !!grant);

    const start = await exec(`(async () => {
      try { return await window.api.fbListStart({ dir: ${JSON.stringify(listDir)}, grantId: ${JSON.stringify(grant)}, pageSize: 3 }); }
      catch (e) { return { ok: false, error: e.message }; }
    })()`);
    check('LIVE-2b', 'fb:listStart returns session+page', start && start.ok === true && !!start.sessionId && !!start.cursor && start.totalCount === 7,
      start && start.error ? String(start.error).slice(0, 80) : `total=${start && start.totalCount} page=${start && start.items && start.items.length}`);

    if (start && start.ok) {
      // Attack: forged cursors
      let forgedRefused = 0;
      for (const bogus of ['0', '3', '999999', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']) {
        const r = await exec(`(async () => {
          try { return await window.api.fbListNext({ sessionId: ${JSON.stringify(start.sessionId)}, cursor: ${JSON.stringify(bogus)} }); }
          catch (e) { return { ok: false, error: e.message }; }
        })()`);
        if (r && r.ok === false) forgedRefused++;
      }
      check('LIVE-2c', 'all 4 forged cursors refused', forgedRefused === 4, `${forgedRefused}/4 refused`);

      // Walk the real pages
      const walked = [];
      let cursor = start.cursor;
      let hasMore = start.hasMore;
      walked.push(...(start.items || []).map((it) => it.name));
      let pages = 1;
      while (hasMore && pages < 10) {
        const next = await exec(`(async () => {
          try { return await window.api.fbListNext({ sessionId: ${JSON.stringify(start.sessionId)}, cursor: ${JSON.stringify(cursor)} }); }
          catch (e) { return { ok: false, error: e.message }; }
        })()`);
        if (!next || next.ok === false) break;
        walked.push(...(next.items || []).map((it) => it.name));
        cursor = next.cursor;
        hasMore = next.hasMore;
        pages++;
      }
      check('LIVE-2d', 'real cursor walks all 7 entries in order', JSON.stringify(walked) === JSON.stringify(names),
        `pages=${pages} got=${walked.length}`);

      const close = await exec(`(async () => {
        try { return await window.api.fbListClose({ sessionId: ${JSON.stringify(start.sessionId)} }); }
        catch (e) { return { ok: false, error: e.message }; }
      })()`);
      check('LIVE-2e', 'fb:listClose ok', close && close.ok === true);

      const afterClose = await exec(`(async () => {
        try { return await window.api.fbListNext({ sessionId: ${JSON.stringify(start.sessionId)}, cursor: ${JSON.stringify(cursor)} }); }
        catch (e) { return { ok: false, error: e.message }; }
      })()`);
      check('LIVE-2f', 'cursor dead after session close', afterClose && afterClose.ok === false);
    }
    fs.rmSync(listDir, { recursive: true, force: true });
  } catch (e) {
    check('LIVE-2x', 'LIVE-2 completed without crash', false, String(e && e.message).slice(0, 120));
  }

  // ========================================================================
  // LIVE-3 — H-009/L-003 live: wrapped config:set replace -> no plaintext
  // ========================================================================
  try {
    const CANARY = 'sk-LIVE-CANARY-777-xyz';
    const setRes = await exec(`(async () => {
      try {
        return await window.api.setConfig({
          cfg: { output_dir: ${JSON.stringify(OUT)}, region: 'global', theme: 'dark', styles: [] },
          apiKeyAction: 'replace',
          apiKeyValue: ${JSON.stringify(CANARY)}
        });
      } catch (e) { return { ok: false, error: e.message }; }
    })()`);
    check('LIVE-3a', 'wrapped config:set replace accepted', setRes && setRes.ok !== false, setRes && setRes.error ? String(setRes.error).slice(0, 80) : 'ok');

    const disk = fs.readFileSync(CFG, 'utf8');
    check('LIVE-3b', 'no plaintext key in config.txt', !disk.includes(CANARY));
    check('LIVE-3c', 'api_key line present but EMPTY', /^api_key=\s*$/m.test(disk), JSON.stringify((disk.match(/^api_key=.*$/m) || ['<absent>'])[0]));
    check('LIVE-3d', 'api_credential_id persisted', /api_credential_id=.+/.test(disk));

    const pub = await exec(`(async () => {
      try { return JSON.stringify(await window.api.getConfigPublic()); }
      catch (e) { return JSON.stringify({ error: e.message }); }
    })()`);
    check('LIVE-3e', 'getConfigPublic leaks no key material', typeof pub === 'string' && !pub.includes(CANARY) && !/sk-LIVE/.test(pub));
  } catch (e) {
    check('LIVE-3x', 'LIVE-3 completed without crash', false, String(e && e.message).slice(0, 120));
  }

  // ========================================================================
  // LIVE-4 — H-002 live: providers:generate refuses before touching outDir
  // ========================================================================
  try {
    const canaryDir = path.join(TMP, 'canary-dir');
    const res = await exec(`(async () => {
      try {
        return await window.api.providersGenerate({
          providerId: 'zz-no-such-provider',
          modality: 'image',
          outDir: ${JSON.stringify(canaryDir)},
          grantId: 'bogus-grant-id',
          params: { n: 1 }
        });
      } catch (e) { return { ok: false, error: e.message }; }
    })()`);
    check('LIVE-4a', 'bogus provider/grant refused', res && res.ok === false, res && res.error ? String(res.error).slice(0, 90) : JSON.stringify(res));
    check('LIVE-4b', 'canary outDir NOT created pre-validation', !fs.existsSync(canaryDir));
  } catch (e) {
    check('LIVE-4x', 'LIVE-4 completed without crash', false, String(e && e.message).slice(0, 120));
  }

  // ---- summary ----
  const pass = results.filter((r) => r.pass).length;
  console.log(`\nLIVE VERDICT: ${pass}/${results.length} pass`);
  if (h.problems && h.problems.length) console.log('HARNESS PROBLEMS:', JSON.stringify(h.problems));
  try { await h.cleanup(); } catch (_) {}
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error('live_verify crashed:', e);
  process.exit(1);
});
