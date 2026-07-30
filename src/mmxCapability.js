// src/mmxCapability.js
// R7.2: Provider-Capability-Snapshot — probes the mmx CLI's actual capabilities
// (version, supported flags, model/mode matrix) and caches the result.
//
// Before R7.2, the app only checked `probeMmxVersion() >= 1.0.16` to decide
// whether to warn the user. This is brittle: a newer CLI might remove a flag
// the UI still shows, or an older CLI might support a flag we don't expose.
//
// The CapabilitySnapshot replaces the version-only check with a structured
// probe of what the CLI ACTUALLY supports:
//   1. Version (from `mmx --version`)
//   2. Top-level flags (from `mmx --help`)
//   3. Subcommand availability (image, speech, music, video, etc.)
//   4. Per-subcommand flags (from `mmx <sub> --help`)
//   5. Model/mode matrix (parsed from subcommand help)
//
// The snapshot is cached in-memory with explicit invalidation (called after
// a CLI update or manual "Re-detect" in Settings). It is NEVER persisted to
// disk — the probe is fast (~200ms) and must reflect the actual installed CLI.
//
// Usage:
//   const { getSnapshot, invalidate } = require('./mmxCapability');
//   const snap = getSnapshot();
//   if (snap.subcommands.image && snap.subcommands.image.flags.includes('--model')) { ... }

'use strict';

const { spawnSync } = require('child_process');
const { findNodeExe, findMmxEntry, needsRunAsNode } = require('./mmxResolve');
const { COMMAND_MATRIX, isVersionAllowed } = require('./services/ContractRegistry');

// Known subcommands the app uses. The probe checks each one's --help.
// Note: sound-effect is not a bundled CLI subcommand or supported speech flag.
// on the speech subcommand. Only actual mmx subcommands belong here.
const KNOWN_SUBCOMMANDS = ['image', 'speech', 'music', 'video'];

// Cache: undefined = not probed, null = probe failed, object = snapshot.
let _cache = undefined;

/**
 * Run a synchronous probe command and return { stdout, stderr, status }.
 * Never throws — returns null on any error.
 */
function _probe(args, timeoutMs) {
  try {
    const node = findNodeExe();
    const entry = findMmxEntry();
    if (!node || !entry) return null;
    // BUG FIX: spread process.env so the child inherits PATH, USERPROFILE,
    // APPDATA, SYSTEMROOT etc. The old code replaced the entire env with just
    // { ELECTRON_RUN_AS_NODE: '1' } (or {}), stripping everything the CLI
    // needs to locate its config (~/.mmx/config.json) and run sub-tools.
    const env = needsRunAsNode(node) ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : undefined;
    const r = spawnSync(node, [entry, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: timeoutMs || 6000,
      env,
    });
    return {
      stdout: (r && r.stdout) || '',
      stderr: (r && r.stderr) || '',
      status: r ? r.status : -1,
    };
  } catch (_) {
    return null;
  }
}

/**
 * Parse `--help` output to extract flag names (e.g. --model, --dry-run).
 * Returns an array of lowercase flag strings.
 */
function _parseFlags(helpText) {
  if (!helpText) return [];
  const flags = new Set();
  // Match --flag-name patterns (word chars + hyphens after --).
  const re = /--([a-z][a-z0-9-]*)/gi;
  let m;
  while ((m = re.exec(helpText)) !== null) {
    flags.add('--' + m[1].toLowerCase());
  }
  return Array.from(flags).sort();
}

/**
 * Parse `--help` output to extract available models/modes.
 * Looks for a "Models:" or "Available models:" section and extracts
 * indented model names. Returns an array of strings.
 */
function _parseModels(helpText) {
  if (!helpText) return [];
  const models = [];
  // Look for lines like "  model-name" after a "Models:" header.
  const lines = helpText.split('\n');
  let inModels = false;
  for (const line of lines) {
    if (/^\s*(available\s+)?models?\s*:/i.test(line)) {
      inModels = true;
      continue;
    }
    if (inModels) {
      // End of models section: a new header or empty line after content.
      if (/^\s*$/.test(line) && models.length > 0) break;
      if (/^\s*[A-Z]/.test(line) && !/^\s{2,}/.test(line)) break;
      // Extract model name (first word on an indented line).
      const m = line.match(/^\s{2,}([a-z0-9][a-z0-9._-]*)/i);
      if (m) models.push(m[1]);
    }
  }
  return models;
}

/**
 * Probe the CLI and build the full capability snapshot.
 * Synchronous — called once at startup or after invalidation.
 * @returns {object|null} Snapshot or null if CLI not found.
 */
function _buildSnapshot() {
  // 1. Version probe.
  const versionProbe = _probe(['--version'], 6000);
  if (!versionProbe) return null;
  const versionMatch = (versionProbe.stdout + ' ' + versionProbe.stderr).match(/(\d+\.\d+\.\d+)/);
  const version = versionMatch ? versionMatch[1] : null;

  // 2. Top-level help.
  const helpProbe = _probe(['--help'], 6000);
  const topFlags = helpProbe ? _parseFlags(helpProbe.stdout + '\n' + helpProbe.stderr) : [];

  // 3. Per-subcommand probes.
  // FUNC-001: use ContractRegistry COMMAND_MATRIX instead of hardcoded
  // [sub, 'generate', '--help']. Speech uses 'synthesize', not 'generate'.
  const subcommands = {};
  for (const sub of KNOWN_SUBCOMMANDS) {
    const cmd = COMMAND_MATRIX[sub];
    if (!cmd) {
      subcommands[sub] = { available: false, flags: [], models: [] };
      continue;
    }
    // cmd is e.g. ['image', 'generate'] or ['speech', 'synthesize']
    const subProbe = _probe([...cmd, '--help'], 4000);
    if (subProbe && subProbe.status === 0) {
      const combined = subProbe.stdout + '\n' + subProbe.stderr;
      subcommands[sub] = {
        available: true,
        flags: _parseFlags(combined),
        models: _parseModels(combined),
      };
    } else {
      subcommands[sub] = { available: false, flags: [], models: [] };
    }
  }

  // 4. Dry-run capability: check if any subcommand supports --dry-run.
  const hasDryRun = Object.values(subcommands).some((s) => s.flags.includes('--dry-run'));

  return {
    version,
    // FUNC-002: hard-reject blocked versions (1.0.16, 1.0.17).
    versionAllowed: isVersionAllowed(version),
    topFlags,
    subcommands,
    hasDryRun,
    probedAt: Date.now(),
  };
}

/**
 * Get the capability snapshot (cached). Returns null if the CLI is not found.
 * @returns {object|null}
 */
function getSnapshot() {
  if (_cache !== undefined) return _cache;
  _cache = _buildSnapshot();
  return _cache;
}

/**
 * Invalidate the cached snapshot. Call after a CLI update or manual re-detect.
 */
function invalidate() {
  _cache = undefined;
}

/**
 * Check if a specific subcommand is available.
 * @param {string} sub - Subcommand name (e.g. 'image', 'speech').
 * @returns {boolean}
 */
function isSubcommandAvailable(sub) {
  const snap = getSnapshot();
  return !!(snap && snap.subcommands[sub] && snap.subcommands[sub].available);
}

/**
 * Check if a specific flag is supported by a subcommand.
 * @param {string} sub - Subcommand name.
 * @param {string} flag - Flag name (e.g. '--model', '--dry-run').
 * @returns {boolean}
 */
function isFlagSupported(sub, flag) {
  const snap = getSnapshot();
  if (!snap || !snap.subcommands[sub]) return false;
  return snap.subcommands[sub].flags.includes(flag.toLowerCase());
}

/**
 * Get the list of available models for a subcommand.
 * @param {string} sub - Subcommand name.
 * @returns {string[]}
 */
function getModels(sub) {
  const snap = getSnapshot();
  if (!snap || !snap.subcommands[sub]) return [];
  return snap.subcommands[sub].models;
}

module.exports = {
  getSnapshot,
  invalidate,
  isSubcommandAvailable,
  isFlagSupported,
  getModels,
  KNOWN_SUBCOMMANDS,
  // Exported for testing.
  _parseFlags,
  _parseModels,
  _buildSnapshot,
};
