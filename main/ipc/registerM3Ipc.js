// main/ipc/registerM3Ipc.js
// IPC handler for MiniMax M3 text generation (OpenAI-compatible chat completions).
// The API key is read from config in main — the renderer never sees it.
'use strict';
const { ipcMain } = require('electron');
const cfg = require('../../src/config');
const { chat } = require('../../src/minimaxText');
// P1-A (360° Audit H-001): secure IPC wrapper.
const { secureHandle } = require('./secureHandle');
// H-006 (_5 audit): use the same central credential resolution as MMX.
// A session-only key (not persisted) must also work for M3.
const { getSessionCredential } = require('../services/SessionCredentialStore');

function register(deps) {
  const getMainWindow = (deps && typeof deps.getMainWindow === 'function') ? deps.getMainWindow : () => null;
  // H-005 (_5 audit): per-run AbortController map so the renderer can cancel
  // an in-flight M3 request via the m3:cancel channel.
  const activeRuns = new Map();

  // m3:chat — send a chat completion request to MiniMax M3.
  // Payload: { messages, jsonMode?, temperature?, maxTokens?, model?, runId? }
  // The API key and region are read from config (never from the renderer).
  // Redaction: never log the payload with the key; the service takes the key
  // from config, not the renderer, so the renderer never sees it.
  secureHandle('m3:chat', { getMainWindow }, async (_e, payload) => {
    const p = payload || {};
    const runId = typeof p.runId === 'string' ? p.runId : null;
    const ctrl = new AbortController();
    if (runId) activeRuns.set(runId, ctrl);
    try {
      const c = cfg.read();
      // H-006 (_5 audit): resolve the API key from the same sources as MMX.
      // Priority: persisted config > session-only credential.
      const apiKey = c.api_key || getSessionCredential();
      if (!apiKey) return { ok: false, error: 'No API key configured.' };
      // SECURITY: explicitly pick only the allowed fields from the renderer
      // payload. A spread (..payload) AFTER apiKey/region would let a
      // compromised renderer override them and redirect traffic (including
      // prompts) to an attacker-controlled endpoint.
      // MED-006: enforce a 120s timeout so a hung M3 endpoint cannot block
      // the pipeline indefinitely. H-005: combine with per-run cancel signal.
      const signals = [ctrl.signal];
      if (AbortSignal.timeout) signals.push(AbortSignal.timeout(120000));
      const signal = AbortSignal.any ? AbortSignal.any(signals) : signals[0];
      const r = await chat({
        apiKey,
        region: c.region,
        messages: Array.isArray(p.messages) ? p.messages : [],
        jsonMode: typeof p.jsonMode === 'boolean' ? p.jsonMode : undefined,
        temperature: typeof p.temperature === 'number' ? p.temperature : undefined,
        maxTokens: typeof p.maxTokens === 'number' ? p.maxTokens : undefined,
        model: typeof p.model === 'string' ? p.model : undefined,
        signal,
      });
      return { ok: true, content: r.content, usage: r.usage };
    } catch (e) {
      if (ctrl.signal.aborted) return { ok: false, error: 'Cancelled.', cancelled: true };
      if (e && e.name === 'TimeoutError') return { ok: false, error: 'M3 request timed out (120s). Try a shorter document or retry.' };
      return { ok: false, error: String((e && e.message) || e) };
    } finally {
      if (runId) activeRuns.delete(runId);
    }
  });

  // H-005 (_5 audit): cancel an in-flight M3 request by runId.
  secureHandle('m3:cancel', { getMainWindow }, (_e, runId) => {
    if (typeof runId !== 'string' || !runId) return { ok: false, error: 'runId required' };
    const ctrl = activeRuns.get(runId);
    if (ctrl) { ctrl.abort(); return { ok: true }; }
    return { ok: true, noop: true };
  });
}

module.exports = { register };
