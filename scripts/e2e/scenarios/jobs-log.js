// scripts/e2e/scenarios/jobs-log.js
// ============================================================================
// Ported from scripts/smoke-renderer.js step 5c (log-chevron expand).
//
// The reported symptom was that every log entry's ">" chevron did nothing
// because LogService.setupLogClicks() was never wired (LogService.init()
// was never called from bootstrap.js). This scenario seeds its own log row
// with a details payload (the harness reset() clears the log first, so it
// cannot rely on leftover rows the way the monolith did), clicks the chev,
// and asserts the row expands + the chevron glyph flips.
// ============================================================================

module.exports = {
  name: 'jobs-log',
  needsRealApi: false,
  order: 50,
  async run(ctx) {
    // NOTE: `exec` is the harness's win.webContents.executeJavaScript() — NOT child_process.exec.
    const { exec, check } = ctx;

    const logChev = await exec(`(async () => {
      const log = document.querySelector('#log');
      if (!log) return { error: 'no #log' };
      // Seed a row that HAS details so there is something to expand (the
      // harness reset() cleared the log; the monolith relied on leftovers).
      if (window.LogService && window.LogService.addLogEvent) {
        window.LogService.addLogEvent({ category: 'info', headline: 'chev-probe', details: ['path C:/x/y.mp3', 'size 123'] });
      }
      await new Promise((r) => setTimeout(r, 100));
      // Find a row that has both a chevron and a details block.
      let row = null, chev = null, details = null;
      for (const r of log.querySelectorAll('.log-event')) {
        const c = r.querySelector('.log-event-chev');
        const d = r.querySelector('.log-event-details');
        if (c && d) { row = r; chev = c; details = d; break; }
      }
      if (!row) return { error: 'no log row with a chevron + details' };
      const beforeDisp = details.style.display;
      const beforeChev = chev.textContent;
      chev.click();
      await new Promise((r) => setTimeout(r, 100));
      const afterDisp = details.style.display;
      const afterChev = chev.textContent;
      return { beforeDisp, beforeChev, afterDisp, afterChev,
        rowCount: log.querySelectorAll('.log-event').length,
        hasDetails: !!details };
    })()`);
    check(!logChev.error, `log pane has no row to click the chev on: ${logChev.error || 'unknown'}`);
    if (!logChev.error) {
      check(logChev.beforeDisp === 'none',
        `the log row's details should start collapsed — got display="${logChev.beforeDisp}"`);
      check(logChev.afterDisp !== logChev.beforeDisp,
        `clicking the chev MUST change the details display from "${logChev.beforeDisp}" to something else. The chev click handler is wired by LogService.init() (called from bootstrap.js) — if it's not wired, this assertion fails.`);
      check(logChev.afterChev !== logChev.beforeChev,
        `clicking the chev MUST change its text from "${logChev.beforeChev}" to something else (e.g. "▸" ↔ "▾")`);
    }
  },
};
