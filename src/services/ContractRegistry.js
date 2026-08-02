// src/services/ContractRegistry.js
// ============================================================================
// Shared Component 1B: Capability & Contract Registry.
//
// Single source of truth for:
//   - CLI command matrix (which subcommand/verb each modality uses)
//   - Model/mode/resolution/duration matrices (MiniMax video)
//   - Version constraints (blocked/recommended mmx-cli versions)
//   - Validation severity classification (error vs warning vs info)
//
// Covers: FUNC-001, FUNC-002, FUNC-013, FUNC-014, FUNC-015, FUNC-016, MED-034.
//
// Usage:
//   const { COMMAND_MATRIX, getVideoDurations, isVersionAllowed } = require('./ContractRegistry');
//   const cmd = COMMAND_MATRIX.speech; // ['speech', 'synthesize']
// ============================================================================
'use strict';

const crypto = require('crypto');

// ---- CLI COMMAND MATRIX ----
// The authoritative mapping from modality to the mmx CLI subcommand + verb.
// Capability probes, ArgvBuilders, and help-parsers ALL derive from this.
// FUNC-001 fix: speech uses 'synthesize', not 'generate'.
const COMMAND_MATRIX = Object.freeze({
  image: Object.freeze(['image', 'generate']),
  speech: Object.freeze(['speech', 'synthesize']),
  music: Object.freeze(['music', 'generate']),
  video: Object.freeze(['video', 'generate']),
});

// ---- VERSION CONSTRAINTS ----
// FUNC-002 fix: 1.0.16 and 1.0.17 are HARD-BLOCKED (silent-drop of settings).
const VERSION_CONSTRAINTS = Object.freeze({
  min: '1.0.18',
  recommended: '1.0.18',
  blocked: Object.freeze(['1.0.16', '1.0.17']),
  blockedReason: 'These versions silently discard video duration, resolution, optimizer, and speech sound-effect settings while returning exit code 0.',
});

/**
 * Compare semver strings. Returns -1, 0, or 1.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function _semverCmp(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  return 0;
}

/**
 * Check if a CLI version is allowed to run generations.
 * @param {string} version - e.g. '1.0.18'
 * @returns {{ allowed: boolean, reason?: string }}
 */
function isVersionAllowed(version) {
  if (!version) return { allowed: false, reason: 'Unable to determine mmx-cli version.' };
  if (VERSION_CONSTRAINTS.blocked.includes(version)) {
    return { allowed: false, reason: `mmx-cli ${version} is blocked: ${VERSION_CONSTRAINTS.blockedReason}` };
  }
  if (_semverCmp(version, VERSION_CONSTRAINTS.min) < 0) {
    return { allowed: false, reason: `mmx-cli ${version} is below the minimum required ${VERSION_CONSTRAINTS.min}.` };
  }
  return { allowed: true };
}

// ---- VIDEO MODE DEFINITIONS ----
// FUNC-013/014/015 fix: duration is a discrete enum per (mode, model, resolution).

/** Video generation modes. */
const VIDEO_MODES = Object.freeze({
  T2V: 'T2V',   // Text-to-Video
  I2V: 'I2V',   // Image-to-Video (first frame)
  FL2V: 'FL2V', // First+Last Frame to Video
  S2V: 'S2V',   // Subject-to-Video (face reference)
});

/**
 * Determine the video mode from parameters.
 * @param {{ model?: string, hasFirstFrame?: boolean, hasLastFrame?: boolean, hasSubjectImage?: boolean }} p
 * @returns {string} One of VIDEO_MODES values.
 */
function getVideoMode(p) {
  if (p.hasSubjectImage || p.model === 'S2V-01') return VIDEO_MODES.S2V;
  if (p.hasLastFrame) return VIDEO_MODES.FL2V;
  if (p.hasFirstFrame) return VIDEO_MODES.I2V;
  return VIDEO_MODES.T2V;
}

/**
 * Per-(model, mode, resolution) allowed durations.
 * Source: official MiniMax docs (platform.minimax.io), July 2026.
 *
 * FUNC-013 fix: only discrete values (6 or 10), never a range.
 * FUNC-014 fix: FL2V on Hailuo-02 only allows 768P/1080P (no 512P).
 * FUNC-015 fix: Hailuo-2.3-Fast supports 1080P/6s.
 */
const VIDEO_MATRIX = Object.freeze({
  'MiniMax-Hailuo-2.3': Object.freeze({
    [VIDEO_MODES.T2V]: Object.freeze({
      '768P': Object.freeze([6, 10]),
      '1080P': Object.freeze([6]),
    }),
    [VIDEO_MODES.I2V]: Object.freeze({
      '768P': Object.freeze([6, 10]),
      '1080P': Object.freeze([6]),
    }),
  }),
  'MiniMax-Hailuo-2.3-Fast': Object.freeze({
    [VIDEO_MODES.I2V]: Object.freeze({
      '768P': Object.freeze([6, 10]),
      '1080P': Object.freeze([6]),  // FUNC-015: Fast DOES support 1080P/6s
    }),
  }),
  'MiniMax-Hailuo-02': Object.freeze({
    [VIDEO_MODES.T2V]: Object.freeze({
      '512P': Object.freeze([6, 10]),
      '768P': Object.freeze([6, 10]),
      '1080P': Object.freeze([6]),
    }),
    [VIDEO_MODES.I2V]: Object.freeze({
      '512P': Object.freeze([6, 10]),
      '768P': Object.freeze([6, 10]),
      '1080P': Object.freeze([6]),
    }),
    // FUNC-014: FL2V (first+last frame) only supports 768P and 1080P.
    [VIDEO_MODES.FL2V]: Object.freeze({
      '768P': Object.freeze([6, 10]),
      '1080P': Object.freeze([6]),
    }),
  }),
  'S2V-01': Object.freeze({
    [VIDEO_MODES.S2V]: Object.freeze({
      '768P': Object.freeze([6]),
    }),
  }),
});

/**
 * Get allowed durations for a specific model/mode/resolution combination.
 * @param {string} model
 * @param {string} mode - One of VIDEO_MODES.
 * @param {string} resolution - e.g. '768P', '1080P'
 * @returns {number[]} Allowed duration values (e.g. [6, 10]). Empty = invalid combo.
 */
function getVideoDurations(model, mode, resolution) {
  const modelEntry = VIDEO_MATRIX[model];
  if (!modelEntry) return [];
  const modeEntry = modelEntry[mode];
  if (!modeEntry) return [];
  return modeEntry[resolution] || [];
}

/**
 * Get allowed resolutions for a model/mode combination.
 * @param {string} model
 * @param {string} mode
 * @returns {string[]}
 */
function getVideoResolutions(model, mode) {
  const modelEntry = VIDEO_MATRIX[model];
  if (!modelEntry) return [];
  const modeEntry = modelEntry[mode];
  if (!modeEntry) return [];
  return Object.keys(modeEntry);
}

/**
 * Get all modes available for a model.
 * @param {string} model
 * @returns {string[]}
 */
function getVideoModes(model) {
  const modelEntry = VIDEO_MATRIX[model];
  if (!modelEntry) return [];
  return Object.keys(modelEntry);
}

/**
 * Full validation of a video parameter combination.
 * Returns typed result: errors (hard block) vs warnings (confirmable).
 *
 * @param {{ model: string, duration?: number, resolution?: string, hasFirstFrame?: boolean, hasLastFrame?: boolean, hasSubjectImage?: boolean, prompt?: string }} params
 * @returns {{ errors: string[], warnings: string[] }}
 */
function validateVideoParams(params) {
  const errors = [];
  const warnings = [];
  const { model, duration, resolution } = params;

  if (!model) { errors.push('Video model is required.'); return { errors, warnings }; }
  if (!VIDEO_MATRIX[model]) { errors.push(`Unknown video model "${model}".`); return { errors, warnings }; }

  const mode = getVideoMode(params);
  const modelEntry = VIDEO_MATRIX[model];

  // Mode availability check
  if (!modelEntry[mode]) {
    errors.push(`Model ${model} does not support mode ${mode}.`);
    return { errors, warnings };
  }

  // Resolution check
  if (resolution) {
    const allowedRes = getVideoResolutions(model, mode);
    if (!allowedRes.includes(resolution)) {
      errors.push(`Resolution ${resolution} is not supported by ${model} in ${mode} mode. Allowed: ${allowedRes.join(', ')}.`);
    }
  }

  // Duration check (discrete enum, not range)
  if (duration != null && resolution) {
    const allowedDurations = getVideoDurations(model, mode, resolution);
    if (allowedDurations.length === 0) {
      errors.push(`No valid durations for ${model} / ${mode} / ${resolution}. This combination may not be supported.`);
    } else if (!allowedDurations.includes(Number(duration))) {
      errors.push(`Duration ${duration}s is not allowed for ${model} at ${resolution}. Allowed: ${allowedDurations.join('s, ')}s.`);
    }
  }

  // Mode-specific requirements
  if (mode === VIDEO_MODES.I2V || mode === VIDEO_MODES.FL2V) {
    if (!params.hasFirstFrame) errors.push(`${mode} mode requires a first-frame image.`);
  }
  if (mode === VIDEO_MODES.FL2V) {
    if (!params.hasLastFrame) errors.push('FL2V mode requires a last-frame image.');
  }
  if (mode === VIDEO_MODES.S2V) {
    if (!params.hasSubjectImage) errors.push('S2V mode requires a subject reference image.');
  }

  // Prompt limit
  if (params.prompt && String(params.prompt).length > 2000) {
    errors.push(`Video prompt is ${String(params.prompt).length} chars; max is 2000.`);
  }

  return { errors, warnings };
}

/**
 * H-001 (_5 audit): compute a stable hash of the VIDEO_MATRIX for diagnostics.
 * If the renderer's copy diverges, the hash mismatch reveals it.
 * @returns {string} SHA-256 hex prefix (16 chars).
 */
function contractHash() {
  const canonical = JSON.stringify(VIDEO_MATRIX, Object.keys(VIDEO_MATRIX).sort());
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

module.exports = {
  COMMAND_MATRIX,
  VERSION_CONSTRAINTS,
  VIDEO_MODES,
  VIDEO_MATRIX,
  isVersionAllowed,
  getVideoMode,
  getVideoDurations,
  getVideoResolutions,
  getVideoModes,
  validateVideoParams,
  contractHash,
  _semverCmp,
};
