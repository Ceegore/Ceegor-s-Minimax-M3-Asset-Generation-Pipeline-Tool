// main/ipc/registerM3Ipc.js
// IPC handler for MiniMax M3 text generation (OpenAI-compatible chat completions).
// The API key is read from config in main — the renderer never sees it.
'use strict';
const { ipcMain } = require('electron');
const cfg = require('../../src/config');
const { chat } = require('../../src/minimaxText');
// P1-A (360° Audit H-001): secure IPC wrapper.
const { secureHandle } = require('./secureHandle');

function register(deps) {
  const getMainWindow = (deps && typeof deps.getMainWindow === 'function') ? deps.getMainWindow : () => null;
  // m3:chat — send a chat completion request to MiniMax M3.
  // Payload: { messages, jsonMode?, temperature?, maxTokens?, model? }
  // The API key and region are read from config (never from the renderer).
  // Redaction: never log the payload with the key; the service takes the key
  // from config, not the renderer, so the renderer never sees it.
  secureHandle('m3:chat', { getMainWindow }, async (_e, payload) => {
    try {
      const c = cfg.read();
      if (!c.api_key) return { ok: false, error: 'No API key configured.' };
      // SECURITY: explicitly pick only the allowed fields from the renderer
      // payload. A spread (..payload) AFTER apiKey/region would let a
      // compromised renderer override them and redirect traffic (including
      // prompts) to an attacker-controlled endpoint.
      const p = payload || {};
      // MED-006: enforce a 120s timeout so a hung M3 endpoint cannot block
      // the pipeline indefinitely. The renderer's cancel button can also
      // abort via the AbortSignal.
      const timeout = AbortSignal.timeout ? AbortSignal.timeout(120000) : undefined;
      const r = await chat({
        apiKey: c.api_key,
        region: c.region,
        messages: Array.isArray(p.messages) ? p.messages : [],
        jsonMode: typeof p.jsonMode === 'boolean' ? p.jsonMode : undefined,
        temperature: typeof p.temperature === 'number' ? p.temperature : undefined,
        maxTokens: typeof p.maxTokens === 'number' ? p.maxTokens : undefined,
        model: typeof p.model === 'string' ? p.model : undefined,
        signal: timeout,
      });
      return { ok: true, content: r.content, usage: r.usage };
    } catch (e) {
      if (e && e.name === 'TimeoutError') return { ok: false, error: 'M3 request timed out (120s). Try a shorter document or retry.' };
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
}

module.exports = { register };
