// renderer/utils/ipcResult.js
// QA-006 fix: shared helper for checking IPC result envelopes.
// Many IPC handlers resolve with {ok:false, error} instead of rejecting
// the promise. Callers that only catch rejections miss these failures
// and show success toasts for data that was never saved.

(function () {
  'use strict';

  /**
   * Check an IPC result envelope. If it indicates failure, show an error
   * toast and return false. Otherwise return true.
   * @param {{ok?:boolean, error?:string}|null|undefined} result
   * @param {string} context - human-readable operation name for the toast
   * @returns {boolean} true if the result is ok
   */
  function assertIpcOk(result, context) {
    if (!result || !result.ok) {
      const msg = (result && result.error) || 'Unknown error';
      if (typeof toast === 'function') toast((context || 'Operation') + ': ' + msg, 'err', 6000);
      return false;
    }
    // KGO6-006: surface warnings (e.g. privacy-switch clear failure) as a
    // visible warn toast. The operation succeeded (ok:true) but the user
    // should know about a partial failure.
    if (result.warnings && result.warnings.length && typeof toast === 'function') {
      for (const w of result.warnings) toast(w, 'warn', 8000);
    }
    return true;
  }

  /**
   * KGO7-003: adopt a `config:set` response into `state.config` WITHOUT
   * losing the session-only API key.
   *
   * When the "Don't save API key" privacy switch is on, the renderer
   * deliberately sends `api_key: ''` and the main process persists an
   * empty key — so the envelope's `config` (read back from disk) always
   * has an empty `api_key`. Assigning it verbatim over `state.config`
   * therefore DESTROYS the key the current session is using, and every
   * subsequent generation fails with "No API key configured".
   *
   * `section04_Settings.js` had a bespoke guard for this; the styles pane
   * and the batch-import style helper did not. This helper is the single
   * place that rule lives, so no future call site can forget it.
   *
   * @param {{api_key?:string}|null|undefined} saved  the envelope's `config`
   * @returns {object} the config to assign to state.config
   */
  function adoptConfig(saved) {
    const state = window.state;
    if (!saved || typeof saved !== 'object') return (state && state.config) || saved;
    if (!state) return saved;
    // SEC-001: config:set now returns a public DTO (no raw api_key).
    // Preserve hasApiKey/apiKeyLast4 from the response; the session
    // key lives exclusively in the main process.
    return saved;
  }

  /**
   * Toast every entry of an envelope's `warnings[]` exactly once.
   * De-duplicated per message so a batch loop over 40 files does not
   * produce 40 identical toasts.
   * @param {{warnings?:string[]}|null|undefined} result
   */
  const _seenWarnings = new Set();
  function reportIpcWarnings(result) {
    if (!result || !Array.isArray(result.warnings) || !result.warnings.length) return;
    if (typeof toast !== 'function') return;
    for (const w of result.warnings) {
      const key = String(w);
      if (_seenWarnings.has(key)) continue;
      _seenWarnings.add(key);
      // Let the same warning fire again after 30 s (a later, unrelated run).
      setTimeout(() => _seenWarnings.delete(key), 30000);
      toast(key, 'warn', 6000);
    }
  }

  // KGO7-020: `image:resize` reports a dimension clamp (e.g. 99999 ->
  // 65500) in `warnings[]`, and only ONE of its six renderer call sites
  // read it — the other five silently produced a different size than the
  // user asked for.
  //
  // NOTE for future maintainers: monkey-patching `window.api.resizeImage`
  // to do this automatically does NOT work and was tried. `window.api` is
  // a contextBridge object, so it is frozen — the assignment fails
  // silently and the wrapper never installs (measured:
  // `window.api.resizeImage.__autoWarnWrapped === false`). Every call
  // site must therefore report explicitly; the unit test
  // `KGO7-020: the resize clamp notice reaches every call site` enforces
  // that none of the six is forgotten.

  window.assertIpcOk = assertIpcOk;
  window.adoptConfig = adoptConfig;
  window.reportIpcWarnings = reportIpcWarnings;
})();
