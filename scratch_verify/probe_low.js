'use strict';
/*
 * probe_low.js — hands-on verification of Low findings L-001..L-004.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Electron shim (safeStorage round-trip) for main-process modules.
const Module = require('module');
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: { isPackaged: false, getPath: () => require('os').tmpdir(), getVersion: () => '0.0.0-probe' },
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (s) => Buffer.from('shimenc:' + s),
        decryptString: (b) => Buffer.from(b).toString().slice(8),
      },
      ipcMain: { handle() {}, on() {}, removeHandler() {} },
      BrowserWindow: class {},
      dialog: {},
      shell: {},
    };
  }
  return origLoad.apply(this, arguments);
};

const ROOT = path.resolve(__dirname, '..');
const results = [];
function check(id, name, pass, detail) {
  results.push({ id, name, pass, detail });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${id} ${name}${detail ? ' — ' + detail : ''}`);
}

(async () => {
  // ============================================================
  // L-001 — architecture wiring suite is behavioral AND passes
  // ============================================================
  {
    const suitePath = path.join(ROOT, 'tests/unit/architecture-wiring.hhhhu3.test.js');
    const src = fs.readFileSync(suitePath, 'utf8');
    // Meta-check: the suite EXECUTES code (loads preload, invokes bridges,
    // resolves requires) instead of only searching source strings.
    const behavioralMarkers = [
      "require(path.join(ROOT, 'preload.js'))",        // loads real preload
      'ipcRenderer',                                    // records real channel invocations
      'api.fbConfirmDestructive(spec)',                 // invokes exposed bridge
      'win.FbIntent.del',                               // drives renderer bridge
      'require.resolve',                                // dead-import walk
      'svc.recover()',                                  // runs real recovery
    ];
    const markers = behavioralMarkers.filter((m) => src.includes(m)).length;
    // Source-string-search style would be `<fileContentVar>.includes(...)`;
    // the suite's `.includes(` calls are array-membership asserts on recorded
    // IPC channels, so count only content-variable searches.
    const stringSearches = (src.match(/\bsrc\.includes\(|\bcontent\.includes\(|\bsource\.includes\(/g) || []).length;

    // Execute the suite for real (node:test).
    let exit = 0, out = '';
    try {
      out = execFileSync(process.execPath, ['--test', suitePath], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
    } catch (e) {
      exit = e.status;
      out = (e.stdout || '') + (e.stderr || '');
    }
    const passMatch = out.match(/pass (\d+)/);
    const failMatch = out.match(/fail (\d+)/);
    const passed = passMatch ? Number(passMatch[1]) : 0;
    const failed = failMatch ? Number(failMatch[1]) : -1;
    check('L-001', 'behavioral wiring suite exists, executes real code paths, and passes',
      markers >= 5 && stringSearches <= 2 && exit === 0 && passed >= 8 && failed === 0,
      `markers=${markers}/6 stringSearches=${stringSearches} pass=${passed} fail=${failed} exit=${exit}`);
  }

  // ============================================================
  // L-002 — comments no longer overclaim (scope notes present,
  // fetch-fallback paths explicitly marked unit-test-only)
  // ============================================================
  {
    const safeHttp = fs.readFileSync(path.join(ROOT, 'main/services/SafeHttpClient.js'), 'utf8');
    const installer = fs.readFileSync(path.join(ROOT, 'scripts/lib/RuntimeInstaller.js'), 'utf8');
    const oac = fs.readFileSync(path.join(ROOT, 'src/providers/openaiCompatible.js'), 'utf8');
    const rep = fs.readFileSync(path.join(ROOT, 'src/providers/replicate.js'), 'utf8');
    const notes =
      /L-002 \(hhhhu3 audit\) scope note/.test(safeHttp) &&
      /L-002 \(hhhhu3 audit\) scope note/.test(installer);
    const qualified =
      /ONLY for direct unit tests/i.test(oac) &&
      /fetch path remains for direct unit tests/i.test(rep);
    check('L-002', 'overclaiming comments replaced with explicit scope notes (safe-http, recovery, fetch fallback)',
      notes && qualified, `scopeNotes=${notes} qualifiedFallbacks=${qualified}`);
  }

  // ============================================================
  // L-003 — one canonical credential schema documented + enforced.
  // BEHAVIORAL end-to-end: seed a plaintext api_key into config.txt, run
  // the real CredentialRepository.migrateLegacy(), and verify the plaintext
  // is gone from disk while the key resolves through the encrypted blob.
  // ============================================================
  {
    const store = fs.readFileSync(path.join(ROOT, 'src/providersStore.js'), 'utf8');
    const doc = /ONE canonical credential schema/.test(store) &&
      /ONLY persisted credential reference field/.test(store);

    const tmp = path.join(__dirname, '_tmp_low_l003');
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    process.env.MINIMAX_CONFIG_DIR = tmp;
    fs.writeFileSync(path.join(tmp, 'config.txt'),
      ['api_key=sk-PLAINTEXT-CANARY-42', 'output_dir=', 'region=global', 'theme=dark', 'styles=', ''].join('\n'));
    const credRepo = require(path.join(ROOT, 'main/services/CredentialRepository.js'));
    let mig = null, migErr = null;
    try { mig = credRepo.migrateLegacy(); } catch (e) { migErr = e; }
    const disk = fs.readFileSync(path.join(tmp, 'config.txt'), 'utf8');
    const plaintextGone = !/sk-PLAINTEXT-CANARY-42/.test(disk) && /^api_key=\s*$/m.test(disk);
    const hasRef = /api_credential_id=.+/.test(disk);
    const cfgMod = require(path.join(ROOT, 'src/config.js'));
    const resolved = cfgMod.read().api_credential_id;
    check('L-003', 'single credential schema: live migration moves plaintext api_key off disk into encrypted blob ref',
      doc && !migErr && mig && mig.migrated === true && plaintextGone && hasRef && !!resolved,
      `schemaDoc=${doc} migrated=${mig && mig.migrated} plaintextGone=${plaintextGone} ref=${!!resolved} err=${migErr && migErr.message}`);
  }

  // ============================================================
  // L-004 — large-directory listing is fully async (no sync enum in the
  // listing path) and the renderer uses the paginated surface
  // ============================================================
  {
    const dls = fs.readFileSync(path.join(ROOT, 'main/services/DirectoryListingService.js'), 'utf8');
    const noSyncEnum = !/readdirSync|lstatSync|statSync/.test(dls);
    const usesPromises = /require\('fs'\)\.promises/.test(dls) || /fsp\.lstat|fs\.lstat|fs\.readdir/.test(dls);
    const ipc = fs.readFileSync(path.join(ROOT, 'main/ipc/fileBrowserListingIpc.js'), 'utf8');
    const registers = /fb:listStart/.test(ipc) && /fb:listNext/.test(ipc) && /fb:listClose/.test(ipc);
    const pagedPath = path.join(ROOT, 'renderer/services/fbListPaged.js');
    const paged = fs.existsSync(pagedPath) && fs.readFileSync(pagedPath, 'utf8').includes('fbListStart');
    check('L-004', 'listing path is async end-to-end (DirectoryListingService has no sync enumeration; renderer uses fbListPaged)',
      noSyncEnum && usesPromises && registers && paged,
      `noSync=${noSyncEnum} asyncIO=${usesPromises} ipc=${registers} rendererPaged=${paged}`);
  }

  const pass = results.filter((r) => r.pass).length;
  console.log(`\nprobe_low: ${pass}/${results.length} PASS`);
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => {
  console.error('probe_low crashed:', e);
  process.exit(2);
});
