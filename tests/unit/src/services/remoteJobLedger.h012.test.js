// tests/unit/src/services/remoteJobLedger.h012.test.js
// H-012 (_5 audit): Persistent Remote Job Ledger unit tests.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Point configDir at a temp directory so the ledger writes there.
let tmpDir;
let ledger;

test.before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-h012-'));
  process.env.MINIMAX_CONFIG_DIR = tmpDir;
  // Clear require cache so config picks up the env var.
  delete require.cache[require.resolve('../../../../src/config')];
  delete require.cache[require.resolve('../../../../src/services/remoteJobLedger')];
  ledger = require('../../../../src/services/remoteJobLedger');
});

test.after(() => {
  delete process.env.MINIMAX_CONFIG_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('H-012: add() creates a ledger entry with correct fields', () => {
  ledger._reset();
  const entry = ledger.add({
    localJobId: 'job-1',
    providerId: 'openrouter',
    remoteJobId: 'vid_abc123',
    pollUrl: 'https://openrouter.ai/api/v1/videos/vid_abc123',
    model: 'minimax/video-01',
    modality: 'video',
    outDir: 'C:\\output',
  });
  assert.equal(entry.localJobId, 'job-1');
  assert.equal(entry.remoteJobId, 'vid_abc123');
  assert.equal(entry.status, 'pending');
  assert.ok(entry.createdAt > 0);
  // Verify persistence.
  const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, 'remote-jobs.json'), 'utf8'));
  assert.equal(raw.length, 1);
  assert.equal(raw[0].remoteJobId, 'vid_abc123');
});

test('H-012: update() patches status and resultUrls', () => {
  ledger._reset();
  ledger.update('job-1', { status: 'completed', resultUrls: ['C:\\output\\video.mp4'] });
  const entry = ledger.get('job-1');
  assert.equal(entry.status, 'completed');
  assert.deepEqual(entry.resultUrls, ['C:\\output\\video.mp4']);
  assert.ok(entry.updatedAt >= entry.createdAt);
});

test('H-012: getPending() returns only pending/running entries', () => {
  ledger._reset();
  ledger.add({ localJobId: 'job-2', providerId: 'replicate', remoteJobId: 'r-999', pollUrl: 'https://api.replicate.com/v1/predictions/r-999' });
  ledger.update('job-2', { status: 'running' });
  const pending = ledger.getPending();
  // job-1 is completed, job-2 is running.
  assert.equal(pending.length, 1);
  assert.equal(pending[0].localJobId, 'job-2');
});

test('H-012: remove() deletes an entry', () => {
  ledger._reset();
  assert.equal(ledger.remove('job-2'), true);
  assert.equal(ledger.get('job-2'), null);
  assert.equal(ledger.remove('nonexistent'), false);
});

test('H-012: prune() removes old terminal entries', () => {
  ledger._reset();
  // Add an old completed entry.
  ledger.add({ localJobId: 'job-old', providerId: 'x', remoteJobId: 'old-1', pollUrl: 'http://x' });
  ledger.update('job-old', { status: 'completed' });
  // Manually backdate updatedAt.
  const all = ledger.getAll();
  const old = all.find((e) => e.localJobId === 'job-old');
  old.updatedAt = Date.now() - 8 * 24 * 60 * 60 * 1000; // 8 days ago
  // Prune with 7-day retention.
  const pruned = ledger.prune();
  assert.ok(pruned >= 1);
  assert.equal(ledger.get('job-old'), null);
});

test('H-012: add() with duplicate localJobId replaces the entry', () => {
  ledger._reset();
  ledger.add({ localJobId: 'job-dup', providerId: 'a', remoteJobId: 'r1', pollUrl: 'http://a' });
  ledger.add({ localJobId: 'job-dup', providerId: 'b', remoteJobId: 'r2', pollUrl: 'http://b' });
  const all = ledger.getAll();
  const dups = all.filter((e) => e.localJobId === 'job-dup');
  assert.equal(dups.length, 1);
  assert.equal(dups[0].remoteJobId, 'r2');
});

test('H-012: ledger survives reload from disk (persistence)', () => {
  ledger._reset();
  ledger.add({ localJobId: 'job-persist', providerId: 'p', remoteJobId: 'rp', pollUrl: 'http://p' });
  // Simulate app restart: reset in-memory cache, re-load from disk.
  ledger._reset();
  const entry = ledger.get('job-persist');
  assert.ok(entry);
  assert.equal(entry.remoteJobId, 'rp');
  assert.equal(entry.status, 'pending');
});
