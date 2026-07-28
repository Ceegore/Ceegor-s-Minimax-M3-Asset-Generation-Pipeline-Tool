// tests/unit/main/models/ConfigSchema.qa.test.js
// Phase 4 (adversarial QA) — deepens the ConfigSchema security coverage.
// The existing ConfigSchema.test.js proves the headline injection + data-loss
// fixes; these tests close the remaining gaps:
//   - external_tools NAME/EXE/ARGS are themselves INI-injection vectors (each
//     is a scalar written to config.txt) → must strip CR/LF/|
//   - a tool missing name OR exe is dropped (unusable)
//   - field-length clamping (TOOL_*_MAX)
//   - standalone \r and other C0 control chars in scalars
//   - report_dir end-to-end persistence (parse ↔ serialize round-trip)
//   - removebg_api_key end-to-end (not just sanitize)
//   - malicious args field can't inject a pipe-delimited directive

const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitize } = require('../../../../main/models/ConfigSchema');
const cfgMod = require('../../../../src/config');

// ------------------------------------------------- external_tools deep tests
test('external_tools: a newline in name/exe/args cannot inject an INI directive', () => {
  const out = sanitize({
    external_tools: [
      { name: 'GIMP\napi_key=PWNED', exe: 'C:\\gimp.exe', args: '' },
      { name: 'ok', exe: 'D:\\tool.exe\nregion=cn', args: '' },
      { name: 'ok2', exe: 'D:\\t2.exe', args: '-flag\ntheme=light' },
    ],
  });
  assert.equal(out.external_tools.length, 3);
  for (const t of out.external_tools) {
    assert.ok(!t.name.includes('\n'), 'name must have no LF');
    assert.ok(!t.exe.includes('\n'), 'exe must have no LF');
    assert.ok(!t.args.includes('\n'), 'args must have no LF');
    // The injected directive text is collapsed to a space, never forming its
    // own line — confirmed by the round-trip below.
  }
});

test('external_tools: pipe chars are stripped from name/exe/args', () => {
  // config.txt is pipe-delimited for the external_tools line; a raw | in a
  // field would shift every subsequent field. sanitize must neutralise it.
  const out = sanitize({
    external_tools: [{ name: 'a|b', exe: 'c|d', args: 'e|f' }],
  });
  assert.equal(out.external_tools.length, 1);
  const t = out.external_tools[0];
  assert.ok(!t.name.includes('|'), 'name must have no pipe');
  assert.ok(!t.exe.includes('|'), 'exe must have no pipe');
  assert.ok(!t.args.includes('|'), 'args must have no pipe');
});

test('external_tools: tool with empty name OR empty exe is dropped', () => {
  const out = sanitize({
    external_tools: [
      { name: '', exe: 'C:\\x.exe', args: '' },   // no name → drop
      { name: 'NoExe', exe: '', args: '' },         // no exe → drop
      { name: '   ', exe: 'C:\\y.exe', args: '' },  // whitespace name → drop
      { name: 'Good', exe: 'C:\\z.exe', args: '' }, // keep
    ],
  });
  assert.equal(out.external_tools.length, 1);
  assert.equal(out.external_tools[0].name, 'Good');
});

test('external_tools: non-array / non-object entries are dropped', () => {
  const out = sanitize({
    external_tools: ['nope', 42, null, { name: 'ok', exe: 'ok.exe' }, undefined, {}],
  });
  assert.equal(out.external_tools.length, 1);
  assert.equal(out.external_tools[0].name, 'ok');
});

test('external_tools: args is optional and defaults to "" when absent', () => {
  const out = sanitize({ external_tools: [{ name: 'T', exe: 't.exe' }] });
  assert.equal(out.external_tools[0].args, '');
});

test('external_tools: fields are clamped to their size caps', () => {
  const long = 'x'.repeat(5000);
  const out = sanitize({ external_tools: [{ name: long, exe: long, args: long }] });
  const t = out.external_tools[0];
  // Caps from the module: name 80, exe 1024, args 1024.
  assert.ok(t.name.length <= 80, 'name clamped to 80, got ' + t.name.length);
  assert.ok(t.exe.length <= 1024, 'exe clamped to 1024, got ' + t.exe.length);
  assert.ok(t.args.length <= 1024, 'args clamped to 1024, got ' + t.args.length);
});

// ----------------------------------------------- standalone \r / control chars
test('sanitize strips standalone \\r and other C0 control chars from scalars', () => {
  // \r alone (CR, no LF) is also an INI-line break on some parsers.
  const out = sanitize({
    api_key: 'a\rb',
    output_dir: 'o\tx',          // TAB
    report_dir: 'r\x00null',     // NUL
  });
  for (const v of [out.api_key, out.output_dir, out.report_dir]) {
    assert.ok(!/[\r\n\x00-\x1f]/.test(v), 'no C0 control char survives: ' + JSON.stringify(v));
  }
});

// ----------------------------------------------- report_dir end-to-end
test('report_dir survives the full parse ↔ serialize ↔ sanitize round-trip', () => {
  const orig = sanitize({ report_dir: 'E:\\my-reports' });
  const text = cfgMod.serialize(orig);
  assert.ok(text.includes('report_dir=E:\\my-reports'), 'serialize emits the report_dir line');
  const back = cfgMod.parse(text);
  assert.equal(back.report_dir, 'E:\\my-reports');
});

test('report_dir round-trip: blank stays blank (uses asset-folder fallback)', () => {
  const text = cfgMod.serialize(sanitize({ report_dir: '' }));
  const back = cfgMod.parse(text);
  assert.equal(back.report_dir, '');
});

// ----------------------------------------------- removebg_api_key end-to-end
// removebg_api_key was REMOVED (H7-018) — the feature collected the secret
// but never consumed it. The full round-trip must now DROP it, and a legacy
// config.txt that still has the line must parse cleanly without surfacing it.
test('removebg_api_key is dropped across the full round-trip (H7-018)', () => {
  const orig = sanitize({ removebg_api_key: 'rbg-secret-123' });
  assert.equal('removebg_api_key' in orig, false, 'sanitize must not keep the removed key');
  const text = cfgMod.serialize(orig);
  assert.ok(!text.includes('removebg_api_key'), 'serialize must not emit the removed key');
  // A legacy file containing the line must still parse without error.
  const legacy = cfgMod.parse('api_key=k\nremovebg_api_key=legacy\n');
  assert.equal(legacy.api_key, 'k');
  assert.equal(legacy.removebg_api_key, undefined);
});

// ----------------------------------------------- injected-args end-to-end
test('end-to-end: a malicious external_tools args field cannot inject api_key', () => {
  const safe = sanitize({ external_tools: [{ name: 't', exe: 't.exe', args: 'x\napi_key=PWNED' }] });
  const text = cfgMod.serialize(safe);
  const back = cfgMod.parse(text);
  assert.equal(back.api_key, '', 'the args newline did NOT spawn an api_key directive');
});
