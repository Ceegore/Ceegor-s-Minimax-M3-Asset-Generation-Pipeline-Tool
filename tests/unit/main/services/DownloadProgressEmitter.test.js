// tests/unit/main/services/DownloadProgressEmitter.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createProgressEmitter, BYTE_THRESHOLD, TIME_THRESHOLD_MS } = require('../../../../main/services/DownloadProgressEmitter');

test('createProgressEmitter: fires initial event instantly', () => {
  let fired = [];
  const target = (payload) => { fired.push(payload); };
  const emitter = createProgressEmitter(target, () => ({ status: 'start' }));

  assert.deepEqual(fired, [{ status: 'start' }]);
});

test('createProgressEmitter: throttles intermediate calls but forces final/done call', () => {
  let fired = [];
  const target = (payload) => { fired.push(payload); };
  const emitter = createProgressEmitter(target, () => ({ status: 'start' }));

  // Reset tracking list
  fired = [];

  // Fire small updates immediately. They should be throttled (not sent)
  emitter(100, 1000, false);
  emitter(200, 1000, false);
  assert.equal(fired.length, 0);

  // Fire a larger update that exceeds BYTE_THRESHOLD (e.g. 600 KB)
  emitter(BYTE_THRESHOLD + 10, 1000, false);
  assert.equal(fired.length, 1);
  assert.deepEqual(fired[0], { downloaded: BYTE_THRESHOLD + 10, total: 1000 });

  // Reset tracking list
  fired = [];

  // Fire done call
  emitter(BYTE_THRESHOLD + 50, 1000, true);
  assert.equal(fired.length, 1);
  assert.deepEqual(fired[0], { downloaded: BYTE_THRESHOLD + 50, total: 1000 });
});

test('createProgressEmitter: fires after TIME_THRESHOLD_MS', async () => {
  let fired = [];
  const target = (payload) => { fired.push(payload); };
  const emitter = createProgressEmitter(target, () => ({ status: 'start' }));

  fired = [];
  emitter(10, 1000, false);
  assert.equal(fired.length, 0);

  // Wait for TIME_THRESHOLD_MS
  await new Promise(resolve => setTimeout(resolve, TIME_THRESHOLD_MS + 20));

  emitter(20, 1000, false);
  assert.equal(fired.length, 1);
  assert.deepEqual(fired[0], { downloaded: 20, total: 1000 });
});
