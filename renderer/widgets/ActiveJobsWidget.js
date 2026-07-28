// renderer/widgets/ActiveJobsWidget.js
//
// Floating "active jobs" widget (bottom-right of the content area).
// Subscribes to JobRunner events and renders one row per running
// job: icon, title, age (seconds since start), progress fraction
// (if a batch child), and a cancel button. Clicking a row scrolls
// the log pane to the corresponding primary log row and expands it.
//
// The widget is a pure projection of state.jobs. It owns no data.
// The widget can be removed without affecting the rest of the app.

(function () {
  const WIDGET_ID = 'active-jobs-widget';
  const WIDGET_HOST_ID = 'active-jobs-host';
  const TYPE_ICONS = {
    image: '🖼', speech: '🗣', music: '🎵', video: '🎬',
    upscale: '⬆', optimize: '⚙', isnetbg: '✂',
  };

  function _ensureHost() {
    let host = document.getElementById(WIDGET_HOST_ID);
    if (host) return host;
    // The host is a small fixed-position div in the bottom-right of
    // the content area. The CSS in jobs.css positions it.
    host = document.createElement('div');
    host.id = WIDGET_HOST_ID;
    host.className = 'active-jobs-host';
    document.body.appendChild(host);
    return host;
  }

  function _ensureWidget() {
    let w = document.getElementById(WIDGET_ID);
    if (w) return w;
    const host = _ensureHost();
    w = document.createElement('div');
    w.id = WIDGET_ID;
    w.className = 'active-jobs-widget';
    w.setAttribute('aria-label', 'Active generation jobs');
    const header = document.createElement('div');
    header.className = 'active-jobs-header';
    header.textContent = 'Running';
    w.appendChild(header);
    const list = document.createElement('div');
    list.className = 'active-jobs-list';
    w.appendChild(list);
    host.appendChild(w);
    return w;
  }

  function _ageString(startedAt) {
    if (!startedAt) return '';
    const ms = Date.now() - new Date(startedAt).getTime();
    const sec = Math.max(0, Math.floor(ms / 1000));
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    const remSec = sec - min * 60;
    return `${min}m ${remSec}s`;
  }

  function _renderJobRow(job, list) {
    const row = document.createElement('div');
    row.className = 'active-jobs-row';
    row.setAttribute('data-job-id', job.id);
    // Icon
    const icon = document.createElement('span');
    icon.className = 'active-jobs-icon';
    icon.textContent = TYPE_ICONS[job.type] || '·';
    row.appendChild(icon);
    // Title + subtitle
    const text = document.createElement('div');
    text.className = 'active-jobs-text';
    const title = document.createElement('div');
    title.className = 'active-jobs-title';
    title.textContent = job.title || 'Generation';
    title.title = job.title || '';
    text.appendChild(title);
    const meta = document.createElement('div');
    meta.className = 'active-jobs-meta';
    const age = _ageString(job.startedAt);
    const progress = job.progress && job.progress.total > 0
      ? `${job.progress.step}/${job.progress.total}` : '';
    const parts = [];
    if (job.tab) parts.push(job.tab);
    if (progress) parts.push(progress);
    if (age) parts.push(age);
    meta.textContent = parts.join(' · ');
    text.appendChild(meta);
    row.appendChild(text);
    // Cancel button
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'active-jobs-cancel';
    cancel.title = 'Cancel this job';
    cancel.textContent = '✕';
    cancel.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (window.JobRunner && typeof window.JobRunner.cancel === 'function') {
        window.JobRunner.cancel(job.id);
      }
    });
    row.appendChild(cancel);
    // Click on the row → scroll the log pane to the job's primary row.
    row.addEventListener('click', (e) => {
      if (e.target === cancel) return;
      if (window.LogService && typeof window.LogService.scrollToJob === 'function') {
        window.LogService.scrollToJob(job.id);
      }
    });
    list.appendChild(row);
    return row;
  }

  function render() {
    if (!window.JobRunner) return;
    const jobs = window.JobRunner.activeJobs();
    const widget = _ensureWidget();
    const list = widget.querySelector('.active-jobs-list');
    if (!list) return;
    // Diff: rebuild the list. Active jobs are typically < 5, so
    // the rebuild cost is negligible. The widget is a pure
    // projection so we don't need to track DOM identity.
    list.innerHTML = '';
    if (jobs.length === 0) {
      widget.style.display = 'none';
      return;
    }
    widget.style.display = '';
    for (const j of jobs) _renderJobRow(j, list);
  }

  // Re-render every 500ms so the age counter ticks. Cheap, runs
  // only when the widget is visible (the list rebuild is O(active
  // jobs) which is bounded by HARD_CAP = 16).
  let _tickTimer = null;
  // Keep the unsubscribe functions returned by JobRunner.on() so a
  // re-init (hot-reload / second init() call) can tear down the old
  // listeners before registering new ones — otherwise every re-init
  // would double the listeners and render() would fire N times per
  // event.
  let _offs = [];
  function startTicker() {
    if (_tickTimer) return;
    _tickTimer = setInterval(render, 500);
  }
  // stopTicker() clears the interval so it doesn't keep firing after
  // the widget DOM is removed (hot-reload, tab switch, route change).
  // init() calls this before re-adding listeners, and destroy() uses
  // it to tear the widget down cleanly.
  function stopTicker() {
    if (_tickTimer) {
      clearInterval(_tickTimer);
      _tickTimer = null;
    }
  }

  // Subscribe to JobRunner events so we re-render on every change.
  function init() {
    if (!window.JobRunner) return;
    // Idempotent: if init() is called again, tear down the previous
    // listeners first so we don't accumulate duplicates.
    for (const off of _offs) { try { off(); } catch (_) { /* best-effort */ } }
    _offs = [];
    // Also stop the ticker so a second init() call restarts it
    // cleanly.
    stopTicker();
    // Re-render on every event.
    _offs.push(window.JobRunner.on('jobrunner:job-added', render));
    _offs.push(window.JobRunner.on('jobrunner:job-removed', render));
    _offs.push(window.JobRunner.on('jobrunner:job-updated', render));
    startTicker();
    render();
  }

  // destroy() tears the widget down cleanly — unregisters the
  // JobRunner listeners and stops the ticker. Call on hot-reload /
  // route change / before re-init to avoid leaking intervals.
  function destroy() {
    for (const off of _offs) { try { off(); } catch (_) { /* best-effort */ } }
    _offs = [];
    stopTicker();
  }

  // Public surface.
  window.ActiveJobsWidget = { init, render, destroy };
})();
