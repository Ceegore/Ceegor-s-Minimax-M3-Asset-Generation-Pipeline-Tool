// scripts/e2e/scenarios/zz-no-errors.js
// ============================================================================
// Ported from scripts/smoke-renderer.js step 8 (global error sweep).
//
// Runs LAST (order 99): asserts that across the ENTIRE run there were no
// uncaught / error-level console messages from the renderer and no
// main-process errors (registrar failures, render-process-gone, preload
// errors). consoleMsgs/mainErrors accumulate on the harness for the whole
// run, so checking them here matches the monolith's end-of-run sweep.
// ============================================================================

module.exports = {
  name: 'zz-no-errors',
  needsRealApi: false,
  order: 99,
  async run(ctx) {
    const { check, consoleMsgs, mainErrors } = ctx;
    const consoleErrors = consoleMsgs.filter((m) => /uncaught|referenceerror|typeerror|is not defined|is not a function|cannot read|syntaxerror/i.test(m.message));
    check(consoleErrors.length === 0, `console errors: ${JSON.stringify(consoleErrors).slice(0, 400)}`);
    check(mainErrors.length === 0, `main-process errors: ${JSON.stringify(mainErrors).slice(0, 400)}`);
  },
};
