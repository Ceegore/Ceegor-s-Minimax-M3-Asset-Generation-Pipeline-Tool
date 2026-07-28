// src/contracts/settingsSnapshot.js
// ============================================================================
// R3.1 — Canonical boundary contract for a "settings snapshot" — the
// fully-resolved settings that a backend will actually use for a
// given operation, after defaults + user overrides + profile merge
// have been applied.
//
// The invariant is:
//
//   source     is one of SOURCE_VALUES
//   options    is a plain object (not array, not null)
//   appliedAt  is a parseable ISO date string
//
//   Consumers MUST read `source` to label the UI ("Default",
//   "User override", "Profile: Foo") and MUST pass the same
//   `options` object into the backend unchanged.
//
// Extracted to its own file so the contract is the single source of
// truth and so consumers can `require('./settingsSnapshot')` without
// pulling in any IPC handler module.
// ============================================================================

/**
 * @typedef {'default' | 'user' | 'profile'} SettingsSource
 *
 * @typedef {object} SettingsSnapshot
 * @property {SettingsSource} source       Where the snapshot originated.
 * @property {string|null} backend         Backend the snapshot applies to (e.g. "sharp", "realesrgan").
 * @property {string|null} model           Model identifier the snapshot applies to.
 * @property {object} options              Plain object of fully-merged backend options.
 * @property {string} appliedAt            ISO date string when the snapshot was built.
 * @property {string|null} profileName     Name of the profile (only when source === 'profile').
 */

/** Allowlist of accepted source values. */
const SOURCE_VALUES = new Set(['default', 'user', 'profile']);

/** Fields the contract guarantees on a normalized snapshot. */
const SHAPE = Object.freeze([
  'source', 'backend', 'model', 'options', 'appliedAt', 'profileName',
]);

/**
 * Cheap shape check. Returns true if the value is *plausibly* a
 * `SettingsSnapshot` (object with a string `source`). Does not
 * validate invariants — use `validateSettingsSnapshot` for that.
 *
 * @param {*} v
 * @returns {boolean}
 */
function isSettingsSnapshot(v) {
  return !!v && typeof v === 'object' && typeof v.source === 'string';
}

/**
 * Normalize a value to the `SettingsSnapshot` shape.
 *
 * @param {*} v
 * @returns {object}
 */
function normalize(v) {
  const raw = (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  const source = (typeof raw.source === 'string' && SOURCE_VALUES.has(raw.source))
    ? raw.source
    : 'default';
  const options = (raw.options && typeof raw.options === 'object' && !Array.isArray(raw.options))
    ? raw.options
    : {};
  return {
    source,
    backend: (typeof raw.backend === 'string' && raw.backend.trim()) ? raw.backend.trim() : null,
    model: (typeof raw.model === 'string' && raw.model.trim()) ? raw.model.trim() : null,
    options,
    appliedAt: (typeof raw.appliedAt === 'string' && raw.appliedAt.trim()) ? raw.appliedAt.trim() : null,
    profileName: (typeof raw.profileName === 'string' && raw.profileName.trim()) ? raw.profileName.trim() : null,
  };
}

/**
 * Validate a value against the `SettingsSnapshot` contract.
 * Never throws.
 *
 * @param {*} v
 * @returns {{ok: boolean, value: object, errors: string[]}}
 */
function validateSettingsSnapshot(v) {
  if (v === null || v === undefined) {
    return { ok: false, value: normalize(null), errors: ['SettingsSnapshot: input is null/undefined'] };
  }
  if (typeof v !== 'object' || Array.isArray(v)) {
    return { ok: false, value: normalize(v), errors: ['SettingsSnapshot: input is not a plain object'] };
  }
  if (typeof v.source !== 'string' || !SOURCE_VALUES.has(v.source)) {
    return {
      ok: false,
      value: normalize(v),
      errors: ['SettingsSnapshot: field "source" must be one of ' + Array.from(SOURCE_VALUES).join(', ')],
    };
  }
  const value = normalize(v);
  const errors = [];
  if (typeof v.options !== 'object' || v.options === null || Array.isArray(v.options)) {
    errors.push('SettingsSnapshot: field "options" must be a plain object');
  }
  if (typeof v.appliedAt !== 'string') {
    errors.push('SettingsSnapshot: field "appliedAt" must be an ISO date string');
  } else {
    const ts = Date.parse(v.appliedAt);
    if (!Number.isFinite(ts)) {
      errors.push('SettingsSnapshot: field "appliedAt" must be a parseable ISO date string');
    }
  }
  if (value.source === 'profile' && !value.profileName) {
    errors.push('SettingsSnapshot: source:"profile" requires a non-empty profileName');
  }
  return errors.length ? { ok: false, value, errors } : { ok: true, value, errors: [] };
}

module.exports = {
  validateSettingsSnapshot,
  normalize,
  isSettingsSnapshot,
  SOURCE_VALUES,
  SHAPE,
};
