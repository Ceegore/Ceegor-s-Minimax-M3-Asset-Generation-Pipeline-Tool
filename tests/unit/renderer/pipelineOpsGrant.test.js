// ============================================================================
// BGR follow-up (BUG-C, SEVERE) — END-TO-END pipeline grant wiring test.
//
// The 360° hunt found that pipelineOps minted its transform grant on
// pathDirname(src) — the PREVIOUS column's folder — while the output is
// written into THIS column's folder (a sibling directory). The handler then
// rejected the write ("directory grant covers only strict descendants"),
// so every pipeline upscale / removebg / resize / optimize failed.
//
// grantHelper.test.js GH.L proves ensureTransform() mints the RIGHT grant in
// isolation. This file proves the REAL op flow wires it through: it drives
// window.PipelineOps.run(item) for the resize + optimize columns with a stub
// IPC layer backed by the REAL PathGrantService, captures the grantId that
// actually reaches the resizeImage / optimizeImage IPC, and asserts that
// grant authorises BOTH the handler's ('read', src) and ('write', dst)
// checks — the exact pair grantAuthorizer.authorizePath performs.
//
// Against the pre-fix code (grant minted on pathDirname(src)) the
// "write dst" assertion FAILS, so this is a true regression test.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const { PathGrantService } = require(path.join(ROOT, 'main', 'services', 'PathGrantService'));
const grantCachePath = path.join(ROOT, 'renderer', 'services', 'grantCache.js');
const grantHelperPath = path.join(ROOT, 'renderer', 'utils', 'grantHelper.js');
const pipelineOpsPath = path.join(ROOT, 'renderer', 'pipeline', 'pipelineOps.js');

const VALID_OPS = new Set(['read', 'write', 'delete', 'mkdir', 'rename', 'copy', 'move']);

// mintGrant stub mirroring main/ipc/registerPathGrantIpc.js 'pathGrant:mint'
// (same shape as grantHelper.test.js — kind / capabilities / coversRoot).
function makeMintGrant(svc) {
  return async function mintGrant(p, operation, opts) {
    if (typeof p !== 'string' || !p.trim()) return { ok: false, error: 'Path is required.' };
    if (!VALID_OPS.has(operation)) return { ok: false, error: 'bad operation: ' + operation };
    let kind = 'file';
    let capabilities = [operation];
    let coversRoot = false;
    if (opts && Object.getPrototypeOf(opts) === Object.prototype) {
      if (opts.kind != null) kind = opts.kind;
      if (opts.capabilities != null) capabilities = opts.capabilities.slice();
      if (opts.coversRoot != null) coversRoot = opts.coversRoot;
    }
    const spec = {
      origin: 'renderer-mint', purpose: operation + ' on ' + p,
      path: p, capabilities, singleUse: false,
    };
    if (kind === 'directory') {
      spec.coversRoot = coversRoot;
      return svc.mintDirectoryGrant(spec);
    }
    return svc.mintFileGrant(spec);
  };
}

// Build a fresh service + window + module graph, then drive ONE pipeline op
// end-to-end and return what the transform IPC actually received.
async function runOp(column, apiMethod, settingsStub) {
  let idc = 0;
  const svc = new PathGrantService({
    now: () => 1700000000000,
    idFactory: () => 'g-' + (++idc),
    realpath: (p) => p,
  });

  const captured = { calls: [] };

  global.window = global; // renderer scripts hang off window; alias to global
  global.window.api = {
    mintGrant: makeMintGrant(svc),
    revokeGrant: async (id) => svc.revoke(id),
    pathDirname: (p) => path.posix.dirname(p),
    jobCancel: async () => ({ ok: true }),
    fbEnsureDir: async () => ({ ok: true }),
  };
  // The transform IPC under test: capture src / dst / grantId, succeed.
  global.window.api[apiMethod] = async (src, opts, grantId) => {
    captured.calls.push({ src, dst: opts.outputPath, grantId });
    return { ok: true, outputPath: opts.outputPath };
  };

  // Board + item shaped like the real pipeline (src in the PREVIOUS column's
  // folder, dst written into THIS column's folder — the sibling-dir shape
  // that broke under the pathDirname(src) grant).
  global.window.state = { pipeline: { image: { workspace: '/ws', columnFolders: {} } } };

  // Bare globals pipelineOps reads at call time.
  global.PipelineBoard = { updateCard() {}, save() {}, render() {}, logEvent() {}, toast() {} };
  global.PipelineModel = {
    resolveSettings: () => Object.assign({}, settingsStub),
    nextColumn: () => 'done',
    outPath: (ws, id, name, col, opts) => ws + '/' + col + '/' + name + '.' + ((opts && opts.ext) || 'png'),
    safeBaseName: (n) => String(n || 'image'),
  };

  for (const p of [grantCachePath, grantHelperPath, pipelineOpsPath]) {
    try { delete require.cache[require.resolve(p)]; } catch (_) {}
  }
  require(grantCachePath);   // sets window.GrantCache
  require(grantHelperPath);  // sets window.GrantHelper
  require(pipelineOpsPath);  // sets window.PipelineOps

  const src = '/ws/prev/img.png'; // previous column's output (sibling folder)
  const item = {
    id: 'it1', name: 'img', column, status: 'idle',
    files: { [column]: src }, settings: {}, history: [],
  };

  await global.window.PipelineOps.run(item);

  return { svc, captured, item, src };
}

test.afterEach(() => {
  delete global.window;
  delete global.PipelineBoard;
  delete global.PipelineModel;
  delete global.state;
});

// ---------------------------------------------------------------------------
// resize column: run() -> doResize -> ensureTransform -> resizeImage(grantId)
// ---------------------------------------------------------------------------
test('PIPE.resize: the grantId reaching the resize IPC authorises BOTH read-src and write-dst (sibling column folders)', async () => {
  const { svc, captured, item, src } = await runOp('resize', 'resizeImage', { width: 100, height: 100, sharpen: true });

  assert.equal(captured.calls.length, 1, 'resize IPC must be invoked exactly once');
  const call = captured.calls[0];
  assert.equal(call.src, src, 'IPC receives the previous column output as src');
  assert.equal(call.dst, '/ws/resize/img.png', 'IPC writes into THIS column folder (a sibling of src dir)');
  assert.equal(typeof call.grantId, 'string', 'a grantId must reach the IPC');

  // The exact authorisation pair the handler performs via
  // grantAuthorizer.authorizePath(grantId, op, p) ->
  // pathGrantService.authorize(grantId, {operation, path}).
  assert.equal(svc.authorize(call.grantId, { operation: 'read', path: call.src }).ok, true,
    'handler read-on-src must authorise');
  assert.equal(svc.authorize(call.grantId, { operation: 'write', path: call.dst }).ok, true,
    'handler write-on-dst must authorise (FAILED pre-fix: grant was on pathDirname(src))');

  // The op advanced the card.
  assert.equal(item.column, 'done', 'item advanced to the next column');
  assert.equal(item.files.done, '/ws/resize/img.png', 'output recorded on the item');
});

// ---------------------------------------------------------------------------
// optimize column: run() -> doOptimize -> ensureTransform -> optimizeImage(grantId)
// ---------------------------------------------------------------------------
test('PIPE.optimize: the grantId reaching the optimize IPC authorises BOTH read-src and write-dst (sibling column folders)', async () => {
  const { svc, captured, item } = await runOp('optimize', 'optimizeImage', { quality: 80, format: 'keep', stripMetadata: true });

  assert.equal(captured.calls.length, 1, 'optimize IPC must be invoked exactly once');
  const call = captured.calls[0];
  assert.equal(call.dst, '/ws/optimize/img.png', 'IPC writes into THIS column folder');
  assert.equal(typeof call.grantId, 'string', 'a grantId must reach the IPC');

  assert.equal(svc.authorize(call.grantId, { operation: 'read', path: call.src }).ok, true,
    'handler read-on-src must authorise');
  assert.equal(svc.authorize(call.grantId, { operation: 'write', path: call.dst }).ok, true,
    'handler write-on-dst must authorise (FAILED pre-fix)');

  assert.equal(item.column, 'done', 'item advanced to the next column');
});
