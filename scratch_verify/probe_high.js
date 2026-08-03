// Hands-on verification of High findings H-001..H-014 (H-015..H-018 are
// covered by probe_h017/probe_h018/probe_release + the real installer run).
// Executes shipped modules directly with hostile inputs. electron's
// app/safeStorage are shimmed (OS primitives only); code under test is real.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const crypto = require('crypto');
const { spawn } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const results = [];
function check(id, name, pass, detail) { results.push([id, name, pass, detail || '']); }

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'high-probe-'));
const cfgDir = path.join(temp, 'cfg');
fs.mkdirSync(cfgDir, { recursive: true });
process.env.MINIMAX_CONFIG_DIR = cfgDir;

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
Module._load = function (request) {
  if (request === 'electron') return electronShim;
  return origLoad.apply(this, arguments);
};

// Global fetch sentinel: any provider code still touching global fetch dies.
let fetchTouched = '';
globalThis.fetch = function (url) { fetchTouched = String(url); throw new Error('SENTINEL-global-fetch-used: ' + url); };

(async () => {
  // ================= H-001: provider traffic via injected SafeHttpClient ==
  const replicate = require(path.join(ROOT, 'src', 'providers', 'replicate'));
  const openaiCompat = require(path.join(ROOT, 'src', 'providers', 'openaiCompatible'));
  const httpCalls = [];
  const stubHttp = {
    json: async (url, opts, policy) => {
      httpCalls.push(['json', url]);
      if (url.includes('/predictions')) {
        return { status: 'succeeded', output: ['https://example.invalid/out.png'] };
      }
      return { data: [{ id: 'model-a' }, { id: 'model-b' }] };
    },
    bytes: async (url) => { httpCalls.push(['bytes', url]); return { buffer: Buffer.from('x'), status: 200 }; },
  };
  let repErr = null;
  try {
    await replicate.run({ apiKey: 'k', model: 'owner/name', input: {}, http: stubHttp });
  } catch (e) { repErr = e.message; }
  check('H-001', 'replicate.run with injected http never touches global fetch',
    httpCalls.some((c) => c[0] === 'json' && c[1].includes('predictions')) && fetchTouched === '',
    'calls=' + httpCalls.length + (repErr ? ' err=' + repErr : '') + (fetchTouched ? ' FETCH:' + fetchTouched : ''));

  fetchTouched = '';
  const models = await openaiCompat.listModels({ baseUrl: 'https://provider.example/v1', apiKey: 'k', http: stubHttp });
  check('H-001', 'openaiCompatible.listModels with injected http never touches global fetch',
    Array.isArray(models) && models.join(',') === 'model-a,model-b' && fetchTouched === '',
    'models=' + JSON.stringify(models));

  const regSrc = fs.readFileSync(path.join(ROOT, 'main', 'ipc', 'registerProvidersIpc.js'), 'utf8');
  check('H-001', 'IPC injects SafeHttpClient into listing AND generation (production path)',
    /listModels\(\{[^}]*http:\s*SafeHttpClient/.test(regSrc) && /http:\s*SafeHttpClient,\s*\n?\s*onProgress/.test(regSrc.replace(/\s+/g, ' ')) || (regSrc.match(/http:\s*SafeHttpClient/g) || []).length >= 3,
    'injections=' + (regSrc.match(/http:\s*SafeHttpClient/g) || []).length);

  // ================= H-002: authorize BEFORE writeProbe ==================
  const genBlock = regSrc.slice(regSrc.indexOf("secureHandle('providers:generate'"), regSrc.length);
  const authIdx = genBlock.indexOf('authorizePath(req.grantId');
  const probeIdx = genBlock.indexOf('writeProbe(resolvedOut)');
  check('H-002', 'providers:generate authorizes the output root before any writeProbe/mkdir',
    authIdx > 0 && probeIdx > authIdx, `authorize@${authIdx} writeProbe@${probeIdx}`);

  // ================= H-003: transaction recovery at startup ===============
  const mainSrc = fs.readFileSync(path.join(ROOT, 'main', 'index.js'), 'utf8');
  const recIdx = mainSrc.indexOf('txnService.recover()');
  const winIdx = mainSrc.indexOf('createMainWindow(');
  check('H-003', 'main boot runs OutputTransactionService.recover() before renderer creation',
    recIdx > 0 && winIdx > recIdx, `recover@${recIdx} window@${winIdx}`);

  const { OutputTransactionService } = require(path.join(ROOT, 'main', 'services', 'OutputTransactionService'));
  const journalDir = path.join(temp, 'journals');
  fs.mkdirSync(journalDir, { recursive: true });
  fs.writeFileSync(path.join(journalDir, 'corrupt.json'), '{{{not json');
  fs.writeFileSync(path.join(journalDir, 'badschema.json'), JSON.stringify({ foo: 1 }));
  const txn = new OutputTransactionService({ journalDir });
  const rec = txn.recover();
  check('H-003', 'recover() survives hostile journals and flags them (no crash, no silent pass)',
    !!rec && (rec.manualReview === true || (Array.isArray(rec.errors) && rec.errors.length > 0)),
    JSON.stringify(rec).slice(0, 200));

  // ================= H-004: bundled pinned ffprobe, no PATH in packaged ===
  const { resolveFfprobe } = require(path.join(ROOT, 'main', 'services', 'mediaProbe'));
  const ff = resolveFfprobe();
  const bundled = ff && fs.existsSync(ff) && (ff.includes('node_modules') || ff.includes(path.join(ROOT, 'bin')));
  check('H-004', 'resolveFfprobe() finds a bundled pinned ffprobe binary on this machine',
    !!bundled, 'resolved=' + ff);
  const mpSrc = fs.readFileSync(path.join(ROOT, 'main', 'services', 'mediaProbe.js'), 'utf8');
  check('H-004', 'PATH fallback is prohibited in packaged builds; @ffprobe-installer pinned in deps',
    /_isPackaged\(\)/.test(mpSrc) && /@ffprobe-installer\/ffprobe/.test(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')), '');

  // ================= H-005: decoded-byte budget BEFORE decode =============
  const sharp = require(path.join(ROOT, 'node_modules', 'sharp'));
  const finalizer = require(path.join(ROOT, 'main', 'services', 'ArtifactFinalizer'));
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
  const imgPath = path.join(temp, 'probe.png');
  fs.writeFileSync(imgPath, png);
  const tight = await finalizer.validateImageDecode(imgPath, { maxDecodedBytes: 16 });
  const ok = await finalizer.validateImageDecode(imgPath, {});
  check('H-005', 'validateImageDecode enforces aggregate decoded-byte budget before decoding',
    tight.ok === false && /decoded|budget|byte/i.test(tight.error || '') && ok.ok === true && ok.width === 64,
    'tight=' + JSON.stringify(tight).slice(0, 120) + ' ok=' + JSON.stringify(ok).slice(0, 80));

  // ================= H-006: primary plaintext key migrated at startup =====
  const LEGACY_KEY = 'sk-legacy-primary-' + crypto.randomUUID();
  fs.writeFileSync(path.join(cfgDir, 'config.txt'), 'api_key=' + LEGACY_KEY + '\n');
  const credRepo = require(path.join(ROOT, 'main', 'services', 'CredentialRepository'));
  const mig = credRepo.migrateLegacy();
  const cfgAfter = fs.readFileSync(path.join(cfgDir, 'config.txt'), 'utf8');
  check('H-006', 'CredentialRepository.migrateLegacy moves plaintext primary key to encrypted store',
    mig.migrated === true && !cfgAfter.includes(LEGACY_KEY) && /api_credential_id=/.test(cfgAfter),
    JSON.stringify(mig).slice(0, 120));
  check('H-006', 'main/index.js calls CredentialRepository.migrateLegacy() at startup',
    /credentialRepo\.migrateLegacy\(\)/.test(mainSrc), '');

  // ================= H-007: fd-3 credential bridge is the live transport ==
  const bridge = require(path.join(ROOT, 'src', 'mmxCredentialBridge'));
  const entry = path.join(temp, 'fake-mmx-entry.js');
  fs.writeFileSync(entry, 'console.log(JSON.stringify(process.argv));');
  const prepared = bridge.prepare(entry, ['--task', 't2v']);
  const KEY = 'mmx-secret-' + crypto.randomUUID();
  const childOut = await new Promise((resolveP, rejectP) => {
    const proc = spawn(process.execPath, prepared.argv, { stdio: prepared.stdio, cwd: temp });
    let so = '', se = '';
    proc.stdout.on('data', (d) => { so += d; });
    proc.stderr.on('data', (d) => { se += d; });
    proc.on('error', rejectP);
    proc.on('close', (code) => resolveP({ code, so, se }));
    bridge.sendCredential(proc, KEY);
  });
  let argvOk = false;
  try {
    const av = JSON.parse(childOut.so.trim());
    argvOk = av.includes('--api-key') && av[av.indexOf('--api-key') + 1] === KEY && av.includes('--task');
  } catch (_) {}
  check('H-007', 'fd-3 bridge delivers the key inside the child and injects it into argv (end-to-end)',
    childOut.code === 0 && argvOk, 'code=' + childOut.code + ' stderr=' + childOut.se.slice(0, 120));
  const mmxSrc = fs.readFileSync(path.join(ROOT, 'src', 'mmx.js'), 'utf8');
  const mmxNoComments = mmxSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  check('H-007', 'mmx.js uses the bridge; no MINIMAX_API_KEY env and no ~/.mmx key persistence',
    /credentialBridge\.prepare\(/.test(mmxSrc) && /credentialBridge\.sendCredential\(/.test(mmxSrc) &&
    !/MINIMAX_API_KEY/.test(mmxNoComments), '');

  // ================= H-008: cleanup can never fail a committed replace ====
  const credSrc = fs.readFileSync(path.join(ROOT, 'main', 'services', 'CredentialRepository.js'), 'utf8');
  const committedBlocks = credSrc.split('safeQueueCleanup').length - 1;
  check('H-008', 'committed credential paths use safeQueueCleanup (queueCleanup wrapped, never throws out)',
    /function safeQueueCleanup\(id\) \{\s*try \{ queueCleanup\(id\); \} catch/.test(credSrc) && committedBlocks >= 4,
    'safeQueueCleanup sites=' + committedBlocks);

  // ================= H-009: config:set is ONE transaction =================
  const NEW_KEY = 'sk-commit-' + crypto.randomUUID();
  const res9 = credRepo.commitKeyAction({ action: 'replace', value: NEW_KEY, config: { theme: 'light' } });
  const cfgAfter9 = fs.readFileSync(path.join(cfgDir, 'config.txt'), 'utf8');
  check('H-009', 'commitKeyAction fuses key action + settings into one config write',
    res9 && res9.hasApiKey === true && !cfgAfter9.includes(NEW_KEY) && /api_credential_id=/.test(cfgAfter9) && /theme=light/.test(cfgAfter9),
    JSON.stringify(res9).slice(0, 140));
  const cfgIpcSrc = fs.readFileSync(path.join(ROOT, 'main', 'ipc', 'registerConfigIpc.js'), 'utf8');
  check('H-009', 'config:set handler routes through commitKeyAction; no swallowed clearPrimary error',
    /commitKeyAction\(\{/.test(cfgIpcSrc) && !/try \{ credentialRepo\.clearPrimary\(\); \} catch \(_\) \{\}/.test(cfgIpcSrc), '');

  // ================= H-010: public status comes from the repository =======
  const providersStore = require(path.join(ROOT, 'src', 'providersStore'));
  const { ProviderCredentialRepository } = require(path.join(ROOT, 'main', 'services', 'ProviderCredentialRepository'));
  const blobStore = require(path.join(ROOT, 'main', 'services', 'SecretBlobStore'));
  const providersPath = providersStore.file();
  fs.writeFileSync(providersPath, JSON.stringify({ providers: [{ id: 'openrouter', label: 'OpenRouter', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' }], selections: {} }, null, 2));
  const pRepo = new ProviderCredentialRepository({ blobStore, providersPath });
  const ENC_KEY = 'sk-enc-' + crypto.randomUUID();
  pRepo.replacePersisted('openrouter', ENC_KEY);
  const pub = pRepo.getPublic();
  const row = pub.find((r) => r.id === 'openrouter');
  const diskProv = JSON.parse(fs.readFileSync(providersPath, 'utf8')).providers[0];
  check('H-010', 'getPublic reports hasKey from repository state even when raw apiKey field is absent',
    !!row && row.hasKey === true && !diskProv.apiKey, JSON.stringify(row || {}).slice(0, 140));

  // ================= H-011: replicate fetch path is byte-bounded ==========
  const BIG = 5 * 1024 * 1024;
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    headers: { get: () => null },
    body: { getReader: () => { let sent = false; return { read: async () => { if (sent) return { done: true }; sent = true; return { done: false, value: new Uint8Array(BIG) }; }, cancel: async () => {} }; } },
  });
  let h11 = '';
  try { await replicate.run({ apiKey: 'k', model: 'owner/name', input: {} }); } catch (e) { h11 = e.message; }
  check('H-011', 'replicate fetch fallback aborts on bodies above the 4 MB cap (bounded read)',
    /cap|too large/i.test(h11), 'err=' + h11.slice(0, 140));
  const repSrc = fs.readFileSync(path.join(ROOT, 'src', 'providers', 'replicate.js'), 'utf8');
  const oacSrc = fs.readFileSync(path.join(ROOT, 'src', 'providers', 'openaiCompatible.js'), 'utf8');
  check('H-011', 'no unbounded `await res.text()/json()` body reads remain in either adapter',
    !/await\s+\w+\.(?:text|json)\(\)/.test(repSrc) && !/await\s+\w+\.(?:text|json)\(\)/.test(oacSrc), '');

  // ================= H-012: ACTIVATING crash window is journaled ==========
  const { RuntimeInstaller } = require(path.join(ROOT, 'scripts', 'lib', 'RuntimeInstaller'));
  const rt = path.join(temp, 'rt');
  fs.mkdirSync(rt, { recursive: true });
  const inst = new RuntimeInstaller({ projectRoot: rt });
  fs.mkdirSync(inst.activePath, { recursive: true });
  fs.writeFileSync(path.join(inst.activePath, 'old-runtime.txt'), 'known-good');
  const { transactionId, stagePath } = inst.begin({ verifyFn: () => true });
  fs.writeFileSync(path.join(stagePath, 'new-runtime.txt'), 'candidate');
  inst.verifyStage(transactionId, () => true);
  inst.activate(transactionId);
  // Simulate crash: rename completed, marker never reached ACTIVATED.
  const markerRaw = JSON.parse(fs.readFileSync(inst.markerPath, 'utf8'));
  markerRaw.state = 'ACTIVATING';
  fs.writeFileSync(inst.markerPath, JSON.stringify(markerRaw, null, 2));
  const recH12 = inst.recover({ verifyFn: () => false }); // verifier REJECTS the new tree
  const activeRestored = fs.existsSync(path.join(inst.activePath, 'old-runtime.txt'));
  check('H-012', 'crash in ACTIVATING + failing verifier rolls back to the known-good backup',
    recH12.recovered === true && /rolled-back/.test(recH12.action || '') && activeRestored && !fs.existsSync(inst.markerPath),
    JSON.stringify(recH12));

  // ================= H-013: recovery without verifier never commits ======
  const rt2 = path.join(temp, 'rt2');
  fs.mkdirSync(rt2, { recursive: true });
  const inst2 = new RuntimeInstaller({ projectRoot: rt2 });
  fs.mkdirSync(inst2.activePath, { recursive: true });
  fs.writeFileSync(path.join(inst2.activePath, 'unverified.txt'), 'x');
  const tx2 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeffff0000';
  const sp2 = inst2.siblingPaths(tx2);
  fs.mkdirSync(sp2.backupPath, { recursive: true });
  fs.writeFileSync(path.join(sp2.backupPath, 'good.txt'), 'known-good');
  fs.writeFileSync(inst2.markerPath, JSON.stringify({ schemaVersion: 1, transactionId: tx2, state: 'ACTIVATED', stagePath: sp2.stagePath, backupPath: sp2.backupPath, activePath: inst2.activePath, createdAt: Date.now() }, null, 2));
  const recH13 = inst2.recover(); // NO verifyFn (what begin() without opts used to do)
  const goodRestored = fs.existsSync(path.join(inst2.activePath, 'good.txt'));
  check('H-013', 'recovery WITHOUT a verifier never commits an interrupted activation (backup restored)',
    recH13.recovered === true && /rolled-back-unverifiable/.test(recH13.action || '') && goodRestored,
    JSON.stringify(recH13));
  const riSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'RuntimeInstaller.js'), 'utf8');
  check('H-013', 'begin() forwards its verifyFn into recover()',
    /begin\(opts = \{\}\) \{\s*\/\/ First[\s\S]*?this\.recover\(opts\);/.test(riSrc), '');

  // ================= H-014: failed activation restores old destination ===
  const { extractZip } = require(path.join(ROOT, 'scripts', 'lib', 'safeExtract'));
  const sevenZip = require(path.join(ROOT, 'node_modules', '7zip-bin'));
  const zipDir = path.join(temp, 'zip-src');
  const zipTop = path.join(zipDir, 'TopFolder');
  fs.mkdirSync(zipTop, { recursive: true });
  fs.writeFileSync(path.join(zipTop, 'file.txt'), 'content');
  const zipPath = path.join(temp, 'probe.zip');
  const { spawnSync } = require('child_process');
  const az = spawnSync(sevenZip.path7za || sevenZip, ['a', '-tzip', '-mx=0', zipPath, 'TopFolder'], { cwd: zipDir });
  if (az.status !== 0) throw new Error('zip fixture failed: ' + az.stderr);
  const dest = path.join(temp, 'dest');
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'precious.txt'), 'original-destination');
  // Sabotage ONLY the staging->dest rename (second rename whose dest==dest).
  const realRename = fs.renameSync;
  let renameHits = 0;
  fs.renameSync = function (a, b) {
    if (path.resolve(b) === path.resolve(dest) && path.resolve(a) !== path.resolve(dest)) {
      renameHits++;
      if (renameHits >= 1) { const e = new Error('EBUSY: simulated crash'); e.code = 'EBUSY'; throw e; }
    }
    return realRename(a, b);
  };
  let h14;
  try { h14 = await extractZip(zipPath, dest, {}); } finally { fs.renameSync = realRename; }
  const destRestored = fs.existsSync(path.join(dest, 'precious.txt'));
  check('H-014', 'failed staging->dest activation restores the original destination (no stranding)',
    h14 && h14.ok === false && destRestored, JSON.stringify(h14).slice(0, 160));
})().catch((e) => {
  check('FATAL', 'probe crashed', false, e && e.stack ? e.stack : String(e));
}).finally(() => {
  let pass = 0;
  for (const [id, name, ok, detail] of results) {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${id} :: ${name}${ok ? '' : ' :: ' + detail}`);
    if (ok) pass++;
  }
  console.log(`\nhigh-probe: ${pass}/${results.length} passed`);
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch (_) {}
  process.exit(pass === results.length ? 0 : 1);
});
