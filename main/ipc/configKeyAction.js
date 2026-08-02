// main/ipc/configKeyAction.js
// B-007: typed secret command resolution for the API key in config:set,
// split out of registerConfigIpc.js (lint size budget).
//
// The API key is a typed secret command, NOT a config text field. The
// renderer's key input renders EMPTY (secretless DTO), so a plain
// `api_key: ""` in the cfg MUST NEVER mean "delete the stored key" — that
// wiped the key on every unrelated settings save. Resolution order:
//   1. apiKeyNoSave (privacy switch) → persisted key cleared
//      (R2.3.1 contract), session key handled separately.
//   2. Explicit payload.apiKeyAction: 'keep' | 'replace' | 'clear'
//      ('replace' requires a non-empty payload.apiKeyValue).
//   3. Legacy inference (bare-cfg callers): a NON-EMPTY cfg.api_key
//      means replace; empty/absent means KEEP.

'use strict';

/**
 * Resolve the typed key command for a config:set payload.
 * @param {{ isWrapped: boolean, payload: any, cfg: object, apiKeyNoSave: boolean }} opts
 * @returns {{ keyAction: 'keep'|'replace'|'clear', keyValue: string } | { error: string }}
 */
function parseKeyAction({ isWrapped, payload, cfg, apiKeyNoSave }) {
  const rawAction = (isWrapped && payload.apiKeyAction !== undefined) ? payload.apiKeyAction : null;
  if (rawAction !== null && rawAction !== 'keep' && rawAction !== 'replace' && rawAction !== 'clear') {
    return { error: "apiKeyAction must be 'keep', 'replace' or 'clear'." };
  }
  const legacyKey = (typeof cfg.api_key === 'string') ? cfg.api_key.trim() : '';
  if (apiKeyNoSave) {
    return { keyAction: 'clear', keyValue: '' }; // privacy switch: nothing persisted
  }
  if (rawAction === 'replace') {
    const keyValue = (typeof payload.apiKeyValue === 'string') ? payload.apiKeyValue.trim() : '';
    if (!keyValue) {
      return { error: "apiKeyAction 'replace' requires a non-empty apiKeyValue." };
    }
    return { keyAction: 'replace', keyValue };
  }
  if (rawAction === 'clear') return { keyAction: 'clear', keyValue: '' };
  if (rawAction === 'keep') return { keyAction: 'keep', keyValue: '' };
  // Legacy inference: empty text never means delete.
  return { keyAction: legacyKey ? 'replace' : 'keep', keyValue: legacyKey };
}

module.exports = { parseKeyAction };
