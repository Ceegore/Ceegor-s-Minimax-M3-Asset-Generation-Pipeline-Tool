const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const PACKAGE_JSON = require(path.join(ROOT, 'package.json'));

function purgeProjectCache() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(ROOT) && key !== __filename) delete require.cache[key];
  }
}

async function withModuleMocks(mocks, run) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request];
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return await run();
  } finally {
    Module._load = originalLoad;
  }
}

function createElectronMock(overrides = {}) {
  const handlers = {};
  const listeners = {};
  const sends = [];
  const showItemInFolderCalls = [];
  const openPathCalls = [];
  const openExternalCalls = [];
  const userDataPath = overrides.userDataPath || path.join(process.cwd(), 'tmp-user-data');
  return {
    handlers,
    listeners,
    sends,
    showItemInFolderCalls,
    openPathCalls,
    openExternalCalls,
    module: {
      ipcMain: {
        handle(channel, fn) { handlers[channel] = fn; },
        on(channel, fn) { listeners[channel] = fn; },
      },
      dialog: {
        showOpenDialog: overrides.showOpenDialog || (async () => ({ canceled: true, filePaths: [] })),
        // H-013: fb:confirmDestructive shows a native confirmation box.
        // Auto-confirm so the intent-token flow runs in tests.
        showMessageBox: overrides.showMessageBox || (async () => ({ response: 1 })),
      },
      shell: {
        showItemInFolder(p) { showItemInFolderCalls.push(p); },
        openPath: overrides.openPath || (async (p) => { openPathCalls.push(p); return ''; }),
        openExternal: overrides.openExternal || (async (url) => { openExternalCalls.push(url); }),
      },
      app: {
        getPath(name) {
          if (name === 'userData') return userDataPath;
          if (name === 'exe') return path.join(userDataPath, 'MiniMaxAssetTool.exe');
          return userDataPath;
        },
      },
      BrowserWindow: class BrowserWindow {},
      // B-002 (hhhhu2 audit): CredentialRepository persists keys through
      // SecretBlobStore, which requires electron's safeStorage.
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (s) => Buffer.from('enc:' + s, 'utf8'),
        decryptString: (buf) => buf.toString('utf8').replace(/^enc:/, ''),
      },
      contextBridge: overrides.contextBridge,
      ipcRenderer: overrides.ipcRenderer,
    },
  };
}

async function withIsolatedProject(options, run) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'full-tool-sweep-'));
  const outputDir = path.join(tmp, 'output');
  const userDataDir = path.join(tmp, 'userData');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });
  const previousConfigDir = process.env.MINIMAX_CONFIG_DIR;
  process.env.MINIMAX_CONFIG_DIR = tmp;
  purgeProjectCache();
  const electron = createElectronMock({
    userDataPath: userDataDir,
    showOpenDialog: options?.showOpenDialog,
    openPath: options?.openPath,
    openExternal: options?.openExternal,
    contextBridge: options?.contextBridge,
    ipcRenderer: options?.ipcRenderer,
  });
  try {
    return await withModuleMocks(
      { electron: electron.module, ...(options?.mocks || {}) },
      async () => run({
        tmp,
        outputDir,
        userDataDir,
        electron,
        load: (relPath) => require(path.join(ROOT, relPath)),
      }),
    );
  } finally {
    if (previousConfigDir == null) delete process.env.MINIMAX_CONFIG_DIR;
    else process.env.MINIMAX_CONFIG_DIR = previousConfigDir;
    purgeProjectCache();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

function makeSender(sendLog) {
  return {
    id: 17,
    send(channel, data) {
      sendLog.push({ channel, data });
    },
  };
}

test('preload bridge exposes every tool function and maps to the expected channels', async () => {
  const invokes = [];
  const sent = [];
  const listeners = [];
  let exposedName = null;
  let api = null;

  const ipcRenderer = {
    invoke(channel, ...args) {
      invokes.push({ channel, args });
      return Promise.resolve({ channel, args });
    },
    on(channel, fn) {
      listeners.push({ type: 'on', channel, fn });
    },
    removeListener(channel, fn) {
      listeners.push({ type: 'remove', channel, fn });
    },
    send(channel, ...args) {
      sent.push({ channel, args });
    },
  };

  await withIsolatedProject({
    contextBridge: {
      exposeInMainWorld(name, exposed) {
        exposedName = name;
        api = exposed;
      },
    },
    ipcRenderer,
  }, async ({ load }) => {
    load('preload.js');
  });

  assert.equal(exposedName, 'api');
  assert.ok(api);

  const expectedKeys = [
    'ackPrepareClose',
    'assetsReset',
    'audioAutocutDetect',
    'audioAvailable',
    'audioCut',
    'audioDecodePeaks',
    'audioFindZeroCrossing',
    'audioProbe',
    'audioTrimSilence',
    'authStatus',
    'authTestDraft',
    'batchesAcknowledgeRecovery',
    'batchesGenerateExamples',
    'batchesGet',
    'batchesRecoveryStatus',
    'batchesSet',
    'configPath',
    'confirmRequest',
    'confirmResetAndRelaunch',
    'defaultOutputDir',
    'diagnose',
    'externalToolsProbe',
    'externalToolsRun',
    'fbConfirmDestructive',
    'fbCopy',
    'fbDelete',
    'fbEnsureDir',
    'fbExists',
    'fbList',
    'fbListClose',
    'fbListDrives',
    'fbListNext',
    'fbListStart',
    'fbMkdir',
    'fbMove',
    'fbOpenDialog',
    'fbOpenInExplorer',
    'fbRead',
    'fbRename',
    'fbReveal',
    'fbSetActiveDir',
    'fbWrite',
    'fileSaveAs',
    'fixImageExtension',
    'getAppVersion',
    'getConfigPublic',
    'getPremadeStyles',
    'imageMetadata',
    'inpaintModelsAvailable',
    'inpaintReplaceModel',
    'inpaintRestoreModel',
    'inpaintRunOnnx',
    'inpaintRunTelea',
    'installOpenUrl',
    'installPickAndCopy',
    'isnetbgAvailable',
    'isnetbgDownloadModel',
    'isnetbgRun',
    'jobCancel',
    'jobCancelAll',
    'jobList',
    'logToFile',
    'm3Cancel',
    'm3Chat',
    'mintGrant',
    'mmxCancel',
    'mmxProfile',
    'mmxRun',
    'mmxRunJob',
    'onBeforeQuit',
    'onIsnetbgDownloadProgress',
    'onLog',
    'onLogRich',
    'onPrepareClose',
    'onProvidersProgress',
    'onRealesrganDownloadProgress',
    'onRealesrganProgress',
    'optimizeImage',
    'pathBasename',
    'pathDirname',
    'pathExtname',
    'pathForDragFile',
    'pathJoin',
    'pickFile',
    'pickFolder',
    'pickFolderFull',
    'pipelineImport',
    'pipelineMintWorkspace',
    'pipelineReplace',
    'pipelineThumb',
    'pipelineTrash',
    'providersCancel',
    'providersGenerate',
    'providersGetPublic',
    'providersListModels',
    'providersPendingJobs',
    'providersSet',
    'quota',
    'realesrganAvailable',
    'realesrganDownload',
    'realesrganRun',
    'refImageExists',
    'relaunchApp',
    'resetAllData',
    'resetAndRelaunch',
    'resizeImage',
    'revokeGrant',
    'saveManualAs',
    'setConfig',
    'stateArchiveClear',
    'stateArchiveDelete',
    'stateArchiveRead',
    'stateArchiveSize',
    'stateGet',
    'stateSet',
    'voices',
    'writeImageBase64',
  ];
  assert.deepEqual(Object.keys(api).sort(), expectedKeys.slice().sort());

  const checks = [
    ['getAppVersion', [], 'app:version'],
    ['getConfigPublic', [], 'config:getPublic'],
    ['setConfig', [{ api_key: 'sk-test' }], 'config:set'],
    ['pickFolderFull', [{ purpose: 'config-output' }], 'config:pickFolder'],
    ['configPath', [], 'config:path'],
    ['defaultOutputDir', [], 'config:defaultOutputDir'],
    // R7.5 (S1 §6 R1.5b): mmx:run / mmx:run:job are grant-gated — the preload
    // bridge forwards a Main-minted grantId as the trailing arg so the --out /
    // --out-dir / cwd path is authorised in main. Assert it is included so a
    // future preload change that drops it fails this contract.
    ['mmxRun', [['image', '--prompt', 'hello'], 'grant-id', ['read-grant-id']], 'mmx:run'], // B-002: trailing readGrantIds
    ['mmxRunJob', [{ args: ['image', 'generate'], jobId: 'j1' }, 'grant-id'], 'mmx:run:job'],
    ['mmxProfile', [], 'mmx:profile'],
    ['voices', [], 'mmx:voices'],
    ['quota', [], 'mmx:quota'],
    ['authStatus', [], 'mmx:authStatus'],
    ['authTestDraft', [{ draftKey: 'sk-test' }], 'mmx:authTestDraft'],
    ['diagnose', [], 'mmx:diagnose'],
    ['mmxCancel', [], 'mmx:cancel'],
    ['fbList', ['C:\\work'], 'fb:list'],
    // R1.3: fbTrustAncestors is REMOVED from the preload bridge
    // (S1 §4 "File Browser"). The renderer's Up button still
    // uses fb:list + fb:set-active-dir (the nav-ACK).
    ['fbSetActiveDir', ['C:\\work\\sub'], 'fb:set-active-dir'],
    // R1.3: mutating handlers now also take a grantId as the last
    // argument; the preload bridge forwards it through.
    ['fbMkdir', ['C:\\work', 'sub', 'grant-id'], 'fb:mkdir'],
    ['fbEnsureDir', ['C:\\work\\newdir', 'grant-id'], 'fb:ensureDir'],
    ['fbRename', ['C:\\work\\a.txt', 'b.txt', 'grant-id', 'intent-id'], 'fb:rename'],
    ['fbDelete', ['C:\\work\\a.txt', 'grant-id', 'intent-id'], 'fb:delete'],
    // gewv2 GEW-002: fbMove/fbCopy now accept an optional 4th destGrantId
    // arg (a separately-minted grant for the destination when src/destDir
    // don't share a common-ancestor grant) — the preload wrapper forwards
    // it 1:1, so the sweep exercises it explicitly here.
    ['fbMove', ['C:\\work\\a.txt', 'C:\\work\\out', 'grant-id', 'dest-grant-id', 'intent-id'], 'fb:move'],
    // B-007/M-012/M-013 (hhhhu3 audit): the confirm-then-execute bridge and
    // the paginated listing surface are preload contract members too.
    ['fbConfirmDestructive', [{ operation: 'delete', sourcePath: 'C:\\work\\a.txt', sourceGrantId: 'grant-id' }], 'fb:confirmDestructive'],
    ['fbListStart', [{ dir: 'C:\\work', grantId: 'grant-id' }], 'fb:listStart'],
    ['fbListNext', [{ cursor: 'c1' }], 'fb:listNext'],
    ['fbListClose', [{ cursor: 'c1' }], 'fb:listClose'],
    ['fbCopy', ['C:\\work\\a.txt', 'C:\\work\\out', 'grant-id', 'dest-grant-id'], 'fb:copy'],
    ['fbReveal', ['C:\\work\\a.txt', 'grant-r1'], 'fb:reveal'],
    ['fbOpenInExplorer', ['C:\\work\\a.txt', 'grant-r2'], 'fb:openInExplorer'],
    // v1.1.31: fbOpenDialog is a backward-compat alias for pickFile.
    // It maps to the same `file:pick` channel.
    ['fbOpenDialog', [{ title: 'Pick a file' }], 'file:pick'],
    // R1.3: fb:read and fb:exists now also require a read grantId.
    ['fbRead', ['C:\\work\\a.txt', 'grant-id'], 'fb:read'],
    ['fbExists', ['C:\\work\\a.txt', 'grant-id'], 'fb:exists'],
    ['fbWrite', ['C:\\work\\a.txt', 'Zm9v', 'grant-id'], 'fb:write'],
    ['writeImageBase64', ['C:\\work\\a.png', 'iVBORw0KGgo=', 'grant-id'], 'image:writeBase64'],
    ['inpaintRunTelea', [{ srcPath: 'C:\\work\\a.png', mode: 'transparency', grantId: 'grant-id' }], 'inpaint:runTelea'],
    ['inpaintRunOnnx', [{ srcPath: 'C:\\work\\a.png', maskB64: 'iVBORw0KGgo=', grantId: 'grant-id' }], 'inpaint:runOnnx'],
    ['inpaintModelsAvailable', [], 'inpaint:modelsAvailable'],
    ['inpaintReplaceModel', ['migan'], 'inpaint:replaceModel'],
    ['inpaintRestoreModel', ['migan'], 'inpaint:restoreModel'],
    ['realesrganAvailable', [], 'upscale:realesrgan:available'],
    // R1.5a.follow-up Phase 5: grantId is now forwarded through
    // the preload. The R1.5a preload signature was
    // `(srcPath, dstPath, opts)` and the third arg was silently
    // dropped, so the handler's grant-check always received
    // `undefined` for the production preload→IPC pipeline. The
    // contract test now asserts the grantId is included as the
    // 4th arg, matching the handler's expected signature
    // `(event, srcPath, dstPath, opts, grantId)`.
    ['realesrganRun', ['C:\\in.png', 'C:\\out.png', { model: 'realesrgan-x4plus' }, 'grant-id'], 'upscale:realesrgan:run'],
    ['realesrganDownload', [], 'upscale:realesrgan:download'],
    ['installOpenUrl', ['https://example.com'], 'install:openUrl'],
    ['installPickAndCopy', ['realesrgan-binary'], 'install:pickAndCopy'],
    ['isnetbgAvailable', [], 'isnetbg:available'],
    ['isnetbgRun', ['C:\\in.png', 'C:\\out.png', { useGpu: true }, 'grant-id'], 'isnetbg:run'],
    ['isnetbgDownloadModel', ['birefnet-general-lite'], 'isnetbg:download-model'],
    ['optimizeImage', ['C:\\in.png', { quality: 82 }, 'grant-id'], 'image:optimize'],
    ['resizeImage', ['C:\\in.png', { width: 100, height: 100 }, 'grant-id'], 'image:resize'],
    ['fixImageExtension', ['C:\\in.png', 'grant-id'], 'image:fixExtension'],
    ['refImageExists', ['C:\\ref.png'], 'image:refExists'],
    ['audioAvailable', [], 'audio:available'],
    // R7.5 (S1 §6 R1.5a): the path-taking audio handlers are grant-gated.
    // The preload bridge now forwards a Main-minted grantId as the trailing
    // arg (matching the handler signature, e.g. audio:cut =
    // (event, srcPath, dstPath, opts, grantId)). Assert the grantId is
    // included so a future preload change that drops it fails this contract.
    ['audioProbe', ['C:\\tone.wav', 'grant-id'], 'audio:probe'],
    ['audioDecodePeaks', ['C:\\tone.wav', { maxBuckets: 32 }, 'grant-id'], 'audio:decodePeaks'],
    ['audioFindZeroCrossing', [[1, -1, 1], 5, 12], 'audio:findZeroCrossing'],
    ['audioTrimSilence', ['C:\\tone.wav', { thresholdDb: -40 }, 'grant-id'], 'audio:trimSilence'],
    ['audioCut', ['C:\\tone.wav', 'C:\\cut.wav', { startSec: 1, endSec: 2 }, 'grant-id'], 'audio:cut'],
    ['audioAutocutDetect', ['C:\\tone.wav', {}, 'grant-id'], 'audio:autocutDetect'],
    ['batchesGet', [], 'batches:get'],
    ['batchesSet', [{ image: ['one'], speech: [], music: [], video: [] }], 'batches:set'],
    // H-053: recovery status/acknowledge for corrupt batches.json.
    ['batchesRecoveryStatus', [], 'batches:recoveryStatus'],
    ['batchesAcknowledgeRecovery', [], 'batches:acknowledgeRecovery'],
    ['pickFile', [{ title: 'Pick a file' }], 'file:pick'],
    ['fileSaveAs', ['C:\\in.png', undefined], 'file:saveAs'],
    ['stateGet', [], 'state:get'],
    ['stateSet', [{ currentTab: 'image' }], 'state:set'],
    ['batchesGenerateExamples', ['png'], 'batches:generateExamples'],
    ['saveManualAs', ['md'], 'batches:saveManualAs'],
    // v1.1.31: External tools IPC. The payload carries the tool
    // NAME (looked up from the persisted config) + the file
    // paths to hand off; the main process validates + spawns.
    ['externalToolsRun', [{ name: 'GIMP', paths: ['C:\\a.png'] }, 'grant-id'], 'externalTools:run'],
    ['externalToolsProbe', [{ name: 'GIMP' }], 'externalTools:probe'],
    // R6.6.1: unified job cancellation.
    ['jobCancel', [{ jobId: 'j1' }], 'job:cancel'],
    ['jobCancelAll', [], 'job:cancel-all'],
    ['jobList', [], 'job:list'],
    // Other APIs tab (non-MiniMax providers).
    ['providersGetPublic', [], 'providers:getPublic'],
    ['providersSet', [{ providers: [] }], 'providers:set'],
    ['providersListModels', [{ providerId: 'openrouter' }], 'providers:listModels'],
    ['providersGenerate', [{ jobId: 'j1', modality: 'image', providerId: 'openrouter', model: 'x', prompt: 'p', outDir: 'C:\\out', grantId: 'g' }], 'providers:generate'],
  ];
  // v1.3 (Feature 3): the Pipeline channels (pipeline:import / :replace / :trash
  // / :thumb) are exercised by their own registrar test in
  // tests/unit/src/pipeline/ + the dedicated IPC smoke below, rather than the
  // inline checks array here — pipelineImport's preload wrapper nests its args
  // into { items }, and pathForDragFile has no channel (it calls webUtils
  // locally), so they don't fit the [method, args, channel] shape cleanly.

  for (const [method, args, channel] of checks) {
    invokes.length = 0;
    const result = await api[method](...args);
    assert.equal(invokes.length, 1, `${method} should invoke exactly once`);
    assert.equal(invokes[0].channel, channel);
    assert.deepEqual(invokes[0].args, args);
    assert.equal(result.channel, channel);
  }

  // pickFolder is an async wrapper that unwraps the IPC envelope
  // (returns the path string or null), so it doesn't fit the generic
  // result.channel assertion above. Test its forwarding separately.
  invokes.length = 0;
  const pfResult = await api.pickFolder();
  assert.equal(invokes.length, 1, 'pickFolder should invoke exactly once');
  assert.equal(invokes[0].channel, 'config:pickFolder');
  assert.equal(pfResult, null, 'pickFolder returns null when the envelope has no ok+path');

  const offProgress = api.onRealesrganDownloadProgress(() => {});
  assert.equal(listeners[0].type, 'on');
  assert.equal(listeners[0].channel, 'upscale:realesrgan:download:progress');
  offProgress();
  assert.equal(listeners[1].type, 'remove');
  assert.equal(listeners[1].channel, 'upscale:realesrgan:download:progress');

  const offLog = api.onLog(() => {});
  assert.equal(listeners[2].type, 'on');
  assert.equal(listeners[2].channel, 'mmx:log');
  offLog();
  assert.equal(listeners[3].type, 'remove');
  assert.equal(listeners[3].channel, 'mmx:log');

  // v1.1 (audit BUG-N8): onBeforeQuit is the renderer-side
  // listener for the main process's before-quit signal. The
  // previous test only asserted the bridge method exists
  // (via `expectedKeys`); it didn't verify the call returns
  // a working unsubscribe function. We add a full
  // subscribe-and-unsubscribe cycle below — same shape as
  // the onLog / onRealesrganDownloadProgress tests above.
  const onBeforeQuitCount = listeners.length;
  const offBeforeQuit = api.onBeforeQuit(() => {});
  assert.equal(typeof offBeforeQuit, 'function', 'onBeforeQuit must return a function (the unsubscribe handle)');
  assert.equal(listeners[onBeforeQuitCount].type, 'on');
  assert.equal(listeners[onBeforeQuitCount].channel, 'app:before-quit');
  offBeforeQuit();
  assert.equal(listeners[onBeforeQuitCount + 1].type, 'remove');
  assert.equal(listeners[onBeforeQuitCount + 1].channel, 'app:before-quit');

  const onBgProgressCount = listeners.length;
  const offBgProgress = api.onIsnetbgDownloadProgress(() => {});
  assert.equal(typeof offBgProgress, 'function', 'onIsnetbgDownloadProgress must return a function (the unsubscribe handle)');
  assert.equal(listeners[onBgProgressCount].type, 'on');
  assert.equal(listeners[onBgProgressCount].channel, 'isnetbg:download-progress');
  offBgProgress();
  assert.equal(listeners[onBgProgressCount + 1].type, 'remove');
  assert.equal(listeners[onBgProgressCount + 1].channel, 'isnetbg:download-progress');

  api.logToFile('[renderer] boom');
  assert.deepEqual(sent, [{ channel: 'renderer:log', args: ['[renderer] boom'] }]);
});

test('app, config, state, batches, and file browser handlers pass a real filesystem sweep', async () => {
  await withIsolatedProject({
    showOpenDialog: async () => ({ canceled: false, filePaths: [] }),
  }, async ({ outputDir, tmp, electron, load }) => {
    const config = load('src/config.js');
    config.write({
      api_key: 'sk-initial',
      output_dir: outputDir,
      region: 'global',
      theme: 'dark',
      styles: [{ name: 'Default', value: 'Cinematic' }],
    });

    const trustedDir = path.join(tmp, 'trusted-folder');
    fs.mkdirSync(trustedDir, { recursive: true });
    fs.writeFileSync(path.join(trustedDir, 'trusted.txt'), 'trusted', 'utf8');
    electron.module.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [trustedDir] });

    // R1.3: mint the directory grants up front via the real
    // defaultService so every mutating fb:* call below has a valid
    // grantId. The grants cover the outputDir root (coversRoot:true
    // so writes next to the root work) and the trustedDir (for
    // the config:pickFolder path that gets exercised below).
    const { defaultService: pathGrantService } = load('main/services/PathGrantService.js');
    pathGrantService.destroy();
    const outputGrant = pathGrantService.mintDirectoryGrant({
      origin: 'app-output',
      purpose: 'fullToolSweep test',
      path: outputDir,
      capabilities: ['read', 'write', 'delete', 'mkdir', 'rename', 'move', 'copy'],
      coversRoot: true,
    });
    const trustedGrant = pathGrantService.mintDirectoryGrant({
      origin: 'picker-browser-dir',
      purpose: 'fullToolSweep test',
      path: trustedDir,
      capabilities: ['read', 'write', 'delete', 'mkdir', 'rename', 'move', 'copy'],
      coversRoot: true,
    });
    const outputGrantId = outputGrant.grantId;
    const trustedGrantId = trustedGrant.grantId;

    const registrars = [
      'main/ipc/registerAppIpc.js',
      'main/ipc/registerConfigIpc.js',
      'main/ipc/registerConfigPublicIpc.js',
      'main/ipc/registerStateIpc.js',
      'main/ipc/registerBatchesIpc.js',
      'main/ipc/registerFileBrowserIpc.js',
    ];
    for (const rel of registrars) {
      load(rel).register({ appRoot: ROOT, getMainWindow: () => null });
    }

    const appVersion = electron.handlers['app:version']();
    assert.equal(appVersion.version, PACKAGE_JSON.version);
    assert.equal(appVersion.name, PACKAGE_JSON.name);
    assert.equal(appVersion.productName, PACKAGE_JSON.build.productName);

    const currentConfig = electron.handlers['config:getPublic']();
    // SEC-001: config:getPublic returns a secret-free DTO.
    assert.equal(currentConfig.hasApiKey, true);
    assert.equal(currentConfig.output_dir, outputDir);

    const savedResult = electron.handlers['config:set'](null, {
      api_key: 'sk-updated',
      output_dir: outputDir,
      region: 'cn',
      theme: 'light',
      styles: [{ name: 'Moody', value: 'Noir' }],
      ignored: 'nope',
    });
    // Bug-fix M2 (_temp5.md 360° audit): config:set now returns an
    // envelope `{ ok, config, error }` instead of the bare config
    // (which was null on failure and crashed callers).
    assert.equal(savedResult.ok, true);
    assert.equal(savedResult.error, null);
    const savedConfig = savedResult.config;
    // SEC-001: config:set returns a public DTO (no raw api_key).
    assert.equal(savedConfig.hasApiKey, true);
    assert.equal(savedConfig.region, 'cn');
    assert.equal(savedConfig.theme, 'light');
    assert.equal(savedConfig.ignored, undefined);
    assert.equal(electron.handlers['config:path'](), path.join(tmp, 'config.txt'));
    assert.equal(electron.handlers['config:defaultOutputDir'](), path.join(path.join(tmp, 'userData'), 'generated'));

    // R1.2a: config:pickFolder now returns an envelope
    // `{ ok, path, grantId, capabilities }` (additive, the path is
    // still there for display/read consumers).
    const pickedFolder = await electron.handlers['config:pickFolder']();
    assert.equal(pickedFolder.ok, true);
    assert.equal(pickedFolder.path, trustedDir);
    assert.ok(typeof pickedFolder.grantId === 'string' && pickedFolder.grantId.length > 0,
      'config:pickFolder must return a grantId for the picked folder');

    const trustedList = await electron.handlers['fb:list'](null, trustedDir, trustedGrantId);
    assert.equal(trustedList.ok, true);
    assert.ok(trustedList.items.some((item) => item.name === 'trusted.txt'));

    const base64 = Buffer.from('hello world', 'utf8').toString('base64');
    const rootFile = path.join(outputDir, 'note.txt');
    // R1.3: every mutating handler now takes a grantId as the last
    // argument. The outputGrant covers the outputDir root and its
    // descendants, so all the writes/reads/renames/copies/moves
    // below are authorized.
    const writeRes = await electron.handlers['fb:write'](null, rootFile, base64, outputGrantId);
    assert.deepEqual(writeRes, { ok: true, path: rootFile });
    // v1.1 (audit BUG-R2-09): fb:exists now returns the
    // { ok, exists } envelope. The test asserts both fields.
    // R1.3: also takes a grantId (read grant on the file).
    const existsRes = await electron.handlers['fb:exists'](null, rootFile, outputGrantId);
    assert.equal(existsRes.ok, true, 'fb:exists should return ok=true on success');
    assert.equal(existsRes.exists, true, 'fb:exists should report the file exists');
    const readRes = await electron.handlers['fb:read'](null, rootFile, outputGrantId);
    assert.equal(Buffer.from(readRes.base64, 'base64').toString('utf8'), 'hello world');

    const mkdirRes = await electron.handlers['fb:mkdir'](null, outputDir, 'sub', outputGrantId);
    assert.equal(mkdirRes.ok, true);
    assert.equal(fs.existsSync(path.join(outputDir, 'sub')), true);

    // bug-fix D1 (_temp4.md): fb:ensureDir must create a path that does
    // not exist yet directly (no named-child requirement like fb:mkdir),
    // and must still be gated by the same allow-list as every other fb:*
    // handler. R1.3: the "allow-list" is the PathGrantService; the grant
    // is checked BEFORE the mkdir runs.
    const notYetCreated = path.join(outputDir, 'ensured-root-child');
    assert.equal(fs.existsSync(notYetCreated), false);
    const ensureRes = await electron.handlers['fb:ensureDir'](null, notYetCreated, outputGrantId);
    assert.deepEqual(ensureRes, { ok: true, path: notYetCreated });
    assert.equal(fs.existsSync(notYetCreated), true);

    // R1.3: a path outside ANY grant is rejected with the new
    // grantId-required / not-covered error, not the OLD
    // "outside the allowed directories" message. The grantId IS
    // provided (outputGrantId), so the error here is the
    // "directory grant covers only strict descendants" or
    // "path is outside the grant root" message.
    const deniedEnsure = await electron.handlers['fb:ensureDir'](null, path.join(tmp, 'outside', 'denied'), outputGrantId);
    assert.equal(deniedEnsure.ok, false);
    assert.match(deniedEnsure.error, /root itself|descendant|outside the grant|not found|not covered/i);

    // H-013 (hhhhu2 audit): destructive ops (rename/move/delete) require
    // a one-shot intent token minted via fb:confirmDestructive. The handlers
    // bind the token to the IPC sender, so pass a fake event with a stable
    // sender id (secureHandle skips sender checks outside real Electron).
    const fakeEvent = { sender: { id: 1 } };
    const renameIntent = await electron.handlers['fb:confirmDestructive'](fakeEvent, {
      operation: 'rename',
      sourcePath: rootFile,
      destinationPath: path.join(outputDir, 'renamed.txt'),
      sourceGrantId: outputGrantId,
    });
    assert.equal(renameIntent.ok, true);
    const renameRes = await electron.handlers['fb:rename'](fakeEvent, rootFile, 'renamed.txt', outputGrantId, renameIntent.intentId);
    assert.equal(renameRes.ok, true);
    const renamedFile = renameRes.path;
    assert.equal(path.basename(renamedFile), 'renamed.txt');

    const copyRes = await electron.handlers['fb:copy'](null, renamedFile, path.join(outputDir, 'sub'), outputGrantId);
    assert.equal(copyRes.ok, true);
    assert.equal(fs.existsSync(copyRes.path), true);

    const moveIntent = await electron.handlers['fb:confirmDestructive'](fakeEvent, {
      operation: 'move',
      sourcePath: renamedFile,
      destinationPath: path.join(outputDir, 'sub', path.basename(renamedFile)),
      sourceGrantId: outputGrantId,
      destinationGrantId: outputGrantId,
    });
    assert.equal(moveIntent.ok, true);
    const moveRes = await electron.handlers['fb:move'](fakeEvent, renamedFile, path.join(outputDir, 'sub'), outputGrantId, outputGrantId, moveIntent.intentId);
    assert.equal(moveRes.ok, true);
    assert.equal(fs.existsSync(moveRes.path), true);
    assert.equal(path.dirname(moveRes.path), path.join(outputDir, 'sub'));

    const listRes = await electron.handlers['fb:list'](null, path.join(outputDir, 'sub'), outputGrantId);
    assert.equal(listRes.ok, true);
    assert.ok(listRes.items.some((item) => item.name === path.basename(copyRes.path)));
    assert.ok(listRes.items.some((item) => item.name === path.basename(moveRes.path)));

    const revealRes = await electron.handlers['fb:reveal'](null, moveRes.path, outputGrantId);
    assert.deepEqual(revealRes, { ok: true });
    assert.deepEqual(electron.showItemInFolderCalls, [moveRes.path]);

    const openExplorerRes = await electron.handlers['fb:openInExplorer'](null, moveRes.path, outputGrantId);
    assert.deepEqual(openExplorerRes, { ok: true });
    assert.deepEqual(electron.openPathCalls, [path.dirname(moveRes.path)]);

    // R1.3: a write to a path outside the grant is rejected with
    // the new grantId / not-covered error.
    const deniedWrite = await electron.handlers['fb:write'](null, path.join(tmp, 'outside', 'bad.txt'), base64, outputGrantId);
    assert.equal(deniedWrite.ok, false);
    assert.match(deniedWrite.error, /root itself|descendant|outside the grant|not found|not covered/i);

    const deleteIntent = await electron.handlers['fb:confirmDestructive'](fakeEvent, {
      operation: 'delete',
      sourcePath: moveRes.path,
      sourceGrantId: outputGrantId,
    });
    assert.equal(deleteIntent.ok, true);
    const deleteRes = await electron.handlers['fb:delete'](fakeEvent, moveRes.path, outputGrantId, deleteIntent.intentId);
    assert.deepEqual(deleteRes, { ok: true, path: moveRes.path });
    assert.equal(fs.existsSync(moveRes.path), false);

    // Suppress the unused-trustedGrantId warning — it's minted to
    // exercise the same defaultService but the trustedDir path
    // is only read (fb:list), not mutated, in this test.
    void trustedGrantId;

    const stateSet = electron.handlers['state:set'](null, {
      tabs: { image: { prompt: 'robot' } },
      currentTab: 'image',
      filePrefix: 'demo-',
      filePrefixForceOnly: true,
    });
    assert.deepEqual(stateSet, { ok: true });
    const savedState = electron.handlers['state:get']();
    assert.equal(savedState.currentTab, 'image');
    assert.equal(savedState.filePrefix, 'demo-');
    assert.equal(savedState.filePrefixForceOnly, true);

    const batchesData = { image: ['one'], speech: ['two'], music: [], video: [] };
    assert.deepEqual(electron.handlers['batches:set'](null, batchesData), { ok: true });
    assert.deepEqual(electron.handlers['batches:get'](), batchesData);

    const examplesRes = await electron.handlers['batches:generateExamples'](null, 'txt');
    assert.equal(examplesRes.ok, true);
    assert.equal(examplesRes.format, 'txt');
    assert.equal(fs.existsSync(examplesRes.path), true);
    assert.equal(fs.existsSync(path.join(outputDir, 'example_batch_import.txt')), true);
    assert.equal(fs.existsSync(path.join(outputDir, 'example_batch_import.md')), false);
  });
});

test('file picker returns structured envelopes for success, cancel, and dialog failures', async () => {
  await withIsolatedProject({}, async ({ electron, load }) => {
    load('main/ipc/registerFilePickerIpc.js').register({ getMainWindow: () => null });
    const pick = electron.handlers['file:pick'];

    electron.module.dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: ['C:\\picked\\asset.png'],
    });
    const ok = await pick(null, {
      title: 'Pick an image',
      filters: [{ name: 'Images', extensions: ['png', 'jpg'] }],
    });
    // R1.2: file:pick now returns an envelope
    // `{ ok, path, grantId, capabilities }`. The path is preserved
    // for legacy read-side consumers, and the grantId is the
    // R1.1/R1.2 read-only file grant the caller must present for
    // any subsequent read of the picked file.
    assert.equal(ok.ok, true);
    assert.equal(ok.path, 'C:\\picked\\asset.png');
    assert.ok(typeof ok.grantId === 'string' && ok.grantId.length > 0,
      'file:pick must mint and return a grantId');
    assert.deepEqual(ok.capabilities, ['read']);

    electron.module.dialog.showOpenDialog = async () => ({
      canceled: true,
      filePaths: [],
    });
    const canceled = await pick(null, {});
    assert.deepEqual(canceled, { ok: false, canceled: true });

    electron.module.dialog.showOpenDialog = async () => {
      throw new Error('dialog exploded');
    };
    const failed = await pick(null, {});
    assert.equal(failed.ok, false);
    assert.match(failed.error, /dialog exploded/);
  });
});

test('install IPC returns structured results for URL open and pick-and-copy failure paths', async () => {
  let copyMode = 'ok';
  let resetCounts = { real: 0, isnet: 0 };

  await withIsolatedProject({
    mocks: {
      '../../src/realesrgan': { resetCache() { resetCounts.real += 1; } },
      '../../src/isnetbg': { resetCache() { resetCounts.isnet += 1; } },
      '../services/InstallPickCopyService': {
        async pickAndCopy(kind) {
          if (copyMode === 'throw') throw new Error('copy failed');
          return { ok: true, kind, destPath: 'C:\\bin\\tool.exe' };
        },
      },
    },
  }, async ({ electron, load }) => {
    load('main/ipc/registerInstallIpc.js').register({ appRoot: ROOT, getMainWindow: () => null });
    const openUrl = electron.handlers['install:openUrl'];
    const pickAndCopy = electron.handlers['install:pickAndCopy'];

    const invalid = await openUrl(null, 'javascript:alert(1)');
    assert.equal(invalid.ok, false);
    assert.match(invalid.error, /Only http\(s\) URLs are allowed/i);

    const valid = await openUrl(null, 'https://example.com/download');
    assert.deepEqual(valid, { ok: true });
    assert.deepEqual(electron.openExternalCalls, ['https://example.com/download']);

    const senderEvents = [];
    const success = await pickAndCopy({ sender: makeSender(senderEvents) }, 'realesrgan-binary');
    assert.deepEqual(success, {
      ok: true,
      kind: 'realesrgan-binary',
      destPath: 'C:\\bin\\tool.exe',
    });
    assert.deepEqual(resetCounts, { real: 1, isnet: 1 });

    copyMode = 'throw';
    const failed = await pickAndCopy({ sender: makeSender(senderEvents) }, 'realesrgan-binary');
    assert.equal(failed.ok, false);
    assert.match(failed.error, /copy failed/);
  });
});

test('image, upscale, and background-removal handlers keep returning envelopes when dependencies fail', async () => {
  let imageMode = 'ok';
  let upscaleMode = 'ok';
  let downloadMode = 'ok';
  let isnetMode = 'ok';
  let upscaleResetCount = 0;

  await withIsolatedProject({
    mocks: {
      '../../src/imageOptimizer': {
        async optimize(srcPath, opts) {
          if (imageMode === 'throw') throw new Error('optimizer boom');
          return { ok: true, outputPath: opts.outputPath || srcPath, inputSize: 1, outputSize: 1, savedBytes: 0, savedPercent: 0, format: 'png', width: 1, height: 1 };
        },
        async fixExtensionToMatchContent(filePath) {
          if (imageMode === 'throw') throw new Error('optimizer boom');
          return { ok: true, path: filePath, renamed: false };
        },
      },
      '../../src/realesrgan': {
        isAvailable: () => true,
        getBinaryPath: () => 'C:\\bin\\realesrgan.exe',
        probeVersion: () => '0.2.0',
        async run(_srcPath, dstPath) {
          if (upscaleMode === 'throw') throw new Error('upscale boom');
          return { ok: true, code: 0, stderr: '', outputPath: dstPath };
        },
        resetCache() { upscaleResetCount += 1; },
      },
      '../services/InstallDownloadService': {
        async downloadRealesrgan(_appRoot, send) {
          send({ phase: 'download', downloaded: 5, total: 10 });
          if (downloadMode === 'throw') throw new Error('download boom');
          return { ok: true, binDir: 'C:\\bin' };
        },
      },
      '../../src/isnetbg': {
        isAvailable: () => true,
        getBinaryPath: () => 'C:\\bin\\isnetbg.exe',
        getModelPath: () => 'C:\\bin\\models\\isnet-general-use.onnx',
        probeVersion: () => '1.0.0',
        listModelStatus: () => ({}),
        async run(_srcPath, dstPath) {
          if (isnetMode === 'throw') throw new Error('isnet boom');
          return { ok: true, code: 0, stderr: '', outputPath: dstPath };
        },
      },
    },
  }, async ({ outputDir, electron, load }) => {
    load('src/config.js').write({
      api_key: 'sk-tool',
      output_dir: outputDir,
      region: 'global',
      theme: 'dark',
      styles: [],
    });
    load('main/ipc/registerImageIpc.js').register({ appRoot: ROOT });
    load('main/ipc/registerUpscaleIpc.js').register({ appRoot: ROOT, getMainWindow: () => null });
    load('main/ipc/registerIsnetbgIpc.js').register({ appRoot: ROOT });

    const srcPath = path.join(outputDir, 'in.png');
    const dstPath = path.join(outputDir, 'out.png');
    // R1.5a: mint a directory grant for outputDir so the handlers
    // (image:optimize, image:fixExtension) don't short-circuit on
    // "no grantId". The grant covers both srcPath and dstPath.
    const pathGrantService = load('main/services/PathGrantService').defaultService;
    pathGrantService.destroy();
    const imgGrant = pathGrantService.mintDirectoryGrant({
      origin: 'picker-browser-dir', purpose: 'fullToolSweep image grant',
      path: outputDir, capabilities: ['read', 'write', 'rename', 'delete', 'mkdir'],
    });

    const imageOk = await electron.handlers['image:optimize'](null, srcPath, { outputPath: dstPath }, imgGrant.grantId);
    assert.equal(imageOk.ok, true);

    imageMode = 'throw';
    const imageFail = await electron.handlers['image:optimize'](null, srcPath, { outputPath: dstPath }, imgGrant.grantId);
    assert.equal(imageFail.ok, false);
    assert.match(imageFail.error, /optimizer boom/);
    imageMode = 'ok';

    // bug-fix M6 (_temp4.md)
    const fixOk = await electron.handlers['image:fixExtension'](null, srcPath, imgGrant.grantId);
    assert.deepEqual(fixOk, { ok: true, path: srcPath, renamed: false });

    // R1.5a: the outside path is not under the grant → rejected
    // with the grant-authorisation error.
    const fixDenied = await electron.handlers['image:fixExtension'](null, path.join(outputDir, '..', 'outside.png'), imgGrant.grantId);
    assert.equal(fixDenied.ok, false);
    assert.match(fixDenied.error, /grant|authoris|outside/i,
      'image:fixExtension outside the grant must be blocked: ' + fixDenied.error);

    imageMode = 'throw';
    const fixFail = await electron.handlers['image:fixExtension'](null, srcPath, imgGrant.grantId);
    assert.equal(fixFail.ok, false);
    assert.match(fixFail.error, /optimizer boom/);
    imageMode = 'ok';

    const upscaleAvailable = electron.handlers['upscale:realesrgan:available']();
    assert.deepEqual(upscaleAvailable, {
      ok: true,
      available: true,
      binaryPath: 'C:\\bin\\realesrgan.exe',
      version: '0.2.0',
    });

    // R1.5a.3: upscale:realesrgan:run now requires a grantId.
    // The grant covers BOTH srcPath and dstPath (directory grant for outputDir).
    // P4.1 (DB-H-002/008): the handler now validates the output artifact; the
    // mocked run() writes nothing, so pre-create a REAL decodable 1x1 PNG at
    // dstPath (H-064 made the full decode mandatory for image artifacts).
    fs.writeFileSync(dstPath, Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64'));
    const upscaleOk = await electron.handlers['upscale:realesrgan:run'](null, srcPath, dstPath, { model: 'realesrgan-x4plus' }, imgGrant.grantId);
    assert.equal(upscaleOk.ok, true);

    upscaleMode = 'throw';
    const upscaleFail = await electron.handlers['upscale:realesrgan:run'](null, srcPath, dstPath, {}, imgGrant.grantId);
    assert.equal(upscaleFail.ok, false);
    assert.match(upscaleFail.stderr || upscaleFail.error, /upscale boom/);

    const senderEvents = [];
    const downloadOk = await electron.handlers['upscale:realesrgan:download']({ sender: makeSender(senderEvents) });
    assert.deepEqual(downloadOk, { ok: true, binDir: 'C:\\bin' });
    assert.deepEqual(senderEvents, [
      {
        channel: 'upscale:realesrgan:download:progress',
        data: { phase: 'download', downloaded: 5, total: 10 },
      },
    ]);
    assert.equal(upscaleResetCount, 1);

    downloadMode = 'throw';
    const downloadFail = await electron.handlers['upscale:realesrgan:download']({ sender: makeSender([]) });
    assert.equal(downloadFail.ok, false);
    assert.match(downloadFail.error, /download boom/);

    const isnetAvailable = electron.handlers['isnetbg:available']();
    assert.deepEqual(isnetAvailable, {
      ok: true,
      available: true,
      binaryPath: 'C:\\bin\\isnetbg.exe',
      modelPath: 'C:\\bin\\models\\isnet-general-use.onnx',
      modelPresent: true,
      version: '1.0.0',
      models: {},
    });

    // R1.5a.4: isnetbg:run now requires a grantId.
    const isnetOk = await electron.handlers['isnetbg:run'](null, srcPath, dstPath, { useGpu: true }, imgGrant.grantId);
    assert.equal(isnetOk.ok, true);

    isnetMode = 'throw';
    const isnetFail = await electron.handlers['isnetbg:run'](null, srcPath, dstPath, {}, imgGrant.grantId);
    assert.equal(isnetFail.ok, false);
    assert.match(isnetFail.stderr || isnetFail.error, /isnet boom/);
  });
});

test('audio handlers cover happy paths, typed-array conversion, and path validation', async () => {
  await withIsolatedProject({
    mocks: {
      '../../src/audioCutter': {
        isAvailable: () => true,
        findBinary: () => 'C:\\bin\\ffmpeg.exe',
        async probe(srcPath) {
          return { ok: true, duration: 2, path: srcPath };
        },
        async decodePeaks() {
          return {
            ok: true,
            peaks: new Float32Array([0.25, 0.75]),
            pcm: new Float32Array([1, -1, 1]),
          };
        },
        findZeroCrossing() {
          return 9;
        },
        async trimSilence() {
          return { ok: true, startSec: 0.2, endSec: 1.8 };
        },
        async cut(_srcPath, dstPath) {
          return { ok: true, outputPath: dstPath };
        },
        async detectSilences(srcPath) {
          return { ok: true, duration: 2, silences: [{ start: 0.5, end: 1.0 }] };
        },
        invertSilences(silences, duration) {
          return [{ start: 0, end: 0.5 }, { start: 1.0, end: 2.0 }];
        },
        planAutoCut(segments, rules) {
          return { segments, stats: { kept: 2, droppedShort: 0, truncated: 0, split: 0, capped: 0 } };
        },
        sanitizeAutoCutRules(rules) {
          return rules;
        },
      },
    },
  }, async ({ outputDir, electron, load }) => {
    load('src/config.js').write({
      api_key: 'sk-audio',
      output_dir: outputDir,
      region: 'global',
      theme: 'dark',
      styles: [],
    });
    load('main/ipc/registerAudioIpc.js').register({ appRoot: ROOT });

    const srcPath = path.join(outputDir, 'tone.wav');
    const dstPath = path.join(outputDir, 'trimmed.wav');

    assert.deepEqual(electron.handlers['audio:available'](), {
      ok: true,
      available: true,
      path: 'C:\\bin\\ffmpeg.exe',
    });

    // R1.5a.2: mint a directory grant that covers BOTH src and dst.
    // The audio path-taking handlers all require a grantId; the
    // grant is authorised through PathGrantService.
    const pathGrantService = load('main/services/PathGrantService').defaultService;
    pathGrantService.destroy();
    const audioGrant = pathGrantService.mintDirectoryGrant({
      origin: 'picker-browser-dir', purpose: 'fullToolSweep audio grant',
      path: outputDir, capabilities: ['read', 'write', 'rename', 'delete', 'mkdir'],
    });

    const probe = await electron.handlers['audio:probe'](null, srcPath, audioGrant.grantId);
    assert.equal(probe.ok, true);
    assert.equal(probe.duration, 2);

    const peaks = await electron.handlers['audio:decodePeaks'](null, srcPath, { withPcm: true }, audioGrant.grantId);
    assert.deepEqual(peaks.peaks, [0.25, 0.75]);
    assert.deepEqual(peaks.pcm, [1, -1, 1]);

    const zero = await electron.handlers['audio:findZeroCrossing'](null, new Float32Array([1, -1, 1]), 4, 12);
    assert.deepEqual(zero, { ok: true, index: 9 });

    const trim = await electron.handlers['audio:trimSilence'](null, srcPath, {}, audioGrant.grantId);
    assert.equal(trim.ok, true);
    assert.equal(trim.startSec, 0.2);

    const cut = await electron.handlers['audio:cut'](null, srcPath, dstPath, {}, audioGrant.grantId);
    assert.deepEqual(cut, { ok: true, outputPath: dstPath });

    const autocut = await electron.handlers['audio:autocutDetect'](null, srcPath, {}, audioGrant.grantId);
    assert.equal(autocut.ok, true);
    assert.deepEqual(autocut.plan, [{ start: 0, end: 0.5 }, { start: 1.0, end: 2.0 }]);

    // R1.5a.2: "outside" now triggers the grant-authorisation error
    // (the grant does not cover the outside path), not the legacy
    // isPathUnderAny error. Both messages convey "outside" intent.
    const denied = await electron.handlers['audio:probe'](null, path.join(outputDir, '..', '..', 'forbidden.wav'), audioGrant.grantId);
    assert.equal(denied.ok, false);
    assert.match(denied.error, /grant|authoris|outside/i,
      'audio:probe outside the grant must be blocked: ' + denied.error);

    const samePath = await electron.handlers['audio:cut'](null, srcPath, srcPath, {}, audioGrant.grantId);
    assert.equal(samePath.ok, false);
    assert.match(samePath.error, /must differ from the source/i);
  });
});

test('mmx handlers cover validation, streaming logs, voices, quota, auth, cancel, and diagnose', async () => {
  let cfg = { api_key: 'sk-mmx', region: 'global' };
  let runMode = 'ok';
  let cancelCount = 0;
  let voiceKeys = [];
  const cancelByJobIdCalls = [];

  await withIsolatedProject({
    mocks: {
      '../../src/config': {
        read() { return cfg; },
      },
      '../../src/mmx': {
        async runMmx({ args, onLog }) {
          onLog?.(`[log] ${args.join(' ')}`);
          if (runMode === 'quota-fail') {
            return { ok: false, code: 1, stdout: '', stderr: 'quota failed', parsed: null, command: 'mmx', argv: args };
          }
          if (runMode === 'auth-fail') {
            return {
              ok: false,
              code: 1,
              stdout: '',
              stderr: 'node.exe : auth failed',
              parsed: null,
              command: 'mmx',
              argv: args,
            };
          }
          if (runMode === 'auth-api-error') {
            return {
              ok: true,
              code: 0,
              stdout: '',
              stderr: '',
              parsed: { base_resp: { status_code: 401, status_msg: 'bad key' } },
              command: 'mmx',
              argv: args,
            };
          }
          return {
            ok: true,
            code: 0,
            stdout: '{"ok":true}',
            stderr: '',
            parsed: { base_resp: { status_code: 0 } },
            command: 'mmx',
            argv: args,
          };
        },
        cancelAll() {
          cancelCount += 1;
        },
        cancelByJobId(jobId) {
          cancelByJobIdCalls.push(jobId);
          return jobId === 'job-known';
        },
        resolve() {
          return {
            command: 'node.exe',
            prefix: ['mmx.mjs'],
            node: 'C:\\Program Files\\nodejs\\node.exe',
            entry: 'C:\\Users\\AppData\\Roaming\\npm\\node_modules\\mmx-cli\\dist\\mmx.mjs',
            error: null,
          };
        },
        probeMmxVersion: () => '1.0.16',
        SUPPORTED_MMX: { min: '1.0.16', recommended: '1.0.16' },
        compareSemver: () => 0,
      },
      // R7.2: mock capability service (no real CLI probes in tests).
      '../../src/mmxCapability': {
        getSnapshot: () => ({
          version: '1.0.16',
          topFlags: ['--version', '--help'],
          subcommands: {
            image: { available: true, flags: ['--model', '--dry-run'], models: ['flux-dev'] },
            speech: { available: true, flags: ['--model'], models: [] },
            music: { available: true, flags: [], models: [] },
            video: { available: true, flags: ['--model'], models: [] },
            'sound-effect': { available: true, flags: [], models: [] },
          },
          hasDryRun: true,
          probedAt: Date.now(),
        }),
        invalidate: () => {},
      },
      '../services/VoicesCacheService': {
        async get(apiKey) {
          voiceKeys.push(apiKey);
          return [{ id: apiKey || 'none' }];
        },
      },
    },
  }, async ({ electron, load }) => {
    const sent = [];
    const fakeWindow = { webContents: { send(channel, data) { sent.push({ channel, data }); } } };
    load('main/ipc/registerMmxIpc.js').register({ appRoot: ROOT, getMainWindow: () => fakeWindow });

    const run = electron.handlers['mmx:run'];
    const voices = electron.handlers['mmx:voices'];
    const quota = electron.handlers['mmx:quota'];
    const cancel = electron.handlers['mmx:cancel'];
    const authStatus = electron.handlers['mmx:authStatus'];
    const diagnose = electron.handlers['mmx:diagnose'];

    const missingArgs = await run(null, []);
    assert.equal(missingArgs.ok, false);
    assert.match(missingArgs.stderr, /first arg/i);

    const badSubcommand = await run(null, ['rm-all']);
    assert.equal(badSubcommand.ok, false);
    assert.match(badSubcommand.stderr, /not allowed/i);

    cfg = { api_key: '', region: 'global' };
    const noKey = await run(null, ['image']);
    assert.equal(noKey.ok, false);
    assert.match(noKey.stderr, /No API key configured/i);

    cfg = { api_key: 'sk-mmx', region: 'global' };
    runMode = 'ok';
    const okRun = await run(null, ['image', '--prompt', 'robot']);
    assert.equal(okRun.ok, true);
    // Phase A: the new wire format is { line, jobId, kind } (the
    // legacy plain-string fallback would still satisfy the renderer
    // via preload.js onLog's backwards-compat shim).
    assert.deepEqual(sent, [{
      channel: 'mmx:log',
      data: { line: '[log] image --prompt robot', jobId: null, kind: 'stderr' },
    }]);

    const voiceList = await voices();
    assert.deepEqual(voiceList, [{ id: 'sk-mmx' }]);
    assert.deepEqual(voiceKeys, ['sk-mmx']);

    const quotaOk = await quota();
    assert.deepEqual(quotaOk, { ok: true, parsed: { base_resp: { status_code: 0 } } });

    runMode = 'quota-fail';
    const quotaFail = await quota();
    assert.equal(quotaFail.ok, false);
    assert.match(quotaFail.error, /quota failed/i);

    runMode = 'ok';
    const authOk = await authStatus();
    assert.deepEqual(authOk, {
      ok: true,
      message: 'Authenticated. Quota snapshot loaded.',
      command: 'mmx',
    });

    runMode = 'auth-fail';
    const authFail = await authStatus();
    assert.equal(authFail.ok, false);
    assert.equal(authFail.error, 'auth failed');

    runMode = 'auth-api-error';
    const authApiError = await authStatus();
    assert.equal(authApiError.ok, false);
    assert.equal(authApiError.error, 'bad key');

    assert.deepEqual(cancel(), { ok: true });
    assert.equal(cancelCount, 1);

    // bug-fix H4/Phase1 (_temp4.md): a jobId-scoped cancel must call
    // cancelByJobId, NOT the panic-button cancelAll — it must not kill
    // sibling jobs on other tabs/batch items.
    assert.deepEqual(cancel(null, { jobId: 'job-known' }), { ok: true });
    assert.deepEqual(cancelByJobIdCalls, ['job-known']);
    assert.equal(cancelCount, 1, 'a jobId-scoped cancel must not also fall through to cancelAll');

    const diag = await diagnose();
    assert.equal(diag.platform, process.platform);
    assert.equal(diag.nodePath, 'C:\\Program Files\\nodejs\\node.exe');
    assert.equal(diag.mmxCommand, 'node.exe');
    assert.equal(diag.apiKeyPresent, true);
    assert.equal(diag.region, 'global');
  });
});

// bug-fix S1 (_temp4.md): mmx:run / mmx:run:job used to pass --out /
// --out-dir / --download straight through to the spawned mmx process
// with no allow-list check, unlike every other path-taking IPC handler.
// Uses the REAL src/config.js + PathSecurityService (only src/mmx is
// mocked, so no process is actually spawned) so the allow-list check
// runs for real against a real isolated output directory.
//
// R1.5b.1: the allow-list check is now grant-based. We pre-populate
// `require.cache[PathGrantService]` with a mock whose authorize()
// accepts paths under `outputDir` (the test's allowed root) and
// rejects everything else. The handler now takes a trailing `grantId`
// argument; the test passes 's1-grant' for path-bearing calls and
// omits it for the no-path-flags call.
test('mmx:run / mmx:run:job reject --out / --out-dir / --download paths outside the allowed directories (S1)', async () => {
  const runCalls = [];
  await withIsolatedProject({
    mocks: {
      '../../src/mmx': {
        async runMmx({ args }) {
          runCalls.push(args);
          return { ok: true, code: 0, stdout: '{"ok":true}', stderr: '', parsed: { ok: true }, command: 'mmx', argv: args };
        },
        cancelAll() {},
        resolve() { return { command: 'mmx', prefix: [], node: null, entry: null, error: null }; },
      },
    },
  }, async ({ outputDir, tmp, electron, load }) => {
    load('src/config.js').write({
      api_key: 'sk-s1',
      output_dir: outputDir,
      region: 'global',
      theme: 'dark',
      styles: [],
    });
    // R1.5b.1: pre-populate the PathGrantService cache with a mock
    // that accepts paths under outputDir (any file inside, or the
    // directory itself for --out-dir). The lazy require inside
    // grantAuthorizer runs at handler-call time (see R1.5a.6 fix).
    const pathGrantPath = path.join(ROOT, 'main', 'services', 'PathGrantService.js');
    require.cache[pathGrantPath] = {
      exports: {
        defaultService: {
          authorize: (grantId, spec) => {
            if (!grantId) return { ok: false, error: 'grantId required' };
            if (!spec || typeof spec.path !== 'string') return { ok: false, error: 'path required' };
            // Accept paths under outputDir; reject everything else.
            // The handler's --out-dir check is on the directory
            // itself (outputDir), so a flat equality check covers
            // both "file inside outputDir" and "outputDir itself".
            const real = path.resolve(spec.path);
            const root = path.resolve(outputDir);
            if (real === root || real.startsWith(root + path.sep)) {
              return { ok: true, canonicalPath: real };
            }
            return { ok: false, error: 'path "' + spec.path + '" is outside the grant scope' };
          },
          mintDirectoryGrant: () => ({ ok: true, grantId: 's1-grant', grant: {} }),
          mintFileGrant: () => ({ ok: true, grantId: 's1-grant', grant: {} }),
          revoke: () => ({ ok: true }),
          destroy: () => 0,
        },
      },
    };
    load('main/ipc/registerMmxIpc.js').register({ appRoot: ROOT, getMainWindow: () => null });
    const run = electron.handlers['mmx:run'];
    const runJob = electron.handlers['mmx:run:job'];

    // P4.1 (DB-H-002/008): the IPC now validates every --out artifact after
    // the (mocked) runMmx resolves; pre-create valid PNGs for the ok-paths.
    const _png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(1200, 0)]);
    fs.writeFileSync(path.join(outputDir, 'a.png'), _png);
    fs.writeFileSync(path.join(outputDir, 'b.png'), _png);

    // --- mmx:run -------------------------------------------------------
    const okOut = await run(null, ['image', '--prompt', 'x', '--out', path.join(outputDir, 'a.png')], 's1-grant');
    assert.equal(okOut.ok, true);

    const okOutDir = await run(null, ['image', '--prompt', 'x', '--n', '2', '--out-dir', outputDir], 's1-grant');
    assert.equal(okOutDir.ok, true);

    const noPathFlags = await run(null, ['quota']);
    assert.equal(noPathFlags.ok, true, 'a call with no path flags must be unaffected by the new check');

    const deniedOut = await run(null, ['image', '--prompt', 'x', '--out', path.join(tmp, 'outside', 'a.png')], 's1-grant');
    assert.equal(deniedOut.ok, false);
    assert.match(deniedOut.stderr, /not authorised|outside the allowed directories/i);
    assert.match(deniedOut.stderr, /--out/);

    const deniedOutDir = await run(null, ['image', '--prompt', 'x', '--n', '2', '--out-dir', path.join(tmp, 'outside')], 's1-grant');
    assert.equal(deniedOutDir.ok, false);
    assert.match(deniedOutDir.stderr, /not authorised|outside the allowed directories/i);
    assert.match(deniedOutDir.stderr, /--out-dir/);

    const deniedDownload = await run(null, ['video', '--prompt', 'x', '--download', path.join(tmp, 'outside', 'clip.mp4')], 's1-grant');
    assert.equal(deniedDownload.ok, false);
    assert.match(deniedDownload.stderr, /not authorised|outside the allowed directories/i);

    // A traversal attempt must also be rejected (not just a sibling dir).
    const traversal = await run(null, ['image', '--prompt', 'x', '--out', path.join(outputDir, '..', 'escape.png')], 's1-grant');
    assert.equal(traversal.ok, false);
    assert.match(traversal.stderr, /not authorised|outside the allowed directories/i);

    // --- mmx:run:job -----------------------------------------------------
    const jobOk = await runJob(null, { args: ['image', '--prompt', 'x', '--out', path.join(outputDir, 'b.png')], jobId: 'j1' }, 's1-grant');
    assert.equal(jobOk.ok, true);

    const jobDenied = await runJob(null, { args: ['image', '--prompt', 'x', '--out', path.join(tmp, 'outside', 'b.png')], jobId: 'j2' }, 's1-grant');
    assert.equal(jobDenied.ok, false);
    assert.match(jobDenied.stderr, /not authorised|outside the allowed directories/i);

    // Exactly the allowed calls reached the spawn layer — none of the
    // denied ones did.
    assert.equal(runCalls.length, 4);
  });
});
