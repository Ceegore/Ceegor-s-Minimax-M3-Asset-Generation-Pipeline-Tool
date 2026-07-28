'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MANIFEST_PATH = path.resolve(__dirname, '..', 'runtime-assets.json');

function readManifest() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.assets) || manifest.assets.length === 0) {
    throw new Error('The runtime asset manifest has an unsupported or empty format.');
  }
  return manifest;
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let read;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function verifyRuntimeAssets(binRoot, options = {}) {
  const verifyHashes = options.verifyHashes !== false;
  const manifest = readManifest();
  const issues = [];
  let totalBytes = 0;

  for (const asset of manifest.assets) {
    const filePath = path.resolve(binRoot, ...asset.path.split('/'));
    const expectedRoot = path.resolve(binRoot) + path.sep;
    if (!filePath.startsWith(expectedRoot)) {
      issues.push(`${asset.path}: invalid path in manifest`);
      continue;
    }
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (_) {
      issues.push(`${asset.path}: missing`);
      continue;
    }
    if (!stat.isFile()) {
      issues.push(`${asset.path}: not a file`);
      continue;
    }
    if (stat.size !== asset.bytes) {
      issues.push(`${asset.path}: size ${stat.size} does not match ${asset.bytes}`);
      continue;
    }
    totalBytes += stat.size;
    if (verifyHashes) {
      const actual = sha256File(filePath);
      if (actual !== asset.sha256) issues.push(`${asset.path}: SHA-256 mismatch`);
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    count: manifest.assets.length,
    totalBytes,
  };
}

module.exports = { MANIFEST_PATH, readManifest, sha256File, verifyRuntimeAssets };
