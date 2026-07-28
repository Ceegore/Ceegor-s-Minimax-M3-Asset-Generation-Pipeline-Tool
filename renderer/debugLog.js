// renderer/debugLog.js
// Loaded FIRST (before every other <script> tag). Installs global
// error handlers that write EVERY renderer error to a file:
//   C:\Projects\Ceegor-s-Minimax-M3-Asset-Generation-Pipeline-Tool\renderer-error.log
//
// Usage: start the tool, reproduce the crash, then read the log file
// in the project root.
//
// Also exposes window.logError(category, location, err) — a thin
// wrapper that calls addLogEvent (so the in-app log pane shows the
// error AND it's persisted in the log buffer) AND console.error (so
// the file logger above captures it). Catch blocks across the
// renderer should use this instead of plain `console.error` so the
// user sees the error in the log pane too.

(function installDebugLogger() {
  if (window.__rendererDebugStarted) return;
  window.__rendererDebugStarted = true;
  const sendToFile = (line) => {
    // window.api may not exist yet (set later by preload). Try every
    // time; no-op when unavailable.
    try {
      if (window.api && typeof window.api.logToFile === 'function') {
        window.api.logToFile(line);
      }
    } catch (_) {}
  };
  // Buffer until window.api is available.
  const buffer = [];
  const flush = () => {
    while (buffer.length) sendToFile(buffer.shift());
  };
  let flushHandle = setInterval(() => {
    if (window.api && typeof window.api.logToFile === 'function') {
      clearInterval(flushHandle); flushHandle = null;
      flush();
    }
  }, 50);
  const log = (msg) => {
    sendToFile(msg);
    buffer.push(msg);
  };
  log('=== renderer-debug started (pid=' + (typeof process !== 'undefined' && process?.pid || 'n/a') + ') ===');
  log('location=' + location.href);
  log('userAgent=' + navigator.userAgent);

  // Register error handlers as early as possible.
  window.addEventListener('error', (e) => {
    const s = 'ERR ' + (e.filename || '?') + ':' + (e.lineno || '?') + ':' + (e.colno || '?') + ' ' + (e.error?.stack || e.error?.message || e.message || 'unknown');
    log(s);
  }, true);
  window.addEventListener('unhandledrejection', (e) => {
    log('REJ ' + (e.reason?.stack || e.reason?.message || e.reason || 'unknown'));
  }, true);
  const origErr = console.error;
  console.error = function() {
    try { log('CE: ' + Array.from(arguments).map(a => a?.stack || a?.message || String(a)).join(' | ')); } catch (_) {}
    origErr.apply(console, arguments);
  };
  const origWarn = console.warn;
  console.warn = function() {
    try { log('CW: ' + Array.from(arguments).map(a => String(a)).join(' | ')); } catch (_) {}
    origWarn.apply(console, arguments);
  };
  // Probe (after all script tags): check whether known vars/funcs are
  // defined, and dump a config + state + addons snapshot so the file
  // log captures what the tool loaded at startup without requiring the
  // user to open DevTools.
  //
  // Every identifier in the probe body must be safe to read at parse
  // time. debugLog.js is the FIRST <script> in index.html - `TABS`,
  // `state`, etc. are not yet declared. `typeof` works on bare
  // undeclared identifiers (e.g. `typeof TABS`) but NOT on member
  // access (`typeof TABS?.image`) because `TABS?.image` evaluates the
  // member access first and ReferenceErrors on the bare identifier.
  // So: only `typeof IDENT`, never `typeof IDENT?.member`.
  let lastProbe = '';
  const probe = setInterval(() => {
    const parts = [
      'applyFileSearch=' + (typeof applyFileSearch),
      'refreshBrowser=' + (typeof refreshBrowser),
      'state=' + (typeof state),
      'window.state=' + (typeof window.state),
      'TABS=' + (typeof TABS),
      'init=' + (typeof init),
    ];
    // Dump a redacted config snapshot so we know what the tool
    // actually loaded from disk. Never log the api_key value
    // (the mask helper above strips it from log lines).
    try {
      const s = (typeof window !== 'undefined') ? window.state : null;
      if (s && s.config) {
        const c = s.config;
        parts.push('cfg.api_key_set=' + (!!c.api_key && c.api_key.length > 0));
        parts.push('cfg.output_dir=' + (c.output_dir || '(empty)'));
        parts.push('cfg.region=' + (c.region || '(empty)'));
        parts.push('cfg.theme=' + (c.theme || '(empty)'));
        parts.push('cfg.styles_count=' + (Array.isArray(c.styles) ? c.styles.length : 0));
      }
    } catch (_) {}
    // Addons: which optional binaries the tool found at boot.
    try {
      const s = (typeof window !== 'undefined') ? window.state : null;
      if (s) {
        parts.push('addons.realesrgan=' + (s.realesrganFirstRunDismissed ? 'dismissed' : 'pending'));
      }
    } catch (_) {}
    const line = 'probe: ' + parts.join(' ');
    if (line !== lastProbe) {
      lastProbe = line;
      log(line);
    }
  }, 500);
  // Stop probing after 30s.
  setTimeout(() => clearInterval(probe), 30000);

  // window.logError — call from catch blocks across the renderer so a
  // swallowed error (a) reaches renderer-error.log via the
  // console.error wrapper above, AND (b) appears in the in-app log
  // pane via addLogEvent. Without this helper, a
  // `catch (_) { /* ignore */ }` block silently loses the error and
  // the user has to re-trigger the bug to report it.
  //
  //   logError(category, location, err)
  //     category : short tag for the call-site (e.g. 'fb-up',
  //                'audio-cut', 'state-save'). Used as the log
  //                headline prefix and in the file log line.
  //     location : "path/to/file.js:lineno" — where the error
  //                happened. Becomes part of the details.
  //     err      : the error object (or string, or null). We
  //                pull .message/.stack if present, else stringify.
  //
  // The logger deliberately does NOT throw if any sub-step fails — it
  // must never crash the caller.
  function _stringifyErr(err) {
    if (err == null) return '(no error object)';
    if (typeof err === 'string') return err;
    if (err.stack) return err.stack;
    if (err.message) return err.message;
    try { return String(err); } catch (_) { return '(unstringifiable error)'; }
  }
  window.logError = function logError(category, location, err) {
    try {
      const text = _stringifyErr(err);
      const cat = String(category || 'uncaught');
      const loc = String(location || 'unknown');
      const headline = `[${cat}] error at ${loc}`;
      // 1) File log (via console.error wrapper).
      console.error(cat, loc, text);
      // 2) In-app log pane (when addLogEvent is loaded).
      try {
        if (typeof window.addLogEvent === 'function') {
          window.addLogEvent({
            category: 'error',
            headline,
            details: [text],
            result: 'err',
          });
        } else if (window.LogService && typeof window.LogService.addLogEvent === 'function') {
          window.LogService.addLogEvent({
            category: 'error',
            headline,
            details: [text],
            result: 'err',
          });
        }
      } catch (_) { /* addLogEvent itself failed — console.error already fired */ }
    } catch (_) { /* never throw from the logger */ }
  };
  // window.logWarn — same shape as logError, severity 'warn' (used
  // for non-fatal anomalies a developer would want to see, e.g. a
  // retryable IPC timeout that succeeded on the second try).
  window.logWarn = function logWarn(category, location, msg) {
    try {
      const cat = String(category || 'warn');
      const loc = String(location || 'unknown');
      const text = (msg && msg.stack) || String(msg || '');
      const headline = `[${cat}] warning at ${loc}`;
      console.warn(cat, loc, text);
      try {
        if (typeof window.addLogEvent === 'function') {
          window.addLogEvent({ category: 'info', headline, details: [text] });
        } else if (window.LogService && typeof window.LogService.addLogEvent === 'function') {
          window.LogService.addLogEvent({ category: 'info', headline, details: [text] });
        }
      } catch (_) {}
    } catch (_) {}
  };

  // window.logAction — breadcrumb for user actions. Use from every
  // meaningful user interaction (tab switch, file-browser button,
  // Generate click, settings save, audio cut, popup open, keyboard
  // shortcut, install, theme toggle, …) so a developer's
  // renderer-error.log captures the full timeline of what the user
  // did before a problem.
  //
  //   logAction(category, action, details?)
  //     category : short tag for the subsystem (e.g. 'tab',
  //                'file-browser', 'generate', 'settings',
  //                'audio-cut', 'image-overlay', 'popup',
  //                'shortcut', 'install', 'theme').
  //     action   : the verb (e.g. 'switch', 'click-up',
  //                'save', 'export', 'open').
  //     details  : optional string OR object. Strings become
  //                the log detail line; objects are serialised
  //                as key=value pairs for grep-friendliness.
  //
  // Lower overhead than logError/logWarn: we don't echo to the
  // in-app log pane (that would flood the user's view during a
  // long session). We DO write to renderer-error.log via the
  // console.log wrapper below, AND we keep a small ring buffer
  // in window.__actionTrail so the user (or a future "copy log"
  // button) can see the last N actions without scrolling
  // through thousands of file-log lines.
  function _formatDetails(d) {
    if (d == null) return '';
    if (typeof d === 'string') return d;
    if (typeof d === 'object') {
      try {
        const parts = [];
        for (const k of Object.keys(d)) {
          const v = d[k];
          parts.push(`${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
        }
        return parts.join(' ');
      } catch (_) { return String(d); }
    }
    return String(d);
  }
  window.logAction = function logAction(category, action, details) {
    try {
      const cat = String(category || 'action');
      const act = String(action || '?');
      const det = _formatDetails(details);
      const line = det ? `ACT ${cat}:${act} ${det}` : `ACT ${cat}:${act}`;
      // 1) Console.log → routed to renderer-error.log by the
      //    probe-free log helper below (we don't install a probe
      //    here, we just write to console.log + a ring buffer).
      // 2) ring buffer for fast in-memory access.
      try {
        const trail = (window.__actionTrail = window.__actionTrail || []);
        trail.push({ ts: Date.now(), cat, act, details: det });
        if (trail.length > 500) trail.splice(0, trail.length - 500);
      } catch (_) {}
      // 3) File log via window.api.logToFile (same channel the
      //    console wrappers use). We bypass console.* here so
      //    we don't pollute the user's DevTools console with a
      //    per-action line — DevTools is for errors, the file
      //    log is the action trail.
      try {
        if (window.api && typeof window.api.logToFile === 'function') {
          const ts = new Date().toISOString().slice(11, 23);
          window.api.logToFile(ts + ' ' + line);
        }
      } catch (_) {}
    } catch (_) { /* never throw from the logger */ }
  };
  // Convenience: window.getActionTrail() returns the ring buffer
  // (a defensive copy so callers can't mutate the internal array).
  window.getActionTrail = function getActionTrail() {
    try {
      return ((window.__actionTrail || []).slice());
    } catch (_) { return []; }
  };
})();
