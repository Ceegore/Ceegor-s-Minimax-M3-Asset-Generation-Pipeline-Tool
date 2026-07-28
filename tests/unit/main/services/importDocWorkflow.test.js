// tests/unit/main/services/importDocWorkflow.test.js
// Verifies the shared workflow module (importDocWorkflow.js) exports the
// expected constants and that the 7-phase catalogue-then-compose pattern
// is present in both MD and TXT formats.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { PHASES_MD, PHASES_TXT, KICKOFF_PROMPT, CHECKPASS_PROMPT } = require('../../../../main/services/importDocWorkflow');

test('PHASES_MD is a substantial string with all 7 phases', () => {
  assert.ok(typeof PHASES_MD === 'string' && PHASES_MD.length > 2000, 'MD phases is substantial');
  assert.ok(PHASES_MD.includes('Phase 1'), 'Phase 1 present');
  assert.ok(PHASES_MD.includes('Phase 2'), 'Phase 2 present');
  assert.ok(PHASES_MD.includes('Phase 3'), 'Phase 3 present');
  assert.ok(PHASES_MD.includes('Phase 4'), 'Phase 4 present');
  assert.ok(PHASES_MD.includes('Phase 5'), 'Phase 5 present');
  assert.ok(PHASES_MD.includes('Phase 6'), 'Phase 6 present');
  assert.ok(PHASES_MD.includes('Phase 7'), 'Phase 7 present');
});

test('PHASES_MD documents the catalogue-then-compose pattern', () => {
  assert.ok(PHASES_MD.includes('SCENE BIBLE'), 'Scene Bible section present');
  assert.ok(PHASES_MD.includes('CHARACTER BIBLE'), 'Character Bible section present');
  assert.ok(/VERBATIM/i.test(PHASES_MD), 'verbatim rule stated');
  assert.ok(/concatenat/i.test(PHASES_MD), 'concatenation rule stated');
});

test('PHASES_MD includes a worked example with verbatim repetition', () => {
  assert.ok(PHASES_MD.includes('Worked example'), 'worked example present');
  assert.ok(PHASES_MD.includes('S1'), 'Scene ID S1 in example');
  assert.ok(PHASES_MD.includes('C1'), 'Character ID C1 in example');
  assert.ok(PHASES_MD.includes('Elara'), 'character name in example');
});

test('PHASES_TXT mirrors the MD phases (no drift)', () => {
  assert.ok(typeof PHASES_TXT === 'string' && PHASES_TXT.length > 1500, 'TXT phases is substantial');
  assert.ok(PHASES_TXT.includes('PHASE 1'), 'TXT Phase 1 present');
  assert.ok(PHASES_TXT.includes('PHASE 7'), 'TXT Phase 7 present');
  assert.ok(PHASES_TXT.includes('SCENE BIBLE'), 'TXT Scene Bible present');
  assert.ok(PHASES_TXT.includes('CHARACTER BIBLE'), 'TXT Character Bible present');
  assert.ok(/VERBATIM/i.test(PHASES_TXT), 'TXT verbatim rule stated');
});

test('KICKOFF_PROMPT instructs the AI to follow the structured workflow', () => {
  assert.ok(typeof KICKOFF_PROMPT === 'string' && KICKOFF_PROMPT.length > 200, 'kickoff is substantial');
  assert.ok(KICKOFF_PROMPT.includes('Scene Bible'), 'references Scene Bible');
  assert.ok(KICKOFF_PROMPT.includes('Character Bible'), 'references Character Bible');
  assert.ok(/decision questions/i.test(KICKOFF_PROMPT), 'references decision questions');
  assert.ok(KICKOFF_PROMPT.includes('[PASTE YOUR GDD HERE'), 'has GDD placeholder');
});

test('CHECKPASS_PROMPT instructs a strict review pass', () => {
  assert.ok(typeof CHECKPASS_PROMPT === 'string' && CHECKPASS_PROMPT.length > 200, 'checkpass is substantial');
  assert.ok(/HARD character limits/i.test(CHECKPASS_PROMPT), 'references HARD limits');
  assert.ok(/byte-for-byte/i.test(CHECKPASS_PROMPT), 'references byte-for-byte consistency');
  assert.ok(/style header/i.test(CHECKPASS_PROMPT), 'references style header check');
});

test('Phase 6 decision questions cover all required topics', () => {
  assert.ok(PHASES_MD.includes('Output folder'), 'output folder question');
  assert.ok(PHASES_MD.includes('Pipeline usage'), 'pipeline usage question');
  assert.ok(PHASES_MD.includes('Style consistency'), 'style consistency question');
  assert.ok(PHASES_MD.includes('Variants'), 'variants question');
  assert.ok(PHASES_MD.includes('Format'), 'format question');
  assert.ok(PHASES_MD.includes('Naming'), 'naming question');
});
