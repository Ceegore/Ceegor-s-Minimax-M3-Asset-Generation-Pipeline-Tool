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
const { secureHandle } = require('./secureHandle');
const { OperationIntentService } = require('../services/OperationIntentService');

const intentService = new OperationIntentService();

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
    const labels = { delete: 'Delete', move: 'Move', rename: 'Rename' };
    const label = labels[operation] || operation;
    return intentService.confirm(e, {
      title: label + ' confirmation',
      message: `${label} "${path.basename(sourcePath)}"?`,
      detail: destinationPath ? `Destination: ${destinationPath}` : undefined,
      confirmLabel: label,
      operation,
      canonicalSource: path.resolve(sourcePath),
      canonicalDestination: destinationPath ? path.resolve(destinationPath) : null,
      sourceGrantId,
      destinationGrantId: destinationGrantId || null,
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

module.exports = { intentService, registerConfirmDestructive, consumeIntent };
