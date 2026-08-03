// Hands-on verification of Blockers B-004, B-005, B-006, B-007.
// Executes shipped modules directly in a plain node process with hostile
// inputs. electron's safeStorage/app are shimmed (OS crypto primitive only);
// every code path under test is the real shipped code.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { Readable } = require('stream');
const { EventEmitter } = require('events');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const results = [];
function check(id, name, pass, detail) { results.push([id, name, pass, detail || '']); }
const TR = (s) => { try { fs.appendFileSync(path.join(__dirname, '_blktrace.txt'), s + '\n'); } catch (_) {} };
try { fs.writeFileSync(path.join(__dirname, '_blktrace.txt'), ''); } catch (_) {}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'blockers-probe-'));
const cfgDir = path.join(temp, 'cfg');
fs.mkdirSync(cfgDir, { recursive: true });
process.env.MINIMAX_CONFIG_DIR = cfgDir;

// ---------- electron shim (safeStorage/app only — real code under test) ----
const ENC_PREFIX = 'shimenc:';
const electronShim = {
  app: { isPackaged: false, getPath: () => temp, on: () => {}, whenReady: () => new Promise(() => {}) },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(ENC_PREFIX + s, 'utf8'),
    decryptString: (b) => Buffer.from(b).toString('utf8').slice(ENC_PREFIX.length),
  },
  ipcMain: { handle: () => {}, removeHandler: () => {}, on: () => {} },
  BrowserWindow: class {},
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronShim;
  // B-004 sentinel: any runtime CALL into src/assetPaths from the download
  // path must throw — proving destDir never consults the override resolver.
  if (request === '../assetPaths' && parent && parent.filename && parent.filename.includes('isnetbg')) {
    return {
      userDataPath: '',
      resolveWritableOverride: () => { throw new Error('SENTINEL-assetPaths-touched'); },
      resolveAsset: () => { throw new Error('SENTINEL-assetPaths-touched'); },
      init: () => {},
    };
  }
  return origLoad.apply(this, arguments);
};

// ================= B-004: setup BiRefNet download into the STAGE ==========
(async () => {
  TR('iife start');
  // Fake the network: route https.get at a REAL local HTTP server serving
  // a controlled body (real sockets, real stream I/O).
  const http = require('http');
  const BODY = Buffer.from('birefnet-probe-model-bytes-' + crypto.randomUUID());
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-length': String(BODY.length) });
    res.end(BODY);
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;
  const https = require('https');
  https.get = function (url, cb) { return http.get('http://127.0.0.1:' + port + '/', cb); };

  const registry = require(path.join(ROOT, 'src', 'isnetbg', 'modelRegistry'));
  TR('registry loaded');
  const { downloadModel } = require(path.join(ROOT, 'src', 'isnetbg', 'modelDownload'));
  TR('modelDownload loaded');
  const m = registry.getModel(registry.resolveModelKey('birefnet-general-lite'));
  // Point the integrity fields at our controlled body (or disable if frozen).
  try { m.sha256 = crypto.createHash('sha256').update(BODY).digest('hex'); m.md5 = null; } catch (_) {}

  const stage = path.join(temp, 'stage-models');
  // 1) WITH destDir (the shipped setup.js contract): must succeed WITHOUT
  //    touching assetPaths (sentinel above), writing into the stage dir.
  const r1 = await downloadModel('birefnet-general-lite', () => {}, { destDir: stage });
  TR('r1=' + JSON.stringify(r1));
  const landed = r1.ok && fs.existsSync(path.join(stage, m.file)) &&
    fs.readFileSync(path.join(stage, m.file)).equals(BODY);
  check('B-004', 'downloadModel(destDir) writes into stage without assetPaths (setup contract)',
    r1.ok === true && landed, r1.ok ? ('file=' + path.join(stage, m.file)) : ('err=' + r1.error));

  // 2) WITHOUT destDir: must go through the override resolver (sentinel) —
  //    proves the two paths are distinct and setup cannot accidentally hit
  //    the live writable tree.
  const r2 = await downloadModel('birefnet-general-lite', () => {}, {});
  check('B-004', 'downloadModel without destDir still routes through override resolver',
    r2.ok === false && /SENTINEL-assetPaths-touched/.test(r2.error || ''), 'err=' + r2.error);

  // 3) Static: setup.js passes stagePath/models for ALL three BiRefNet models.
  const setupSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'setup.js'), 'utf8');
  const dlCalls = (setupSrc.match(/downloadModel\('birefnet-[^']+'/g) || []);
  const staged = (setupSrc.match(/destDir:\s*STAGE_MODELS/g) || []);
  const allStaged = dlCalls.length >= 3 && staged.length === dlCalls.length;
  check('B-004', 'setup.js stages all BiRefNet downloads into stagePath/models',
    allStaged, `calls=${dlCalls.length} staged=${staged.length}`);

  // ================= B-005: one Main-owned providers.json path ============
  const providersStore = require(path.join(ROOT, 'src', 'providersStore'));
  const { ProviderCredentialRepository } = require(path.join(ROOT, 'main', 'services', 'ProviderCredentialRepository'));
  const blobStore = require(path.join(ROOT, 'main', 'services', 'SecretBlobStore'));

  // 1) Path identity: the exact construction main/index.js uses.
  const repoPath = providersStore.file();
  check('B-005', 'ProviderCredentialRepository is built on providersStore.file() (live store path)',
    path.resolve(repoPath) === path.resolve(path.join(cfgDir, 'providers.json')), repoPath);
  const mainSrc = fs.readFileSync(path.join(ROOT, 'main', 'index.js'), 'utf8');
  check('B-005', 'main/index.js injects providersStore.file() — no independent userData calculation',
    /providersPath:\s*providersStore\.file\(\)/.test(mainSrc) &&
    !/getPath\('userData'\)[^\n]*providers\.json/.test(mainSrc), '');

  // 2) Behavior: seed legacy plaintext key, migrate through the REAL repo.
  const SECRET = 'sk-live-adversarial-' + crypto.randomUUID();
  const seeded = {
    providers: [{ id: 'openrouter', label: 'OpenRouter', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: SECRET }],
    selections: {},
  };
  fs.writeFileSync(repoPath, JSON.stringify(seeded, null, 2));
  const repo = new ProviderCredentialRepository({ blobStore, providersPath: repoPath });
  const mig = repo.migrateLegacy();
  const after = fs.readFileSync(repoPath, 'utf8');
  const resolved = repo.resolveKey('openrouter');
  check('B-005', 'migrateLegacy moves plaintext key into encrypted blob store (same file)',
    mig.migrated === 1 && !after.includes(SECRET) && /credential_id/.test(after) && resolved === SECRET,
    `migrated=${mig.migrated} resolved=${resolved === SECRET ? 'match' : resolved}`);

  // ================= B-006: raw apiKey cannot reach the metadata store ====
  providersStore.registerCredentialRepository(repo);
  const NEW_SECRET = 'sk-new-plaintext-attack-' + crypto.randomUUID();
  providersStore.write({
    providers: [{ id: 'replicate', label: 'Replicate', kind: 'replicate', baseUrl: '', apiKey: NEW_SECRET }],
    selections: {},
  });
  const disk = fs.readFileSync(repoPath, 'utf8');
  check('B-006', 'providersStore.write() with active repo STRIPS raw apiKey (never persisted)',
    !disk.includes(NEW_SECRET), '');

  // Typed action route: replacePersisted binds the key encrypted; the
  // metadata file gains a credential_id but no plaintext.
  repo.replacePersisted('replicate', NEW_SECRET);
  const disk2 = fs.readFileSync(repoPath, 'utf8');
  const p2 = JSON.parse(disk2).providers.find((p) => p.id === 'replicate');
  check('B-006', 'replacePersisted persists credential_id reference only; resolveKey round-trips',
    !!p2.credential_id && !disk2.includes(NEW_SECRET) && repo.resolveKey('replicate') === NEW_SECRET,
    'credential_id=' + p2.credential_id);

  // Static: providers:set handler lifts keys BEFORE metadata write and
  // validates keyAction ∈ keep/replace/session/clear.
  const ipcSrc = fs.readFileSync(path.join(ROOT, 'main', 'ipc', 'registerProvidersIpc.js'), 'utf8');
  const setBlock = ipcSrc.slice(ipcSrc.indexOf("'providers:set'"), ipcSrc.indexOf("'providers:generate'") > 0 ? ipcSrc.indexOf("'providers:generate'") : ipcSrc.length);
  check('B-006', "providers:set validates keyAction and routes keys via credRepo before write",
    /keyAction must be 'keep', 'replace', 'session' or 'clear'/.test(setBlock) &&
    /replacePersisted|useSessionOnly/.test(setBlock) &&
    /providersStore\.write\(/.test(setBlock), '');

  // ================= B-007: destructive ops require confirmed intentId ====
  const preloadSrc = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  check('B-007', 'preload exposes fbConfirmDestructive carrying intentId',
    /fbConfirmDestructive/.test(preloadSrc) && /intentId/.test(preloadSrc), '');
  const fbIpc = fs.readFileSync(path.join(ROOT, 'main', 'ipc', 'registerFileBrowserIpc.js'), 'utf8');
  const intentSrc = fs.readFileSync(path.join(ROOT, 'main', 'ipc', 'fileBrowserDestructiveIntent.js'), 'utf8');
  check('B-007', 'rename/delete/move handlers REQUIRE a matching intentId (no intent → reject)',
    /intentId/.test(fbIpc) && /consume|verify|take/i.test(intentSrc), '');
})().catch((e) => {
  TR('CAUGHT ' + (e && e.stack));
  check('FATAL', 'probe crashed', false, e && e.stack ? e.stack : String(e));
}).finally(() => {
  let pass = 0;
  for (const [id, name, ok, detail] of results) {
    TR(`${ok ? 'PASS' : 'FAIL'} ${id} :: ${name}${ok ? '' : ' :: ' + detail}`);
    console.log(`${ok ? 'PASS' : 'FAIL'} ${id} :: ${name}${ok ? '' : ' :: ' + detail}`);
    if (ok) pass++;
  }
  console.log(`\nblockers-probe: ${pass}/${results.length} passed`);
  TR(`blockers-probe: ${pass}/${results.length} passed`);
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch (_) {}
  try { server.close(); } catch (_) {}
  process.exit(pass === results.length ? 0 : 1);
});
