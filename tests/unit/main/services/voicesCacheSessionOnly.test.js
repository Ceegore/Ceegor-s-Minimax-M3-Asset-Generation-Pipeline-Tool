// tests/unit/main/services/voicesCacheSessionOnly.test.js
// 360°-sweep regression: the voices cache must honor session-only mode so the
// API key is never written to ~/.mmx/config.json when the user opted out
// (same class as H7-022).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const MMX_PATH = path.join(ROOT, 'src', 'mmx.js');
const SVC_PATH = path.join(ROOT, 'main', 'services', 'VoicesCacheService.js');

function loadFresh(t, runMmxImpl) {
  // Stub src/mmx.js so VoicesCacheService gets a controllable runMmx.
  require.cache[require.resolve(MMX_PATH)] = {
    exports: { runMmx: runMmxImpl, cancelAll() {}, cancelOne() {}, cancelByJobId() {}, getActiveProcs() {} },
  };
  delete require.cache[require.resolve(SVC_PATH)];
  return require(SVC_PATH);
}

test('VoicesCacheService.get forwards sessionOnly:true to runMmx (360° sweep / H7-022)', async (t) => {
  let capturedSessionOnly = '__not_seen__';
  const svc = loadFresh(t, async (opts) => {
    capturedSessionOnly = opts && opts.sessionOnly;
    return { ok: false, parsed: null };
  });
  svc.reset();
  await svc.get('sk-test', { sessionOnly: true });
  assert.equal(capturedSessionOnly, true, 'sessionOnly must be forwarded to runMmx');
});

test('VoicesCacheService.get defaults sessionOnly to false when omitted', async (t) => {
  let captured = '__not_seen__';
  const svc = loadFresh(t, async (opts) => {
    captured = opts && opts.sessionOnly;
    return { ok: false, parsed: null };
  });
  svc.reset();
  await svc.get('sk-test');
  assert.equal(captured, false, 'omitting opts must NOT default to session-only (must be falsy, not true)');
});
