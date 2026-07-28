// renderer/utils/fileUrl.js
// File URL builder.
//
// Normalises Windows backslashes to forward slashes, encodes
// special characters (in particular '#' and '?' which encodeURI does
// not escape), and ensures exactly 3 slashes after "file:" — some
// Chromium clients and older Electron versions reject
// file:////home/... as malformed.

/**
 * @param {string} p  Absolute file path
 * @returns {string}  file:// URL
 */
function fileUrl(p) {
  if (!p) return '';
  let normalized = p.replace(/\\/g, '/');
  const encoded = encodeURI(normalized)
    .replace(/#/g, '%23')
    .replace(/\?/g, '%3F');
  const body = encoded.startsWith('/') ? encoded.slice(1) : encoded;
  return 'file:///' + body;
}

window.FileUrl = { fileUrl };
