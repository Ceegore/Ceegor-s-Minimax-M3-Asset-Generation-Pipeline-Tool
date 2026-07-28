// tests/unit/renderer/tabs/batchGrant.test.js
// B.3: regression test for the pure-batch grant gap fix.
// In a pure-batch flow (no prior interactive Generate), state._fbGrantId is
// undefined. The batch must mint its own grant and forward it through
// batchDirectRunner → mmxRunJob + fbEnsureDir. These tests verify the
// forwarding works even when state._fbGrantId is undefined.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');

global.window = global;
global.toast = () => {};
require(path.join(ROOT, 'renderer', 'tabs', 'argvBuilders.js'));
require(path.join(ROOT, 'renderer', 'tabs', 'batchDirectRunner.js'));
const { runVariantDirect, makeCtx, ensureRunSubdir } = global.window.BatchDirectRunner;

function resetState(overrides) {
  global.window.state = Object.assign({
    fbDir: 'C:\\out',
    generating: null,
    // Deliberately NO _fbGrantId — simulates the pure-batch case.
  }, overrides || {});
}

test('B.3: makeCtx picks up overrides.grantId when state._fbGrantId is undefined', () => {
  resetState(); // no _fbGrantId
  const ctx = makeCtx({ grantId: 'batch-grant-123', outputDir: 'C:\\out' });
  assert.equal(ctx.grantId, 'batch-grant-123');
});

test('B.3: makeCtx falls back to state._fbGrantId when no override', () => {
  resetState({ _fbGrantId: 'state-grant-456' });
  const ctx = makeCtx({ outputDir: 'C:\\out' });
  assert.equal(ctx.grantId, 'state-grant-456');
});

test('B.3: makeCtx returns null grantId when neither override nor state has one', () => {
  resetState(); // no _fbGrantId
  const ctx = makeCtx({ outputDir: 'C:\\out' });
  assert.equal(ctx.grantId, null);
});

test('B.3: runVariantDirect forwards ctx.grantId to mmxRunJob (pure-batch, no JobRunner)', async () => {
  resetState(); // no _fbGrantId — the pure-batch case
  let capturedGrantId = 'NOT_CALLED';
  global.window.api = {
    mmxRunJob: async (_payload, grantId) => { capturedGrantId = grantId; return { ok: true, code: 0 }; },
  };
  // No JobRunner → takes the plain-call path (line ~194 in batchDirectRunner).
  delete global.window.JobRunner;
  const r = await runVariantDirect('image', 'a red circle', { grantId: 'batch-grant-abc' });
  assert.equal(r.ok, true);
  assert.equal(capturedGrantId, 'batch-grant-abc',
    'mmxRunJob must receive the batch-owned grantId even when state._fbGrantId is undefined');
});

test('B.3: runVariantDirect forwards ctx.grantId via JobRunner path', async () => {
  resetState(); // no _fbGrantId
  let capturedGrantId = 'NOT_CALLED';
  global.window.api = {
    mmxRunJob: async (_payload, grantId) => { capturedGrantId = grantId; return { ok: true, code: 0 }; },
  };
  // Minimal fake JobRunner that defers runFn (like the real one) so ctrl is assigned.
  global.window.JobRunner = {
    run({ runFn }) {
      const ctrl = { jobId: 'job-1', done: null };
      ctrl.done = Promise.resolve().then(() => runFn({ signal: { aborted: false } })).then(() => {});
      return ctrl;
    },
    isTabRunning() { return false; },
  };
  const r = await runVariantDirect('image', 'a blue square', { grantId: 'batch-grant-xyz' });
  assert.equal(r.ok, true);
  assert.equal(capturedGrantId, 'batch-grant-xyz',
    'mmxRunJob (JobRunner path) must receive the batch-owned grantId');
  delete global.window.JobRunner;
});

test('B.3: ensureRunSubdir forwards the explicit grantId param', async () => {
  resetState(); // no _fbGrantId
  let capturedGrantId = 'NOT_CALLED';
  global.window.api = {
    fbEnsureDir: async (_dir, grantId) => { capturedGrantId = grantId; return { ok: true, path: _dir }; },
  };
  const r = await ensureRunSubdir('C:\\out\\run_123', 'explicit-grant-789');
  assert.equal(r.ok, true);
  assert.equal(capturedGrantId, 'explicit-grant-789',
    'fbEnsureDir must receive the explicit grantId param');
});

test('B.3: ensureRunSubdir falls back to state._fbGrantId when no param', async () => {
  resetState({ _fbGrantId: 'fallback-grant-000' });
  let capturedGrantId = 'NOT_CALLED';
  global.window.api = {
    fbEnsureDir: async (_dir, grantId) => { capturedGrantId = grantId; return { ok: true, path: _dir }; },
  };
  const r = await ensureRunSubdir('C:\\out\\run_456');
  assert.equal(r.ok, true);
  assert.equal(capturedGrantId, 'fallback-grant-000',
    'fbEnsureDir must fall back to state._fbGrantId when no explicit param');
});
