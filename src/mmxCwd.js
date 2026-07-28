// src/mmxCwd.js
// cwd validation for runMmx. A malicious cwd could point at a UNC path the
// user isn't supposed to see (mmx-cli would chdir into it before running),
// or trigger a path-traversal-amplified arg-injection via cwd-relative
// resource lookups. We accept cwd only when it is:
//   (a) undefined / null (use the OS default — process.cwd())
//   (b) an absolute path
// Anything else (relative paths, paths with NUL bytes, empty strings,
// non-strings) is silently coerced to undefined.

const path = require('path');

function safeCwd(cwd) {
  if (cwd === undefined || cwd === null) return undefined;
  if (typeof cwd !== 'string') return undefined;
  if (cwd.indexOf('\0') !== -1) return undefined;
  if (cwd === '' || cwd === '.' || cwd === './') return undefined;
  return path.isAbsolute(cwd) ? cwd : undefined;
}

module.exports = { safeCwd };
