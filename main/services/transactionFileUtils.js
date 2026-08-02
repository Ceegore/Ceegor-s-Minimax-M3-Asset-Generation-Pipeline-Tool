// main/services/transactionFileUtils.js
// Low-level filesystem primitives for OutputTransactionService — split out
// for the lint size budget. Behavior-preserving move; no logic changed.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Atomically write and fsync a JSON file.
 * @param {string} filePath
 * @param {object} data
 */
function writeJsonSync(filePath, data) {
  const json = JSON.stringify(data, null, 2);
  const tmp = filePath + '.tmp-' + crypto.randomUUID().slice(0, 8);
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, json);
    try { fs.fsyncSync(fd); } catch (_) { /* best-effort on Windows */ }
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
  // fsync the containing directory where supported
  try {
    const dirFd = fs.openSync(path.dirname(filePath), 'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } catch (_) { /* Windows may not support directory fsync */ }
}

/**
 * Verify a path is a regular file (not a link/reparse point).
 * @param {string} filePath
 * @returns {boolean}
 */
function isRegularFile(filePath) {
  try {
    const st = fs.lstatSync(filePath);
    return st.isFile();
  } catch (_) { return false; }
}

/**
 * Verify no ancestor in the chain is a symlink/reparse point.
 * @param {string} filePath
 * @param {string} stopAt - Ancestor at which to stop checking
 * @returns {boolean}
 */
function ancestorsAreRegular(filePath, stopAt) {
  let current = path.dirname(filePath);
  const stop = path.resolve(stopAt);
  while (current.length > stop.length) {
    try {
      const st = fs.lstatSync(current);
      if (st.isSymbolicLink()) return false;
    } catch (_) { return false; }
    current = path.dirname(current);
  }
  return true;
}

/**
 * Compute SHA-256 of a file synchronously.
 * @param {string} filePath
 * @returns {string} hex digest
 */
function hashFileSync(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(64 * 1024);
    let bytesRead;
    while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.slice(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/**
 * Fsync a file by path (best-effort on Windows where EPERM is common).
 * @param {string} filePath
 */
function fsyncFile(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch (e) {
    // EPERM/EIO on Windows temp/network paths is non-fatal.
    if (e.code !== 'EPERM' && e.code !== 'EIO' && e.code !== 'ENOTSUP') throw e;
  }
}

module.exports = { writeJsonSync, isRegularFile, ancestorsAreRegular, hashFileSync, fsyncFile };
