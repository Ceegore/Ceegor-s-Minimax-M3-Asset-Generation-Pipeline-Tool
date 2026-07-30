// main/services/CloudJobGate.js
// ============================================================================
// P2-C (360° Audit H-014, H-015): Cloud job concurrency & rate limiting.
//
// Prevents a compromised renderer (or a buggy batch loop) from:
//   - Flooding cloud APIs with unlimited parallel requests
//   - Exceeding per-provider rate limits (causing 429s / bans)
//   - Running up unbounded API costs
//
// Enforcement:
//   1. Global concurrency limit: max 4 parallel cloud jobs
//   2. Per-provider rate limit: max 10 requests/minute per provider
//   3. Session budget: configurable daily limit with confirmation above threshold
//
// Usage:
//   const gate = require('./CloudJobGate');
//   const slot = gate.acquire('openrouter');
//   if (!slot.ok) return { ok: false, error: slot.error };
//   try { ... await apiCall(); ... }
//   finally { gate.release(slot.id); }
// ============================================================================
'use strict';

/** Maximum parallel cloud jobs across all providers. */
const MAX_GLOBAL_CONCURRENCY = 4;

/** Maximum requests per minute per provider. */
const MAX_PER_PROVIDER_RPM = 10;

/** Default daily budget (API calls). 0 = unlimited. */
const DEFAULT_DAILY_BUDGET = 500;

/** @type {Map<string, {provider: string, startedAt: number}>} */
const _activeSlots = new Map();

/** @type {Map<string, number[]>} provider -> [timestamps of recent requests] */
const _rateWindows = new Map();

/** Session budget tracking. */
let _dailyCount = 0;
let _dailyBudget = DEFAULT_DAILY_BUDGET;
let _dailyResetDate = new Date().toDateString();

let _nextSlotId = 1;

/**
 * Reset the daily counter if the date has changed.
 */
function _maybeResetDaily() {
  const today = new Date().toDateString();
  if (today !== _dailyResetDate) {
    _dailyResetDate = today;
    _dailyCount = 0;
  }
}

/**
 * Attempt to acquire a slot for a cloud API call.
 * @param {string} provider - Provider identifier (e.g. 'openrouter', 'replicate').
 * @returns {{ok: true, id: number} | {ok: false, error: string, retryAfterMs?: number}}
 */
function acquire(provider) {
  _maybeResetDaily();

  // 1. Global concurrency check
  if (_activeSlots.size >= MAX_GLOBAL_CONCURRENCY) {
    return { ok: false, error: `Cloud job limit reached (${MAX_GLOBAL_CONCURRENCY} parallel). Wait for a slot to free up.` };
  }

  // 2. Per-provider rate limit
  const now = Date.now();
  const window = _rateWindows.get(provider) || [];
  // Remove entries older than 60 seconds
  const fresh = window.filter((ts) => now - ts < 60000);
  _rateWindows.set(provider, fresh);
  if (fresh.length >= MAX_PER_PROVIDER_RPM) {
    const oldest = fresh[0];
    const retryAfterMs = 60000 - (now - oldest) + 100;
    return { ok: false, error: `Provider '${provider}' rate limit (${MAX_PER_PROVIDER_RPM}/min). Retry in ${Math.ceil(retryAfterMs / 1000)}s.`, retryAfterMs };
  }

  // 3. Daily budget check
  if (_dailyBudget > 0 && _dailyCount >= _dailyBudget) {
    return { ok: false, error: `Daily API budget exhausted (${_dailyBudget} calls). Reset at midnight or increase the limit in settings.` };
  }

  // Acquire slot
  const id = _nextSlotId++;
  _activeSlots.set(String(id), { provider, startedAt: now });
  fresh.push(now);
  _dailyCount++;

  return { ok: true, id };
}

/**
 * Release a previously acquired slot.
 * @param {number} id - The slot ID returned by acquire().
 */
function release(id) {
  _activeSlots.delete(String(id));
}

/**
 * Get current gate status (for diagnostics / UI display).
 * @returns {{activeSlots: number, maxConcurrency: number, dailyCount: number, dailyBudget: number}}
 */
function getStatus() {
  _maybeResetDaily();
  return {
    activeSlots: _activeSlots.size,
    maxConcurrency: MAX_GLOBAL_CONCURRENCY,
    dailyCount: _dailyCount,
    dailyBudget: _dailyBudget,
  };
}

/**
 * Set the daily budget. 0 = unlimited.
 * @param {number} budget
 */
function setDailyBudget(budget) {
  _dailyBudget = Math.max(0, Math.floor(budget || 0));
}

/**
 * Cancel all active slots (emergency cleanup on crash/shutdown).
 */
function cancelAll() {
  _activeSlots.clear();
}

module.exports = {
  acquire,
  release,
  getStatus,
  setDailyBudget,
  cancelAll,
  MAX_GLOBAL_CONCURRENCY,
  MAX_PER_PROVIDER_RPM,
  DEFAULT_DAILY_BUDGET,
};
