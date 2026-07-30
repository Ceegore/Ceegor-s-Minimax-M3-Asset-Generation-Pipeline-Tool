// main/services/PayloadLimits.js
// ============================================================================
// P2-A (360° Audit): Unified payload size limits for all IPC channels.
//
// Before this module, payload limits were scattered (or absent) across
// IPC handlers. A compromised renderer could send multi-GB Base64 payloads
// to OOM the main process. This module defines a single source of truth
// for per-channel size limits.
//
// Usage:
//   const { checkPayloadLimit, LIMITS } = require('./PayloadLimits');
//   const err = checkPayloadLimit('image:writeBase64', payload);
//   if (err) return { ok: false, error: err };
// ============================================================================
'use strict';

/**
 * Per-channel payload size limits (in bytes).
 * These are the MAXIMUM serialized sizes accepted on each channel.
 */
const LIMITS = Object.freeze({
  // Image operations
  'image:writeBase64': 64 * 1024 * 1024,       // 64 MB (was 256 MB)
  'image:resize': 64 * 1024 * 1024,            // 64 MB
  'inpaint:run': 32 * 1024 * 1024,             // 32 MB (mask + source)
  'inpaint:onnx': 32 * 1024 * 1024,            // 32 MB

  // State management
  'state:set': 1 * 1024 * 1024,                // 1 MB serialized state
  'batches:set': 512 * 1024,                   // 512 KB batch definitions

  // Audio
  'audio:writeBase64': 64 * 1024 * 1024,       // 64 MB
  'audio:waveform': 64 * 1024 * 1024,          // 64 MB PCM data

  // Pipeline
  'pipeline:import': 4 * 1024 * 1024,          // 4 MB (metadata only, not file content)
  'pipeline:replace': 4 * 1024 * 1024,         // 4 MB

  // Config
  'config:set': 256 * 1024,                    // 256 KB (config is small)
  'providers:set': 256 * 1024,                 // 256 KB

  // Jobs
  'job:archive': 2 * 1024 * 1024,              // 2 MB job archive entries

  // Default for unlisted channels
  '_default': 1 * 1024 * 1024,                 // 1 MB
});

/**
 * Estimate the serialized size of a payload.
 * @param {*} payload
 * @returns {number} Estimated size in bytes.
 */
function estimateSize(payload) {
  if (payload === undefined || payload === null) return 0;
  if (typeof payload === 'string') return payload.length;
  if (Buffer.isBuffer(payload)) return payload.length;
  try {
    return JSON.stringify(payload).length;
  } catch (_) {
    return Infinity; // Non-serializable — fail closed
  }
}

/**
 * Check if a payload exceeds the limit for a given channel.
 * Returns null if OK, or an error string if the payload is too large.
 *
 * @param {string} channel - The IPC channel name.
 * @param {*} payload - The payload to check.
 * @returns {string|null} Error message or null if within limits.
 */
function checkPayloadLimit(channel, payload) {
  const limit = LIMITS[channel] || LIMITS['_default'];
  const size = estimateSize(payload);
  if (size > limit) {
    const sizeMB = (size / (1024 * 1024)).toFixed(1);
    const limitMB = (limit / (1024 * 1024)).toFixed(1);
    return `Payload too large for '${channel}': ${sizeMB} MB exceeds ${limitMB} MB limit`;
  }
  return null;
}

/**
 * Get the limit for a specific channel.
 * @param {string} channel
 * @returns {number} Limit in bytes.
 */
function getLimit(channel) {
  return LIMITS[channel] || LIMITS['_default'];
}

module.exports = { LIMITS, checkPayloadLimit, getLimit, estimateSize };
