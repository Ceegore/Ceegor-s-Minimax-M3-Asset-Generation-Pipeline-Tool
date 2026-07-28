const path = require('path');
const fs = require('fs');

let config = {
  appRoot: process.env.MINIMAX_APP_ROOT || process.cwd(),
  resourcesPath: process.env.MINIMAX_RESOURCES_PATH || '',
  userDataPath: process.env.MINIMAX_USER_DATA_PATH || ''
};

function init(opts) {
  config = { ...config, ...opts };
}

function getConfig() {
  return config;
}

function bundledBinDir(appRoot = config.appRoot, resourcesPath = config.resourcesPath) {
  // Electron exposes a resourcesPath in development too, but it points into
  // electron/dist rather than this application's resources. Prefer an
  // existing bundled directory and fall back to the source tree.
  const candidates = [];
  if (resourcesPath) candidates.push(path.join(resourcesPath, 'bin'));
  candidates.push(path.join(appRoot || process.cwd(), 'bin'));
  for (const candidate of candidates) {
    try { if (fs.existsSync(candidate)) return candidate; } catch (_) { /* try the fallback */ }
  }
  return candidates[candidates.length - 1];
}

function writableAssetsDir(userDataPath = config.userDataPath) {
  if (!userDataPath) {
    throw new Error('userDataPath is required for writableAssetsDir');
  }
  const dir = path.join(userDataPath, 'assets');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function resolveAsset(kind, filename, { appRoot = config.appRoot, resourcesPath = config.resourcesPath, userDataPath = config.userDataPath } = {}) {
  const partsOverride = ['assets'];
  const partsBundled = [];
  if (kind) {
    partsOverride.push(kind);
    partsBundled.push(kind);
  }
  partsOverride.push(filename);
  partsBundled.push(filename);

  // Check writable override first
  let overridePath = null;
  if (userDataPath) {
    overridePath = path.join(userDataPath, ...partsOverride);
    // Ensure parent directory exists for write target (when resolving dest path)
    const parentDir = path.dirname(overridePath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
    if (fs.existsSync(overridePath)) {
      return overridePath;
    }
  }

  // Check bundled next
  const bundledPath = path.join(bundledBinDir(appRoot, resourcesPath), ...partsBundled);
  if (fs.existsSync(bundledPath)) {
    return bundledPath;
  }

  // Fallback to overridePath for fresh installs
  return overridePath || bundledPath;
}

module.exports = {
  init,
  getConfig,
  bundledBinDir,
  writableAssetsDir,
  resolveAsset
};
