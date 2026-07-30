// main/services/FeatureFlags.js
// ============================================================================
// P0-A (360° Audit C-003, C-008): Central feature-flag gate for security-
// sensitive features that are disabled in production builds until their
// permanent fixes are complete.
//
// In production (packaged) builds:
//   - External Tools execution is DISABLED (C-003: renderer-configurable RCE)
//   - Custom Provider base-URL changes are DISABLED (C-008: SSRF vector)
//
// In development builds (ELECTRON_IS_DEV or !app.isPackaged):
//   - All features remain available for testing.
//
// These flags are REMOVED once the permanent security fixes land:
//   - C-003: Main-side-only tool registration with hash verification
//   - C-008: URL policy + native confirmation for custom providers
// ============================================================================
'use strict';

const { app } = require('electron');

/** True when running as a packaged/production build. */
function isProduction() {
  return app.isPackaged;
}

/**
 * External Tools execution (spawning user-configured .exe files).
 * DISABLED in production until C-003 permanent fix lands.
 */
function externalToolsEnabled() {
  if (!isProduction()) return true;
  // Allow override via environment for testing packaged builds
  if (process.env.MINIMAX_ENABLE_EXTERNAL_TOOLS === '1') return true;
  return false;
}

/**
 * Custom Provider base-URL modification.
 * DISABLED in production until C-008 permanent fix lands.
 * Fixed-URL providers (OpenRouter, Replicate) remain functional.
 */
function customProviderUrlsEnabled() {
  if (!isProduction()) return true;
  if (process.env.MINIMAX_ENABLE_CUSTOM_PROVIDERS === '1') return true;
  return false;
}

module.exports = {
  isProduction,
  externalToolsEnabled,
  customProviderUrlsEnabled,
};
