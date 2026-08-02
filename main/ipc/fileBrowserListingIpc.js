// main/ipc/fileBrowserListingIpc.js
// M-014 (hhhhu2 audit): cursor-based paginated directory listing handlers
// (fb:listStart / fb:listNext / fb:listClose), split out of
// registerFileBrowserIpc.js. These handlers replace the old 5,000-entry
// truncation with bounded Main-owned sessions that return all entries in
// sorted pages.
//
// MED-020: the drive enumeration helper (fb:listDrives) lives here too —
// parallel per-letter probing with an overall deadline so a slow/unresponsive
// network drive never blocks the listing.

'use strict';

const fsp = require('fs').promises;
const { authorizePath: _authorizePath } = require('./grantAuthorizer');
const { secureHandle } = require('./secureHandle');
// M-014 (hhhhu2 audit): cursor-based directory pagination service.
const { DirectoryListingService } = require('../services/DirectoryListingService');
const listingService = new DirectoryListingService();

// MED-020: parallel drive enumeration with an overall deadline instead of
// sequential per-letter probing.
async function listDrives() {
  if (process.platform === 'win32') {
    const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ';
    const PER_LETTER_TIMEOUT_MS = 1500;
    const OVERALL_DEADLINE_MS = 4000;
    const results = await Promise.race([
      Promise.allSettled(
        [...letters].map(async (ch) => {
          const root = ch + ':\\';
          const st = await Promise.race([
            fsp.stat(root),
            new Promise((_, reject) => {
              setTimeout(() => reject(new Error('stat timeout')), PER_LETTER_TIMEOUT_MS);
            }),
          ]);
          if (st && st.isDirectory()) return { name: root, label: ch + ':' };
          return null;
        })
      ),
      new Promise((resolve) => {
        setTimeout(() => resolve([]), OVERALL_DEADLINE_MS);
      }),
    ]);
    const out = [];
    for (const r of results) {
      if (r && r.status === 'fulfilled' && r.value) out.push(r.value);
    }
    return out;
  }
  return [{ name: '/', label: '/' }];
}

/**
 * Register the listing IPC handlers.
 * @param {{ getMainWindow: () => any }} deps
 */
function registerListingHandlers(deps) {
  const getMainWindow = deps.getMainWindow;

  secureHandle('fb:listStart', { getMainWindow }, async (e, opts) => {
    if (!opts || typeof opts !== 'object') return { ok: false, error: 'opts is required.' };
    const { dir, grantId, sort, direction, pageSize } = opts;
    if (!dir || typeof dir !== 'string') return { ok: false, error: 'dir is required.' };
    if (!grantId) return { ok: false, error: 'grantId is required for directory listing.' };
    const authz = _authorizePath(grantId, 'read', dir);
    if (!authz.ok) return authz;
    try {
      const result = await listingService.listStart({
        dir,
        senderId: e.sender.id,
        sort,
        direction,
        pageSize,
      });
      return { ok: true, ...result };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  secureHandle('fb:listNext', { getMainWindow }, async (e, opts) => {
    if (!opts || typeof opts !== 'object') return { ok: false, error: 'opts is required.' };
    const { sessionId, cursor } = opts;
    if (!sessionId || !cursor) return { ok: false, error: 'sessionId and cursor are required.' };
    try {
      const result = listingService.listNext({
        sessionId,
        cursor,
        senderId: e.sender.id,
      });
      return { ok: true, ...result };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  secureHandle('fb:listClose', { getMainWindow }, async (e, opts) => {
    if (!opts || typeof opts !== 'object') return { ok: false, error: 'opts is required.' };
    const { sessionId } = opts;
    if (!sessionId) return { ok: false, error: 'sessionId is required.' };
    try {
      listingService.listClose({ sessionId, senderId: e.sender.id });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  secureHandle('fb:listDrives', { getMainWindow }, async () => {
    try {
      const drives = await listDrives();
      return { ok: true, drives };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e), drives: [] };
    }
  });
}

module.exports = { registerListingHandlers, listDrives };
