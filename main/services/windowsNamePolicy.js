'use strict';

/**
 * Re-export from src/ (canonical location).
 * The implementation lives in src/windowsNamePolicy.js so that both
 * src/ and main/ tiers can consume it without DAG violations.
 */
module.exports = require('../../src/windowsNamePolicy');
