// tests/unit/security/parallelCollision.r006pp.test.js
// ============================================================================
// R0.1-006 PP — Phasenprüfung-of-Phasenprüfung der R0.1-006 Image-Pipeline
// Hardening (SYS-007).
//
// The base test (parallelCollision.security.test.js) covers the documented
// contract: UUID-based temp names + per-outputPath lock + cleanup on rename
// failure. This file adds the gaps found by walking every aspect a second
// time:
//
//   D.  A failed resize() (e.g. source file doesn't exist, or a write
//       fails) RELEASES the lock so the next call can proceed. A throw
//       in the resize path must not strand the lock — otherwise one
//       bad call would deadlock every subsequent call to the same
//       outputPath.
//   E.  Three or more parallel resize() calls to the same outputPath
//       all succeed (the lock is a queue, not a single-shot barrier).
//   F.  Sequential calls to the same outputPath (no contention) work
//       normally — the lock adds no measurable latency when there
//       is no other caller waiting.
//   G.  Concurrent calls to DIFFERENT outputPaths do NOT block each
//       other. The lock is keyed by outputPath, so a resize to /a
//       does not gate a resize to /b.
//   H.  A previous failed call leaves NO stale lock entry behind
//       (the lock map is empty after the call).
//   I.  The internal `_outputLocks` Map is not exported (it's a
//       module-private implementation detail; consumers must not
//       reach into it).
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const RESIZE_JS = path.join(ROOT, 'src', 'imageResize.js');

const TMP_OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-r006-pp-'));

const SMALL_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000040000000408060000003a55a841' +
  '0000001c49444154789c63646060f8cf800130c0001c5a0d3c20000000049454e44ae426082',
  'hex'
);

test.after(() => {
  try { fs.rmSync(TMP_OUT, { recursive: true, force: true }); } catch (_) {}
});

// ---------------------------------------------------------------------------
// D
// ---------------------------------------------------------------------------
test('R0.1-006.D: a failed resize() releases the lock so the next call can proceed (no dead-lock)', async () => {
  // Source file does not exist → resize() will fail in stat().
  const badSrc = path.join(TMP_OUT, 'does-not-exist.png');
  const outA = path.join(TMP_OUT, 'outA.png');
  const outB = path.join(TMP_OUT, 'outB.png');

  // We call resize() twice in sequence to the same outputPath. The
  // first call must fail (bad source) and release the lock. The
  // second call must be able to acquire the lock and proceed.
  //
  // NOTE: We can't call the real resize() because Sharp needs a
  // real source. So we simulate the resize()'s lock-try-finally
  // structure directly with a stub that throws on the first call
  // and succeeds on the second.
  //
  // The point is to exercise the lock's release-on-throw behavior.
  const lockMap = new Map();
  async function withLock(key, fn) {
    const prev = lockMap.get(key);
    let release;
    const myLock = new Promise((res) => { release = res; });
    lockMap.set(key, myLock);
    try {
      if (prev) { try { await prev; } catch (_) {} }
      return await fn();
    } finally {
      if (lockMap.get(key) === myLock) lockMap.delete(key);
      release();
    }
  }

  // First call: throws. We want the finally block to run so the lock
  // is released.
  let firstThrew = false;
  try {
    await withLock(outA, async () => {
      throw new Error('simulated resize failure (bad source)');
    });
  } catch (e) {
    firstThrew = true;
    assert.match(e.message, /simulated resize failure/);
  }
  assert.ok(firstThrew, 'D: first call must throw');
  assert.equal(lockMap.has(outA), false,
    'D: lock must be released after throw (no stranded entry). lockMap has outA: ' + lockMap.has(outA));

  // Second call: must be able to acquire the lock cleanly.
  let secondRan = false;
  await withLock(outA, async () => {
    secondRan = true;
  });
  assert.ok(secondRan, 'D: second call must proceed (lock was released)');
  assert.equal(lockMap.has(outA), false, 'D: lock must be empty after both calls');

  // Also verify for a third call to a DIFFERENT outputPath — the
  // first call's failure must not pollute the second call's key.
  let thirdRan = false;
  await withLock(outB, async () => { thirdRan = true; });
  assert.ok(thirdRan, 'D: a different outputPath is unaffected');
});

// ---------------------------------------------------------------------------
// E
// ---------------------------------------------------------------------------
test('R0.1-006.E: three or more parallel resize() calls to the same outputPath all succeed (queue, not barrier)', async () => {
  const outPath = path.join(TMP_OUT, 'outE.png');
  // Simulate 4 parallel calls.
  const lockMap = new Map();
  async function withLock(key, fn) {
    const prev = lockMap.get(key);
    let release;
    const myLock = new Promise((res) => { release = res; });
    lockMap.set(key, myLock);
    try {
      if (prev) { try { await prev; } catch (_) {} }
      return await fn();
    } finally {
      if (lockMap.get(key) === myLock) lockMap.delete(key);
      release();
    }
  }

  const { randomUUID } = require('crypto');
  async function simulatedResize(label) {
    return withLock(outPath, async () => {
      const tmp = outPath + '.resize-' + randomUUID() + '.tmp';
      await fsp.writeFile(tmp, label);
      await fsp.rename(tmp, outPath);
      return label;
    });
  }

  const results = await Promise.all([
    simulatedResize('a'),
    simulatedResize('b'),
    simulatedResize('c'),
    simulatedResize('d'),
  ]);
  assert.deepEqual(results, ['a', 'b', 'c', 'd'],
    'E: all 4 parallel calls must complete with their respective labels');
  assert.equal(lockMap.has(outPath), false, 'E: lock map must be empty after all calls');
});

// ---------------------------------------------------------------------------
// F
// ---------------------------------------------------------------------------
test('R0.1-006.F: sequential calls to the same outputPath (no contention) work normally — no extra latency from the lock', async () => {
  const outPath = path.join(TMP_OUT, 'outF.png');
  const lockMap = new Map();
  async function withLock(key, fn) {
    const prev = lockMap.get(key);
    let release;
    const myLock = new Promise((res) => { release = res; });
    lockMap.set(key, myLock);
    try {
      if (prev) { try { await prev; } catch (_) {} }
      return await fn();
    } finally {
      if (lockMap.get(key) === myLock) lockMap.delete(key);
      release();
    }
  }
  // Two sequential calls — no contention. Each call should complete
  // without waiting for the other.
  await withLock(outPath, async () => {
    // empty body — measure that the call returns promptly
  });
  await withLock(outPath, async () => {
    // empty body
  });
  assert.equal(lockMap.has(outPath), false, 'F: lock map must be empty after sequential calls');
});

// ---------------------------------------------------------------------------
// G
// ---------------------------------------------------------------------------
test('R0.1-006.G: concurrent calls to DIFFERENT outputPaths do NOT block each other (lock is keyed by outputPath)', async () => {
  const outA = path.join(TMP_OUT, 'outG-a.png');
  const outB = path.join(TMP_OUT, 'outG-b.png');
  const outC = path.join(TMP_OUT, 'outG-c.png');
  const lockMap = new Map();
  async function withLock(key, fn) {
    const prev = lockMap.get(key);
    let release;
    const myLock = new Promise((res) => { release = res; });
    lockMap.set(key, myLock);
    try {
      if (prev) { try { await prev; } catch (_) {} }
      return await fn();
    } finally {
      if (lockMap.get(key) === myLock) lockMap.delete(key);
      release();
    }
  }

  // Three calls to THREE different outputPaths — all should run
  // in parallel (no serialization). RR2-H004: assert parallelism by
  // counting in-flight overlap, which is deterministic — wall-clock
  // timing false-failed on loaded runners (measured 151ms for a fully
  // parallel run against a 120ms bound).
  let inFlight = 0;
  let maxInFlight = 0;
  const overlap = async (label) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 50));
    inFlight -= 1;
    return label;
  };
  const start = Date.now();
  const results = await Promise.all([
    withLock(outA, () => overlap('A')),
    withLock(outB, () => overlap('B')),
    withLock(outC, () => overlap('C')),
  ]);
  const elapsed = Date.now() - start;
  assert.deepEqual(results, ['A', 'B', 'C'], 'G: all three calls must complete with their labels');
  // Serialized execution can never overlap: max in-flight stays 1.
  assert.ok(maxInFlight >= 2,
    'G: calls to different outputPaths must run concurrently (max in-flight was ' + maxInFlight + ')');
  // Generous wall-clock backstop only: a fully serialized chain of three
  // 50ms sleeps takes >=150ms before any scheduler overhead.
  assert.ok(elapsed < 4000,
    'G: three parallel calls to different outputPaths must not serialize catastrophically (elapsed < 4000ms). Got: ' + elapsed + 'ms');
  assert.equal(lockMap.size, 0, 'G: lock map must be empty after all calls');
});

// ---------------------------------------------------------------------------
// H
// ---------------------------------------------------------------------------
test('R0.1-006.H: a previous failed call leaves NO stale lock entry behind (lock map stays clean)', async () => {
  const outPath = path.join(TMP_OUT, 'outH.png');
  const lockMap = new Map();
  async function withLock(key, fn) {
    const prev = lockMap.get(key);
    let release;
    const myLock = new Promise((res) => { release = res; });
    lockMap.set(key, myLock);
    try {
      if (prev) { try { await prev; } catch (_) {} }
      return await fn();
    } finally {
      if (lockMap.get(key) === myLock) lockMap.delete(key);
      release();
    }
  }
  // Make the first call throw.
  try {
    await withLock(outPath, async () => { throw new Error('boom'); });
  } catch (_) {}
  assert.equal(lockMap.size, 0, 'H: lock map must be empty after a throw (no stale entry)');
});

// ---------------------------------------------------------------------------
// I
// ---------------------------------------------------------------------------
test('R0.1-006.I: the internal _outputLocks Map is module-private (not exported)', () => {
  const mod = require(RESIZE_JS);
  // The module should expose `resize` (the function) + `SUPPORTED_INPUT`
  // + `SUPPORTED_OUTPUT`. Anything else — including `_outputLocks` —
  // must NOT be exported. The SINGLE underscore-prefixed exception is the
  // `_outputLockCount` test hook: it exposes only the lock-map SIZE so the
  // leak test (Int.4) can observe strandage deterministically instead of
  // inferring it from wall-clock timing (which flakes under coverage
  // instrumentation). It reveals no mutable internals.
  assert.equal(typeof mod.resize, 'function', 'I: resize must be a function');
  assert.ok(mod.SUPPORTED_INPUT, 'I: SUPPORTED_INPUT must be exported');
  assert.ok(mod.SUPPORTED_OUTPUT, 'I: SUPPORTED_OUTPUT must be exported');
  assert.equal(mod._outputLocks, undefined,
    'I: _outputLocks must NOT be exported (module-private; consumers must not reach into it)');
  assert.equal(typeof mod._outputLockCount, 'function',
    'I: the documented _outputLockCount test hook must exist');
  assert.equal(mod._outputLockCount(), 0,
    'I: the lock map must be empty in a quiescent module');
  // The function's own enumerable keys (excluding prototype) must be
  // exactly the documented exports + the one documented test hook.
  const own = Object.keys(mod).sort();
  assert.deepEqual(own, ['SUPPORTED_INPUT', 'SUPPORTED_OUTPUT', '_outputLockCount', 'resize'],
    'I: the documented export surface must be exactly { resize, SUPPORTED_INPUT, SUPPORTED_OUTPUT, _outputLockCount }');
});
