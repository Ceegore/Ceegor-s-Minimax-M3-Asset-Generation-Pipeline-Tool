// Seed-test for the anti-pattern guards.
//
// Each case feeds the scanner a synthetic file containing the exact defect the
// corresponding guard exists to catch, and asserts the guard's regex MATCHES —
// and, just as importantly, that the same pattern inside a comment or a string
// literal does NOT match. That second half is what keeps the guards trusted:
// the first draft fired on its own comments and on a textarea placeholder, and
// a guard that cries wolf gets deleted rather than fixed.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { stripNonCode, scan, scanWithStrings, countPerFile } = require('../helpers/sourceScan');

function withFile(contents, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-ap-'));
  const rel = 'seeded.js';
  fs.writeFileSync(path.join(dir, rel), contents, 'utf8');
  try { return fn(dir, [rel]); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const PROMPT_RE = /(^|[^.\w$])prompt\s*\(/;
const SHARP_RE = /\bsharp\(\s*[A-Za-z_$][\w$]*[Pp]ath\s*\)/;
const NODE_GLOBALS_RE = /(^|[^A-Za-z0-9_.$])(process\.(platform|env|cwd|argv|versions)|require\(|__dirname|__filename)/;
const TAIL_RE = /\|\s*tail\b/;
const ADVISORY_RE = /ok:\s*true\s*,\s*advisory/;
const DIALOG_RE = /(^|[^.\w$])(confirm|alert)\s*\(/gm;

test('seed: the prompt() guard catches a real call and ignores comments/strings', () => {
  withFile('const typed = prompt("Type DELETE");\n', (d, f) => {
    assert.strictEqual(scan(d, f, PROMPT_RE).length, 1, 'a real prompt() call must be caught');
  });
  withFile('// the main prompt (mirrors batchManager)\nconst x = "prepended to your prompt (e.g. foo)";\n', (d, f) => {
    assert.deepStrictEqual(scan(d, f, PROMPT_RE), [], 'a comment or string mentioning prompt( must NOT fire');
  });
  withFile('await window.asyncPrompt("q", "DELETE");\n', (d, f) => {
    assert.deepStrictEqual(scan(d, f, PROMPT_RE), [], 'asyncPrompt must not be flagged');
  });
});

test('seed: the sharp(<path>) guard catches the leak form and ignores the buffer form', () => {
  withFile('const meta = await sharp(srcPath).metadata();\n', (d, f) => {
    assert.strictEqual(scan(d, f, SHARP_RE).length, 1, 'sharp(srcPath) must be caught');
  });
  withFile('const meta = await sharp(outputPath).metadata();\n', (d, f) => {
    assert.strictEqual(scan(d, f, SHARP_RE).length, 1, 'sharp(outputPath) must be caught');
  });
  withFile('const meta = await sharp(await fsp.readFile(srcPath)).metadata();\n', (d, f) => {
    assert.deepStrictEqual(scan(d, f, SHARP_RE), [], 'the buffer form is correct and must NOT fire');
  });
  withFile('const m = await sharp(srcBuf).metadata();\nawait sharp(raw, { raw: {} }).png();\n', (d, f) => {
    assert.deepStrictEqual(scan(d, f, SHARP_RE), [], 'buffer/raw forms must NOT fire');
  });
});

test('seed: the renderer node-globals guard catches each global', () => {
  for (const bad of [
    'if (process.platform === "win32") {}',
    'const v = process.env.HOME;',
    'const x = require("fs");',
    'const p = __dirname + "/x";',
  ]) {
    withFile(bad + '\n', (d, f) => {
      assert.strictEqual(scan(d, f, NODE_GLOBALS_RE).length, 1, `must catch: ${bad}`);
    });
  }
  // The false-positive that bit the first draft: a method whose NAME contains
  // "process" is not the Node global.
  withFile('await window.BatchPostprocess.runRowPostprocess(files, pp);\n', (d, f) => {
    assert.deepStrictEqual(scan(d, f, NODE_GLOBALS_RE), [], 'runRowPostprocess must NOT fire');
  });
  withFile('// process.platform is unavailable here\n', (d, f) => {
    assert.deepStrictEqual(scan(d, f, NODE_GLOBALS_RE), [], 'a comment must NOT fire');
  });
});

test('seed: the `| tail` guard catches exit-code masking', () => {
  // | tail lives inside a string literal (shell command), so we use
  // scanWithStrings (strips comments only, keeps strings intact).
  withFile('const cmd = execSync("npm test | tail -20");\n', (d, f) => {
    assert.strictEqual(scanWithStrings(d, f, TAIL_RE).length, 1);
  });
  withFile('const out = run("npm test"); const code = out.status;\n', (d, f) => {
    assert.deepStrictEqual(scanWithStrings(d, f, TAIL_RE), []);
  });
});

test('seed: the advisory-gate guard catches ok:true alongside failures', () => {
  withFile('return { ok: true, advisory: true, failures };\n', (d, f) => {
    assert.strictEqual(scan(d, f, ADVISORY_RE).length, 1);
  });
  withFile('return { ok: failures.length === 0, failures };\n', (d, f) => {
    assert.deepStrictEqual(scan(d, f, ADVISORY_RE), []);
  });
});

test('seed: the blocking-dialog counter counts code only', () => {
  withFile('alert("x"); if (confirm("y")) {}\n', (d, f) => {
    assert.deepStrictEqual(countPerFile(d, f, DIALOG_RE), { 'seeded.js': 2 });
  });
  withFile('// alert("x") and confirm("y") are banned\nconst s = "call alert( here)";\n', (d, f) => {
    assert.deepStrictEqual(countPerFile(d, f, DIALOG_RE), {}, 'comments/strings must not be counted');
  });
  withFile('await asyncConfirm("q"); window.myAlert("z");\n', (d, f) => {
    assert.deepStrictEqual(countPerFile(d, f, DIALOG_RE), {}, 'asyncConfirm / a dotted call must not be counted');
  });
});

test('seed: stripNonCode preserves line numbers', () => {
  const src = 'const a = 1;\n/* block\n   spanning\n   lines */\nconst b = prompt("x");\n';
  const stripped = stripNonCode(src);
  assert.strictEqual(stripped.split('\n').length, src.split('\n').length,
    'line count must be preserved or every reported line number is wrong');
  assert.match(stripped.split('\n')[4], /prompt\(/, 'code on line 5 must survive');
  assert.doesNotMatch(stripped.split('\n')[1], /block/, 'block-comment text must be blanked');
});
