// main/ipc/registerConfigIpc.js
// IPC handlers: `config:get` / `config:set` / `config:path` /
// `config:pickFolder` / `config:defaultOutputDir`.
// R1.2a: `config:pickFolder` und `config:set` arbeiten mit
// PathGrantService (S1 §4).
//
//   • `config:pickFolder` zeigt den nativen Browse-Dialog und mintet
//     einen `config-output`- oder `config-report`-Grant für den
//     gewählten Pfad. Rückgabe: {ok, path, grantId, capabilities}.
//     KEIN addTrusted mehr (S1 §4: kein stiller Parent-Trust).
//
//   • `config:set` akzeptiert die Form {cfg, grants}.
//     `grants.output_dir` ist ein grantId, der für den NEUEN Wert
//     von `cfg.output_dir` autorisieren muss; gleiches gilt für
//     `grants.report_dir` und `cfg.report_dir`.
//     Unveränderte Config-Felder brauchen keinen Grant (S1 §4).
//     Manuelle Texteingabe für output_dir/report_dir ist VERBOTEN —
//     der Main-Prozess antwortet mit einem klaren Fehler, der auf
//     den nativen Browse-Pfad verweist. Kein stiller Fallback.

const path = require('path');
const { ipcMain, dialog } = require('electron');

const cfgMod = require('../../src/config');
const { sanitize } = require('../models/ConfigSchema');
const { defaultService: pathGrantService } = require('../services/PathGrantService');
// Issue-6 fix: the native folder picker is a Main-owned trust gesture.
// R1.2a removed the `addTrusted` call here ("KEIN addTrusted mehr") in
// favour of purpose-bound grants — but the file browser's 📂 flow
// (`pickFolder()` in preload) DISCARDS the minted grantId (it returns
// only the path string) and later mints its own grant via
// `pathGrant:mint`, whose trust-root gate rejects any folder that is
// not already an allowed root. Without re-adding the picked folder to
// the session trust set, EVERY generation into an externally-picked
// folder failed with "Path is not in an allowed root" (Issue 6).
const pathSecurity = require('../services/PathSecurityService');
// R2.3.1: wire the mmx-cli's persisted-key removal into the
// `config:set` privacy switch. When the renderer sends
// `{cfg, apiKeyNoSave: true}` and the user just toggled "Don't
// save" on, the previously-persisted `~/.mmx/config.json api_key`
// must be cleared atomically. Otherwise the privacy switch is a
// no-op for the mmx side, even though config.txt is clean.
const { clearApiKeyFromMmxCliConfig } = require('../../src/mmxApiKeySync');
const voicesCache = require('../services/VoicesCacheService');

const PURPOSE_TO_ORIGIN = Object.freeze({
  'config-output': 'config-output',
  'config-report': 'config-report',
});

/**
 * @param {{ getMainWindow: () => (Electron.BrowserWindow|null) }} deps
 */
function register({ getMainWindow }) {
  ipcMain.handle('config:get', () => {
    // SYS-006: defensive envelope — never return null. The renderer
    // dereferences .styles immediately; a null would crash the boot.
    try {
      const c = cfgMod.read();
      if (c && typeof c === 'object') return c;
    } catch (_) { /* fall through to default */ }
    return { api_key: '', output_dir: '', region: 'global', theme: 'dark', styles: [] };
  });

  ipcMain.handle('config:set', (_e, payload) => {
    try {
      // R1.2a: accept the {cfg, grants} form. For backward
      // compatibility with the pre-R1.2a renderer (which sends just
      // `cfg`), fall back to a no-grants form. This is the LAST
      // shim before R1.5 migrates the renderer; it must be removed
      // in R1.5 because the spec is strict: no path-to-grant
      // lookup as a legacy fallback for mutations.
      // Array.isArray guards on both `payload` and `payload.cfg`
      // because `typeof [] === 'object'` is true; without them a
      // malicious renderer could trick the unwrap into treating
      // an array as the cfg.
      const isWrapped = !!payload && typeof payload === 'object' && !Array.isArray(payload)
        && payload.cfg && typeof payload.cfg === 'object' && !Array.isArray(payload.cfg);
      const cfg = isWrapped ? payload.cfg : payload;
      // R2.3.2 (Phasenprüfung-of-Phasenprüfung): the `isWrapped`
      // check has a hole when the payload is a wrapped-form-looking
      // object but `cfg` is not a valid cfg (e.g. `{cfg: 5}` or
      // `{cfg: []}`). The third condition of `isWrapped` rejects
      // those — but then `isWrapped` is false and the WHOLE payload
      // is treated as a bare cfg, which `sanitize()` happily
      // accepts (the unknown `cfg` key just gets dropped, no error).
      // A defensive renderer-correctness fix: if the payload has a
      // `cfg` key but the cfg value is invalid, the payload is
      // malformed and we must reject. Otherwise a renderer bug or
      // a malicious send could silently no-op a save.
      const looksLikeWrapped = !!payload && typeof payload === 'object' && !Array.isArray(payload)
        && 'cfg' in payload;
      if (looksLikeWrapped && !isWrapped) {
        return { ok: false, config: cfgMod.read(), error: 'Config must be a plain object.' };
      }
      const grants = (isWrapped && payload.grants && typeof payload.grants === 'object' && !Array.isArray(payload.grants))
        ? payload.grants : {};
      // R2.3.1: the renderer's privacy switch (Don't save) lives in
      // state.json, NOT config.txt. The renderer passes the
      // intended new value via the `apiKeyNoSave` field of the
      // payload (wither wrapped or bare — accept both for forward
      // compatibility). When true, clear the persisted
      // `~/.mmx/config.json` api_key after the config.txt write
      // so the privacy switch is fully effective.
      const apiKeyNoSave = !!(payload && (
        (typeof payload.apiKeyNoSave === 'boolean' && payload.apiKeyNoSave) ||
        (isWrapped && typeof payload.cfg._apiKeyNoSave === 'boolean' && payload.cfg._apiKeyNoSave) ||
        // Backward-compat: pre-R2.3.1 renderer may have stuffed
        // the flag onto cfg itself (as a transient key the
        // section04 pane strips before send). We treat any
        // _apiKeyNoSave === true on cfg as "user wants session-only"
        // for this write, then strip it before sanitise.
        (cfg && typeof cfg._apiKeyNoSave === 'boolean' && cfg._apiKeyNoSave)
      ));
      if (cfg && typeof cfg === 'object' && '_apiKeyNoSave' in cfg) {
        try { delete cfg._apiKeyNoSave; } catch (_) { /* defensive */ }
      }

      if (cfg == null || typeof cfg !== 'object' || Array.isArray(cfg)) {
        return { ok: false, config: cfgMod.read(), error: 'Config must be a plain object.' };
      }
      // S1 §4: output_dir / report_dir changes REQUIRE a matching
      // grant. Compare the new payload against the on-disk state so
      // we can detect a "user changed the value" vs "user re-saved
      // the same value" without trusting the renderer. A field
      // that's absent from the payload (undefined) is treated as
      // "no change" — the renderer's save always re-sends every
      // field, but defensive parsing avoids false positives when
      // a payload is partial (e.g. a future IPC variant).
      const prev = (() => {
        try { return cfgMod.read(); } catch (_) { return {}; }
      })();
      const newOutputDir = typeof cfg.output_dir === 'string' ? cfg.output_dir.trim() : '';
      const newReportDir = typeof cfg.report_dir === 'string' ? cfg.report_dir.trim() : '';
      const prevOutputDir = (prev && typeof prev.output_dir === 'string') ? prev.output_dir.trim() : '';
      const prevReportDir = (prev && typeof prev.report_dir === 'string') ? prev.report_dir.trim() : '';
      const outputDirChanged = cfg.output_dir !== undefined && newOutputDir !== prevOutputDir;
      const reportDirChanged = cfg.report_dir !== undefined && newReportDir !== prevReportDir;

      if (outputDirChanged) {
        if (!grants.output_dir || typeof grants.output_dir !== 'string') {
          return {
            ok: false,
            config: prev,
            error: 'output_dir changed but no grant provided; use config:pickFolder to obtain a config-output grant and pass it as grants.output_dir.',
          };
        }
        // Purpose-mismatch check: the grant must have origin
        // 'config-output'. The grant-service itself only checks
        // path + capabilities; the origin-vs-field mapping is the
        // IPC handler's responsibility.
        const outGrant = pathGrantService.inspect(grants.output_dir);
        if (!outGrant) {
          return { ok: false, config: prev, error: 'output_dir grant rejected: grant not found' };
        }
        if (outGrant.origin !== 'config-output') {
          return {
            ok: false,
            config: prev,
            error: 'output_dir grant rejected: grant origin "' + outGrant.origin + '" does not match purpose (must be a config-output grant)',
          };
        }
        const authz = pathGrantService.authorize(grants.output_dir, {
          operation: 'write',
          path: newOutputDir,
        });
        if (!authz.ok) {
          return { ok: false, config: prev, error: 'output_dir grant rejected: ' + authz.error };
        }
      }
      if (reportDirChanged) {
        if (!grants.report_dir || typeof grants.report_dir !== 'string') {
          return {
            ok: false,
            config: prev,
            error: 'report_dir changed but no grant provided; use config:pickFolder to obtain a config-report grant and pass it as grants.report_dir.',
          };
        }
        const repGrant = pathGrantService.inspect(grants.report_dir);
        if (!repGrant) {
          return { ok: false, config: prev, error: 'report_dir grant rejected: grant not found' };
        }
        if (repGrant.origin !== 'config-report') {
          return {
            ok: false,
            config: prev,
            error: 'report_dir grant rejected: grant origin "' + repGrant.origin + '" does not match purpose (must be a config-report grant)',
          };
        }
        const authz = pathGrantService.authorize(grants.report_dir, {
          operation: 'write',
          path: newReportDir,
        });
        if (!authz.ok) {
          return { ok: false, config: prev, error: 'report_dir grant rejected: ' + authz.error };
        }
      }
      const safe = sanitize(Object.assign({}, prev, cfg)); // KGO5-013: merge preserves absent fields
      cfgMod.write(safe);
      if (typeof voicesCache?.reset === 'function') {
        try { voicesCache.reset(); } catch { /* best-effort */ }
      }
      // R2.3.1: privacy switch. If the user just toggled
      // apiKeyNoSave=true, the persisted `~/.mmx/config.json`
      // api_key must be cleared. The clear runs AFTER the
      // config.txt write so the persisted config and the
      // persisted mmx key are both updated in the same Save
      // gesture. If the clear fails, we surface a warning so the
      // renderer can show a visible error — the privacy switch
      // is NOT silently "successful" (design contract §14.3 R2.3:
      // "Failure sichtbar und Privacywechsel nicht fälschlich
      // als erfolgreich markiert").
      let privacyWarning = null;
      if (apiKeyNoSave) {
        const r = clearApiKeyFromMmxCliConfig();
        if (r !== true) {
          privacyWarning = 'config:set wrote config.txt but mmxApiKeySync.clearApiKeyFromMmxCliConfig returned ' + JSON.stringify(r) + '; ~/.mmx/config.json may still contain a previously-persisted api_key.';
        }
      }
      return {
        ok: true,
        config: cfgMod.read(),
        error: privacyWarning,
        warnings: privacyWarning ? [privacyWarning] : [],
      };
    } catch (e) {
      let prev = null;
      try { prev = cfgMod.read(); } catch (_) { /* ignore */ }
      if (!prev || typeof prev !== 'object') {
        prev = { api_key: '', output_dir: '', region: 'global', theme: 'dark', styles: [] };
      }
      return { ok: false, config: prev, error: (e && e.message) || String(e) };
    }
  });

  ipcMain.handle('config:path', () => {
    try { return cfgMod.configPath(); } catch (e) { return null; }
  });

  ipcMain.handle('config:defaultOutputDir', () => {
    try { return cfgMod.defaultOutputDir(); } catch (e) { return null; }
  });

  // R1.2a: `config:pickFolder` mints a Main-side grant. The grant is
  // purpose-fest: the caller declares whether the picked folder is
  // intended for the output_dir or the report_dir. This prevents a
  // renderer from using a "config-output" grant to set report_dir
  // and vice versa. The grant's canonical path is the picked folder;
  // subsequent config:set calls must present this grantId when
  // setting the corresponding field.
  ipcMain.handle('config:pickFolder', async (_e, opts) => {
    try {
      const purpose = (opts && opts.purpose === 'config-report') ? 'config-report' : 'config-output';
      const origin = PURPOSE_TO_ORIGIN[purpose];
      const win = getMainWindow();
      const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
      if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
      const pickedPath = r.filePaths[0];
      // Issue-6 fix: trust the picked folder for this session. The path
      // comes from the native OS dialog (user gesture, Main-owned — the
      // renderer cannot inject it), so this is NOT a SYS-001 trust
      // widening: `state:get` still never re-trusts persisted paths, and
      // the trust set is session-scoped (cleared on app restart). This
      // restores the documented behaviour ("the picked path is auto-
      // added to the IPC allow-list", app.js 📂 handler) that the R1.2a
      // grant refactor silently broke.
      try { pathSecurity.addTrusted(pickedPath); } catch (_) { /* best-effort */ }
      const mint = pathGrantService.mintDirectoryGrant({
        origin,
        purpose: 'user picked ' + purpose + ' folder',
        path: pickedPath,
        // The picked folder is the new app-output / report
        // directory. The user must be able to write inside AND to
        // re-target the app's main output to this directory itself
        // (via config:set). The S1 §3 "app-output" row of the
        // capability table explicitly allows this: "app-eigene
        // Unterordner und Output-Dateien lesen/schreiben" plus
        // the "Root löschen/umbenennen" exception. We mint a
        // directory-root grant (coversRoot: true) so the grant
        // covers both the root and its strict descendants.
        capabilities: ['read', 'write', 'delete', 'mkdir', 'rename', 'move', 'copy'],
        coversRoot: true,
      });
      if (!mint.ok) return { ok: false, error: mint.error };
      return {
        ok: true,
        path: pickedPath,
        grantId: mint.grantId,
        capabilities: mint.grant.capabilities,
      };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  ipcMain.handle('config:getPremadeStyles', async () => {
    try {
      const styles = loadPremadeStylesFromDisk();
      return { ok: true, styles };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e), styles: [] };
    }
  });
}

function parseStylePresetsFromMarkdown(mdContent) {
  const presets = [];
  if (typeof mdContent !== 'string') return presets;
  const sections = mdContent.split(/^##\s+/m);
  for (const sec of sections) {
    if (!sec.trim()) continue;
    const lines = sec.split(/\r?\n/);
    const header = lines[0].trim();
    if (!header || header.startsWith('#')) continue;

    let currentType = null;
    let longText = '';
    let shortText = '';

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line === '**Long**') {
        currentType = 'long';
      } else if (line === '**Short**') {
        currentType = 'short';
      } else if (line && currentType === 'long') {
        longText = longText ? longText + ' ' + line : line;
      } else if (line && currentType === 'short') {
        shortText = shortText ? shortText + ' ' + line : line;
      }
    }

    if (longText) {
      presets.push({
        name: `${header} - long`,
        value: longText.trim(),
      });
    }
    if (shortText) {
      presets.push({
        name: `${header} - short`,
        value: shortText.trim(),
      });
    }
  }
  return presets;
}

function loadPremadeStylesFromDisk() {
  const fsMod = require('fs');
  const candidates = [
    path.join(process.cwd(), 'IMAGE_STYLE_PRESETS_ENGLISH_v2.0.md'),
    path.join(__dirname, '../../IMAGE_STYLE_PRESETS_ENGLISH_v2.0.md'),
    path.join(path.dirname(process.execPath), 'IMAGE_STYLE_PRESETS_ENGLISH_v2.0.md'),
  ];
  for (const p of candidates) {
    if (fsMod.existsSync(p)) {
      try {
        const text = fsMod.readFileSync(p, 'utf8');
        return parseStylePresetsFromMarkdown(text);
      } catch (_) {}
    }
  }
  return [];
}

module.exports = { register, parseStylePresetsFromMarkdown, loadPremadeStylesFromDisk };

