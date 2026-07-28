// tests/helpers/effectAssertions.js
// ============================================================================
// Assertions for OBSERVABLE EFFECTS, not return-value shape.
//
// Why this exists: the last three confirmed bugs in this codebase were all the
// same shape — the code ran, the envelope looked right, and the tests passed,
// while the effect on the world was wrong:
//
//   KGO9-001  LaMa inpaint returned ok:true with correct dimensions and filled
//             the hole with a pure-WHITE patch. Nobody asserted the PIXELS.
//   KGO9-002  image:optimize returned its "kept the original" warning, which the
//             legacy adapter then silently dropped. Nobody asserted the ENVELOPE
//             AFTER the adapter — only the module's return value.
//   KGO10-001 optimize() kept a webp unchanged and left an open libvips handle,
//             so the file could not be deleted afterwards. Nobody asserted the
//             file was still USABLE.
//
// Line coverage would not have caught any of them: keepOriginal.js was at 92 %
// and the defective line was executed. The gap is assertions, not execution.
//
// Use these helpers in any test that touches an image, a file, or an IPC
// envelope. They are deliberately blunt and cheap.
// ============================================================================

const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/**
 * Assert that `filePath` is still fully usable after whatever operation just
 * touched it: renamable, deletable, and its directory removable.
 *
 * Catches the file-handle-leak class (KGOOO-1, KGOOO-2, KGO10-001 — three
 * separate shipments). `sharp(<path>).metadata()` leaks a handle on webp;
 * `sharp(<path>)….toFile()` does not. Prefer `sharp(await fsp.readFile(p))`.
 *
 * @param {string} filePath  the file the operation read or wrote
 * @param {string} [label]   context for the failure message
 */
function assertFileUsable(filePath, label = '') {
  const ctx = label ? ` (${label})` : '';
  assert.ok(fs.existsSync(filePath), `assertFileUsable: ${filePath} does not exist${ctx}`);

  const moved = filePath + '.usable-probe';
  try {
    fs.renameSync(filePath, moved);
  } catch (e) {
    assert.fail(`file is LOCKED — cannot rename${ctx}: ${filePath} (${e.code}). `
      + 'Something is holding an open handle; look for a path-based sharp()/fs read.');
  }
  try { fs.renameSync(moved, filePath); } catch (_) { /* restore best-effort */ }

  try {
    fs.unlinkSync(filePath);
  } catch (e) {
    assert.fail(`file is LOCKED — cannot delete${ctx}: ${filePath} (${e.code}).`);
  }
}

/**
 * Assert the whole directory can be removed — the strongest form of "nothing
 * still holds a handle in here". An `EPERM` from rmSync is exactly how
 * KGO10-001 was discovered; it is a signal, never noise.
 *
 * @param {string} dir
 * @param {string} [label]
 */
function assertDirRemovable(dir, label = '') {
  const ctx = label ? ` (${label})` : '';
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    assert.fail(`directory could not be removed${ctx}: ${dir} (${e.code}) — `
      + 'an open file handle is still held somewhere in it.');
  }
}

/**
 * Decode `filePath` and assert things about the actual pixels.
 *
 * Catches the "ran fine, produced garbage" class (KGO9-001): ok:true plus
 * correct width/height told us nothing about whether the image was right.
 *
 * @param {import('sharp')} sharp        the sharp module (injected so this
 *                                       helper has no hard dependency)
 * @param {string} filePath
 * @param {object} opts
 * @param {Array<[number,number]>} [opts.notSaturated]
 *        points that must NOT be blown out to near-white (>=250 on all
 *        channels) — the LaMa failure signature
 * @param {{ ref: string, points: Array<[number,number]>, tolerance?: number }}
 *        [opts.matches]
 *        points that must equal the same points in a reference image, e.g. the
 *        region OUTSIDE an inpaint mask, which must be byte-identical
 * @param {number} [opts.minDistinctColours]
 *        guards against a flat/blank result (the historic blank-save bug)
 */
async function assertPixels(sharp, filePath, opts = {}) {
  const img = await sharp(await fs.promises.readFile(filePath))
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: W, channels: C } = img.info;
  const at = (buf, ch, x, y) => { const i = (y * W + x) * ch; return [buf[i], buf[i + 1], buf[i + 2]]; };

  if (opts.notSaturated) {
    for (const [x, y] of opts.notSaturated) {
      const p = at(img.data, C, x, y);
      assert.ok(!(p[0] >= 250 && p[1] >= 250 && p[2] >= 250),
        `pixel (${x},${y}) is blown out to ${JSON.stringify(p)} — this is the LaMa `
        + 'wrong-tensor-convention signature (output treated as normalised when it is already 0..255).');
    }
  }

  if (opts.matches) {
    const tol = opts.matches.tolerance != null ? opts.matches.tolerance : 2;
    const ref = await sharp(await fs.promises.readFile(opts.matches.ref))
      .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.strictEqual(ref.info.width, W, 'reference image width differs');
    for (const [x, y] of opts.matches.points) {
      const a = at(ref.data, ref.info.channels, x, y);
      const b = at(img.data, C, x, y);
      const diff = a.map((v, i) => Math.abs(v - b[i]));
      assert.ok(diff.every((d) => d <= tol),
        `pixel (${x},${y}) should have been left untouched: reference ${JSON.stringify(a)} `
        + `vs result ${JSON.stringify(b)}`);
    }
  }

  if (opts.minDistinctColours != null) {
    const seen = new Set();
    for (let i = 0; i < img.data.length; i += C * 37) {
      seen.add(img.data[i] + ',' + img.data[i + 1] + ',' + img.data[i + 2]);
    }
    assert.ok(seen.size >= opts.minDistinctColours,
      `image looks blank/flat — only ${seen.size} distinct colours sampled `
      + `(expected >= ${opts.minDistinctColours})`);
  }
}

/**
 * Assert that a handler result survives the IPC envelope adapter intact.
 *
 * Catches the envelope-rewrite class (KGO9-002): `adaptInpaintResult` rebuilt
 * `warnings` from stderr and then spread the validated envelope OVER the
 * handler's result, so structured warnings were destroyed between the module
 * and the renderer. Testing the module's return value could never see it.
 *
 * @param {(result:object, backend:string)=>object} adapt  the adapter under test
 * @param {object} handlerResult  what the handler returns
 * @param {object} expectations
 * @param {string[]} [expectations.warningsContain]  substrings that must survive
 * @param {string[]} [expectations.keepsFields]      fields that must not be lost
 */
function assertIpcEnvelope(adapt, handlerResult, expectations = {}) {
  const out = adapt(handlerResult, 'sharp');
  assert.ok(out && typeof out === 'object', 'adapter returned no envelope');

  for (const needle of expectations.warningsContain || []) {
    assert.ok(Array.isArray(out.warnings), 'envelope.warnings must be an array');
    assert.ok(out.warnings.some((w) => String(w).includes(needle)),
      `warning containing "${needle}" was DROPPED by the envelope adapter. `
      + `Got: ${JSON.stringify(out.warnings)}. The adapter must MERGE handler `
      + 'warnings, never replace them.');
  }

  for (const field of expectations.keepsFields || []) {
    assert.ok(Object.prototype.hasOwnProperty.call(out, field),
      `field "${field}" was lost by the envelope adapter`);
    assert.deepStrictEqual(out[field], handlerResult[field],
      `field "${field}" was altered by the envelope adapter`);
  }
  return out;
}

module.exports = { assertFileUsable, assertDirRemovable, assertPixels, assertIpcEnvelope };
