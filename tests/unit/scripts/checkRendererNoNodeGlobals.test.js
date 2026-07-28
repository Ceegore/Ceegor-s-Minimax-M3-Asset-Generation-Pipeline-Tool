// tests/unit/scripts/checkRendererNoNodeGlobals.test.js
// Regression coverage for the renderer Node-global guardrail
// (scripts/check-renderer-no-node-globals.js).
//
// The headline case is the QA-032 false-negative, caught by a 360° audit:
// a REAL `process.` leak on the line that CLOSES a multi-line template
// literal was being silently dropped, because the line-finder re-stripped
// each line in isolation (resetting comment/template state) instead of
// reusing the whole-file strip. These tests pin the corrected behaviour so
// the guardrail can never quietly stop guarding again.
const assert = require('node:assert/strict');
const test = require('node:test');

const { scanFile, stripCommentsAndStrings } = require('../../../scripts/check-renderer-no-node-globals');

test('QA-032 regression: process. leak on the closing line of a multi-line template is detected', () => {
  const src = [
    'const html = `',
    '<div>hi</div>',
    '`; process.platform;',
    '',
  ].join('\n');
  const hits = scanFile(src, 'renderer/x.js');
  const proc = hits.find((h) => h.label === 'process');
  assert.ok(proc, 'expected a process. violation to be reported');
  assert.equal(proc.lineNo, 3, 'violation must be attributed to the closing line (3)');
});

test('QA-032 regression: Buffer leak after a multi-line block comment is detected', () => {
  const src = [
    '/* note',
    '   spans lines */',
    'const b = Buffer.from("x");',
    '',
  ].join('\n');
  const hits = scanFile(src, 'renderer/x.js');
  assert.ok(hits.some((h) => h.label === 'Buffer' && h.lineNo === 3), 'expected Buffer violation on line 3');
});

test('a forbidden token mentioned in a comment is NOT flagged', () => {
  const hits = scanFile('// process.platform is forbidden here\nconst x = 1;\n', 'renderer/x.js');
  assert.equal(hits.length, 0);
});

test('a forbidden token inside a string literal is NOT flagged', () => {
  const hits = scanFile('const msg = "use require( carefully";\n', 'renderer/x.js');
  assert.equal(hits.length, 0);
});

test('a bare require( in real code IS detected', () => {
  const hits = scanFile('const fs = require("fs");\n', 'renderer/x.js');
  assert.ok(hits.some((h) => h.label === 'require()'), 'expected require() violation');
});

test('@node-global-allow suppresses only the annotated line', () => {
  const src = [
    '// @node-global-allow',
    'const r = require("fs");',
    'const p = process.env;',
    '',
  ].join('\n');
  const hits = scanFile(src, 'renderer/x.js');
  // require on line 2 is suppressed; process on line 3 is NOT.
  assert.equal(hits.filter((h) => h.label === 'require()').length, 0, 'annotated require must be suppressed');
  assert.ok(hits.some((h) => h.label === 'process' && h.lineNo === 3), 'unannotated process must still be caught');
});

test('@node-global-allowlist header exempts the whole file for that token', () => {
  const src = [
    '/* @node-global-allowlist: require() */',
    'const r = require("fs");',
    '',
  ].join('\n');
  const hits = scanFile(src, 'renderer/x.js');
  assert.equal(hits.filter((h) => h.label === 'require()').length, 0, 'allowlisted token must be exempt file-wide');
});

test('a clean renderer file yields no hits', () => {
  const src = 'const el = document.querySelector("#x");\nwindow.api.doThing();\n';
  assert.equal(scanFile(src, 'renderer/x.js').length, 0);
});

test('stripCommentsAndStrings preserves newline count (1:1 line mapping)', () => {
  // The whole fix rests on this invariant: the strip keeps newlines 1:1 so
  // splitting the stripped source lines up exactly with the original file.
  const src = 'a\n/* block\ncomment */\nconst t = `\nml`;\nb';
  const stripped = stripCommentsAndStrings(src);
  assert.equal(stripped.split('\n').length, src.split('\n').length, 'line count must be preserved for accurate attribution');
});

test('CLI smoke: the guardrail exits 0 on the current (clean) renderer/', () => {
  // End-to-end exercise of the require.main branch (walk + exit code) that
  // the pure scanFile() unit tests above never touch. Doubles as a live
  // guard: if a Node-global leak lands in renderer/, this fails loudly.
  const { spawnSync } = require('node:child_process');
  const path = require('node:path');
  const script = path.join(__dirname, '..', '..', '..', 'scripts', 'check-renderer-no-node-globals.js');
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(r.status, 0, 'guardrail must pass on the clean repo: ' + (r.stderr || r.stdout));
  assert.match(r.stdout, /OK/);
});
