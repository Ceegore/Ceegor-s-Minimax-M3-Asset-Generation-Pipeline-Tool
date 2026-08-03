'use strict';

/**
 * Directory Listing Service — bounded snapshot sessions with cursor pagination.
 *
 * AUD-019 fix: Large folder listing uses bounded metadata concurrency and
 * stable Main-owned cursor sessions, without repeated scans, silent
 * truncation, or event-loop stalls.
 *
 * IPC contract:
 *   fb:listStart({ dir, grantId, sort, direction, pageSize })
 *     -> { sessionId, cursor, items, totalCount, hasMore, directoryVersion }
 *   fb:listNext({ sessionId, cursor })
 *     -> { cursor, items, hasMore, directoryVersion }
 *   fb:listClose({ sessionId })
 *     -> { ok: true }
 *
 * Main binds a listing session to sender, canonical directory, grant snapshot,
 * sort, direction, and a five-minute TTL. The cursor is opaque; the renderer
 * cannot supply an offset into another session.
 */

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { CODES, AppError } = require('../errors/AppError');

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;
const SESSION_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_SESSIONS_PER_SENDER = 5;
const MAX_TOTAL_ENTRIES = 100_000;
const STAT_CONCURRENCY = 8;
const MAX_DIRECTORY_ENTRIES = 200_000; // Reject directories larger than this

/**
 * Bounded concurrency stat helper.
 * M-013 (hhhhu2 audit): uses fs.promises.lstat for real async I/O so the
 * event loop is not blocked. The worker pool genuinely yields between stats.
 * @param {string[]} paths
 * @param {number} concurrency
 * @returns {Promise<Array<{path: string, stat: fs.Stats|null}>>}
 */
async function boundedLstat(paths, concurrency) {
  const fsp = require('fs').promises;
  const results = new Array(paths.length);
  let index = 0;

  async function worker() {
    while (index < paths.length) {
      const i = index++;
      try {
        results[i] = { path: paths[i], stat: await fsp.lstat(paths[i]) };
      } catch (_) {
        results[i] = { path: paths[i], stat: null };
      }
    }
  }

  const workers = [];
  for (let w = 0; w < Math.min(concurrency, paths.length); w++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

// M-013 (hhhhu3 audit): cursors are random opaque tokens tracked
// server-side. The renderer can never supply (or guess) an offset — it
// must present the exact token issued with the previous page.
function mintCursor() {
  return crypto.randomBytes(16).toString('hex');
}

class DirectoryListingService {
  /**
   * @param {{ now?: () => number }} [opts]
   */
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    /** @type {Map<string, object>} */
    this.sessions = new Map();
    /** @type {Map<number, Set<string>>} */
    this.senderSessions = new Map();
    this._evictionTimer = null;
  }

  /**
   * Start a new listing session.
   * @param {{
   *   dir: string,
   *   senderId: number,
   *   sort?: 'name' | 'mtime' | 'size',
   *   direction?: 'asc' | 'desc',
   *   pageSize?: number
   * }} opts
   * @returns {Promise<{sessionId: string, cursor: string, items: object[], totalCount: number, hasMore: boolean, directoryVersion: string}>}
   */
  async listStart(opts) {
    const { dir, senderId, sort = 'name', direction = 'asc', pageSize: rawPageSize } = opts;
    // L-002 (hhhhu2 audit): validate pageSize as a safe integer. NaN,
    // Infinity, non-numbers are rejected and the default is used.
    let pageSize = DEFAULT_PAGE_SIZE;
    if (typeof rawPageSize === 'number' && Number.isSafeInteger(rawPageSize) && rawPageSize >= 1) {
      pageSize = Math.min(rawPageSize, MAX_PAGE_SIZE);
    }

    // Validate sort parameter — only expose what we implement
    if (!['name', 'mtime', 'size'].includes(sort)) {
      throw new AppError(CODES.INVALID_ARGUMENT, `Unsupported sort: ${sort}`);
    }
    if (!['asc', 'desc'].includes(direction)) {
      throw new AppError(CODES.INVALID_ARGUMENT, `Unsupported direction: ${direction}`);
    }

    // Canonicalize and validate directory.
    // L-004 (hhhhu3 audit): async lstat/readdir so a very large or
    // slow/network-backed folder never stalls the Main event loop.
    const canonicalDir = path.resolve(dir);
    let dirStat;
    try { dirStat = await fs.lstat(canonicalDir); } catch (_) {
      throw new AppError(CODES.INVALID_ARGUMENT, 'Directory not found.');
    }
    if (dirStat.isSymbolicLink()) {
      throw new AppError(CODES.INVALID_ARGUMENT, 'Cannot list a symlink directory.');
    }
    if (!dirStat.isDirectory()) {
      throw new AppError(CODES.INVALID_ARGUMENT, 'Path is not a directory.');
    }

    // Evict excess sessions for this sender
    this._evictSender(senderId);

    // Read directory entries once
    let dirents;
    try {
      dirents = await fs.readdir(canonicalDir, { withFileTypes: true });
    } catch (e) {
      throw new AppError(CODES.INVALID_ARGUMENT, `Cannot read directory: ${e.message}`);
    }

    if (dirents.length > MAX_DIRECTORY_ENTRIES) {
      throw new AppError(CODES.RESPONSE_TOO_LARGE,
        'Directory too large for interactive listing. Use search/filter to narrow results.');
    }

    // L-003 (hhhhu2 audit): enforce MAX_TOTAL_ENTRIES across all active
    // sessions for this sender to prevent unbounded memory growth.
    const currentTotal = this._totalItemsForSender(senderId);
    if (currentTotal + dirents.length > MAX_TOTAL_ENTRIES) {
      throw new AppError(CODES.RESPONSE_TOO_LARGE,
        `Cumulative listing size would exceed ${MAX_TOTAL_ENTRIES} entries. Close other listing sessions first.`);
    }

    // Collect names and dirent type
    const entries = dirents.map((d) => ({
      name: d.name,
      isDirectory: d.isDirectory(),
      isSymlink: d.isSymbolicLink(),
    }));

    // Bounded lstat for metadata
    const fullPaths = entries.map((e) => path.join(canonicalDir, e.name));
    const stats = await boundedLstat(fullPaths, STAT_CONCURRENCY);

    // Build items with metadata
    const items = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const stat = stats[i].stat;
      items.push({
        name: entry.name,
        isDir: entry.isDirectory,
        isSymlink: entry.isSymlink,
        size: stat ? stat.size : 0,
        mtimeMs: stat ? stat.mtimeMs : 0,
        ext: path.extname(entry.name).toLowerCase(),
      });
    }

    // Sort: directories first, then by selected field, then name tie-breaker
    const sortDir = direction === 'asc' ? 1 : -1;
    items.sort((a, b) => {
      // Directories always first
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      let cmp = 0;
      switch (sort) {
        case 'name':
          cmp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
          break;
        case 'mtime':
          cmp = (a.mtimeMs - b.mtimeMs) || a.name.localeCompare(b.name);
          break;
        case 'size':
          cmp = (a.size - b.size) || a.name.localeCompare(b.name);
          break;
      }
      return cmp * sortDir;
    });

    // Create session
    const sessionId = crypto.randomUUID();
    const nonce = crypto.randomBytes(8).toString('hex');
    const directoryVersion = `${dirStat.mtimeMs}:${items.length}:${nonce}`;

    const session = {
      id: sessionId,
      senderId,
      canonicalDir,
      sort,
      direction,
      pageSize,
      items,
      directoryVersion,
      createdAt: this.now(),
      lastAccess: this.now(),
      // M-013 (hhhhu3 audit): server-tracked cursor state. The token
      // handed to the renderer is random; the offset it represents is
      // never disclosed, so a caller cannot skip, repeat, or rewind.
      expectedCursor: null,
      expectedOffset: 0,
    };
    this.sessions.set(sessionId, session);
    this._trackSender(senderId, sessionId);
    this._scheduleEviction();

    // Return first page
    const pageItems = items.slice(0, pageSize);
    const hasMore = items.length > pageSize;
    session.expectedOffset = pageSize;
    session.expectedCursor = hasMore ? mintCursor() : null;
    return {
      sessionId,
      cursor: session.expectedCursor,
      items: pageItems,
      totalCount: items.length,
      hasMore,
      directoryVersion,
    };
  }

  /**
   * Get the next page of a listing session.
   * @param {{ sessionId: string, cursor: string, senderId: number }} opts
   * @returns {Promise<{ cursor: string|null, items: object[], hasMore: boolean, directoryVersion: string }>}
   */
  async listNext(opts) {
    const { sessionId, cursor, senderId } = opts;
    const session = this.sessions.get(sessionId);
    if (!session || session.senderId !== senderId) {
      throw new AppError(CODES.INVALID_ARGUMENT, 'Invalid or expired listing session.');
    }

    // Check TTL
    if (this.now() - session.lastAccess > SESSION_TTL_MS) {
      this._removeSession(sessionId);
      throw new AppError(CODES.INVALID_ARGUMENT, 'Listing session expired.');
    }

    // M-013 (hhhhu3 audit): the cursor must be the EXACT random token
    // issued with the previous page. Offsets are server-tracked, so the
    // renderer cannot skip, repeat, or rewind pages.
    if (!session.expectedCursor || typeof cursor !== 'string' || cursor !== session.expectedCursor) {
      throw new AppError(CODES.INVALID_ARGUMENT, 'Invalid listing cursor. Restart the listing session.');
    }

    // Check directory version (detect changes)
    try {
      // L-004 (hhhhu3 audit): async lstat — no Main-thread stall.
      const dirStat = await fs.lstat(session.canonicalDir);
      const currentVersion = `${dirStat.mtimeMs}`;
      const storedMtime = session.directoryVersion.split(':')[0];
      if (currentVersion !== storedMtime) {
        this._removeSession(sessionId);
        throw new AppError(CODES.INVALID_ARGUMENT, 'DIRECTORY_CHANGED');
      }
    } catch (e) {
      if (e instanceof AppError) throw e;
      this._removeSession(sessionId);
      throw new AppError(CODES.INVALID_ARGUMENT, 'Directory no longer accessible.');
    }

    session.lastAccess = this.now();
    const offset = session.expectedOffset;
    const pageItems = session.items.slice(offset, offset + session.pageSize);
    const hasMore = offset + session.pageSize < session.items.length;
    session.expectedOffset = offset + session.pageSize;
    session.expectedCursor = hasMore ? mintCursor() : null;

    return {
      cursor: session.expectedCursor,
      items: pageItems,
      hasMore,
      directoryVersion: session.directoryVersion,
    };
  }

  /**
   * Close a listing session and release resources.
   * @param {{ sessionId: string, senderId: number }} opts
   * @returns {{ ok: true }}
   */
  listClose(opts) {
    const { sessionId, senderId } = opts;
    const session = this.sessions.get(sessionId);
    if (session && session.senderId === senderId) {
      this._removeSession(sessionId);
    }
    return { ok: true };
  }

  /**
   * Close all sessions for a sender (e.g. on window close/navigation).
   * @param {number} senderId
   */
  closeAllForSender(senderId) {
    const ids = this.senderSessions.get(senderId);
    if (ids) {
      for (const id of ids) this.sessions.delete(id);
      this.senderSessions.delete(senderId);
    }
  }

  /**
   * Destroy the service, clearing all sessions.
   */
  destroy() {
    this.sessions.clear();
    this.senderSessions.clear();
    if (this._evictionTimer) {
      clearTimeout(this._evictionTimer);
      this._evictionTimer = null;
    }
  }

  /** @private */
  _trackSender(senderId, sessionId) {
    if (!this.senderSessions.has(senderId)) {
      this.senderSessions.set(senderId, new Set());
    }
    this.senderSessions.get(senderId).add(sessionId);
  }

  /**
   * L-003 (hhhhu2 audit): compute total items held across all sessions
   * for a sender, used to enforce MAX_TOTAL_ENTRIES.
   * @private
   * @param {number} senderId
   * @returns {number}
   */
  _totalItemsForSender(senderId) {
    const ids = this.senderSessions.get(senderId);
    if (!ids) return 0;
    let total = 0;
    for (const id of ids) {
      const s = this.sessions.get(id);
      if (s && Array.isArray(s.items)) total += s.items.length;
    }
    return total;
  }

  /** @private */
  _removeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      const senderSet = this.senderSessions.get(session.senderId);
      if (senderSet) {
        senderSet.delete(sessionId);
        if (senderSet.size === 0) this.senderSessions.delete(session.senderId);
      }
      this.sessions.delete(sessionId);
    }
  }

  /** @private */
  _evictSender(senderId) {
    const ids = this.senderSessions.get(senderId);
    if (!ids || ids.size < MAX_SESSIONS_PER_SENDER) return;
    // Evict oldest sessions
    const sorted = [...ids]
      .map((id) => this.sessions.get(id))
      .filter(Boolean)
      .sort((a, b) => a.lastAccess - b.lastAccess);
    while (sorted.length >= MAX_SESSIONS_PER_SENDER) {
      const oldest = sorted.shift();
      this._removeSession(oldest.id);
    }
  }

  /** @private */
  _scheduleEviction() {
    if (this._evictionTimer) return;
    this._evictionTimer = setTimeout(() => {
      this._evictionTimer = null;
      const now = this.now();
      for (const [id, session] of this.sessions) {
        if (now - session.lastAccess > SESSION_TTL_MS) {
          this._removeSession(id);
        }
      }
      if (this.sessions.size > 0) this._scheduleEviction();
    }, 60_000);
    this._evictionTimer.unref?.();
  }
}

module.exports = { DirectoryListingService, DEFAULT_PAGE_SIZE, SESSION_TTL_MS, STAT_CONCURRENCY };
