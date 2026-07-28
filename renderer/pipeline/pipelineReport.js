// renderer/pipeline/pipelineReport.js
// A reusable Markdown report writer for the Pipeline's clear/export operations.
// When the user clears the Final column (with report) or exports finals (with
// report), this builds a small .md listing every asset removed from the board
// so there's an auditable record of what was cleared/exported.
//
// The report is written:
//   1. to the configured report folder (Settings → General → Report folder), or
//   2. next to the exported assets (when exporting — the destination folder), or
//   3. to the final column's folder (the workspace/`final` or its custom folder).
//
// Each asset entry records: name, id, source dimensions (if cached), final
// format + file size, the column history, the final file path, and (when
// exporting) the export destination. The filename is timestamped + non-clashing.

(function () {
  'use strict';
  const M = () => window.PipelineModel || null;

  // Renderer path shim (mirrors pipelineOps/pipelineCardExtras).
  const path = {
    sep(p) { return (String(p).includes('\\')) ? '\\' : '/'; },
    basename(p) { const s = path.sep(p); return String(p).split(s).pop(); },
    dirname(p) { const s = path.sep(p); const parts = String(p).split(s); return parts.slice(0, -1).join(s); },
    join(...parts) {
      if (!parts.length) return '';
      const s = path.sep(String(parts[0]));
      // Preserve the leading separator(s) of the FIRST part so UNC roots
      // (\\server\share) and absolute paths survive the join; only strip
      // separators at the boundaries of subsequent parts to avoid doubles.
      return parts.map((x, i) => {
        let p = String(x).replace(/[\\/]+$/, '');
        if (i > 0) p = p.replace(/^[\\/]+/, '');
        return p;
      }).filter(Boolean).join(s);
    },
  };

  // Zero-pad a number to 2 digits (for the timestamp).
  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  // Build a timestamp string YYYY-MM-DD_HHMMSS (local time) for the filename.
  function timestamp(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
      + '_' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
  }

  // Human-readable timestamp for the report header.
  function readableTimestamp(d) {
    d = d || new Date();
    return d.toLocaleString();
  }

  // Resolve where the report should be written.
  //   config.report_dir (if set)  → always there
  //   else exportDir (if given)   → next to the exported assets
  //   else finalDir (the assets' folder) → alongside the cleared assets
  function resolveReportDir(opts) {
    opts = opts || {};
    const cfg = (window.state && window.state.config) || {};
    if (cfg.report_dir && typeof cfg.report_dir === 'string' && cfg.report_dir.trim()) {
      return cfg.report_dir.trim();
    }
    if (opts.exportDir) return opts.exportDir;
    if (opts.finalDir) return opts.finalDir;
    // Fallback: the workspace's final folder.
    const board = window.state && window.state.pipeline && window.state.pipeline.image;
    if (board && board.workspace) {
      const cf = board.columnFolders && board.columnFolders.final;
      if (cf) return cf;
      return path.join(board.workspace, 'final');
    }
    return '';
  }

  // Summarise one asset for the report. Pure (no I/O).
  function summarizeAsset(item, opts) {
    opts = opts || {};
    const finalPath = item.files && item.files.final;
    const dims = item._dims || {};
    const ext = finalPath ? (path.basename(finalPath).split('.').pop() || '').toUpperCase() : '';
    return {
      name: item.name || '(unnamed)',
      id: item.id || '',
      finalPath: finalPath || '(none)',
      finalBasename: finalPath ? path.basename(finalPath) : '(none)',
      format: ext,
      width: dims.w || 0,
      height: dims.h || 0,
      status: item.status || '',
      exportDest: opts.exportDir || '',
      historyCount: Array.isArray(item.history) ? item.history.length : 0,
      createdAt: item.createdAt || 0,
    };
  }

  // Build the full Markdown body. Pure (no I/O).
  function buildReportMarkdown(items, opts) {
    opts = opts || {};
    const mode = opts.mode || 'clear'; // 'clear' | 'export'
    const exportDir = opts.exportDir || '';
    const summaries = items.map((it) => summarizeAsset(it, { exportDir }));

    const lines = [];
    lines.push('# Pipeline ' + (mode === 'export' ? 'export' : 'clear') + ' report');
    lines.push('');
    lines.push('_Generated ' + readableTimestamp() + ' by Ceegor\'s Minimax M3 Asset Generation Pipeline Tool._');
    lines.push('');
    lines.push('**Mode:** ' + (mode === 'export' ? 'Export + remove' : 'Clear (remove only)'));
    lines.push('**Assets in this report:** ' + summaries.length);
    if (exportDir) lines.push('**Export destination:** `' + exportDir + '`');
    const reportDir = opts.reportDir || '';
    if (reportDir) lines.push('**Report written to:** `' + reportDir + '`');
    lines.push('');
    lines.push('---');
    lines.push('');

    if (!summaries.length) {
      lines.push('_(no assets were removed)_');
      return lines.join('\n');
    }

    // Per-asset detail blocks.
    for (let i = 0; i < summaries.length; i++) {
      const s = summaries[i];
      lines.push('## ' + (i + 1) + '. ' + s.name);
      lines.push('');
      lines.push('| Field | Value |');
      lines.push('|---|---|');
      lines.push('| ID | `' + s.id + '` |');
      if (s.width && s.height) lines.push('| Resolution | ' + s.width + ' × ' + s.height + ' px |');
      if (s.format) lines.push('| Format | ' + s.format + ' |');
      lines.push('| Final file | `' + s.finalPath + '` |');
      if (mode === 'export' && exportDir) {
        lines.push('| Exported to | `' + path.join(exportDir, s.finalBasename) + '` |');
      }
      lines.push('| History entries | ' + s.historyCount + ' |');
      if (s.status && s.status !== 'idle') lines.push('| Status | ' + s.status + ' |');
      lines.push('');
    }

    // Compact list at the end for quick scanning / copy-paste.
    lines.push('---');
    lines.push('');
    lines.push('## Asset list');
    lines.push('');
    for (const s of summaries) {
      lines.push('- **' + s.name + '** (`' + s.id + '`) — ' + s.finalBasename
        + (s.width && s.height ? ' · ' + s.width + '×' + s.height : '')
        + (s.format ? ' · ' + s.format : ''));
    }
    lines.push('');
    return lines.join('\n');
  }

  // Choose a non-clashing report filename in `dir`. Uses fbExists to avoid
  // overwriting a prior report (e.g. two clears in the same second).
  // mode = 'clear' | 'export' picks the filename prefix.
  async function chooseReportPath(dir, d, mode) {
    if (!dir) return '';
    const base = mode === 'export' ? 'pipeline_export_report' : 'pipeline_clear_report';
    const stem = base + '_' + timestamp(d);
    // Prefer .md; if it exists, append _2, _3, …
    let candidate = path.join(dir, stem + '.md');
    let n = 1;
    while (n < 9999) {
      try {
        // BGR-009 fix: mint read grant for fbExists (R1.3 gate).
        const existsGrant = (window.GrantHelper) ? await window.GrantHelper.ensureRead(candidate) : undefined;
        // R6: a failed grant envelope must not be forwarded — fb:exists would resolve {ok:false,exists:false} and we'd return an unverifiable name as "free" (overwriting the report). Treat as occupied so the _N suffix advances.
        const r = (existsGrant && existsGrant.ok === false) ? { ok: true, exists: true } : await window.api.fbExists(candidate, existsGrant);
        if (!r || !r.ok || !r.exists) return candidate;
      } catch (_) { return candidate; /* assume free */ }
      n += 1;
      candidate = path.join(dir, stem + '_' + n + '.md');
    }
    return candidate;
  }

  // Write the report for the given items. Returns { ok, path } or { ok:false }.
  // Ensures the destination dir exists, then writes atomically via fbWrite.
  async function writeReport(items, opts) {
    opts = opts || {};
    if (!Array.isArray(items) || items.length === 0) return { ok: false, error: 'No items to report.' };
    const dir = resolveReportDir(opts);
    if (!dir) return { ok: false, error: 'Could not resolve a report folder. Set one in Settings → General → Report folder.' };
    try {
      // BGR-009 fix: mint mkdir grant for fbEnsureDir (R1.3 gate).
      const dirGrant = (window.GrantHelper) ? await window.GrantHelper.ensureDir(dir) : undefined;
      const ensure = await window.api.fbEnsureDir(dir, dirGrant);
      if (!ensure || !ensure.ok) {
        return { ok: false, error: 'Could not create the report folder: ' + ((ensure && ensure.error) || dir) };
      }
      const reportPath = await chooseReportPath(dir, new Date(), opts.mode || 'clear');
      if (!reportPath) return { ok: false, error: 'Could not build a report file path.' };
      const md = buildReportMarkdown(items, Object.assign({}, opts, { reportDir: dir }));
      // fbWrite takes a base64 string. Encode UTF-8 → base64.
      const b64 = btoa(unescape(encodeURIComponent(md)));
      // R1.5a.follow-up Phase 4: mint grant for reportPath before write.
      // PRE-1: use window.GrantCache (no require in sandbox).
      const wg = window.api && window.api.mintGrant ? await window.GrantCache.ensurePathGrant(reportPath, 'write') : undefined;
      if (wg && wg.ok === false) return { ok: false, error: wg.error || 'mintGrant failed' };
      const r = await window.api.fbWrite(reportPath, b64, wg);
      if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'write failed' };
      return { ok: true, path: reportPath };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  window.PipelineReport = {
    resolveReportDir, buildReportMarkdown, summarizeAsset,
    writeReport, timestamp, readableTimestamp,
  };
})();
