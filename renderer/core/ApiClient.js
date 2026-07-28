// renderer/core/ApiClient.js
// Wrapper um window.api (preload-Bridge). Normalisiert Exceptions zu
// { ok: false, error: '...' } und ergänzt Logging.

function safeCall(methodName, ...args) {
  if (typeof window.api === 'undefined' || typeof window.api[methodName] !== 'function') {
    const err = `api.${methodName} is not available (preload bridge missing?)`;
    console.error('[ApiClient]', err);
    return Promise.resolve({ ok: false, error: err });
  }
  return Promise.resolve()
    .then(() => window.api[methodName](...args))
    .catch((e) => {
      const msg = String((e && e.message) || e);
      console.error('[ApiClient]', methodName, 'failed:', msg);
      return { ok: false, error: msg };
    });
}

window.ApiClient = { call: safeCall };
