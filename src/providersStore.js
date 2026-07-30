// src/providersStore.js
// ============================================================================
// Config store for the "Other APIs" tab (non-MiniMax providers).
// Lives in a SEPARATE providers.json next to config.txt — the existing
// config.txt parser (src/config.js) is never touched.
//
// Shape:
//   { providers: [{id, label, kind, baseUrl, apiKey}],
//     selections: { image: {providerId, model}, speech: {...}, ... } }
// ============================================================================
'use strict';
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { configDir } = require('./config');   // reuse the SAME dir resolver (call-only)

function file() { return path.join(configDir(), 'providers.json'); }

function _default() {
  return {
    providers: [
      { id: 'openrouter',    label: 'OpenRouter',             kind: 'openrouter',    baseUrl: 'https://openrouter.ai/api/v1', apiKey: '' },
      { id: 'replicate',     label: 'Replicate',              kind: 'replicate',     baseUrl: '',                              apiKey: '' },
      { id: 'custom-openai', label: 'Custom (OpenAI-compat)', kind: 'custom-openai', baseUrl: '',                              apiKey: '' },
    ],
    selections: {
      image:  { providerId: 'openrouter', model: '' },
      speech: { providerId: 'openrouter', model: '', voice: 'alloy', format: 'mp3' },
      music:  { providerId: 'replicate',  model: '' },
      video:  { providerId: 'openrouter', model: '' },
    },
  };
}

function read() {
  try { return JSON.parse(fs.readFileSync(file(), 'utf8')); }
  catch (_) { return _default(); }
}

function write(d) {
  // SEC-002: merge API keys from existing config when the incoming
  // payload omits them (renderer sends partial updates without raw keys).
  const existing = read();
  if (d && Array.isArray(d.providers) && Array.isArray(existing.providers)) {
    for (const p of d.providers) {
      if (!p.apiKey && p.id) {
        const prev = existing.providers.find((x) => x.id === p.id);
        if (prev && prev.apiKey) p.apiKey = prev.apiKey;
      }
    }
  }
  const p = file();
  const tmp = p + '.tmp-' + randomUUID();
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
  fs.renameSync(tmp, p);
}

function provider(id) {
  const d = read();
  const p = (d.providers || []).find((x) => x.id === id);
  if (!p) throw new Error('unknown provider ' + id);
  return p;
}

module.exports = { read, write, provider, file, _default };
