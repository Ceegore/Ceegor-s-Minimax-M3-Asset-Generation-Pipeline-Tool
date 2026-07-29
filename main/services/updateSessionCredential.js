const sessionCredentials = require('./SessionCredentialStore');

// Apply the Settings privacy choice without persisting the supplied key.
// An empty session key preserves an already active credential when the user
// saves an unrelated setting; switching back to persisted mode clears it.
function updateSessionCredential(sessionOnly, key) {
  if (!sessionOnly) {
    sessionCredentials.clearSessionCredential();
    return;
  }
  const next = typeof key === 'string' ? key.trim() : '';
  if (next) sessionCredentials.setSessionCredential(next);
}

module.exports = { updateSessionCredential };
