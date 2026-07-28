// src/providers/replicate.js
// ============================================================================
// Replicate adapter — universal submit → poll.
// Covers: music (the gap), plus image/video/speech as a universal fallback.
// Model format: "owner/name" (latest) or "owner/name:version".
// ============================================================================
'use strict';

const HOST = 'https://api.replicate.com/v1';

// Max time (ms) to poll a prediction before giving up.
const MAX_WAIT_MS = 10 * 60 * 1000; // 10 minutes

function _ext(u) {
  const m = /\.(\w{2,4})(?:\?|#|$)/.exec(String(u || ''));
  return m ? m[1].toLowerCase() : 'bin';
}

// Core submit-poll loop.
// model: "owner/name" (latest) or "owner/name:version". input: model-specific object.
async function run({ apiKey, model, input, signal, onProgress }) {
  const versioned = model.includes(':');
  const url = versioned ? HOST + '/predictions' : HOST + '/models/' + model + '/predictions';
  const body = versioned ? { version: model.split(':')[1], input } : { input };
  const sub = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + apiKey,
      Prefer: 'wait',
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!sub.ok) throw new Error('replicate submit HTTP ' + sub.status + ': ' + (await sub.text().catch(() => '')).slice(0, 400));
  let pred = await sub.json();

  const start = Date.now();
  while (!['succeeded', 'failed', 'canceled'].includes(pred.status)) {
    if (signal && signal.aborted) throw new Error('cancelled');
    if (Date.now() - start > MAX_WAIT_MS) throw new Error('replicate poll timed out after 10 min');
    if (!pred.urls || !pred.urls.get) throw new Error('replicate: no poll URL in prediction response');
    await new Promise((r) => setTimeout(r, 2000));
    const g = await fetch(pred.urls.get, {
      headers: { Authorization: 'Bearer ' + apiKey },
      signal,
    });
    if (!g.ok) throw new Error('replicate poll HTTP ' + g.status);
    pred = await g.json();
    if (onProgress) onProgress({ stage: pred.status, pct: null });
  }
  if (pred.status !== 'succeeded') throw new Error('replicate ' + pred.status + ': ' + (pred.error || ''));

  const out = pred.output;
  const urls = Array.isArray(out) ? out
    : (typeof out === 'string' ? [out]
    : (out && (out.url || out.audio) ? [out.url || out.audio] : []));
  return urls.map((u) => ({ url: u, b64: null, ext: _ext(u), contentType: null }));
}

// Thin per-modality wrappers map (prompt/params) → Replicate `input`.
module.exports = {
  supports: new Set(['music', 'image', 'video', 'speech']),
  image: (a) => run(Object.assign({}, a, { input: Object.assign({ prompt: a.prompt }, a.params) })),
  images: (a) => run(Object.assign({}, a, { input: Object.assign({ prompt: a.prompt }, a.params) })),
  music: (a) => run(Object.assign({}, a, { input: Object.assign({ prompt: a.prompt }, a.params) })),
  video: (a) => run(Object.assign({}, a, { input: Object.assign({ prompt: a.prompt }, a.params) })),
  speech: (a) => run(Object.assign({}, a, { input: Object.assign({ text: a.input }, a.params) })),
  run,
};
