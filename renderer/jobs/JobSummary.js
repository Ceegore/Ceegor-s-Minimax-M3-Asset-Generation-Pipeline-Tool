// renderer/jobs/JobSummary.js
// ============================================================================
// At the end of a batch (when the last child finishes), emit a single
// "Batch finished: 18/20 ok, 2 failed (1 quota, 1 network)" log event
// with jobId pointing to the batch parent (the first job in the batch,
// or a virtual id chosen by the caller).
//
// The summary line uses `warn` if anything failed, else `ok`. The
// failure breakdown is appended to the details so the user can click
// the row to see what failed (and why).
//
// This is a thin renderer-side helper. The batch parent tracking
// happens in the caller (typically batchManager.js). The helper
// itself just builds the summary string and emits the log event.
//
// Public API:
//   emit(parentJobId, results) -> number (the emitted log event id)
//
//   results is an array of { status, error? } entries, one per child.
//   Order doesn't matter; the helper counts totals + failures.
// ============================================================================

(function () {
  function _buildSummary(results) {
    let ok = 0;
    let err = 0;
    let warn = 0;
    let cancel = 0;
    const failureReasons = new Map(); // reason → count
    let unknown = 0;
    for (const r of results) {
      if (!r) continue;
      if (r.status === 'ok') ok++;
      else if (r.status === 'warn') { warn++; }
      else if (r.status === 'cancel') { cancel++; }
      else if (r.status === 'err') { err++; }
      else {
        // Treat unknown / undefined status as err and count it in the
        // unknown bucket so the cause is visible in the breakdown.
        err++;
        unknown++;
      }
      if (r.status === 'err' || r.status === 'warn' || (r.status !== 'ok' && r.status !== 'cancel' && r.status !== undefined && r.status !== null)) {
        // Guard against a non-string r.error (e.g. an object) — would
        // otherwise throw TypeError and lose the whole summary. Record
        // a row for every non-ok entry, including unknown-status ones,
        // so the breakdown stays accurate.
        const errStr = (typeof r.error === 'string' && r.error)
          ? r.error
          : (r.error && r.error.message) ? String(r.error.message) : 'unknown';
        const reason = errStr.toLowerCase().slice(0, 80);
        failureReasons.set(reason, (failureReasons.get(reason) || 0) + 1);
      }
    }
    void unknown; // tracked in failureReasons under '(unknown status)'
    const total = ok + err + warn + cancel;
    const headline =
      `Batch finished: ${ok}/${total} ok` +
      (err ? `, ${err} failed` : '') +
      (warn ? `, ${warn} partial` : '') +
      (cancel ? `, ${cancel} cancelled` : '');
    // Build the failure breakdown lines. Sort by count desc.
    const lines = [];
    if (failureReasons.size) {
      lines.push('Failures:');
      const sorted = Array.from(failureReasons.entries()).sort((a, b) => b[1] - a[1]);
      for (const [reason, count] of sorted) {
        lines.push(`  ${count}× ${reason}`);
      }
    }
    return { headline, lines, ok, err, warn, cancel, total };
  }

  function emit(parentJobId, results) {
    if (!window.LogService || typeof window.LogService.addLogEvent !== 'function') return -1;
    if (!Array.isArray(results) || results.length === 0) return -1;
    const summary = _buildSummary(results);
    // The status of the row mirrors the highest-severity child:
    //   err > warn > cancel > ok
    let state = 'ok';
    if (summary.err) state = 'err';
    else if (summary.warn) state = 'warn';
    else if (summary.cancel) state = 'warn'; // cancel is also a "warn" colour

    return window.LogService.addLogEvent({
      category: 'gen',
      jobId: parentJobId || null,
      // The summary is NOT cancellable — the parent is already done by the
      // time we emit. No need for a Cancel button on this row.
      cancellable: false,
      headline: summary.headline,
      details: summary.lines,
      state,
      result: summary.err ? 'err' : 'ok',
      typeIcon: '∑',
      // Pin to top of the visible (newest) area when multiple summaries
      // are present. (pinToBottom means visually at the top in the
      // column-reverse flex; the user sees newest-at-bottom so this
      // is informational.)
      pinToBottom: false,
    });
  }

  window.JobSummary = { emit, _buildSummary };
})();