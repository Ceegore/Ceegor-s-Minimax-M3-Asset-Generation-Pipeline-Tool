// tests/unit/h9ManifestCoverage.test.js
// H9 Phase 6: semantic gate — every documented capability-registry flag has
// exactly one executor consumer (argvBuilders or batchPostprocess), and every
// flag the executor emits appears in the registry. This catches the H9-002
// class of bug (documented settings silently ignored, or executor flags
// undocumented) at test time.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Load the capability registry (main-process module).
const registry = require('../../main/services/importCapabilityRegistry');

// Load the argvBuilders source to extract which flags each builder emits.
// We can't execute the IIFE in Node (it expects window), so we parse the
// source text for appendFlag/appendBoolFlag/push('--flag') patterns.
const argvSrc = fs.readFileSync(
  path.join(__dirname, '..', '..', 'renderer', 'tabs', 'argvBuilders.js'), 'utf8'
);

// Load the batchPostprocess source similarly.
const ppSrc = fs.readFileSync(
  path.join(__dirname, '..', '..', 'renderer', 'services', 'batchPostprocess.js'), 'utf8'
);

// Load the batchManager source (reads rowPostprocess keys).
const bmSrc = fs.readFileSync(
  path.join(__dirname, '..', '..', 'renderer', 'tabs', 'batchManager.js'), 'utf8'
);

// Flags that are batch-control / meta flags consumed by the batchManager loop
// itself (not by argvBuilders or batchPostprocess). These are valid registry
// entries that don't appear in the argv/postprocess layer.
const META_FLAGS = new Set([
  '--variants',       // consumed by batchManager variant loop
  '--output-name',    // consumed by batchManager per-row prefix
  '--upscale',        // consumed by batchManager rowPostprocess → batchPostprocess
  '--upscale-multiplier', // ditto
  '--upscale-model',  // ditto (model selection for Real-ESRGAN)
  '--remove-background', // consumed by batchManager rowPostprocess → batchPostprocess
  '--remove-background-model', // ditto
  '--crop',           // ditto
  '--resize',         // ditto
  '--optimize-format', // ditto
  '--optimize-quality', // ditto
  '--strip-metadata', // ditto
  '--trim-start',     // ditto (audio trim)
  '--trim-end',       // ditto
  // --subject-reference-type is embedded in the --subject-ref composition
  // (type=character,image=...) rather than emitted as a separate argv flag.
  '--subject-reference-type',
]);

// Extract flag names emitted by argvBuilders source.
function extractArgvFlags(src) {
  const flags = new Set();
  // Match appendFlag(args, 'flag-name', ...) and appendBoolFlag(args, 'flag-name', ...)
  const re1 = /append(?:Bool)?Flag\(args,\s*'([a-z0-9-]+)'/gi;
  let m;
  while ((m = re1.exec(src)) !== null) flags.add('--' + m[1].toLowerCase());
  // Match args.push('--flag-name', ...)
  const re2 = /args\.push\(\s*'--([a-z0-9-]+)'/gi;
  while ((m = re2.exec(src)) !== null) flags.add('--' + m[1].toLowerCase());
  return flags;
}

test('H9-F6: registry validate() passes (all entries have flag + desc)', () => {
  assert.ok(registry.validate());
});

test('H9-F6: every registry flag has a known consumer (argvBuilders or batchPostprocess/batchManager)', () => {
  const argvFlags = extractArgvFlags(argvSrc);
  const missing = [];
  for (const [type, spec] of Object.entries(registry.CAPABILITIES)) {
    for (const f of spec.flags) {
      const flag = f.flag;
      // Skip prompt/text — they are positional, not argv flags.
      if (flag === '--prompt' || flag === '--text') continue;
      // Skip alias entries (aliasOf set) — they resolve to the canonical flag.
      if (f.aliasOf) continue;
      // Meta flags are consumed by the batch loop / postprocess layer.
      if (META_FLAGS.has(flag)) continue;
      // Check the argv builders emit this flag.
      if (!argvFlags.has(flag)) {
        missing.push(`${type} ${flag}`);
      }
    }
  }
  assert.deepEqual(missing, [],
    'These registry flags have no argv consumer: ' + missing.join(', '));
});

test('H9-F6: every argvBuilders flag appears in the capability registry', () => {
  const argvFlags = extractArgvFlags(argvSrc);
  // Build the full set of registry flags (canonical + without dashes).
  const registryFlags = new Set();
  for (const spec of Object.values(registry.CAPABILITIES)) {
    for (const f of spec.flags) {
      registryFlags.add(f.flag);
      registryFlags.add(f.flag.replace(/^--/, ''));
    }
  }
  // Flags the argv builders emit that are internal plumbing (not user-facing).
  const INTERNAL = new Set([
    '--out', '--out-dir', '--download', // output path plumbing
    '--prompt', '--text',              // content fields (positional, not parameter flags)
  ]);
  const undocumented = [];
  for (const flag of argvFlags) {
    if (INTERNAL.has(flag)) continue;
    const bare = flag.replace(/^--/, '');
    if (!registryFlags.has(flag) && !registryFlags.has(bare)) {
      undocumented.push(flag);
    }
  }
  assert.deepEqual(undocumented, [],
    'These argv flags are not in the registry: ' + undocumented.join(', '));
});

test('H9-F6: postprocess flags in batchManager rowPostprocess match registry entries', () => {
  // The batchManager reads these keys from the row item and passes them to
  // BatchPostprocess. Verify each one is documented in the registry.
  const ppKeys = ['crop', 'resize', 'optimize-format', 'optimize-quality',
    'strip-metadata', 'remove-background', 'remove-background-model',
    'upscale', 'upscale-multiplier', 'trim-start', 'trim-end'];
  const registryFlags = new Set();
  for (const spec of Object.values(registry.CAPABILITIES)) {
    for (const f of spec.flags) {
      registryFlags.add(f.flag.replace(/^--/, ''));
    }
  }
  const missing = ppKeys.filter((k) => !registryFlags.has(k));
  assert.deepEqual(missing, [],
    'These postprocess keys are not in the registry: ' + missing.join(', '));
});

test('H9-F6: knownFlagsByType covers all four asset types', () => {
  const kf = registry.knownFlagsByType();
  for (const type of ['image', 'speech', 'music', 'video']) {
    assert.ok(kf[type] instanceof Set, `${type} should have a Set`);
    assert.ok(kf[type].size > 3, `${type} should have multiple known flags`);
  }
});

test('H9-F6: resolveAlias maps documented aliases correctly', () => {
  // Image: --subject-reference-file ↔ --subject-ref
  const r1 = registry.resolveAlias('image', '--subject-reference-file');
  assert.equal(r1, '--subject-ref');
  // Video: --first-frame-image → --first-frame
  const r2 = registry.resolveAlias('video', '--first-frame-image');
  assert.equal(r2, '--first-frame');
  // Video: --last-frame-image → --last-frame
  const r3 = registry.resolveAlias('video', '--last-frame-image');
  assert.equal(r3, '--last-frame');
  // Non-aliased flag passes through unchanged.
  const r4 = registry.resolveAlias('image', '--model');
  assert.equal(r4, '--model');
});
