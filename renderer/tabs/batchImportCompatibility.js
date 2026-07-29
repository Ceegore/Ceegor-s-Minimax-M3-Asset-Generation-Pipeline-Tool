// Compatibility migrations for import documents exported by older releases.
(function () {
  'use strict';

  function migrateLegacyParams(type, input) {
    const params = { ...(input || {}) };
    const warnings = [];
    for (const key of Object.keys(params)) {
      const bare = String(key).replace(/^--/, '').toLowerCase();
      if (type === 'image' && bare === 'model' && String(params[key]).toLowerCase() === 'image-01') {
        delete params[key];
        warnings.push('Removed legacy image --model image-01 (the CLI uses that model implicitly).');
      }
      if (type === 'speech' && bare === 'sample-rate' && String(params[key]) === '48000') {
        params[key] = '44100';
        warnings.push('Changed legacy speech --sample-rate 48000 to supported 44100 Hz.');
      }
    }
    return { params, warnings };
  }

  function unsupportedReason(type, key) {
    const bare = String(key).replace(/^--/, '').toLowerCase();
    if (type === 'speech' && bare === 'sound-effect') {
      return 'Prompt-to-sound-effect is not supported by the bundled mmx-cli. Generate or import this SFX with another tool; it was not run as speech to prevent the prompt from being spoken aloud.';
    }
    return `Unknown or unsupported parameter "${key}" for ${type}. It will be ignored — remove it or check the spelling.`;
  }

  window.BatchImportCompatibility = { migrateLegacyParams, unsupportedReason };
})();
