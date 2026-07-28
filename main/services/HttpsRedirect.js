// main/services/HttpsRedirect.js
// HTTPS GET with manual redirect handling (3xx).
// Node has no native "followRedirects" toggle for `https.get`, and
// GitHub release URLs can return a Location header pointing at an S3
// URL, so the redirect must be followed manually.

const https = require('https');

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_REDIRECTS = 5;

/**
 * Follows redirects and returns the **final** IncomingMessage.
 * The caller is responsible for `.on('data')` and closing the streams
 * (otherwise the socket leaks).
 *
 * A `remaining` counter is threaded through the recursion and rejects
 * with "Too many redirects" once it hits zero, so a malicious or buggy
 * server that keeps returning 3xx in a tight loop can't pin the
 * function in infinite recursion.
 *
 * The `{ get = https.get }` DI seam lets tests substitute the http
 * transport without spinning up a TLS server; production behaviour
 * is unchanged.
 *
 * @param {string} url
 * @param {number} [maxRedirects=5]
 * @param {{ get?: typeof https.get }} [deps]
 * @returns {Promise<import('http').IncomingMessage>}
 */
function httpsGetFollowingRedirects(url, maxRedirects = DEFAULT_MAX_REDIRECTS, deps = {}) {
  const transport = deps.get || https.get;
  return new Promise((resolve, reject) => {
    function get(target, remaining) {
      transport(target, (res) => {
        if (REDIRECT_CODES.has(res.statusCode)) {
          const next = res.headers.location;
          res.resume(); // Drain the socket so it doesn't leak.
          if (!next || remaining <= 0) return reject(new Error('Too many redirects'));
          get(new URL(next, target).toString(), remaining - 1);
          return;
        }
        resolve(res);
      }).on('error', reject);
    }
    get(url, maxRedirects);
  });
}

module.exports = { httpsGetFollowingRedirects };
