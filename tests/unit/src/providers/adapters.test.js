// tests/unit/src/providers/adapters.test.js
// Unit tests for the OpenAI-compatible and Replicate adapters.
// Uses a mocked global fetch to assert request shapes without real network calls.
'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const openaiCompat = require('../../../../src/providers/openaiCompatible');
const replicate = require('../../../../src/providers/replicate');

// ---- Mock fetch ----
let fetchCalls = [];
let fetchResponses = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  fetchCalls = [];
  fetchResponses = [];
  globalThis.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    const resp = fetchResponses.shift() || {
      ok: true,
      headers: { get: () => '0' },
      body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }), cancel: async () => {} }) },
      json: async () => ({}),
      arrayBuffer: async () => new ArrayBuffer(0),
    };
    return resp;
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function jsonResponse(data, ok = true) {
  const buf = Buffer.from(JSON.stringify(data), 'utf8');
  let sent = false;
  return {
    ok, status: ok ? 200 : 500,
    headers: { get: (k) => k === 'content-length' ? String(buf.length) : null },
    body: { getReader: () => ({ read: async () => { if (sent) return { done: true, value: undefined }; sent = true; return { done: false, value: new Uint8Array(buf) }; }, cancel: async () => {} }) },
    json: async () => data,
    text: async () => JSON.stringify(data),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
}

// ============================================================================
// OpenAI-compatible adapter
// ============================================================================

test('openaiCompat.supports covers image, speech, video (not music)', () => {
  assert.ok(openaiCompat.supports.has('image'));
  assert.ok(openaiCompat.supports.has('speech'));
  assert.ok(openaiCompat.supports.has('video'));
  assert.ok(!openaiCompat.supports.has('music'));
});

test('openaiCompat.listModels sends GET /models with Bearer auth', async () => {
  fetchResponses.push(jsonResponse({ data: [{ id: 'model-a' }, { id: 'model-b' }] }));
  const models = await openaiCompat.listModels({ baseUrl: 'https://api.test.com/v1/', apiKey: 'sk-123' });
  assert.deepEqual(models, ['model-a', 'model-b']);
  assert.equal(fetchCalls[0].url, 'https://api.test.com/v1/models');
  assert.equal(fetchCalls[0].opts.headers.Authorization, 'Bearer sk-123');
});

test('openaiCompat.images sends POST /images/generations with correct body', async () => {
  fetchResponses.push(jsonResponse({ data: [{ b64_json: 'aGVsbG8=' }] }));
  const out = await openaiCompat.images({ baseUrl: 'https://api.test.com/v1', apiKey: 'sk-1', model: 'gpt-image-1', prompt: 'a cat', params: { size: '512x512' } });
  assert.equal(out.length, 1);
  assert.equal(out[0].b64, 'aGVsbG8=');
  assert.equal(out[0].ext, 'png');
  const body = JSON.parse(fetchCalls[0].opts.body);
  assert.equal(body.model, 'gpt-image-1');
  assert.equal(body.prompt, 'a cat');
  assert.equal(body.response_format, 'b64_json');
  assert.equal(body.size, '512x512');
  assert.equal(fetchCalls[0].url, 'https://api.test.com/v1/images/generations');
});

test('openaiCompat.speech sends POST /audio/speech and returns base64 audio', async () => {
  const audioBytes = Buffer.from('fake-audio');
  fetchResponses.push({
    ok: true, status: 200,
    headers: { get: (k) => k === 'content-length' ? String(audioBytes.length) : null },
    body: { getReader: () => { let sent = false; return { read: async () => { if (sent) return { done: true }; sent = true; return { done: false, value: new Uint8Array(audioBytes) }; }, cancel: async () => {} }; } },
    arrayBuffer: async () => audioBytes.buffer.slice(audioBytes.byteOffset, audioBytes.byteOffset + audioBytes.byteLength),
    text: async () => '',
  });
  const out = await openaiCompat.speech({ baseUrl: 'https://api.test.com/v1', apiKey: 'sk-1', model: 'tts-1', input: 'Hello world', voice: 'nova', format: 'wav' });
  assert.equal(out.length, 1);
  assert.equal(out[0].ext, 'wav');
  assert.equal(out[0].contentType, 'audio/wav');
  assert.ok(out[0].b64.length > 0);
  const body = JSON.parse(fetchCalls[0].opts.body);
  assert.equal(body.model, 'tts-1');
  assert.equal(body.input, 'Hello world');
  assert.equal(body.voice, 'nova');
  assert.equal(body.response_format, 'wav');
});

test('openaiCompat.images throws on HTTP error', async () => {
  fetchResponses.push({ ok: false, status: 429, headers: { get: () => null }, body: { getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {} }) }, text: async () => 'rate limited', json: async () => ({}) });
  await assert.rejects(
    () => openaiCompat.images({ baseUrl: 'https://x.com/v1', apiKey: 'k', model: 'm', prompt: 'p' }),
    /images HTTP 429/
  );
});

// ============================================================================
// Replicate adapter
// ============================================================================

test('replicate.supports covers all four modalities', () => {
  assert.ok(replicate.supports.has('image'));
  assert.ok(replicate.supports.has('speech'));
  assert.ok(replicate.supports.has('music'));
  assert.ok(replicate.supports.has('video'));
});

test('replicate.run submits to /models/{owner}/{name}/predictions for unversioned model', async () => {
  fetchResponses.push(jsonResponse({
    status: 'succeeded',
    output: 'https://cdn.replicate.com/out.mp3',
    urls: { get: 'https://api.replicate.com/v1/predictions/abc' },
  }));
  const out = await replicate.run({ apiKey: 'r8-key', model: 'meta/musicgen', input: { prompt: 'jazz' } });
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'https://cdn.replicate.com/out.mp3');
  assert.equal(out[0].ext, 'mp3');
  assert.ok(fetchCalls[0].url.includes('/models/meta/musicgen/predictions'));
  assert.equal(fetchCalls[0].opts.headers.Authorization, 'Bearer r8-key');
  assert.equal(fetchCalls[0].opts.headers.Prefer, 'wait');
});

test('replicate.run submits to /predictions with version for versioned model', async () => {
  fetchResponses.push(jsonResponse({
    status: 'succeeded',
    output: ['https://cdn.replicate.com/img.png'],
    urls: { get: 'https://api.replicate.com/v1/predictions/def' },
  }));
  const out = await replicate.run({ apiKey: 'r8-key', model: 'stability-ai/sdxl:abc123', input: { prompt: 'a dog' } });
  assert.equal(out.length, 1);
  assert.equal(out[0].ext, 'png');
  assert.ok(fetchCalls[0].url.endsWith('/predictions'));
  const body = JSON.parse(fetchCalls[0].opts.body);
  assert.equal(body.version, 'abc123');
  assert.deepEqual(body.input, { prompt: 'a dog' });
});

test('replicate.run polls until succeeded', async () => {
  // First response: processing. Second poll: still processing. Third poll: succeeded.
  fetchResponses.push(jsonResponse({
    status: 'processing',
    urls: { get: 'https://api.replicate.com/v1/predictions/xyz' },
  }));
  fetchResponses.push(jsonResponse({
    status: 'processing',
    urls: { get: 'https://api.replicate.com/v1/predictions/xyz' },
  }));
  fetchResponses.push(jsonResponse({
    status: 'succeeded',
    output: 'https://cdn.replicate.com/result.wav',
    urls: { get: 'https://api.replicate.com/v1/predictions/xyz' },
  }));
  const stages = [];
  const out = await replicate.run({
    apiKey: 'r8-key', model: 'meta/musicgen', input: { prompt: 'rock' },
    onProgress: (p) => stages.push(p.stage),
  });
  assert.equal(out[0].url, 'https://cdn.replicate.com/result.wav');
  assert.ok(stages.includes('processing'), 'onProgress reports intermediate processing status');
  assert.ok(stages.includes('succeeded'), 'onProgress reports final succeeded status');
  assert.equal(fetchCalls.length, 3); // submit + 2 polls
});

test('replicate.run throws on failed prediction', async () => {
  fetchResponses.push(jsonResponse({
    status: 'failed',
    error: 'model crashed',
    urls: { get: 'https://api.replicate.com/v1/predictions/fail' },
  }));
  await assert.rejects(
    () => replicate.run({ apiKey: 'k', model: 'x/y', input: {} }),
    /replicate failed: model crashed/
  );
});

test('replicate.music maps prompt to input.prompt', async () => {
  fetchResponses.push(jsonResponse({
    status: 'succeeded',
    output: 'https://cdn.replicate.com/music.mp3',
    urls: { get: 'https://api.replicate.com/v1/predictions/m1' },
  }));
  await replicate.music({ apiKey: 'k', model: 'meta/musicgen', prompt: 'lo-fi beats', params: { duration: 10 } });
  const body = JSON.parse(fetchCalls[0].opts.body);
  assert.equal(body.input.prompt, 'lo-fi beats');
  assert.equal(body.input.duration, 10);
});

test('replicate.speech maps input text to input.text', async () => {
  fetchResponses.push(jsonResponse({
    status: 'succeeded',
    output: 'https://cdn.replicate.com/speech.wav',
    urls: { get: 'https://api.replicate.com/v1/predictions/s1' },
  }));
  await replicate.speech({ apiKey: 'k', model: 'hexgrad/kokoro-82m', input: 'Hello there', params: {} });
  const body = JSON.parse(fetchCalls[0].opts.body);
  assert.equal(body.input.text, 'Hello there');
});

test('replicate.run throws when prediction has no poll URL', async () => {
  fetchResponses.push(jsonResponse({
    status: 'processing',
    // urls missing entirely
  }));
  await assert.rejects(
    () => replicate.run({ apiKey: 'k', model: 'x/y', input: {} }),
    /no poll URL/
  );
});

test('replicate.run throws on poll HTTP error', async () => {
  fetchResponses.push(jsonResponse({
    status: 'processing',
    urls: { get: 'https://api.replicate.com/v1/predictions/err' },
  }));
  fetchResponses.push({ ok: false, status: 500, headers: { get: () => null }, body: { getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {} }) }, json: async () => ({}), text: async () => 'internal error' });
  await assert.rejects(
    () => replicate.run({ apiKey: 'k', model: 'x/y', input: {} }),
    /replicate poll HTTP 500/
  );
});

// ============================================================================
// OpenAI-compatible video error paths
// ============================================================================

test('openaiCompat.video throws on poll HTTP error', async () => {
  // Submit succeeds
  fetchResponses.push(jsonResponse({ id: 'vid-1' }));
  // Poll returns 500
  fetchResponses.push({ ok: false, status: 500, headers: { get: () => null }, body: { getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {} }) }, json: async () => ({}), text: async () => 'err' });
  await assert.rejects(
    () => openaiCompat.video({ baseUrl: 'https://api.test.com/v1', apiKey: 'k', model: 'm', prompt: 'p' }),
    /video poll HTTP 500/
  );
});

test('openaiCompat.video throws when completed but no output URL', async () => {
  // Submit succeeds
  fetchResponses.push(jsonResponse({ id: 'vid-2' }));
  // Poll returns completed but with no recognizable URL field
  fetchResponses.push(jsonResponse({ status: 'completed', output: {} }));
  await assert.rejects(
    () => openaiCompat.video({ baseUrl: 'https://api.test.com/v1', apiKey: 'k', model: 'm', prompt: 'p' }),
    /no output URL/
  );
});

test('openaiCompat.video success: submit → poll → completed with URL', async () => {
  fetchResponses.push(jsonResponse({ id: 'vid-ok' }));
  fetchResponses.push(jsonResponse({ status: 'completed', output: { url: 'https://cdn.example.com/vid.mp4' } }));
  const stages = [];
  const out = await openaiCompat.video({
    baseUrl: 'https://api.test.com/v1', apiKey: 'k', model: 'm', prompt: 'a sunset',
    onProgress: (p) => stages.push(p.stage),
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'https://cdn.example.com/vid.mp4');
  assert.equal(out[0].ext, 'mp4');
  assert.ok(stages.includes('completed'));
  assert.equal(fetchCalls[0].url, 'https://api.test.com/v1/videos');
  assert.equal(fetchCalls[1].url, 'https://api.test.com/v1/videos/vid-ok');
});

test('openaiCompat.video throws on submit HTTP error', async () => {
  fetchResponses.push({ ok: false, status: 403, headers: { get: () => null }, body: { getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {} }) }, text: async () => 'forbidden', json: async () => ({}) });
  await assert.rejects(
    () => openaiCompat.video({ baseUrl: 'https://x.com/v1', apiKey: 'k', model: 'm', prompt: 'p' }),
    /video submit HTTP 403/
  );
});

test('openaiCompat.video throws on failed status', async () => {
  fetchResponses.push(jsonResponse({ id: 'vid-fail' }));
  fetchResponses.push(jsonResponse({ status: 'failed', error: 'content policy' }));
  await assert.rejects(
    () => openaiCompat.video({ baseUrl: 'https://x.com/v1', apiKey: 'k', model: 'm', prompt: 'p' }),
    /video failed: content policy/
  );
});

test('openaiCompat.speech throws on HTTP error', async () => {
  fetchResponses.push({ ok: false, status: 401, headers: { get: () => null }, body: { getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {} }) }, text: async () => 'unauthorized', json: async () => ({}) });
  await assert.rejects(
    () => openaiCompat.speech({ baseUrl: 'https://x.com/v1', apiKey: 'bad', model: 'tts-1', input: 'hi' }),
    /speech HTTP 401/
  );
});

test('openaiCompat.listModels throws on HTTP error', async () => {
  fetchResponses.push({ ok: false, status: 500, headers: { get: () => null }, body: { getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {} }) }, text: async () => 'err', json: async () => ({}) });
  await assert.rejects(
    () => openaiCompat.listModels({ baseUrl: 'https://x.com/v1', apiKey: 'k' }),
    /models HTTP 500/
  );
});

// ============================================================================
// Replicate modality wrappers
// ============================================================================

test('replicate.images maps prompt to input.prompt and returns png', async () => {
  fetchResponses.push(jsonResponse({
    status: 'succeeded',
    output: ['https://cdn.replicate.com/img1.png'],
    urls: { get: 'https://api.replicate.com/v1/predictions/i1' },
  }));
  const out = await replicate.images({ apiKey: 'k', model: 'stability-ai/sdxl', prompt: 'a landscape', params: { width: 768 } });
  assert.equal(out.length, 1);
  assert.equal(out[0].ext, 'png');
  const body = JSON.parse(fetchCalls[0].opts.body);
  assert.equal(body.input.prompt, 'a landscape');
  assert.equal(body.input.width, 768);
});

test('replicate.video maps prompt to input.prompt and returns mp4', async () => {
  fetchResponses.push(jsonResponse({
    status: 'succeeded',
    output: 'https://cdn.replicate.com/vid.mp4',
    urls: { get: 'https://api.replicate.com/v1/predictions/v1' },
  }));
  const out = await replicate.video({ apiKey: 'k', model: 'minimax/video-01', prompt: 'a car driving', params: {} });
  assert.equal(out.length, 1);
  assert.equal(out[0].ext, 'mp4');
  const body = JSON.parse(fetchCalls[0].opts.body);
  assert.equal(body.input.prompt, 'a car driving');
});

test('replicate.run handles array output (multiple files)', async () => {
  fetchResponses.push(jsonResponse({
    status: 'succeeded',
    output: ['https://cdn.replicate.com/a.png', 'https://cdn.replicate.com/b.png'],
    urls: { get: 'https://api.replicate.com/v1/predictions/multi' },
  }));
  const out = await replicate.run({ apiKey: 'k', model: 'x/y', input: { prompt: 'two' } });
  assert.equal(out.length, 2);
  assert.equal(out[0].url, 'https://cdn.replicate.com/a.png');
  assert.equal(out[1].url, 'https://cdn.replicate.com/b.png');
});

test('openaiCompat.images handles url-based response (no b64)', async () => {
  fetchResponses.push(jsonResponse({ data: [{ url: 'https://cdn.example.com/pic.png' }] }));
  const out = await openaiCompat.images({ baseUrl: 'https://x.com/v1', apiKey: 'k', model: 'm', prompt: 'p' });
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'https://cdn.example.com/pic.png');
  assert.equal(out[0].b64, null);
});
