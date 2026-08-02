// tests/unit/src/services/OperationResult.m053.test.js
// ============================================================================
// M-053 regression: strict status enums + deliverables-aware status matrix.
// Covers EVERY combination of required/optional stage error, deliverables,
// and cancel override (tabular, per the audit acceptance criteria).
// ============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { OperationResult, STAGE_STATUS, OP_STATUS } = require('../../../../src/services/OperationResult');

/**
 * Build an OperationResult from a compact spec.
 * @param {{ stages?: Array<[string, object?]>, deliverables?: number, override?: string }} spec
 */
function build(spec) {
  const op = new OperationResult('matrix-test');
  for (const [status, opts] of spec.stages || []) {
    op.addStage('stage', status, status === 'error' ? 'boom' : undefined, opts);
  }
  for (let i = 0; i < (spec.deliverables || 0); i++) op.addDeliverable(`/out/file${i}.png`);
  if (spec.override) op.setStatus(spec.override);
  return op;
}

test('M-053: full status matrix (stages × deliverables × override)', () => {
  /** [description, spec, expectedStatus, expectedOk, expectedPartial] */
  const MATRIX = [
    ['no stages, no deliverables',
      { stages: [] }, OP_STATUS.OK, true, false],
    ['all ok stages',
      { stages: [['ok'], ['ok']], deliverables: 1 }, OP_STATUS.OK, true, false],
    ['skipped + warning stages only',
      { stages: [['skipped'], ['warning']] }, OP_STATUS.OK, true, false],
    ['optional error only, no deliverables',
      { stages: [['error', { required: false }]] }, OP_STATUS.OK_WITH_WARNINGS, true, false],
    ['optional error + ok stage + deliverable',
      { stages: [['ok'], ['error', { required: false }]], deliverables: 1 },
      OP_STATUS.OK_WITH_WARNINGS, true, false],
    ['required error, no deliverables',
      { stages: [['error', { required: true }]] }, OP_STATUS.FAILED, false, false],
    ['required error (default required), no deliverables',
      { stages: [['error']] }, OP_STATUS.FAILED, false, false],
    ['required error + deliverables',
      { stages: [['ok'], ['error']], deliverables: 2 }, OP_STATUS.PARTIAL, false, true],
    ['required + optional error + deliverable',
      { stages: [['error'], ['error', { required: false }]], deliverables: 1 },
      OP_STATUS.PARTIAL, false, true],
    ['cancel override, no deliverables',
      { stages: [['ok']], override: OP_STATUS.CANCELLED }, OP_STATUS.CANCELLED, false, false],
    ['cancel override AFTER deliverables were produced',
      { stages: [['ok']], deliverables: 1, override: OP_STATUS.CANCELLED },
      OP_STATUS.PARTIAL_CANCELLED, false, true],
    ['failed override wins over ok stages',
      { stages: [['ok']], deliverables: 1, override: OP_STATUS.FAILED }, OP_STATUS.FAILED, false, false],
  ];

  for (const [desc, spec, expStatus, expOk, expPartial] of MATRIX) {
    const op = build(spec);
    assert.equal(op.status, expStatus, `${desc}: status`);
    assert.equal(op.ok, expOk, `${desc}: ok`);
    assert.equal(op.partial, expPartial, `${desc}: partial`);
  }
});

test('M-053: addStage rejects arbitrary status strings', () => {
  const op = new OperationResult('enum-test');
  for (const bad of ['okay', 'success', 'ERROR', 'fail', '', null, undefined, 42]) {
    assert.throws(() => op.addStage('s', bad), /invalid stage status/, `stage status ${String(bad)}`);
  }
  // All enum values are accepted.
  for (const good of Object.values(STAGE_STATUS)) {
    op.addStage('s', good);
  }
  assert.equal(op.stages.length, Object.values(STAGE_STATUS).length);
});

test('M-053: setStatus rejects arbitrary status strings', () => {
  const op = new OperationResult('enum-test');
  for (const bad of ['done', 'OK', 'canceled', '', null, undefined]) {
    assert.throws(() => op.setStatus(bad), /invalid status/, `op status ${String(bad)}`);
  }
  for (const good of Object.values(OP_STATUS)) {
    op.setStatus(good); // must not throw
  }
});

test('M-053: a mistyped stage status can no longer skew the derived status', () => {
  // Before the fix, addStage('x', 'eror') was silently stored and the stage
  // never counted as an error → the operation reported ok. Now it throws at
  // the call site, so the bug is caught in development instead of shipping.
  const op = new OperationResult('typo-test');
  op.addStage('generate', STAGE_STATUS.OK);
  assert.throws(() => op.addStage('upscale', 'eror', 'failed hard'), /invalid stage status/);
  assert.equal(op.status, OP_STATUS.OK, 'the invalid stage was never recorded');
});
