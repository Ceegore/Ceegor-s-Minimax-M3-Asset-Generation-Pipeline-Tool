// src/providers/openaiCompatible.js
// ============================================================================
// OpenAI-compatible / OpenRouter adapter.
// Covers: image (/images/generations), speech (/audio/speech),
//         video (OpenRouter /videos — async submit → poll).
// One base URL + key. OpenRouter recommended (covers 3 of 4 modalities).
// ============================================================================
'use strict';

function _base(u) { return String(u || '').replace(/\/+$/, ''); }

// H-015 (_5 audit): combine a caller-provided AbortSignal with a per-fetch
// timeout so that BOTH user-cancel and hung-endpoint protection are active.
// Previously `signal || timeout` meant the timeout was disabled whenever
// the caller supplied a signal (which is always in production).
const DEFAULT_FETCH_TIMEOUT_MS = 60000; // 60s for images/speech/models
function _fetchSignal(signal, timeoutMs) {
  const ms = timeoutMs || DEFAULT_FETCH_TIMEOUT_MS;
  if (typeof AbortSignal.any === 'function' && typeof AbortSignal.timeout === 'function') {
    const signals = [AbortSignal.timeout(ms)];
    if (signal) signals.unshift(signal);
    return AbortSignal.any(signals);
  }
  // Fallback (very old Node): prefer caller signal, else timeout.
  if (signal) return signal;
  return typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(ms) : undefined;
}

// Max time (ms) to poll an async video job before giving up.
const VIDEO_MAX_WAIT_MS = 10 * 60 * 1000; // 10 minutes

async function listModels({ baseUrl, apiKey, signal }) {
  // MED-007: enforce a 15s timeout so a hung /models endpoint cannot
  // block the settings UI indefinitely.
  const res = await fetch(_base(baseUrl) + '/models', {
    headers: { Authorization: 'Bearer ' + apiKey },
    signal: _fetchSignal(signal, 15000),
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
    signal: _fetchSignal(signal),
  });
  if (!res.ok) throw new Error('images HTTP ' + res.status + ': ' + (await res.text().catch(() => '')).slice(0, 400));
  const j = await res.json();
  return (j.data || []).map((d) => {
    // FUNC-023: detect format from bytes, not hardcoded 'png'.
    let ext = 'png';
    let contentType = 'image/png';
    if (d.url) {
      // Infer from URL extension
      const m = /\.(jpe?g|webp|avif|gif|bmp|tiff?)(?:\?|#|$)/i.exec(d.url);
      if (m) {
        ext = m[1].toLowerCase().replace('jpeg', 'jpg').replace('tif', 'tiff');
        contentType = 'image/' + (ext === 'jpg' ? 'jpeg' : ext);
      }
    }
    if (d.b64_json) {
      // Infer from magic bytes
      const buf = Buffer.from(d.b64_json.slice(0, 16), 'base64');
      if (buf[0] === 0xFF && buf[1] === 0xD8) { ext = 'jpg'; contentType = 'image/jpeg'; }
      else if (buf[0] === 0x52 && buf[1] === 0x49) { ext = 'webp'; contentType = 'image/webp'; }
      else if (buf[0] === 0x47 && buf[1] === 0x49) { ext = 'gif'; contentType = 'image/gif'; }
    }
    return { b64: d.b64_json || null, url: d.url || null, ext, contentType };
  });
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
    signal: _fetchSignal(signal),
  });
  if (!res.ok) throw new Error('speech HTTP ' + res.status + ': ' + (await res.text().catch(() => '')).slice(0, 400));
  const buf = Buffer.from(await res.arrayBuffer());
  return [{ b64: buf.toString('base64'), url: null, ext: effectiveFmt, contentType: 'audio/' + effectiveFmt }];
}

// OpenRouter async video: submit → poll. Field names may differ per provider —
// the poll is written defensively (multiple fallbacks).
// HIGH-003: parse unsigned_urls from completed response.
// MED-011: handle 'cancelled'/'expired' terminal states.
async function video({ baseUrl, apiKey, model, prompt, params, signal, onProgress, onSubmitted }) {
  const FETCH_TIMEOUT_MS = 30000; // MED-010: per-fetch timeout
  const sub = await fetch(_base(baseUrl) + '/videos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
    body: JSON.stringify(Object.assign({ model, prompt }, params || {})),
    signal: _fetchSignal(signal, FETCH_TIMEOUT_MS),
  });
  if (!sub.ok) throw new Error('video submit HTTP ' + sub.status + ': ' + (await sub.text().catch(() => '')).slice(0, 400));
  const j = await sub.json();
  const id = j.id || j.job_id || (j.data && j.data.id);
  if (!id) throw new Error('video submit: no job id in response');

  // HIGH-003: handle polling_url from submit response.
  // H-013 (_5 audit): validate polling_url origin matches baseUrl before
  // use. A malicious/compromised provider could return a polling_url on a
  // different host, causing the API key to be sent to an attacker.
  let pollBase = _base(baseUrl) + '/videos/' + id;
  if (j.polling_url && typeof j.polling_url === 'string') {
    try {
      const baseOrigin = new URL(_base(baseUrl)).origin;
      const pollOrigin = new URL(j.polling_url).origin;
      if (pollOrigin === baseOrigin) {
        pollBase = j.polling_url;
      }
      // else: ignore the foreign polling_url, use the safe default.
    } catch (_) { /* malformed URL — use default */ }
  }
  // H-012: notify caller of the remote job identity for ledger persistence.
  if (onSubmitted) onSubmitted({ remoteJobId: id, pollUrl: pollBase });

  const start = Date.now();
  for (;;) {
    if (signal && signal.aborted) throw new Error('cancelled');
    if (Date.now() - start > VIDEO_MAX_WAIT_MS) throw new Error('video poll timed out after 10 min');
    await new Promise((r) => setTimeout(r, 3000));
    const st = await fetch(pollBase, {
      headers: { Authorization: 'Bearer ' + apiKey },
      signal: _fetchSignal(signal, FETCH_TIMEOUT_MS),
    });
    if (!st.ok) throw new Error('video poll HTTP ' + st.status);
    const s = await st.json();
    if (onProgress) onProgress({ stage: s.status || 'running', pct: s.progress != null ? s.progress : null });

    if (s.status === 'completed' || s.status === 'succeeded') {
      // HIGH-003: parse unsigned_urls (OpenRouter video format).
      const urls = _extractVideoUrls(s);
      if (!urls.length) throw new Error('video completed but no output URL in response');
      // H-014 (_5 audit): attach auth policy so the download layer knows
      // whether these URLs require Authorization. OpenRouter content URLs
      // on the same origin as the API may be protected (require Bearer).
      let trustedOrigin = '';
      try { trustedOrigin = new URL(_base(baseUrl)).origin; } catch (_) {}
      return urls.map((url) => ({ url, b64: null, ext: 'mp4', contentType: 'video/mp4', authPolicy: 'bearer', trustedOrigins: [trustedOrigin] }));
    }
    // MED-011: terminal states 'cancelled'/'expired' → immediate error.
    if (s.status === 'failed' || s.status === 'error') throw new Error('video failed: ' + (s.error || 'unknown'));
    if (s.status === 'cancelled' || s.status === 'canceled') throw new Error('video cancelled by provider');
    if (s.status === 'expired') throw new Error('video job expired');
  }
}

/**
 * HIGH-003: Extract video URLs from various response shapes.
 * Handles: unsigned_urls[], output.url, output[0], url, data[0].url,
 *          video.unsigned_urls[], choices[0].message content URLs.
 * @param {object} s - Poll response.
 * @returns {string[]}
 */
function _extractVideoUrls(s) {
  const urls = [];
  // OpenRouter: top-level unsigned_urls array
  if (Array.isArray(s.unsigned_urls)) urls.push(...s.unsigned_urls.filter(Boolean));
  // OpenRouter: video.unsigned_urls
  if (s.video && Array.isArray(s.video.unsigned_urls)) urls.push(...s.video.unsigned_urls.filter(Boolean));
  // Generic: output.url or output[0]
  if (s.output) {
    if (typeof s.output === 'string') urls.push(s.output);
    else if (Array.isArray(s.output)) urls.push(...s.output.filter((u) => typeof u === 'string'));
    else if (s.output.url) urls.push(s.output.url);
  }
  // Fallback: s.url
  if (s.url && typeof s.url === 'string') urls.push(s.url);
  // Fallback: data[0].url
  if (s.data && Array.isArray(s.data) && s.data[0] && s.data[0].url) urls.push(s.data[0].url);
  // Deduplicate
  return [...new Set(urls)];
}

module.exports = {
  listModels,
  image: images,
  images,
  speech,
  video,
  supports: new Set(['image', 'speech', 'video']),
};
