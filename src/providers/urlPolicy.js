// src/providers/urlPolicy.js
// ============================================================================
// P1-D (360° Audit C-008, H-020): SSRF protection for provider base URLs.
//
// A compromised renderer could set a provider's baseUrl to an internal
// network address (localhost, 169.254.169.254, 10.x, 192.168.x) and use
// the app's HTTP client to probe/attack internal services. This module
// validates provider URLs BEFORE any network request is made.
//
// Rules:
//   1. HTTPS only (no http://, no protocol-relative)
//   2. Block localhost / loopback (127.0.0.1, ::1, 0.0.0.0, localhost)
//   3. Block RFC1918 private ranges (10.x, 172.16-31.x, 192.168.x)
//   4. Block link-local (169.254.x) — includes cloud metadata endpoint
//   5. Block IPv6 unique-local (fc00::/7) and link-local (fe80::/10)
//   6. Block known cloud metadata IPs (169.254.169.254, fd00:ec2::254)
//   7. Allowlist: OpenRouter and Replicate have hardcoded URLs
// ============================================================================
'use strict';

const dns = require('dns');
const { URL } = require('url');

/** Hardcoded safe URLs for known providers. */
const KNOWN_PROVIDER_URLS = Object.freeze({
  openrouter: 'https://openrouter.ai/api/v1',
  replicate: 'https://api.replicate.com/v1',
});

/**
 * Check if a hostname is a loopback/localhost address.
 * @param {string} hostname
 * @returns {boolean}
 */
function isLoopback(hostname) {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h === 'localhost.localdomain') return true;
  if (h === '127.0.0.1' || h === '::1' || h === '[::1]' || h === '0.0.0.0') return true;
  if (h.endsWith('.localhost')) return true;
  // 127.0.0.0/8
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return false;
}

/**
 * Check if an IPv4 address is in a private/reserved range.
 * @param {string} ip - Dotted-quad IPv4 address.
 * @returns {boolean}
 */
function isPrivateIPv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 (link-local + cloud metadata)
  if (a === 169 && b === 254) return true;
  // 0.0.0.0/8
  if (a === 0) return true;
  // 100.64.0.0/10 (CGNAT)
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/**
 * Check if an IPv6 address is private/link-local/loopback.
 * @param {string} ip - IPv6 address (without brackets).
 * @returns {boolean}
 */
function isPrivateIPv6(ip) {
  const h = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === '::1' || h === '::') return true;
  // fe80::/10 link-local
  if (h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb')) return true;
  // fc00::/7 unique-local
  if (h.startsWith('fc') || h.startsWith('fd')) return true;
  // ::ffff:127.0.0.1 (IPv4-mapped loopback)
  if (h.startsWith('::ffff:')) {
    const v4 = h.slice(7);
    if (isLoopback(v4) || isPrivateIPv4(v4)) return true;
  }
  // Cloud metadata: fd00:ec2::254
  if (h === 'fd00:ec2::254') return true;
  return false;
}

/**
 * Validate a provider base URL for SSRF safety.
 * Returns {ok: true} if safe, or {ok: false, error: string} if blocked.
 *
 * @param {string} urlStr - The URL to validate.
 * @param {{ allowHttp?: boolean, skipDnsCheck?: boolean }} [opts]
 * @returns {{ok: true} | {ok: false, error: string}}
 */
function validateProviderUrl(urlStr, opts) {
  const { allowHttp = false, skipDnsCheck = false } = opts || {};

  if (!urlStr || typeof urlStr !== 'string') {
    return { ok: false, error: 'URL is required' };
  }

  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch (_) {
    return { ok: false, error: 'Invalid URL format' };
  }

  // Rule 1: HTTPS only (unless explicitly allowed for dev)
  if (parsed.protocol !== 'https:' && !(allowHttp && parsed.protocol === 'http:')) {
    return { ok: false, error: 'Only HTTPS provider URLs are allowed (got ' + parsed.protocol + ')' };
  }

  const hostname = parsed.hostname;

  // Rule 2: Block loopback
  if (isLoopback(hostname)) {
    return { ok: false, error: 'Loopback/localhost provider URLs are blocked (SSRF protection)' };
  }

  // Rule 3-4: Block private IPv4
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
    if (isPrivateIPv4(hostname)) {
      return { ok: false, error: 'Private/reserved IP provider URLs are blocked (SSRF protection)' };
    }
  }

  // Rule 5: Block private IPv6
  if (hostname.includes(':')) {
    if (isPrivateIPv6(hostname)) {
      return { ok: false, error: 'Private/link-local IPv6 provider URLs are blocked (SSRF protection)' };
    }
  }

  // Rule 6: Block known cloud metadata endpoints explicitly
  if (hostname === '169.254.169.254' || hostname === 'metadata.google.internal') {
    return { ok: false, error: 'Cloud metadata endpoint is blocked (SSRF protection)' };
  }

  return { ok: true };
}

/**
 * Async version that also performs a DNS resolution check to detect
 * DNS rebinding attacks (hostname resolves to a private IP).
 *
 * @param {string} urlStr
 * @param {{ allowHttp?: boolean }} [opts]
 * @returns {Promise<{ok: true} | {ok: false, error: string}>}
 */
async function validateProviderUrlWithDns(urlStr, opts) {
  // First: synchronous checks
  const syncResult = validateProviderUrl(urlStr, opts);
  if (!syncResult.ok) return syncResult;

  const { skipDnsCheck = false } = opts || {};
  if (skipDnsCheck) return { ok: true };

  // DNS resolution check
  let parsed;
  try { parsed = new URL(urlStr); } catch (_) { return { ok: false, error: 'Invalid URL' }; }

  const hostname = parsed.hostname;
  // Skip DNS check for IP literals (already validated above)
  if (/^[\d.]+$/.test(hostname) || hostname.includes(':')) return { ok: true };

  try {
    const addresses = await dns.promises.resolve4(hostname);
    for (const addr of addresses) {
      if (isPrivateIPv4(addr) || isLoopback(addr)) {
        return { ok: false, error: `DNS rebinding detected: ${hostname} resolves to private IP ${addr}` };
      }
    }
  } catch (_) {
    // DNS resolution failure — allow through (the fetch will fail anyway)
    // This avoids blocking providers with transient DNS issues.
  }

  return { ok: true };
}

module.exports = {
  validateProviderUrl,
  validateProviderUrlWithDns,
  isLoopback,
  isPrivateIPv4,
  isPrivateIPv6,
  KNOWN_PROVIDER_URLS,
};
