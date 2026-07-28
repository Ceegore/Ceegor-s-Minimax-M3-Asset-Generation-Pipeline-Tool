// src/providers/openaiCompatible.js
// ============================================================================
// OpenAI-compatible / OpenRouter adapter.
// Covers: image (/images/generations), speech (/audio/speech),
//         video (OpenRouter /videos — async submit → poll).
// One base URL + key. OpenRouter recommended (covers 3 of 4 modalities).
// ============================================================================
'use strict';

function _base(u) { return String(u || '').replace(/\/+$/, ''); }

// Max time (ms) to poll an async video job before giving up.
const VIDEO_MAX_WAIT_MS = 10 * 60 * 1000; // 10 minutes

async function listModels({ baseUrl, apiKey, signal }) {
  const res = await fetch(_base(baseUrl) + '/models', {
    headers: { Authorization: 'Bearer ' + apiKey },
    signal,
  });
  if (!res.ok) throw new Error('models HTTP ' + res.status);
  const j = await res.json();
  return (j.data || []).map((m) => m.id).filter(Boolean);
}

async function images({ baseUrl, apiKey, model, prompt, params, signal }) {
  const body = Object.assign({ model, prompt, n: 1, response_format: 'b64_json' }, params || {});
  const res = await fetch(_base(baseUrl) + '/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error('images HTTP ' + res.status + ': ' + (await res.text().catch(() => '')).slice(0, 400));
  const j = await res.json();
  return (j.data || []).map((d) => ({
    b64: d.b64_json || null,
    url: d.url || null,
    ext: 'png',
    contentType: 'image/png',
  }));
}

async function speech({ baseUrl, apiKey, model, input, voice, format, params, signal }) {
  const fmt = format || 'mp3';
  const body = Object.assign({ model, input, voice: voice || 'alloy', response_format: fmt }, params || {});
  // QA-015 fix: derive the effective format AFTER merging params (which may
  // override response_format). The returned ext must match the actual format
  // sent to the API, not the UI selection that params may have overridden.
  const effectiveFmt = body.response_format || fmt;
  const res = await fetch(_base(baseUrl) + '/audio/speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error('speech HTTP ' + res.status + ': ' + (await res.text().catch(() => '')).slice(0, 400));
  const buf = Buffer.from(await res.arrayBuffer());
  return [{ b64: buf.toString('base64'), url: null, ext: effectiveFmt, contentType: 'audio/' + effectiveFmt }];
}

// OpenRouter async video: submit → poll. Field names may differ per provider —
// the poll is written defensively (multiple fallbacks).
async function video({ baseUrl, apiKey, model, prompt, params, signal, onProgress }) {
  const sub = await fetch(_base(baseUrl) + '/videos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
    body: JSON.stringify(Object.assign({ model, prompt }, params || {})),
    signal,
  });
  if (!sub.ok) throw new Error('video submit HTTP ' + sub.status + ': ' + (await sub.text().catch(() => '')).slice(0, 400));
  const j = await sub.json();
  const id = j.id || j.job_id || (j.data && j.data.id);
  if (!id) throw new Error('video submit: no job id in response');

  const start = Date.now();
  for (;;) {
    if (signal && signal.aborted) throw new Error('cancelled');
    if (Date.now() - start > VIDEO_MAX_WAIT_MS) throw new Error('video poll timed out after 10 min');
    await new Promise((r) => setTimeout(r, 3000));
    const st = await fetch(_base(baseUrl) + '/videos/' + id, {
      headers: { Authorization: 'Bearer ' + apiKey },
      signal,
    });
    if (!st.ok) throw new Error('video poll HTTP ' + st.status);
    const s = await st.json();
    if (onProgress) onProgress({ stage: s.status || 'running', pct: s.progress != null ? s.progress : null });
    if (s.status === 'completed' || s.status === 'succeeded') {
      const url = (s.output && (s.output.url || s.output[0])) || s.url || (s.data && s.data[0] && s.data[0].url);
      if (!url) throw new Error('video completed but no output URL in response');
      return [{ url, b64: null, ext: 'mp4', contentType: 'video/mp4' }];
    }
    if (s.status === 'failed' || s.status === 'error') throw new Error('video failed: ' + (s.error || 'unknown'));
  }
}

module.exports = {
  listModels,
  image: images,
  images,
  speech,
  video,
  supports: new Set(['image', 'speech', 'video']),
};
