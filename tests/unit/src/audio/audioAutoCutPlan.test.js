const test = require('node:test');
const assert = require('node:assert/strict');
const { planAutoCut, sanitizeAutoCutRules } = require('../../../../src/audio/AudioAutoCutPlan');

test('sanitizeAutoCutRules clamps and defaults properly', () => {
  const clean = sanitizeAutoCutRules({
    minSegmentSec: -1,
    maxSegmentSec: 500,
    longSegmentPolicy: 'unknown',
    padMs: -10,
    maxSegments: 2000
  });
  assert.equal(clean.minSegmentSec, 0.15); // defaulted
  assert.equal(clean.maxSegmentSec, 300);  // max clamped
  assert.equal(clean.longSegmentPolicy, 'truncate'); // defaulted
  assert.equal(clean.padMs, 0); // min clamped
  assert.equal(clean.maxSegments, 1000); // max clamped
});

// 360° audit fix: a NEGATIVE maxSegmentSec (corrupted/hand-edited state.json)
// previously clamped to 0 (unlimited) via Math.max(0, ...) — silently
// switching the policy. It must now fall back to the documented default 3.0,
// consistent with how invalid minSegmentSec / maxSegments fall back.
test('sanitizeAutoCutRules: negative maxSegmentSec → default 3.0 (not 0/unlimited)', () => {
  assert.equal(sanitizeAutoCutRules({ maxSegmentSec: -50 }).maxSegmentSec, 3.0, 'negative → default');
  assert.equal(sanitizeAutoCutRules({ maxSegmentSec: NaN }).maxSegmentSec, 3.0, 'NaN → default');
  assert.equal(sanitizeAutoCutRules({ maxSegmentSec: 'abc' }).maxSegmentSec, 3.0, 'non-numeric → default');
  // An EXPLICIT 0 is still honoured (it means "unlimited", a valid user choice).
  assert.equal(sanitizeAutoCutRules({ maxSegmentSec: 0 }).maxSegmentSec, 0, 'explicit 0 preserved');
  assert.equal(sanitizeAutoCutRules({ maxSegmentSec: 5 }).maxSegmentSec, 5, 'valid value preserved');
});

test('planAutoCut drops segments shorter than minSegmentSec', () => {
  const segments = [
    { start: 0, end: 0.1 },
    { start: 1, end: 2.0 }
  ];
  const rules = { minSegmentSec: 0.2, padMs: 0 };
  const res = planAutoCut(segments, rules, 10);
  assert.equal(res.segments.length, 1);
  assert.equal(res.segments[0].startSec, 1.0);
  assert.equal(res.stats.droppedShort, 1);
});

test('planAutoCut splits segments based on maxSegmentSec', () => {
  const segments = [
    { start: 1.0, end: 6.5 }
  ];
  const rules = {
    minSegmentSec: 1.0,
    maxSegmentSec: 3.0,
    longSegmentPolicy: 'split',
    padMs: 0
  };
  const res = planAutoCut(segments, rules, 10);
  assert.equal(res.segments.length, 2);
  assert.equal(res.segments[0].startSec, 1.0);
  assert.equal(res.segments[0].endSec, 4.0);
  assert.equal(res.segments[1].startSec, 4.0);
  assert.equal(res.segments[1].endSec, 6.5);
  assert.equal(res.stats.split, 1);
});

test('planAutoCut splits segments and merges last piece if too short', () => {
  const segments = [
    { start: 1.0, end: 5.5 }
  ];
  const rules = {
    minSegmentSec: 2.0,
    maxSegmentSec: 3.0,
    longSegmentPolicy: 'split',
    padMs: 0
  };
  const res = planAutoCut(segments, rules, 10);
  assert.equal(res.segments.length, 1);
  assert.equal(res.segments[0].startSec, 1.0);
  assert.equal(res.segments[0].endSec, 5.5);
  assert.equal(res.stats.split, 1);
});

test('planAutoCut applies padding with gap constraint', () => {
  const segments = [
    { start: 1.0, end: 2.0 },
    { start: 2.1, end: 3.0 }
  ];
  const rules = {
    minSegmentSec: 0.1,
    maxSegmentSec: 0,
    padMs: 100 // 0.1s padding
  };
  const res = planAutoCut(segments, rules, 10);
  assert.equal(res.segments[0].startSec, 0.9);
  assert.equal(res.segments[0].endSec, 2.05);
  assert.equal(res.segments[1].startSec, 2.05);
  assert.equal(res.segments[1].endSec, 3.1);
});

test('planAutoCut caps at maxSegments', () => {
  const segments = [
    { start: 1, end: 2 },
    { start: 3, end: 4 },
    { start: 5, end: 6 }
  ];
  const rules = { maxSegments: 2, padMs: 0 };
  const res = planAutoCut(segments, rules, 10);
  assert.equal(res.segments.length, 2);
  assert.equal(res.stats.capped, 1);
});

// Regression: the 'skip' long-segment policy previously counted dropped
// (too-long) segments into `droppedShort`, so the renderer's stats line
// read "N dropped: too short" for segments that were actually too LONG.
// The fix adds a separate `droppedLong` bucket. (audit H3 / BUG #2)
test('planAutoCut: skip policy counts too-long drops in droppedLong, not droppedShort', () => {
  const segments = [{ start: 0, end: 10 }]; // 10s — longer than maxSegmentSec=3
  const res = planAutoCut(segments, { longSegmentPolicy: 'skip', maxSegmentSec: 3, padMs: 0 }, 10);
  assert.equal(res.segments.length, 0);
  assert.equal(res.stats.droppedLong, 1, 'too-long skip drop must land in droppedLong');
  assert.equal(res.stats.droppedShort, 0, 'must NOT be miscounted as droppedShort');
  assert.ok(!('droppedLong' in res.stats) === false, 'droppedLong must exist on stats');
});

// Regression: `kept` previously reported the post-cap count, so a plan of
// 3 segments with maxSegments=1 reported "1 planned (2 capped)" — conflating
// "planned" with "kept after cap". The fix reports the pre-cap planned count.
// (audit BUG #3)
test('planAutoCut: kept reflects pre-cap planned count, not post-cap', () => {
  const segments = [
    { start: 1, end: 2 },
    { start: 3, end: 4 },
    { start: 5, end: 6 }
  ];
  const res = planAutoCut(segments, { maxSegments: 1, padMs: 0 }, 10);
  assert.equal(res.segments.length, 1, 'only 1 survives the cap');
  assert.equal(res.stats.kept, 3, 'kept = pre-cap planned count');
  assert.equal(res.stats.capped, 2);
});

// Regression: the duration clamp is the load-bearing edge for the padding
// step. When duration is omitted (unit-test path / a future caller), the
// clamp must degrade gracefully (treat as unbounded) rather than throw or
// silently skip. (audit BUG #1)
test('planAutoCut: omittable duration — no clamp when undefined, clamps when provided', () => {
  const seg = [{ start: 0, end: 5 }];
  const noDur = planAutoCut(seg, { padMs: 1000, maxSegmentSec: 0 }); // no duration
  assert.equal(noDur.segments[0].endSec, 6, 'no duration → end not clamped (5 + 1s pad)');
  const withDur = planAutoCut(seg, { padMs: 1000, maxSegmentSec: 0 }, 5);
  assert.equal(withDur.segments[0].endSec, 5, 'duration=5 → end clamped to 5');
});

// Regression: planAutoCut must also tolerate non-finite / negative duration
// values without throwing (defensive against a corrupted probe() result).
test('planAutoCut: non-finite / negative duration is treated as unbounded', () => {
  const seg = [{ start: 0, end: 5 }];
  for (const bad of [undefined, null, NaN, -1, Infinity, 'oops']) {
    const res = planAutoCut(seg, { padMs: 0, maxSegmentSec: 0 }, bad);
    assert.equal(res.segments.length, 1, `duration=${bad} must not throw or drop the segment`);
  }
});
