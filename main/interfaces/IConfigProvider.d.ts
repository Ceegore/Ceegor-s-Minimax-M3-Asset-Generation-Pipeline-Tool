// main/interfaces/IConfigProvider.d.ts
// Authoritative contract for the config provider.
// Implementation: main/services/ConfigProvider.js.

/**
 * Persisted configuration. Fields are explicit — the sanitizer in
 * main/models/ConfigSchema.js filters every other input.
 *
 * @typedef {object} Config
 * @property {string} api_key
 *   '' when unset; otherwise the raw key (renderer masks before UI display).
 * @property {string} output_dir
 *   Absolute path to the output directory.
 * @property {'global' | 'cn'} region
 * @property {'light' | 'dark'} theme
 * @property {Array<{name: string, value: string}>} styles
 *   User-defined style presets.
 */

/**
 * Reads / writes / sanitises the user config (`config.txt` next to the .exe).
 * Sanitizer: only the fields declared in `Config` are written back to the file
 * — a compromised renderer cannot inject extra keys.
 *
 * @typedef {object} IConfigProvider
 * @property {() => Config} read
 *   Current config. NOT validated by the provider — callers can assume the
 *   file is consistent.
 * @property {(cfg: Partial<Config>) => Config} write
 *   Writes the cleaned config back and returns the final saved version.
 * @property {() => string} configPath
 *   Absolute path to `config.txt`. Shown in the diagnostics dialog so the user
 *   can inspect the file manually.
 */

module.exports = {};
