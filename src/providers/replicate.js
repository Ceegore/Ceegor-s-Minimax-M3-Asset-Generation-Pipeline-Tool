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

// H-005: per-request timeout so a stalled TCP/TLS/response cannot outlive
// the advertised job deadline or cancellation expectation.
const DEFAULT_FETCH_TIMEOUT_MS = 60000; // 60s per individual request

// H-006: strict model identifier grammar. Replicate models are "owner/name"
// or "owner/name:version". Each segment must be a safe URL path component.
const MODEL_SEGMENT_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
function validateModel(model) {
  if (!model || typeof model !== 'string') throw new Error('replicate: model identifier is required');
  const versioned = model.includes(':');
  const base = versioned ? model.slice(0, model.indexOf(':')) : model;
  const version = versioned ? model.slice(model.indexOf(':') + 1) : null;
  const parts = base.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error('replicate: model must be "owner/name" or "owner/name:version"');
  }
  for (const seg of parts) {
    if (!MODEL_SEGMENT_RE.test(seg)) {
      throw new Error('replicate: invalid model segment "' + seg + '"');
    }
  }
  if (version !== null && !MODEL_SEGMENT_RE.test(version)) {
    throw new Error('replicate: invalid model version "' + version + '"');
  }
  return { owner: parts[0], name: parts[1], version };
}

// H-005: combine caller signal with a per-request timeout.
function _fetchSignal(signal, timeoutMs) {
  const ms = timeoutMs || DEFAULT_FETCH_TIMEOUT_MS;
  if (typeof AbortSignal.any === 'function' && typeof AbortSignal.timeout === 'function') {
    const signals = [AbortSignal.timeout(ms)];
    if (signal) signals.unshift(signal);
    return AbortSignal.any(signals);
  }
  if (signal) return signal;
  return typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(ms) : undefined;
}

// H-005: abortable delay — rejects immediately when the signal fires instead
// of waiting for the full timeout duration.
// M-008 (hhhhu3 audit): the abort listener is removed again when the timer
// resolves normally. Previously each poll left a one-time listener on the
// (long-lived) job signal — hundreds accumulated on long jobs.
function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new Error('cancelled'));
    let onAbort;
    const timer = setTimeout(() => {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) {
      onAbort = () => { clearTimeout(timer); reject(new Error('cancelled')); };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

// H-011 (hhhhu3 audit): bounded response body reading for the fetch path.
// `text().slice(...)` does NOT limit allocation — the stream is capped while
// it is being read. The injected SafeHttpClient path (H-001) carries its own
// caps; these constants bound the unit-test fallback only.
const MAX_JSON_BYTES = 4 * 1024 * 1024;   // 4 MB for prediction JSON
const MAX_ERROR_BYTES = 16 * 1024;         // 16 KB for error bodies

/** Read a response body with a hard byte cap (Content-Length + stream counter). */
async function _readBounded(res, maxBytes) {
  const declared = Number((res.headers && res.headers.get && res.headers.get('content-length')) || 0);
  if (declared > maxBytes) {
    throw new Error('response too large (' + declared + ' bytes, cap ' + maxBytes + ')');
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      reader.cancel().catch(() => {});
      throw new Error('response exceeded ' + maxBytes + ' byte cap');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)), total);
}

/** Read and parse JSON with a size cap (H-011). */
async function _jsonBounded(res) {
  const buf = await _readBounded(res, MAX_JSON_BYTES);
  return JSON.parse(buf.toString('utf8'));
}

/** Read bounded error text (H-011). */
async function _errorText(res) {
  try {
    const buf = await _readBounded(res, MAX_ERROR_BYTES);
    return buf.toString('utf8').slice(0, 400);
  } catch (_) { return ''; }
}

function _ext(u) {
  const m = /\.(\w{2,4})(?:\?|#|$)/.exec(String(u || ''));
  return m ? m[1].toLowerCase() : 'bin';
}

// Core submit-poll loop.
// model: "owner/name" (latest) or "owner/name:version". input: model-specific object.
// H-001 (hhhhu3 audit): `http` is the injected SafeHttpClient — production
// callers always provide it so submit/poll receive DNS pinning, redirect
// policy and unified caps. The fetch path remains for direct unit tests and
// is now fully bounded (H-011).
// M-009 (hhhhu3 audit): accepts and invokes `onSubmitted` with the remote
// prediction identity so replicate video jobs reach the remote-job ledger.
async function run({ apiKey, model, input, signal, onProgress, onSubmitted, http }) {
  // H-006: validate and encode model identifier before URL construction.
  const parsed = validateModel(model);
  const versioned = parsed.version !== null;
  const modelPath = encodeURIComponent(parsed.owner) + '/' + encodeURIComponent(parsed.name);
  const url = versioned ? HOST + '/predictions' : HOST + '/models/' + modelPath + '/predictions';
  const body = versioned ? { version: parsed.version, input } : { input };
  let pred;
  if (http) {
    pred = await http.json(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
        Prefer: 'wait',
      },
      body: JSON.stringify(body),
      signal,
    }, { maxJsonBytes: MAX_JSON_BYTES, maxErrorBytes: MAX_ERROR_BYTES });
  } else {
    const sub = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
        Prefer: 'wait',
      },
      body: JSON.stringify(body),
      signal: _fetchSignal(signal), // H-005: per-request timeout
    });
    if (!sub.ok) throw new Error('replicate submit HTTP ' + sub.status + ': ' + await _errorText(sub));
    pred = await _jsonBounded(sub); // H-011: bounded
  }

  // M-009: notify the caller of the remote job identity (ledger persistence).
  if (onSubmitted) {
    try { onSubmitted({ remoteJobId: pred && pred.id ? pred.id : null, pollUrl: (pred && pred.urls && pred.urls.get) || null }); } catch (_) { /* ledger is best-effort */ }
  }

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
    await abortableDelay(2000, signal); // H-005: abortable polling wait
    if (http) {
      pred = await http.json(pred.urls.get, {
        headers: { Authorization: 'Bearer ' + apiKey },
        signal,
      }, { maxJsonBytes: MAX_JSON_BYTES, maxErrorBytes: MAX_ERROR_BYTES });
    } else {
      const g = await fetch(pred.urls.get, {
        headers: { Authorization: 'Bearer ' + apiKey },
        signal: _fetchSignal(signal), // H-005: per-request timeout
      });
      if (!g.ok) throw new Error('replicate poll HTTP ' + g.status);
      pred = await _jsonBounded(g); // H-011: bounded
    }
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
  validateModel,
};
