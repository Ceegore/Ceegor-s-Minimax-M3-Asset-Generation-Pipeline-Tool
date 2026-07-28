// renderer/utils/quotaFormatter.js
// Quota display formatter. Formats per-model quota info from mmx as
// HTML spans with CSS classes (quota-low / quota-warn / quota-in-plan
// / quota-not-in-plan). Field aliases cover old and new mmx versions.
//
// Issue-5: the `current_interval_*` fields describe the CURRENT rolling
// 5-HOUR WINDOW, not the calendar day — every visible label therefore
// says "5h" (never "today"). formatQuotaSummary() renders the compact
// one-line header format:
//   5h used: 61% · week used: 29% ; videos today/week: 1/3, 15/21
// with the full per-model breakdown in the tooltip only.

// Shared field-alias readers (old + new mmx shapes).
function _qName(m) { return m.model_name || m.name || m.model || '?'; }
function _qITotal(m) { return Number(m.current_interval_total_count ?? m.interval_total ?? m.daily_total) || 0; }
function _qIUsed(m) { return Number(m.current_interval_usage_count ?? m.interval_used ?? m.daily_used) || 0; }
function _qWTotal(m) { return Number(m.current_weekly_total_count ?? m.weekly_total) || 0; }
function _qWUsed(m) { return Number(m.current_weekly_usage_count ?? m.weekly_used) || 0; }
// Percent-based fallback fields. Some tiers (e.g. "general") report NO raw
// counts (0/0) but DO provide a *_remaining_percent — return null when absent
// so callers can distinguish "missing" from a genuine 0%.
function _qIRemPct(m) { const v = m.current_interval_remaining_percent ?? m.interval_remaining_percent ?? m.daily_remaining_percent; return v == null ? null : Number(v); }
function _qWRemPct(m) { const v = m.current_weekly_remaining_percent ?? m.weekly_remaining_percent; return v == null ? null : Number(v); }
function _qPctCls(usedPct) { return usedPct >= 90 ? 'quota-low' : (usedPct >= 50 ? 'quota-warn' : ''); }

function quotaSeg(name, used, total, label) {
  if (!total || total <= 0) return '';
  const remaining = Math.max(0, total - used);
  const usedPct = Math.round((used / total) * 100);
  const cls = usedPct >= 90 ? 'quota-low' : (usedPct >= 50 ? 'quota-warn' : '');
  return `<span class="${cls}" title="${escapeHtml(`${name} · ${label}: ${used}/${total} (${usedPct}% used)`)}">${used}/${total} ${label} <small>(${usedPct}%)</small></span>`;
}

/**
 * @param {object} m  Quota entry from mmx (model-specific)
 * @returns {string}  HTML string with formatted quota spans
 */
function formatQuotaModel(m) {
  const name = m.model_name || m.name || m.model || '?';
  // All values are rendered into innerHTML below — escape to avoid XSS via a
  // hostile model name returned by the API.
  const e = (s) => escapeHtml(String(s == null ? '' : s));
  // mmx quota fields have changed between versions. Read them with a few
  // aliases so we survive both old and new shapes.
  const iTotal = m.current_interval_total_count ?? m.interval_total ?? m.daily_total ?? 0;
  const iUsed  = m.current_interval_usage_count ?? m.interval_used ?? m.daily_used ?? 0;
  const iStatus = m.current_interval_status ?? m.interval_status ?? m.daily_status;
  const iPct    = m.current_interval_remaining_percent ?? m.interval_remaining_percent ?? m.daily_remaining_percent;
  const wTotal = m.current_weekly_total_count ?? m.weekly_total ?? 0;
  const wUsed  = m.current_weekly_usage_count ?? m.weekly_used ?? 0;
  const wStatus = m.current_weekly_status ?? m.weekly_status;
  const wPct    = m.current_weekly_remaining_percent ?? m.weekly_remaining_percent;
  // "Not in plan" only when BOTH statuses are explicitly 3. Matching
  // null as well would mis-classify every model that omits the status
  // field. The remaining_percent fields are used as a fallback so the
  // user still sees something useful.
  const explicitlyNotInPlan = (iStatus === 3) && (wStatus === 3);
  if (explicitlyNotInPlan) {
    return `<span class="quota-not-in-plan">${e(name)}: not in plan</span>`;
  }
  const parts = [];
  if (iTotal && iTotal > 0) parts.push(quotaSeg(name, iUsed || 0, iTotal, '5h'));
  if (wTotal && wTotal > 0) parts.push(quotaSeg(name, wUsed || 0, wTotal, 'week'));
  if (parts.length === 0) {
    // In plan but no counts (e.g. general returned 0/0 with status=1).
    // Fall back to the *_remaining_percent field (note: this is "remaining"
    // percent — invert it to show "used" percent, which the user expects).
    const segs = [];
    if (iPct != null) {
      const usedPct = 100 - iPct;
      const cls = usedPct >= 90 ? 'quota-low' : (usedPct >= 50 ? 'quota-warn' : '');
      segs.push(`<span class="${cls}">${iPct}% 5h <small>(${usedPct}% used)</small></span>`);
    }
    if (wPct != null) {
      const usedPct = 100 - wPct;
      const cls = usedPct >= 90 ? 'quota-low' : (usedPct >= 50 ? 'quota-warn' : '');
      segs.push(`<span class="${cls}">${wPct}% week <small>(${usedPct}% used)</small></span>`);
    }
    if (segs.length === 0) {
      return `<span class="quota-in-plan">${e(name)}: in plan</span>`;
    }
    return `<span class="quota-in-plan">${e(name)}:</span> ${segs.join(' · ')}`;
  }
  return parts.join(' · ');
}

/**
 * Issue-5: compact one-line quota summary for the header.
 *
 * Visible text (ONE line, used-percentages prominent):
 *   5h used: 61% · week used: 29% ; videos today/week: 1/3, 15/21
 * - Non-video models are aggregated into one 5h-window and one weekly
 *   used-percentage each.
 * - Video models get their own segment with RAW counts (interval /
 *   weekly), per the user's requested format.
 * - The per-model breakdown (raw counts + percentages for every model)
 *   lives ONLY in the tooltip.
 *
 * @param {object[]} models  Quota entries from mmx (model_remains array)
 * @returns {string|null} HTML string, or null when no usable counts
 *   exist (caller falls back to the legacy per-model rendering).
 */
function formatQuotaSummary(models) {
  if (!Array.isArray(models) || models.length === 0) return null;
  const isVideo = (name) => /video/i.test(String(name || ''));
  // Aggregate the non-video models (5h window + weekly window).
  let iUsed = 0, iTotal = 0, wUsed = 0, wTotal = 0;
  // Video models keep raw counts (summed if several video models exist).
  let vIUsed = 0, vITotal = 0, vWUsed = 0, vWTotal = 0;
  // Percent-based fallback for count-less non-video tiers (e.g. "general"
  // reports 0/0 counts but a *_remaining_percent). Keep the SMALLEST
  // remaining (largest used%) across such models so the header reflects the
  // most-constrained window — mirrors formatQuotaModel's percent fallback.
  let iRemPct = null, wRemPct = null;
  for (const m of models) {
    const it = _qITotal(m), iu = _qIUsed(m), wt = _qWTotal(m), wu = _qWUsed(m);
    if (isVideo(_qName(m))) {
      if (it > 0) { vIUsed += iu; vITotal += it; }
      if (wt > 0) { vWUsed += wu; vWTotal += wt; }
    } else {
      if (it > 0) { iUsed += iu; iTotal += it; }
      if (wt > 0) { wUsed += wu; wTotal += wt; }
      const ip = _qIRemPct(m), wp = _qWRemPct(m);
      if (ip != null) iRemPct = (iRemPct == null) ? ip : Math.min(iRemPct, ip);
      if (wp != null) wRemPct = (wRemPct == null) ? wp : Math.min(wRemPct, wp);
    }
  }
  if (iTotal <= 0 && wTotal <= 0 && vITotal <= 0 && vWTotal <= 0 && iRemPct == null && wRemPct == null) return null;

  // Tooltip: what the windows mean + the full per-model breakdown.
  const tipLines = ['"5h" = the CURRENT rolling 5-hour window (not the calendar day) · "week" = the current weekly window.'];
  for (const m of models) {
    const it = _qITotal(m), iu = _qIUsed(m), wt = _qWTotal(m), wu = _qWUsed(m);
    const iStatus = m.current_interval_status ?? m.interval_status ?? m.daily_status;
    const wStatus = m.current_weekly_status ?? m.weekly_status;
    const ip = _qIRemPct(m), wp = _qWRemPct(m);
    const segs = [];
    if (it > 0) segs.push(`5h: ${iu}/${it} (${Math.round((iu / it) * 100)}% used)`);
    else if (ip != null) segs.push(`5h: ${Math.round(100 - ip)}% used`);
    if (wt > 0) segs.push(`week: ${wu}/${wt} (${Math.round((wu / wt) * 100)}% used)`);
    else if (wp != null) segs.push(`week: ${Math.round(100 - wp)}% used`);
    const tail = segs.length ? segs.join(' · ') : ((iStatus === 3 && wStatus === 3) ? 'not in plan' : 'in plan');
    tipLines.push(`${_qName(m)} — ${tail}`);
  }
  const tip = escapeHtml(tipLines.join('\n'));

  const mainSegs = [];
  if (iTotal > 0) {
    const pct = Math.round((iUsed / iTotal) * 100);
    mainSegs.push(`<span class="${_qPctCls(pct)}">5h used: ${pct}%</span>`);
  } else if (iRemPct != null) {
    const pct = Math.round(100 - iRemPct);
    mainSegs.push(`<span class="${_qPctCls(pct)}">5h used: ${pct}%</span>`);
  }
  if (wTotal > 0) {
    const pct = Math.round((wUsed / wTotal) * 100);
    mainSegs.push(`<span class="${_qPctCls(pct)}">week used: ${pct}%</span>`);
  } else if (wRemPct != null) {
    const pct = Math.round(100 - wRemPct);
    mainSegs.push(`<span class="${_qPctCls(pct)}">week used: ${pct}%</span>`);
  }
  let html = mainSegs.join(' · ');
  if (vITotal > 0 || vWTotal > 0) {
    // Video segment: raw counts, per the requested format
    // "videos today/week: 1/3, 15/21" (today = current 5h window).
    const vSegs = [];
    if (vITotal > 0) vSegs.push(`${Math.max(0, vITotal - vIUsed)} of ${vITotal}`);
    if (vWTotal > 0) vSegs.push(`${Math.max(0, vWTotal - vWUsed)} of ${vWTotal}`);
    const vPct = Math.max(
      vITotal > 0 ? (vIUsed / vITotal) * 100 : 0,
      vWTotal > 0 ? (vWUsed / vWTotal) * 100 : 0
    );
    const vHtml = `<span class="${_qPctCls(Math.round(vPct))}">videos left today/week: ${vSegs.join(', ')}</span>`;
    html = html ? html + ' · ' + vHtml : vHtml;
  }
  return `<span class="quota-compact" title="${tip}">${html}</span>`;
}

window.QuotaFormatter = { quotaSeg, formatQuotaModel, formatQuotaSummary };
