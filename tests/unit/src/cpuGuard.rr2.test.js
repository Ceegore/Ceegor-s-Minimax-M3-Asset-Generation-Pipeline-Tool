// RR2-B003 (release requalification 1.0.4 recheck-2): de-waive cpuGuard.js.
// Every branch of the module is reachable through the os-module injection
// points and the duck-typed sharp instance, so the file is held at
// 100/100/100 by the coverage gate WITHOUT a waiver.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const cpuGuard = require(path.join(ROOT, 'src', 'cpuGuard.js'));

// Run a scenario with patched os-module properties and always restore.
function withOs(patch, fn) {
  const saved = {};
  try {
    for (const [k, v] of Object.entries(patch)) {
      saved[k] = os[k];
      os[k] = v;
    }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) os[k] = v;
  }
}

test('RR2-B003: getSafeThreadCount uses availableParallelism when present', () => {
  withOs({ availableParallelism: () => 8 }, () => {
    assert.equal(cpuGuard.getSafeThreadCount(), 6);
  });
});

test('RR2-B003: getSafeThreadCount falls back to cpus() when availableParallelism is absent', () => {
  withOs({ availableParallelism: undefined, cpus: () => new Array(6) }, () => {
    assert.equal(cpuGuard.getSafeThreadCount(), 4);
  });
});

test('RR2-B003: getSafeThreadCount falls back to 4 cores when cpus() returns nothing', () => {
  withOs({ availableParallelism: undefined, cpus: () => null }, () => {
    // (null || []).length -> 0, 0 || 4 -> 4, max(1, 4-2) = 2
    assert.equal(cpuGuard.getSafeThreadCount(), 2);
  });
  withOs({ availableParallelism: undefined, cpus: () => [] }, () => {
    assert.equal(cpuGuard.getSafeThreadCount(), 2);
  });
});

test('RR2-B003: getSafeThreadCount never returns less than 1 on tiny hosts', () => {
  withOs({ availableParallelism: () => 1 }, () => {
    assert.equal(cpuGuard.getSafeThreadCount(), 1);
  });
  withOs({ availableParallelism: () => 2 }, () => {
    assert.equal(cpuGuard.getSafeThreadCount(), 1);
  });
});

test('RR2-B003: applySharpThreadCap applies the safe count to a capable sharp instance', () => {
  let seen = null;
  withOs({ availableParallelism: () => 10 }, () => {
    cpuGuard.applySharpThreadCap({ concurrency: (n) => { seen = n; } });
  });
  assert.equal(seen, 8);
});

test('RR2-B003: applySharpThreadCap is a no-op without a concurrency function', () => {
  assert.doesNotThrow(() => cpuGuard.applySharpThreadCap(null));
  assert.doesNotThrow(() => cpuGuard.applySharpThreadCap(undefined));
  assert.doesNotThrow(() => cpuGuard.applySharpThreadCap({}));
  assert.doesNotThrow(() => cpuGuard.applySharpThreadCap({ concurrency: 4 }));
});

test('RR2-B003: applySharpThreadCount swallows a throwing sharp instance', () => {
  assert.doesNotThrow(() => {
    cpuGuard.applySharpThreadCap({ concurrency: () => { throw new Error('libvips boom'); } });
  });
});

test('RR2-B003: getSafeProcessEnv merges a provided base env', () => {
  const env = withOs({ availableParallelism: () => 6 }, () => cpuGuard.getSafeProcessEnv({ FOO: 'bar' }));
  assert.equal(env.FOO, 'bar');
  assert.equal(env.OMP_NUM_THREADS, '4');
  assert.equal(env.VIPS_CONCURRENCY, '4');
  assert.equal(env.UV_THREADPOOL_SIZE, '4');
});

test('RR2-B003: getSafeProcessEnv defaults to process.env without a base', () => {
  const env = cpuGuard.getSafeProcessEnv();
  assert.ok(typeof env.OMP_NUM_THREADS === 'string');
  assert.ok(parseInt(env.OMP_NUM_THREADS, 10) >= 1);
});
