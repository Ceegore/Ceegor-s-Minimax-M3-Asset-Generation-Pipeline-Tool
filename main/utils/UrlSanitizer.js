// main/utils/UrlSanitizer.js
// Sanity-Checks für URLs, die der Renderer an `shell.openExternal` reichen darf.
// Verteidigung-in-der-Tiefe: `shell.openExternal` würde zwar vieles ablehnen,
// aber ein klares "no" hier liefert präzise Fehlermeldungen statt
// OS-spezifischer "Invalid URL"-Dialoge.

/**
 * @param {*} url
 * @returns {{ok: true} | {ok: false, error: string}}
 */
function sanitize(url) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return { ok: false, error: 'Only http(s) URLs are allowed.' };
  }
  // Defense-in-depth: reject control characters, newlines, and
  // embedded credentials even though `shell.openExternal` ultimately
  // hands off to the OS browser. The OS would refuse these too,
  // but a clean "no" here means the error message is precise
  // ("malformed URL") instead of OS-specific.
  if (/[\x00-\x1f\x7f]/.test(url) || /[\r\n]/.test(url)) {
    return { ok: false, error: 'URL contains control characters or newlines.' };
  }
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      return { ok: false, error: 'URLs with embedded credentials are not allowed.' };
    }
  } catch {
    return { ok: false, error: 'Malformed URL.' };
  }
  return { ok: true };
}

module.exports = { sanitize };
