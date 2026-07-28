// src/minimaxText.js — OpenAI-compatible chat completions for MiniMax text (M3).
// The M3 model is OpenAI-compatible, so the call path is a standard
// chat-completions POST. No new heavy dependency required — Electron main
// has global fetch (Node 18+).
'use strict';

const REGION_HOSTS = {
  global: 'https://api.minimax.io/v1',
  cn: 'https://api.minimaxi.com/v1', // TODO: confirm the cn host against MiniMax docs
};

/**
 * Send a chat completion request to MiniMax M3.
 * @param {Object} opts
 * @param {string} opts.apiKey - The MiniMax API key (from config, never from renderer).
 * @param {string} [opts.region='global'] - 'global' or 'cn'.
 * @param {string} [opts.model='MiniMax-M3'] - The model id.
 * @param {Array<{role: string, content: string}>} opts.messages - Chat messages.
 * @param {boolean} [opts.jsonMode=false] - Request JSON output mode.
 * @param {number} [opts.temperature=0.2] - Sampling temperature.
 * @param {number} [opts.maxTokens=4096] - Max tokens in response.
 * @param {AbortSignal} [opts.signal] - AbortController signal for cancellation.
 * @returns {Promise<{content: string, usage: Object|null}>}
 */
async function chat({ apiKey, region, model = 'MiniMax-M3', messages,
                      jsonMode = false, temperature = 0.2, maxTokens = 4096, signal }) {
  const base = REGION_HOSTS[region] || REGION_HOSTS.global;
  const body = { model, messages, temperature, max_tokens: maxTokens };
  if (jsonMode) body.response_format = { type: 'json_object' };
  const res = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    // Never include the API key in error messages.
    throw new Error('M3 HTTP ' + res.status + ': ' + txt.slice(0, 500));
  }
  const json = await res.json();
  const msg = json && json.choices && json.choices[0] && json.choices[0].message;
  return { content: (msg && msg.content) || '', usage: json.usage || null };
}

module.exports = { chat, REGION_HOSTS };
