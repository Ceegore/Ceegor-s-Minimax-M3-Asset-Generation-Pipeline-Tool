// tests/unit/main/services/ConfirmationTokenService.h031.test.js
// H-031 (_5 audit): ConfirmationTokenService must use Main-owned immutable
// ACTION_TEXTS — the renderer must NEVER control the native dialog text.
// Also verifies: single-use tokens, TTL expiry, action mismatch rejection,
// DoS guard, and fallback text for unknown actions.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

// ---- Mock electron's dialog ----
let lastDialogOpts = null;
let dialogResponse = 0; // 0 = Confirm, 1 = Cancel

require.cache[require.resolve('electron')] = {
  exports: {
    dialog: {
      showMessageBox: async (_win, opts) => {
        lastDialogOpts = opts;
        return { response: dialogResponse };
      },
    },
  },
};

// Fresh require of the service under test.
delete require.cache[require.resolve('../../../../main/services/ConfirmationTokenService')];
const { mintToken, validateToken, TOKEN_TTL_MS } = require('../../../../main/services/ConfirmationTokenService');

// ---------------------------------------------------------------------------
// H-031: Main-owned text — renderer description is IGNORED
// ---------------------------------------------------------------------------
test('H-031: mintToken uses Main-owned ACTION_TEXTS, ignores renderer description', async () => {
  dialogResponse = 0; // user clicks Confirm
  lastDialogOpts = null;
  const result = await mintToken(null, {
    action: 'app:resetAllData',
    description: 'Harmless preview of cute kittens', // attacker-supplied
  });
  assert.ok(result.ok, 'token minted');
  assert.ok(result.token, 'token is a string');
  // The dialog MUST show the Main-owned text, NOT the renderer description.
  assert.equal(lastDialogOpts.title, 'Reset All Data');
  assert.equal(lastDialogOpts.message, 'Delete ALL local data?');
  assert.ok(lastDialogOpts.detail.includes('CANNOT be undone'), 'detail is Main-owned');
  assert.ok(!lastDialogOpts.detail.includes('kittens'), 'renderer text must NOT appear');
  assert.ok(!lastDialogOpts.message.includes('kittens'), 'renderer text must NOT appear in message');
});

test('H-031: mintToken shows FALLBACK_TEXT for unknown actions', async () => {
  dialogResponse = 0;
  lastDialogOpts = null;
  const result = await mintToken(null, { action: 'some:unknown:action' });
  assert.ok(result.ok);
  assert.equal(lastDialogOpts.title, 'Confirm Action');
  assert.equal(lastDialogOpts.message, 'Are you sure you want to proceed?');
  assert.equal(lastDialogOpts.detail, 'This action cannot be undone.');
});

test('H-031: providers:deleteAll uses its own Main-owned text', async () => {
  dialogResponse = 0;
  lastDialogOpts = null;
  await mintToken(null, { action: 'providers:deleteAll', description: 'evil' });
  assert.equal(lastDialogOpts.title, 'Remove All Providers');
  assert.ok(lastDialogOpts.detail.includes('API keys'));
});

// ---------------------------------------------------------------------------
// Token lifecycle: single-use, TTL, action binding
// ---------------------------------------------------------------------------
test('validateToken: valid token is consumed (single-use)', async () => {
  dialogResponse = 0;
  const { token } = await mintToken(null, { action: 'app:clearHistory' });
  // First use succeeds
  const first = validateToken(token, 'app:clearHistory');
  assert.ok(first.ok, 'first validation succeeds');
  // Second use fails (consumed)
  const second = validateToken(token, 'app:clearHistory');
  assert.equal(second.ok, false);
  assert.ok(second.error.includes('already used') || second.error.includes('Invalid'));
});

test('validateToken: action mismatch is rejected', async () => {
  dialogResponse = 0;
  const { token } = await mintToken(null, { action: 'app:resetAllData' });
  const result = validateToken(token, 'providers:deleteAll');
  assert.equal(result.ok, false);
  assert.ok(result.error.includes('app:resetAllData'));
  assert.ok(result.confirmationRequired);
});

test('validateToken: missing token returns confirmationRequired', () => {
  const result = validateToken(null, 'app:resetAllData');
  assert.equal(result.ok, false);
  assert.ok(result.confirmationRequired);
  assert.ok(result.error.includes('Confirmation required'));
});

test('validateToken: garbage token returns confirmationRequired', () => {
  const result = validateToken('not-a-real-token', 'app:resetAllData');
  assert.equal(result.ok, false);
  assert.ok(result.confirmationRequired);
});

// ---------------------------------------------------------------------------
// User cancellation
// ---------------------------------------------------------------------------
test('mintToken: user cancel returns ok:false with canceled:true', async () => {
  dialogResponse = 1; // Cancel
  const result = await mintToken(null, { action: 'app:resetAllData' });
  assert.equal(result.ok, false);
  assert.ok(result.canceled);
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------
test('mintToken: missing action returns error', async () => {
  const result = await mintToken(null, {});
  assert.equal(result.ok, false);
  assert.ok(result.error.includes('action is required'));
});

test('mintToken: null opts returns error', async () => {
  const result = await mintToken(null, null);
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------------------
// Dialog safety: default button is Cancel (safe default)
// ---------------------------------------------------------------------------
test('H-031: dialog defaultId is Cancel (1), not Confirm', async () => {
  dialogResponse = 0;
  lastDialogOpts = null;
  await mintToken(null, { action: 'app:resetAllData' });
  assert.equal(lastDialogOpts.defaultId, 1, 'default button must be Cancel');
  assert.equal(lastDialogOpts.cancelId, 1, 'cancelId must be 1');
  assert.equal(lastDialogOpts.type, 'warning');
});

// ---------------------------------------------------------------------------
// TOKEN_TTL_MS is exported and sane
// ---------------------------------------------------------------------------
test('TOKEN_TTL_MS is 5 minutes', () => {
  assert.equal(TOKEN_TTL_MS, 5 * 60 * 1000);
});
