'use strict';

/**
 * Operation Intent Service for destructive operations.
 * 
 * AUD-004 fix: Separate navigation/read grants from mutation grants.
 * Mint destructive grants only after a native main-process confirmation
 * tied to exact paths and exact operation. Make delete/move/overwrite
 * grants single-use and short-lived.
 * 
 * The confirmation handler canonicalizes and authorizes paths BEFORE
 * displaying the native dialog. The execute handler repeats authorization
 * and canonicalization, then consumes the exact token. This protects
 * against path replacement between confirmation and execution.
 */

const crypto = require('crypto');
const { dialog } = require('electron');
const { CODES, AppError } = require('../errors/AppError');

// M-015 (hhhhu3 audit): how often expired tokens are proactively evicted.
const SWEEP_INTERVAL_MS = 60_000;

/**
 * M-014 (hhhhu3 audit): compare a bound file identity ({dev, ino} from
 * lstat) against the identity observed at execution time. A null/missing
 * identity on both sides matches (test harnesses without a filesystem);
 * one-sided identity never matches.
 * @param {{dev?: number, ino?: number}|null|undefined} a
 * @param {{dev?: number, ino?: number}|null|undefined} b
 * @returns {boolean}
 */
function identityEqual(a, b) {
  const hasA = !!(a && typeof a === 'object');
  const hasB = !!(b && typeof b === 'object');
  if (!hasA && !hasB) return true;
  if (!hasA || !hasB) return false;
  return a.dev === b.dev && a.ino === b.ino;
}

class OperationIntentService {
  /**
   * @param {{now?: () => number}} [opts] - Options for testing
   */
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    /** @type {Map<string, object>} */
    this.tokens = new Map();
    /** @type {ReturnType<typeof setTimeout>|null} */
    this._sweepTimer = null;
  }

  /**
   * Create a sender binding from an IPC event.
   * @param {Electron.IpcMainInvokeEvent} event
   * @returns {{webContentsId: number, frameRoutingId: number|null}}
   */
  senderBinding(event) {
    return {
      webContentsId: event.sender.id,
      frameRoutingId: event.senderFrame && Number.isInteger(event.senderFrame.routingId)
        ? event.senderFrame.routingId : null,
    };
  }

  /**
   * Show a native confirmation dialog and create an intent token.
   * @param {Electron.IpcMainInvokeEvent} event - IPC event
   * @param {{
   *   title: string,
   *   message: string,
   *   detail?: string,
   *   confirmLabel: string,
   *   operation: string,
   *   canonicalSource: string,
   *   canonicalDestination?: string|null,
   *   sourceGrantId: string,
   *   destinationGrantId?: string|null,
   *   sourceIdentity?: {dev: number, ino: number}|null
   * }} spec - Confirmation specification
   * @returns {Promise<{ok: true, intentId: string} | {ok: false, canceled: true}>}
   */
  async confirm(event, spec) {
    const result = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Cancel', spec.confirmLabel],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: spec.title,
      message: spec.message,
      detail: spec.detail,
    });
    if (result.response !== 1) return { ok: false, canceled: true };

    const id = crypto.randomUUID();
    this.tokens.set(id, {
      id,
      sender: this.senderBinding(event),
      operation: spec.operation,
      canonicalSource: spec.canonicalSource,
      canonicalDestination: spec.canonicalDestination || null,
      sourceGrantId: spec.sourceGrantId,
      destinationGrantId: spec.destinationGrantId || null,
      // M-014 (hhhhu3 audit): bind the file identity observed at
      // confirmation time. The execute handler re-observes it and must
      // match, so swapping the target (symlink/path replacement) between
      // confirmation and execution is rejected.
      sourceIdentity: spec.sourceIdentity || null,
      expiresAt: this.now() + 30_000, // 30-second validity
      consumed: false,
    });
    this._scheduleSweep();
    return { ok: true, intentId: id };
  }

  /**
   * Consume an intent token, verifying it matches the actual operation.
   * @param {Electron.IpcMainInvokeEvent} event - IPC event
   * @param {string} intentId - The intent token ID
   * @param {{
   *   operation: string,
   *   canonicalSource: string,
   *   canonicalDestination?: string|null,
   *   sourceGrantId: string,
   *   destinationGrantId?: string|null,
   *   sourceIdentity?: {dev: number, ino: number}|null
   * }} actual - The actual operation being performed
   * @returns {{ok: true}}
   * @throws {AppError} If token is invalid, expired, consumed, or mismatched
   */
  consume(event, intentId, actual) {
    const token = this.tokens.get(intentId);
    if (!token || token.consumed || this.now() > token.expiresAt) {
      throw new AppError(CODES.PATH_INTENT_REQUIRED, 'A fresh confirmation is required.');
    }
    const sender = this.senderBinding(event);
    const equal = token.sender.webContentsId === sender.webContentsId
      && token.sender.frameRoutingId === sender.frameRoutingId
      && token.operation === actual.operation
      && token.canonicalSource === actual.canonicalSource
      && token.canonicalDestination === (actual.canonicalDestination || null)
      && token.sourceGrantId === actual.sourceGrantId
      && token.destinationGrantId === (actual.destinationGrantId || null)
      && identityEqual(token.sourceIdentity, actual.sourceIdentity);
    if (!equal) throw new AppError(CODES.PATH_INTENT_MISMATCH, 'Confirmation does not match the requested operation.');
    token.consumed = true;
    this.tokens.delete(intentId);
    return { ok: true };
  }

  /**
   * M-015 (hhhhu3 audit): proactively evict expired tokens instead of
   * retaining them until consumed or process shutdown. Runs at most once
   * a minute while any token exists; the timer is unref'd so it never
   * holds the process open.
   * @private
   */
  _scheduleSweep() {
    if (this._sweepTimer) return;
    this._sweepTimer = setTimeout(() => {
      this._sweepTimer = null;
      const now = this.now();
      for (const [id, token] of this.tokens) {
        if (now > token.expiresAt) this.tokens.delete(id);
      }
      if (this.tokens.size > 0) this._scheduleSweep();
    }, SWEEP_INTERVAL_MS);
    this._sweepTimer.unref?.();
  }

  /**
   * Destroy the service, clearing all tokens and the sweep timer.
   * Call this on app/window close.
   */
  destroy() {
    this.tokens.clear();
    if (this._sweepTimer) {
      clearTimeout(this._sweepTimer);
      this._sweepTimer = null;
    }
  }
}

module.exports = { OperationIntentService, identityEqual };
