// tests/unit/main/models/ConfigSchema.test.js
// Unit-Tests für den Config-Sanitizer.

const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitize } = require('../../../../main/models/ConfigSchema');

test('sanitize accepts a complete valid config', () => {
  const out = sanitize({
    api_key: 'sk-abc',
    output_dir: 'C:/out',
    region: 'cn',
    theme: 'light',
    styles: [{ name: 'cinematic', value: 'cinematic, 8k' }],
  });
  assert.equal(out.api_key, 'sk-abc');
  assert.equal(out.output_dir, 'C:/out');
  assert.equal(out.region, 'cn');
  assert.equal(out.theme, 'light');
  assert.deepEqual(out.styles, [{ name: 'cinematic', value: 'cinematic, 8k' }]);
});

test('sanitize filters unknown region to "global"', () => {
  assert.equal(sanitize({ region: 'pluto' }).region, 'global');
  assert.equal(sanitize({ region: 'cn' }).region, 'cn');
  assert.equal(sanitize({ region: 'GLOBAL' }).region, 'global');
});

test('sanitize filters unknown theme to "dark"', () => {
  assert.equal(sanitize({ theme: 'pink' }).theme, 'dark');
  assert.equal(sanitize({ theme: 'light' }).theme, 'light');
});

test('sanitize coerces non-string api_key to empty string', () => {
  assert.equal(sanitize({ api_key: 42 }).api_key, '');
  assert.equal(sanitize({ api_key: null }).api_key, '');
  assert.equal(sanitize({ api_key: { x: 1 } }).api_key, '');
});

test('sanitize drops styles with missing name/value', () => {
  const out = sanitize({
    styles: [
      { name: 'good', value: 'ok' },
      { name: 'no-value' },
      { value: 'no-name' },
      null,
      'string',
      { name: 'a', value: 'b', extra: 'dropped' },
    ],
  });
  assert.deepEqual(out.styles, [
    { name: 'good', value: 'ok' },
    { name: 'a', value: 'b' },
  ]);
});

test('sanitize strips unknown top-level keys', () => {
  const out = sanitize({
    api_key: 'k',
    malicious: 'rm -rf /',
    prototype: { hacked: true },
  });
  assert.equal(out.api_key, 'k');
  assert.equal('malicious' in out, false);
  assert.equal('prototype' in out, false);
});

test('sanitize handles null/undefined input', () => {
  const out1 = sanitize(null);
  const out2 = sanitize(undefined);
  assert.equal(out1.api_key, '');
  assert.equal(out1.theme, 'dark');
  assert.equal(out2.region, 'global');
});

// Task 4 (critical data-loss regression): sanitize() used to whitelist only
// api_key/output_dir/region/theme/styles. external_tools and report_dir were
// dropped on every config:set, wiping them from config.txt. Both are now
// whitelisted. removebg_api_key was REMOVED (H7-018); it must NOT survive.
test('sanitize keeps external_tools (data-loss regression)', () => {
  const out = sanitize({
    external_tools: [{ name: 'GIMP', exe: 'C:\\gimp.exe', args: '' }],
  });
  assert.equal(out.external_tools.length, 1);
  assert.equal(out.external_tools[0].name, 'GIMP');
});

test('sanitize drops removebg_api_key (H7-018 — feature removed)', () => {
  const out = sanitize({ removebg_api_key: 'secret-key' });
  assert.equal('removebg_api_key' in out, false, 'the removed key must not be in the sanitized output');
});

test('sanitize keeps report_dir (Task 3a)', () => {
  assert.equal(sanitize({ report_dir: 'E:\\reports' }).report_dir, 'E:\\reports');
  // non-string coerces to ''
  assert.equal(sanitize({ report_dir: 123 }).report_dir, '');
  assert.equal(sanitize({}).report_dir, '');
});

test('sanitize default external_tools is [] (not undefined)', () => {
  assert.deepEqual(sanitize({}).external_tools, []);
  assert.deepEqual(sanitize({ external_tools: 'nope' }).external_tools, []);
});

// Task 4 (360° audit, HIGH): a newline in ANY scalar config value is written
// verbatim to config.txt (parsed line-by-line), so it injects an extra
// key=value directive and can overwrite api_key / output_dir / etc. on the next
// read. Every scalar must have CR/LF (and other control chars) stripped.
test('sanitize strips newlines from scalar fields (INI-injection regression)', () => {
  const out = sanitize({
    api_key: 'real\napi_key=PWNED',
    output_dir: 'D:/o\nregion=cn',
    report_dir: 'E:/r\ntheme=light',
  });
  for (const v of [out.api_key, out.output_dir, out.report_dir]) {
    assert.ok(!v.includes('\n'), 'no newline survives sanitize: ' + JSON.stringify(v));
    assert.ok(!v.includes('\r'), 'no CR survives sanitize');
  }
  // The injected text is collapsed to a space (it stays part of the SAME key's
  // value rather than becoming a separate directive), so it can't overwrite
  // another key. The end-to-end round-trip test below proves that definitively.
});

test('sanitize round-trip cannot overwrite another key via newline (end-to-end)', () => {
  // Drive the full config:set path: sanitize → serialize → parse.
  const cfgMod = require('../../../../src/config');
  const safe = sanitize({ api_key: 'real', report_dir: 'E:/ok\napi_key=PWNED' });
  const text = cfgMod.serialize(safe);
  const back = cfgMod.parse(text);
  assert.equal(back.api_key, 'real', 'api_key is NOT overwritten by the injected report_dir newline');
});
