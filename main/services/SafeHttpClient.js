'use strict';

/**
 * Safe HTTP client for all provider networking.
 * 
 * AUD-008 fix: Resolve both A and AAAA records, validate every returned address,
 * use a custom dispatcher/agent that connects only to a validated address while
 * preserving the original TLS SNI/Host.
 * 
 * AUD-010 fix: Check Content-Length before reading, stream response bodies through
 * hard byte counters, use strict JSON response caps.
 * 
 * AUD-012 fix: Combined signal with strict timeouts for all requests.
 * 
 * Mandatory integration rules:
 * - Provider API requests use redirectPolicy: 'none'; a paid POST is never replayed.
 * - Output downloads may use 'safe-get' redirects only.
 * - A DNS answer containing ANY non-public address is rejected.
 * - The custom lookup callback supplies the validated records to the actual connection.
 * - Provider HTTP uses no ambient HTTP_PROXY, HTTPS_PROXY, or ALL_PROXY.
 * - Authentication is attached only to an explicit authOrigins set.
 */

const dns = require('dns');
const fs = require('fs');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Agent, request } = require('undici');
const ipaddr = require('ipaddr.js');
const { CODES, AppError } = require('../errors/AppError');
const { combinedSignal } = require('./abortTools');

const DEFAULTS = Object.freeze({
  dnsTimeoutMs: 5_000,
  connectTimeoutMs: 10_000,
  headersTimeoutMs: 30_000,
  bodyTimeoutMs: 60_000,
  totalTimeoutMs: 90_000,
  maxJsonBytes: 4 * 1024 * 1024,
  maxErrorBytes: 16 * 1024,
  maxRedirects: 5,
});

/**
 * Check if an address is a public unicast address.
 * @param {string} address - IP address string
 * @returns {boolean}
 */
function isPublicAddress(address) {
  let parsed;
  try { parsed = ipaddr.parse(address); } catch (_) { return false; }
  if (parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress()) {
    parsed = parsed.toIPv4Address();
  }
  return parsed.range() === 'unicast';
}

/**
 * Strip brackets from IPv6 hostname.
 * @param {string} hostname
 * @returns {string}
 */
function bareHostname(hostname) {
  const value = String(hostname || '').toLowerCase();
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
}

/**
 * DNS lookup with timeout and abort support.
 * @param {string} hostname
 * @param {AbortSignal} signal
 * @param {number} timeoutMs
 * @returns {Promise<Array<{address: string, family: number}>>}
 */
function lookupAllBounded(hostname, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    const timer = setTimeout(() => finish(
      reject,
      new AppError(CODES.NETWORK_TIMEOUT, 'DNS resolution timed out.', { retryable: true })
    ), timeoutMs);
    timer.unref?.();
    const onAbort = () => finish(
      reject,
      signal.reason || new DOMException('Aborted', 'AbortError')
    );
    signal?.addEventListener('abort', onAbort, { once: true });
    dns.lookup(hostname, { all: true, verbatim: true }, (error, records) => {
      if (error) finish(reject, error);
      else finish(resolve, records);
    });
  });
}

/**
 * Resolve and validate all public addresses for a hostname.
 * @param {string} hostname
 * @param {AbortSignal} signal
 * @param {number} timeoutMs
 * @returns {Promise<Array<{address: string, family: number}>>}
 * @throws {AppError} If any address is non-public
 */
async function resolvePublic(hostname, signal, timeoutMs = DEFAULTS.dnsTimeoutMs) {
  if (signal?.aborted) throw signal.reason;
  const host = bareHostname(hostname);
  const literal = ipaddr.isValid(host)
    ? [{ address: host, family: ipaddr.parse(host).kind() === 'ipv6' ? 6 : 4 }]
    : null;
  const records = literal || await lookupAllBounded(host, signal, timeoutMs);
  if (!records.length || records.some((r) => !isPublicAddress(r.address))) {
    throw new AppError(CODES.SSRF_BLOCKED, 'The destination resolves to a blocked address.');
  }
  const unique = [];
  const seen = new Set();
  for (const record of records) {
    const key = `${record.family}:${record.address}`;
    if (!seen.has(key)) { seen.add(key); unique.push(record); }
  }
  return unique;
}

/**
 * Validate a URL against policy.
 * @param {string} urlString
 * @param {object} policy
 * @returns {URL}
 * @throws {AppError}
 */
function validateUrl(urlString, policy) {
  let url;
  try { url = new URL(urlString); } catch (_) {
    throw new AppError(CODES.INVALID_ARGUMENT, 'Invalid URL.');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new AppError(CODES.SSRF_BLOCKED, 'Only credential-free HTTPS URLs are allowed.');
  }
  const port = url.port || '443';
  const allowedPorts = policy.allowedPorts || new Set(['443']);
  if (!allowedPorts.has(port)) {
    throw new AppError(CODES.SSRF_BLOCKED, 'The destination port is not allowed.');
  }
  if (policy.allowedOrigins && !policy.allowedOrigins.has(url.origin)) {
    throw new AppError(CODES.SSRF_BLOCKED, 'The destination origin is not allowed.');
  }
  return url;
}

/**
 * Create a custom lookup callback that returns only validated addresses.
 * @param {string} expectedHostname
 * @param {Array<{address: string, family: number}>} records
 * @returns {Function}
 */
function makeLookup(expectedHostname, records) {
  const expected = bareHostname(expectedHostname);
  return (hostname, options, callback) => {
    if (bareHostname(hostname) !== expected) {
      callback(new AppError(CODES.SSRF_BLOCKED, 'Unexpected DNS hostname.'));
      return;
    }
    if (options && options.all) {
      callback(null, records.map((r) => ({ address: r.address, family: r.family })));
      return;
    }
    const family = options && Number(options.family);
    const chosen = records.find((r) => !family || family === r.family) || records[0];
    callback(null, chosen.address, chosen.family);
  };
}

/**
 * Read a response body with a byte limit.
 * @param {import('stream').Readable} body
 * @param {number} maxBytes
 * @param {AbortSignal} signal
 * @returns {Promise<Buffer>}
 */
async function readLimited(body, maxBytes, signal) {
  const chunks = [];
  let total = 0;
  for await (const chunk of body) {
    if (signal?.aborted) throw signal.reason;
    total += chunk.length;
    if (total > maxBytes) {
      body.destroy?.();
      throw new AppError(CODES.RESPONSE_TOO_LARGE, `Response exceeds ${maxBytes} bytes.`);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, total);
}

/**
 * Normalize and validate headers.
 * @param {object} input
 * @returns {object}
 */
function normalizeHeaders(input) {
  const out = {};
  const forbidden = new Set([
    'host', 'connection', 'transfer-encoding', 'content-length',
    'proxy-authorization', 'proxy-connection',
  ]);
  for (const [rawName, rawValue] of Object.entries(input || {})) {
    const name = String(rawName).toLowerCase();
    if (forbidden.has(name)) {
      throw new AppError(CODES.INVALID_ARGUMENT, `Header ${name} is controlled by the HTTP client.`);
    }
    out[name] = rawValue;
  }
  return out;
}

/**
 * Make a single request with validated DNS.
 * @param {URL} url
 * @param {object} options
 * @param {object} policy
 * @param {AbortSignal} signal
 * @param {AbortSignal} parentSignal
 * @returns {Promise<{response: object, dispatcher: Agent}>}
 */
async function requestOnce(url, options, policy, signal, parentSignal) {
  const records = await resolvePublic(url.hostname, signal, policy.dnsTimeoutMs);
  const dispatcher = new Agent({
    connections: 1,
    pipelining: 0,
    connect: {
      lookup: makeLookup(url.hostname, records),
      timeout: policy.connectTimeoutMs,
      autoSelectFamily: true,
    },
  });
  try {
    const requestHeaders = { 'accept-encoding': 'identity', ...normalizeHeaders(options.headers) };
    const response = await request(url, {
      dispatcher,
      method: options.method || 'GET',
      headers: requestHeaders,
      body: options.body,
      signal,
      maxRedirections: 0,
      headersTimeout: policy.headersTimeoutMs,
      bodyTimeout: policy.bodyTimeoutMs,
    });
    return { response, dispatcher };
  } catch (error) {
    await dispatcher.close().catch(() => {});
    if (parentSignal?.aborted) {
      throw parentSignal.reason || new DOMException('Aborted', 'AbortError');
    }
    if (signal?.aborted) {
      throw new AppError(CODES.NETWORK_TIMEOUT, 'The network request timed out.', { cause: error, retryable: true });
    }
    throw error;
  }
}

/**
 * Check if a status code is a redirect.
 * @param {number} status
 * @returns {boolean}
 */
function redirectStatus(status) {
  return status >= 300 && status <= 399;
}

/**
 * Open a URL with redirect handling and validation.
 * @param {string} urlString
 * @param {object} options
 * @param {object} policyInput
 * @returns {Promise<{url: URL, response: object, dispatcher: Agent, signal: AbortSignal}>}
 */
async function open(urlString, options = {}, policyInput = {}) {
  const policy = { ...DEFAULTS, ...policyInput };
  const totalSignal = combinedSignal(options.signal, policy.totalTimeoutMs);
  let current = validateUrl(urlString, policy);
  let redirects = 0;
  let headers = normalizeHeaders(options.headers);

  for (;;) {
    const { response, dispatcher } = await requestOnce(
      current, options, policy, totalSignal, options.signal
    );
    if (!redirectStatus(response.statusCode)) {
      return { url: current, response, dispatcher, signal: totalSignal };
    }

    await response.body.dump().catch(() => {});
    await dispatcher.close().catch(() => {});
    if (options.redirectPolicy !== 'safe-get' || (options.method || 'GET') !== 'GET') {
      throw new AppError(CODES.REDIRECT_BLOCKED, 'Redirects are not allowed for this request.');
    }
    if (++redirects > policy.maxRedirects) {
      throw new AppError(CODES.REDIRECT_BLOCKED, 'Too many redirects.');
    }
    const location = response.headers.location;
    if (!location) throw new AppError(CODES.RESPONSE_INVALID, 'Redirect is missing a Location header.');
    const next = validateUrl(new URL(location, current).href, policy);
    if (next.origin !== current.origin && !policy.authOrigins?.has(next.origin)) {
      delete headers.authorization;
    }
    current = next;
    options = { ...options, headers };
  }
}

/**
 * Fetch and parse JSON with size limits.
 * @param {string} url
 * @param {object} options
 * @param {object} policy
 * @returns {Promise<object>}
 */
async function json(url, options = {}, policy = {}) {
  const opened = await open(url, options, policy);
  try {
    const success = opened.response.statusCode >= 200 && opened.response.statusCode < 300;
    const cap = success
      ? (policy.maxJsonBytes || DEFAULTS.maxJsonBytes)
      : (policy.maxErrorBytes || DEFAULTS.maxErrorBytes);
    const declared = Number(opened.response.headers['content-length'] || 0);
    if (declared > cap) throw new AppError(CODES.RESPONSE_TOO_LARGE, 'Response is too large.');
    const buffer = await readLimited(opened.response.body, cap, opened.signal);
    if (!success) {
      throw new AppError(CODES.RESPONSE_INVALID, `Provider HTTP ${opened.response.statusCode}.`);
    }
    try { return JSON.parse(buffer.toString('utf8')); }
    catch (error) { throw new AppError(CODES.RESPONSE_INVALID, 'Provider returned invalid JSON.', { cause: error }); }
  } finally {
    await opened.dispatcher.close().catch(() => {});
  }
}

/**
 * Download a file with streaming and size limits.
 * @param {string} url
 * @param {string} destination
 * @param {object} options
 * @param {object} policy
 * @returns {Promise<{bytes: number, sha256: string, finalUrl: string}>}
 */
async function toFile(url, destination, options = {}, policy = {}) {
  const opened = await open(url, { ...options, method: 'GET', redirectPolicy: 'safe-get' }, policy);
  const maxBytes = policy.maxFileBytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError('maxFileBytes is required');
  const declared = Number(opened.response.headers['content-length'] || 0);
  if (declared > maxBytes) {
    await opened.response.body.dump().catch(() => {});
    await opened.dispatcher.close().catch(() => {});
    throw new AppError(CODES.RESPONSE_TOO_LARGE, 'Download is too large.');
  }

  let total = 0;
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 });
  const counter = new (require('stream').Transform)({
    transform(chunk, _encoding, callback) {
      total += chunk.length;
      if (total > maxBytes) {
        callback(new AppError(CODES.RESPONSE_TOO_LARGE, 'Download exceeded its byte limit.'));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  try {
    if (opened.response.statusCode < 200 || opened.response.statusCode >= 300) {
      throw new AppError(CODES.RESPONSE_INVALID, `Download HTTP ${opened.response.statusCode}.`);
    }
    await pipeline(opened.response.body, counter, out, { signal: opened.signal });
    return { bytes: total, sha256: hash.digest('hex'), finalUrl: opened.url.href };
  } catch (error) {
    try { fs.unlinkSync(destination); } catch (_) {}
    throw error;
  } finally {
    await opened.dispatcher.close().catch(() => {});
  }
}

module.exports = { json, toFile, open, isPublicAddress, resolvePublic, validateUrl, DEFAULTS };
