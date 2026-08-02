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
    // SEC-007: only send Authorization to the canonical Replicate API origin.
    // A malicious prediction response could set urls.get to an attacker-
    // controlled host, leaking the API key.
    let pollUrl;
    try { pollUrl = new URL(pred.urls.get); } catch (_) { throw new Error('replicate: invalid poll URL'); }
    if (pollUrl.origin !== 'https://api.replicate.com') {
      throw new Error('replicate: poll URL origin mismatch (expected api.replicate.com, got ' + pollUrl.origin + ')');
    }
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

  // FUNC-024: recursive output normalization for video/image/files objects.
  const out = pred.output;
  const urls = _normalizeOutput(out);
  // H-014 (_5 audit): Replicate CDN output URLs are always unsigned/public.
  // Explicitly mark authPolicy 'none' so the download layer never attaches
  // Authorization to a non-API origin.
  return urls.map((u) => ({ url: u, b64: null, ext: _ext(u), contentType: null, authPolicy: 'none', trustedOrigins: [] }));
}

/**
 * FUNC-024: Recursively normalize Replicate output into a flat URL list.
 * Handles: arrays, strings, {url}, {audio}, {video}, {image}, nested maps.
 * @param {*} out
 * @returns {string[]}
 */
function _normalizeOutput(out) {
  if (!out) return [];
  if (typeof out === 'string') return [out];
  if (Array.isArray(out)) return out.flatMap(_normalizeOutput);
  if (typeof out === 'object') {
    const results = [];
    // Known URL-bearing keys in Replicate FileOutput objects
    for (const key of ['url', 'audio', 'video', 'image', 'file', 'output']) {
      if (out[key]) results.push(..._normalizeOutput(out[key]));
    }
    // If none of the known keys matched, try all string values
    if (results.length === 0) {
      for (const v of Object.values(out)) {
        if (typeof v === 'string' && (v.startsWith('http://') || v.startsWith('https://'))) {
          results.push(v);
        }
      }
    }
    return results;
  }
  return [];
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
