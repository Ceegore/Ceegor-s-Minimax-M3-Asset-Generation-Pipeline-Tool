// src/services/remoteJobLedger.js
// ============================================================================
// H-012 (_5 audit): Persistent Remote Job Ledger.
//
// Remote provider jobs (video generation via OpenRouter/Replicate) survive
// app restarts and poll timeouts. The ledger records enough state to resume
// polling and download the result later.
//
// Storage: remote-jobs.json next to config.txt / state.json.
// Lifecycle: entries are added on submit, updated on progress/completion,
//            and pruned after a configurable retention period.
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { configDir } = require('../config');

/** Retention: completed/failed entries older than this are pruned on load. */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
/** Max entries to prevent unbounded growth. */
const MAX_ENTRIES = 200;

function ledgerPath() {
  return path.join(configDir(), 'remote-jobs.json');
}

/** @type {Array<object>|null} In-memory cache. */
let _entries = null;

function _load() {
  if (_entries) return _entries;
  try {
    const raw = fs.readFileSync(ledgerPath(), 'utf8');
    const parsed = JSON.parse(raw);
    _entries = Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    _entries = [];
  }
  // Prune old terminal entries on load.
  const cutoff = Date.now() - RETENTION_MS;
  _entries = _entries.filter((e) => {
    if (e.status === 'completed' || e.status === 'failed' || e.status === 'cancelled') {
      return (e.updatedAt || e.createdAt || 0) > cutoff;
    }
    return true;
  });
  if (_entries.length > MAX_ENTRIES) _entries = _entries.slice(-MAX_ENTRIES);
  return _entries;
}

function _save() {
  try {
    fs.writeFileSync(ledgerPath(), JSON.stringify(_entries, null, 1), 'utf8');
  } catch (_) { /* best-effort persistence */ }
}

/**
 * Add a new remote job entry to the ledger.
 * @param {{ localJobId: string, providerId: string, remoteJobId: string,
 *           pollUrl: string, model?: string, modality?: string,
 *           outDir?: string }} opts
 * @returns {object} The created entry.
 */
function add(opts) {
  const entries = _load();
  const entry = {
    localJobId: opts.localJobId || '',
    providerId: opts.providerId || '',
    remoteJobId: opts.remoteJobId || '',
    pollUrl: opts.pollUrl || '',
    model: opts.model || '',
    modality: opts.modality || 'video',
    outDir: opts.outDir || '',
    status: 'pending', // pending → running → completed | failed | cancelled
    createdAt: Date.now(),
    updatedAt: Date.now(),
    resultUrls: [],
    error: null,
  };
  // Replace any existing entry with the same localJobId (retry scenario).
  const idx = entries.findIndex((e) => e.localJobId === entry.localJobId);
  if (idx !== -1) entries[idx] = entry; else entries.push(entry);
  _save();
  return entry;
}

/**
 * Update an existing entry by localJobId.
 * @param {string} localJobId
 * @param {object} patch - Fields to merge (status, resultUrls, error, remoteJobId, pollUrl).
 * @returns {object|null} The updated entry, or null if not found.
 */
function update(localJobId, patch) {
  const entries = _load();
  const entry = entries.find((e) => e.localJobId === localJobId);
  if (!entry) return null;
  Object.assign(entry, patch, { updatedAt: Date.now() });
  _save();
  return entry;
}

/**
 * Get a single entry by localJobId.
 * @param {string} localJobId
 * @returns {object|null}
 */
function get(localJobId) {
  return _load().find((e) => e.localJobId === localJobId) || null;
}

/**
 * Get all entries that are still actionable (pending or running).
 * These are candidates for resume on app restart.
 * @returns {object[]}
 */
function getPending() {
  return _load().filter((e) => e.status === 'pending' || e.status === 'running');
}

/**
 * Get all entries (for diagnostics / UI listing).
 * @returns {object[]}
 */
function getAll() {
  return _load().slice();
}

/**
 * Remove an entry by localJobId.
 * @param {string} localJobId
 * @returns {boolean} True if an entry was removed.
 */
function remove(localJobId) {
  const entries = _load();
  const idx = entries.findIndex((e) => e.localJobId === localJobId);
  if (idx === -1) return false;
  entries.splice(idx, 1);
  _save();
  return true;
}

/**
 * Prune terminal entries older than maxAgeMs.
 * @param {number} [maxAgeMs] - Defaults to RETENTION_MS (7 days).
 * @returns {number} Number of entries pruned.
 */
function prune(maxAgeMs) {
  const entries = _load();
  const cutoff = Date.now() - (maxAgeMs || RETENTION_MS);
  const before = entries.length;
  _entries = entries.filter((e) => {
    if (e.status === 'completed' || e.status === 'failed' || e.status === 'cancelled') {
      return (e.updatedAt || 0) > cutoff;
    }
    return true;
  });
  const pruned = before - _entries.length;
  if (pruned > 0) _save();
  return pruned;
}

/** Reset in-memory cache (for tests). */
function _reset() { _entries = null; }

module.exports = { add, update, get, getPending, getAll, remove, prune, ledgerPath, _reset, RETENTION_MS, MAX_ENTRIES };
