// tests/unit/renderer/tabs/speechStyleBehavior.test.js
// H9-010: speech generation must compose the selected style preset into the
// spoken text (it used to send raw textarea text and silently drop the style).
// Source-pattern guard: speechTab must call buildFinalPrompt AND validate the
// composed string AND push the composed string into args.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const SPEECH = fs.readFileSync(path.join(ROOT, 'renderer', 'tabs', 'speechTab.js'), 'utf8');

test('H9-010 speechTab composes the style via buildFinalPrompt', () => {
  assert.match(SPEECH, /buildFinalPrompt\(styleRow\.sel,\s*text\.input\)/);
});

test('H9-010 speechTab validates the COMPOSED text (not the raw textarea)', () => {
  // The validation param must read composedText, and the preflight text field
  // must pass composedText too.
  assert.match(SPEECH, /'--text':\s*\{\s*getValue:\s*\(\)\s*=>\s*composedText\s*\}/);
  assert.match(SPEECH, /text:\s*composedText/);
});

test('H9-010 speechTab pushes the composed text into mmx args', () => {
  assert.match(SPEECH, /args\.push\('--text',\s*composedText\)/);
  // And it must NOT push the raw txt any more.
  assert.doesNotMatch(SPEECH, /args\.push\('--text',\s*txt\)/);
});
