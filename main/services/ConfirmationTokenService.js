// main/services/ConfirmationTokenService.js
// ============================================================================
// P1-G (360° Audit H-016): Destructive IPC confirmation tokens.
//
// Destructive operations (reset, delete-all, cancel-all) require a
// single-use confirmation token minted via a native dialog. A compromised
// renderer cannot bypass the native dialog to mint tokens — it can only
// PRESENT a token that was already minted by a user gesture.
//
// Flow:
//   1. Renderer calls `confirm:request` with { action, description }
//   2. Main shows a native MessageBox with OK/Cancel
//   3. If user clicks OK, Main mints a single-use token and returns it
//   4. Renderer includes the token in the destructive IPC call
//   5. Main validates the token (exists, not consumed, matches action)
//   6. Token is consumed (single-use)
//
// Without a valid token, the destructive IPC returns:
//   { ok: false, error: 'Confirmation required', confirmationRequired: true }
// ============================================================================
'use strict';

const crypto = require('crypto');
const { dialog } = require('electron');

/** @type {Map<string, {action: string, mintedAt: number, consumed: boolean}>} */
const _tokens = new Map();

/** Token TTL: 5 minutes. After this, the token is invalid. */
const TOKEN_TTL_MS = 5 * 60 * 1000;

/** Maximum tokens in memory (DoS guard). */
const MAX_TOKENS = 100;

/**
 * Mint a confirmation token via native dialog.
 * @param {Electron.BrowserWindow|null} win - The parent window for the dialog.
 * @param {{ action: string, description?: string }} opts
 * @returns {Promise<{ok: true, token: string} | {ok: false, error: string, canceled?: boolean}>}
 */
async function mintToken(win, opts) {
  const action = opts && typeof opts.action === 'string' ? opts.action : '';
  if (!action) return { ok: false, error: 'action is required' };

  const description = (opts && typeof opts.description === 'string') ? opts.description : action;

  // Show native confirmation dialog
  const buttons = ['Confirm', 'Cancel'];
  const result = await dialog.showMessageBox(win || undefined, {
    type: 'warning',
    title: 'Confirm Destructive Action',
    message: `Are you sure you want to: ${description}?`,
    detail: 'This action cannot be undone.',
    buttons,
    defaultId: 1, // Default to Cancel (safe default)
    cancelId: 1,
  });

  if (result.response !== 0) {
    return { ok: false, error: 'User canceled', canceled: true };
  }

  // Evict expired tokens
  const now = Date.now();
  for (const [id, t] of _tokens) {
    if (now - t.mintedAt > TOKEN_TTL_MS || t.consumed) _tokens.delete(id);
  }

  // DoS guard
  if (_tokens.size >= MAX_TOKENS) {
    return { ok: false, error: 'Too many pending confirmation tokens' };
  }

  const token = crypto.randomUUID();
  _tokens.set(token, { action, mintedAt: now, consumed: false });
  return { ok: true, token };
}

/**
 * Validate and consume a confirmation token.
 * @param {string|undefined|null} token
 * @param {string} expectedAction - The action this token must match.
 * @returns {{ok: true} | {ok: false, error: string, confirmationRequired?: boolean}}
 */
function validateToken(token, expectedAction) {
  if (!token || typeof token !== 'string') {
    return { ok: false, error: 'Confirmation required', confirmationRequired: true };
  }

  const entry = _tokens.get(token);
  if (!entry) {
    return { ok: false, error: 'Invalid or expired confirmation token', confirmationRequired: true };
  }

  if (entry.consumed) {
    _tokens.delete(token);
    return { ok: false, error: 'Confirmation token already used', confirmationRequired: true };
  }

  if (Date.now() - entry.mintedAt > TOKEN_TTL_MS) {
    _tokens.delete(token);
    return { ok: false, error: 'Confirmation token expired', confirmationRequired: true };
  }

  if (entry.action !== expectedAction) {
    return { ok: false, error: `Confirmation token is for '${entry.action}', not '${expectedAction}'`, confirmationRequired: true };
  }

  // Consume (single-use)
  entry.consumed = true;
  _tokens.delete(token);
  return { ok: true };
}

module.exports = { mintToken, validateToken, TOKEN_TTL_MS };
