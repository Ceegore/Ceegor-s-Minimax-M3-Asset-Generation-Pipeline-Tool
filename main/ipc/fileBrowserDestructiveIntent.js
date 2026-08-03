// main/ipc/fileBrowserDestructiveIntent.js
// H-013 (hhhhu2 audit): native destructive-operation intent confirmation,
// split out of registerFileBrowserIpc.js.
//
// The renderer calls fb:confirmDestructive BEFORE fb:delete/fb:move/
// fb:rename. It shows a native OS dialog and returns a single-use intentId
// bound to the exact operation, paths, and sender. The subsequent mutation
// handler consumes it via consumeIntent().

'use strict';

const path = require('path');
const fsp = require('fs').promises;
const { secureHandle } = require('./secureHandle');
const { OperationIntentService } = require('../services/OperationIntentService');

const intentService = new OperationIntentService();

// M-014 (hhhhu3 audit): non-consuming grant authorization + canonical
// realpath BEFORE the native dialog. Uses PathGrantService.preflight so a
// single-use grant is not consumed by the confirmation step — the execute
// handler still performs the consuming authorize. The token binds the
// service's canonical realpath (not the renderer's path.resolve string)
// plus the file identity observed at confirmation time.
function preflightGrant(grantId, operation, p) {
  if (!grantId || typeof grantId !== 'string') {
    return { ok: false, error: 'grantId is required for ' + operation + ' on ' + p };
  }
  // Lazy require: grantAuthorizer pattern — always see the CURRENT
  // defaultService (tests rebuild the singleton between cases).
  const { defaultService: pathGrantService } = require('../services/PathGrantService');
  return pathGrantService.preflight(grantId, { operation, path: p });
}

/**
 * M-014 (hhhhu3 audit): capture the current file identity ({dev, ino})
 * of a canonical path. Returns null when the path does not exist yet
 * (rename/move destinations) or cannot be stat'ed; the identity check
 * then matches only a null identity at execution time.
 * @param {string} p
 * @returns {Promise<{dev: number, ino: number}|null>}
 */
async function captureIdentity(p) {
  try {
    const st = await fsp.lstat(p);
    return { dev: st.dev, ino: st.ino };
  } catch (_) {
    return null;
  }
}

/**
 * Register fb:confirmDestructive.
 * @param {{ getMainWindow: () => any }} deps
 */
function registerConfirmDestructive(deps) {
  const getMainWindow = deps.getMainWindow;
  secureHandle('fb:confirmDestructive', { getMainWindow }, async (e, spec) => {
    if (!spec || typeof spec !== 'object') return { ok: false, error: 'spec is required.' };
    const { operation, sourcePath, destinationPath, sourceGrantId, destinationGrantId } = spec;
    if (!operation || !sourcePath || !sourceGrantId) {
      return { ok: false, error: 'operation, sourcePath, and sourceGrantId are required.' };
    }
    if (!['delete', 'move', 'rename'].includes(operation)) {
      return { ok: false, error: 'operation must be delete, move, or rename.' };
    }
    // M-014 (hhhhu3 audit): authorize the source grant BEFORE prompting.
    const srcAuthz = preflightGrant(sourceGrantId, operation, sourcePath);
    if (!srcAuthz.ok) return { ok: false, error: srcAuthz.error };
    // When a destination is supplied (move always, rename when the
    // renderer pre-computes the target path), it must also be in grant
    // scope before we prompt about it.
    let canonicalDestination = null;
    if (destinationPath) {
      const destAuthz = preflightGrant(destinationGrantId || sourceGrantId, 'write', destinationPath);
      if (!destAuthz.ok) return { ok: false, error: destAuthz.error };
      canonicalDestination = destAuthz.canonicalPath;
    }
    const canonicalSource = srcAuthz.canonicalPath;
    // M-014: bind the current file identity so a target swap between
    // confirmation and execution is rejected.
    const sourceIdentity = await captureIdentity(canonicalSource);
    const labels = { delete: 'Delete', move: 'Move', rename: 'Rename' };
    const label = labels[operation] || operation;
    return intentService.confirm(e, {
      title: label + ' confirmation',
      message: `${label} "${path.basename(canonicalSource)}"?`,
      detail: canonicalDestination ? `Destination: ${canonicalDestination}` : undefined,
      confirmLabel: label,
      operation,
      canonicalSource,
      canonicalDestination,
      sourceGrantId,
      destinationGrantId: destinationGrantId || null,
      sourceIdentity,
    });
  });
}

/**
 * Consume a one-shot intent token, verifying it matches the actual
 * operation. Requires an intentId; returns an error envelope when the
 * token is missing/invalid/mismatched, or null when consumed successfully.
 *
 * @param {Electron.IpcMainInvokeEvent} e
 * @param {string|undefined} intentId
 * @param {{ operation: string, canonicalSource: string,
 *           canonicalDestination?: string, sourceGrantId: string,
 *           destinationGrantId?: string }} actual
 * @returns {{ ok: false, error: string } | null}
 */
function consumeIntent(e, intentId, actual) {
  if (!intentId) {
    return { ok: false, error: 'intentId is required for ' + actual.operation + '. Call fb:confirmDestructive first.' };
  }
  try {
    intentService.consume(e, intentId, actual);
    return null;
  } catch (ie) {
    return { ok: false, error: ie.message || 'Intent verification failed.' };
  }
}

module.exports = { intentService, registerConfirmDestructive, consumeIntent, captureIdentity };
