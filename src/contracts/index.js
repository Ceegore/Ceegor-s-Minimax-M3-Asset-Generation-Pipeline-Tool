// src/contracts/index.js
// ============================================================================
// R3.1 — Barrel re-export for the canonical boundary contracts.
//
// Consumers should require this file to access all four contracts:
//
//   const c = require('src/contracts');
//   const r = c.validateImageOperationResult(backendResult);
//   if (!r.ok) { return { ok: false, error: r.errors.join('; ') }; }
//   return r.value;
//
// The four contracts cover the IPC-boundary shapes called out in
// design contract §Phase R3.1:
//   - imageOperationResult: backend "operation finished" envelope
//   - filePickerResult:     "user picked a file" envelope
//   - progressEvent:        per-tick progress event
//   - settingsSnapshot:     fully-merged settings for a backend run
// ============================================================================

const imageOperationResult = require('./imageOperationResult');
const filePickerResult = require('./filePickerResult');
const progressEvent = require('./progressEvent');
const settingsSnapshot = require('./settingsSnapshot');

module.exports = {
  // imageOperationResult
  validateImageOperationResult: imageOperationResult.validateImageOperationResult,
  normalizeImageOperationResult: imageOperationResult.normalize,
  isImageOperationResult: imageOperationResult.isImageOperationResult,
  IMAGE_OPERATION_BACKEND_VALUES: imageOperationResult.BACKEND_VALUES,
  IMAGE_OPERATION_SHAPE: imageOperationResult.SHAPE,

  // filePickerResult
  validateFilePickerResult: filePickerResult.validateFilePickerResult,
  normalizeFilePickerResult: filePickerResult.normalize,
  isFilePickerResult: filePickerResult.isFilePickerResult,
  FILE_PICKER_SHAPE: filePickerResult.SHAPE,

  // progressEvent
  validateProgressEvent: progressEvent.validateProgressEvent,
  normalizeProgressEvent: progressEvent.normalize,
  isProgressEvent: progressEvent.isProgressEvent,
  PROGRESS_PHASE_VALUES: progressEvent.PHASE_VALUES,
  PROGRESS_EVENT_SHAPE: progressEvent.SHAPE,

  // settingsSnapshot
  validateSettingsSnapshot: settingsSnapshot.validateSettingsSnapshot,
  normalizeSettingsSnapshot: settingsSnapshot.normalize,
  isSettingsSnapshot: settingsSnapshot.isSettingsSnapshot,
  SETTINGS_SOURCE_VALUES: settingsSnapshot.SOURCE_VALUES,
  SETTINGS_SNAPSHOT_SHAPE: settingsSnapshot.SHAPE,
};
