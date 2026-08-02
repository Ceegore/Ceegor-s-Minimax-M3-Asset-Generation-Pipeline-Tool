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

// H-065: READ-ONLY resolution. Returns the writable override when it exists,
// otherwise the bundled asset, otherwise the (non-existent) override path.
// This function must NEVER be used to compute a WRITE destination — if the
// bundled asset exists, the returned path points into resources/bin, which is
// read-only in packaged builds. Use resolveWritableOverride() for writes.
function resolveAsset(kind, filename, { appRoot = config.appRoot, resourcesPath = config.resourcesPath, userDataPath = config.userDataPath } = {}) {
  const partsOverride = ['assets'];
  const partsBundled = [];
  if (kind) {
    partsOverride.push(kind);
    partsBundled.push(kind);
  }
  partsOverride.push(filename);
  partsBundled.push(filename);

  // Check writable override first (pure read — H-065 removed the mkdir
  // side-effect that used to create override dirs on every lookup).
  let overridePath = null;
  if (userDataPath) {
    overridePath = path.join(userDataPath, ...partsOverride);
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

// H-065: WRITE-TARGET resolution. Always resolves into the writable override
// directory (<userData>/assets/[kind/]filename), never into the bundled
// resources tree. Creates the parent directory so the caller can write
// immediately. Downloads, installs, and replace operations must use THIS
// function — resolveAsset() would hand back the read-only bundled path
// whenever a bundled copy of the asset exists.
function resolveWritableOverride(kind, filename, { userDataPath = config.userDataPath } = {}) {
  if (!userDataPath) {
    throw new Error('userDataPath is required for resolveWritableOverride');
  }
  if (typeof filename !== 'string' || !filename) {
    throw new Error('filename is required for resolveWritableOverride');
  }
  const parts = ['assets'];
  if (kind) parts.push(kind);
  parts.push(filename);
  const dest = path.join(userDataPath, ...parts);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  return dest;
}

module.exports = {
  init,
  getConfig,
  bundledBinDir,
  writableAssetsDir,
  resolveAsset,
  resolveWritableOverride
};
