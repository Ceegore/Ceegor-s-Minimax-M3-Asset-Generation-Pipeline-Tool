// main/services/ArchiveService.js
// ============================================================================
// Append-only JSONL archive for finished jobs.
//
// When the jobsSnapshot list (state.json) overflows the cap (default 200,
// configurable 20..1000), the trimmed entries are appended to
// `state.jobs.archive.jsonl` (next to `state.json`). The file is read on
// demand by the ArchiveViewer widget — never at launch, never during normal
// operation. The archive is not loaded into memory.
//
// Format: one job-summary object per line, terminated by `\n`. Schema:
//
//   {
//     id:        string,
//     type:      'image' | 'speech' | 'music' | 'video' | 'upscale' | 'optimize' | 'isnetbg',
//     tab:       'image' | 'speech' | 'music' | 'video' | null,
//     title:     string,
//     subtitle:  string,
//     status:    'ok' | 'err' | 'warn' | 'cancel',
//     startedAt: ISO string,
//     finishedAt: ISO string,
//     outputPaths: string[],
//     groupId:   string | null,
//   }
//
// Crash-safety: every `append()` call writes a single line to the OS page
// cache via `fs.appendFileSync`. There is no fsync: the archive is a
// best-effort history, not critical state, and an fsync per append would
// dominate the save path's latency. On power loss the last few appended
// lines may be lost. A partial final line (process killed mid-write) is
// detected on the next `append()` and silently dropped by rewriting the
// file without it. The temp-file + rename pattern is never used (it would
// defeat the append-only simplicity and the gain is zero for a stream of
// small appends).
// ============================================================================

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { deepRedact } = require('../deepRedactor');

function archivePath(configDir) {
  return path.join(configDir, 'state.jobs.archive.jsonl');
}

// Append a single JobSummary to the archive. Returns the number
// of bytes written. Crash-safe: a partial final line from a
// previous crash is detected via the trailing-newline check and
// silently dropped.
// P5 (M-027): redact secrets and normalize paths before persisting.
// The archive must never contain API keys, bearer tokens, or full
// absolute paths (which leak usernames / directory structure).
// outputPaths are reduced to basenames; title/subtitle pass through
// deepRedact (scrubs Authorization headers, --api-key, env secrets).
function _sanitizeSummary(summary) {
  const out = deepRedact(summary);
  if (Array.isArray(out.outputPaths)) {
    out.outputPaths = out.outputPaths.map((p) => {
      if (typeof p !== 'string') return p;
      return path.basename(p);
    });
  }
  return out;
}

function append(configDir, summary) {
  if (!configDir) throw new Error('ArchiveService.append: configDir is required');
  if (!summary || typeof summary !== 'object') throw new Error('ArchiveService.append: summary must be an object');
  const p = archivePath(configDir);
  fs.mkdirSync(configDir, { recursive: true });
  // Drop a partial last line from a prior crash, atomically. We
  // re-write the file without the last line (the partial bytes).
  // This is the only "rewrite" we ever do; the rest of the API
  // is strictly append-only.
  _trimPartialLastLine(p);
  const line = JSON.stringify(_sanitizeSummary(summary)) + '\n';
  fs.appendFileSync(p, line, 'utf8');
  return Buffer.byteLength(line, 'utf8');
}

// Read a chunk of lines from the archive. Returns
// { lines, nextOffset, hasMore }. The caller can pass the returned
// `nextOffset` to read the next chunk.
//
// P2-D (360° Audit M-018): streaming read — only reads enough bytes
// from disk to satisfy the `limit` lines, never the whole file.
// P2-D (360° Audit M-019): max line length (64 KB) prevents a
// single-line bomb from exhausting memory.
//
// `offset` is a BYTE-position cursor (fs.readSync start position).
// The file is decoded line-by-line from the read buffer.
const MAX_LINE_BYTES = 64 * 1024; // 64 KB per line cap
const READ_CHUNK_SIZE = 256 * 1024; // read 256 KB at a time

function readChunk(configDir, opts) {
  opts = opts || {};
  const offset = Math.max(0, parseInt(opts.offset, 10) || 0);
  const limit = Math.max(1, Math.min(500, parseInt(opts.limit, 10) || 100));
  const p = archivePath(configDir);
  if (!fs.existsSync(p)) return { lines: [], nextOffset: 0, hasMore: false };
  const stat = fs.statSync(p);
  if (offset >= stat.size) return { lines: [], nextOffset: stat.size, hasMore: false };

  // Stream-read from the offset in chunks until we have `limit` lines.
  const lines = [];
  let pos = offset;       // raw read cursor
  let consumed = offset;  // byte position after the last fully-consumed line
  let leftover = '';      // partial line carried between chunks
  let hasMore = false;

  const fd = fs.openSync(p, 'r');
  try {
    outer:
    while (pos < stat.size && lines.length < limit) {
      const toRead = Math.min(READ_CHUNK_SIZE, stat.size - pos);
      const buf = Buffer.alloc(toRead);
      const bytesRead = fs.readSync(fd, buf, 0, toRead, pos);
      if (bytesRead === 0) break;
      pos += bytesRead;

      const text = leftover + buf.toString('utf8', 0, bytesRead);
      const parts = text.split('\n');
      // Last element is either '' (if text ended with \n) or a partial line
      leftover = parts.pop() || '';

      for (const part of parts) {
        if (lines.length >= limit) {
          // We have enough; nextOffset stays at the last consumed line so
          // the next call resumes exactly where this one stopped.
          hasMore = true;
          break outer;
        }
        // Every full line (even skipped ones) advances the consumed cursor.
        consumed += Buffer.byteLength(part, 'utf8') + 1; // +1 for '\n'
        if (!part) continue;
        // M-019: skip lines exceeding the max length (single-line bomb)
        if (Buffer.byteLength(part, 'utf8') > MAX_LINE_BYTES) continue;
        try { lines.push(JSON.parse(part)); } catch (_) { /* skip malformed */ }
      }
    }
    // Anything left between `consumed` and EOF that we didn't turn into
    // lines is either unread data (limit hit) or a trailing partial line
    // from a crash — the former means hasMore.
    if (!hasMore && lines.length >= limit && consumed < stat.size) hasMore = true;
  } finally {
    fs.closeSync(fd);
  }

  return { lines, nextOffset: consumed, hasMore };
}

// Remove a single entry by id. Atomic rewrite (read all → write
// to temp → rename) so a partial rewrite can't leave the file
// in an inconsistent state. The matching line is removed
// (only the first match — duplicates are tolerated).
function deleteOne(configDir, id) {
  if (!id) throw new Error('ArchiveService.deleteOne: id is required');
  const p = archivePath(configDir);
  if (!fs.existsSync(p)) return false;
  const text = fs.readFileSync(p, 'utf8');
  const parts = text.split('\n');
  let removed = false;
  const out = [];
  for (const line of parts) {
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (!removed && obj && obj.id === id) { removed = true; continue; }
      out.push(JSON.stringify(obj));
    } catch (_) {
      // Keep malformed lines (don't drop user data we can't read).
      out.push(line);
    }
  }
  if (!removed) return false;
  const tmp = p + '.tmp-' + randomUUID();
  fs.writeFileSync(tmp, out.join('\n') + (out.length ? '\n' : ''), 'utf8');
  fs.renameSync(tmp, p);
  return true;
}

// Clear the whole archive. Truncates the file to zero bytes.
function clear(configDir) {
  const p = archivePath(configDir);
  if (!fs.existsSync(p)) return 0;
  const stat = fs.statSync(p);
  fs.writeFileSync(p, '', 'utf8');
  return stat.size;
}

// Current archive size in bytes. Returns 0 if the file doesn't
// exist. Cheap (one stat call).
function size(configDir) {
  const p = archivePath(configDir);
  if (!fs.existsSync(p)) return 0;
  return fs.statSync(p).size;
}

// Internal: detect a partial final line and rewrite the file
// without it. Called by `append()` to recover from a crash.
//
// The partial line is anything after the last `\n`. We scan the
// tail of the file (up to the last 8 KB) for the most recent
// `\n` and truncate the file just after that byte. If the file
// is empty or already ends in `\n`, no work is needed.
function _trimPartialLastLine(p) {
  if (!fs.existsSync(p)) return;
  const stat = fs.statSync(p);
  if (stat.size === 0) return;
  const fd = fs.openSync(p, 'r+');
  try {
    // Read the last 8 KB and scan for the last newline. If the
    // file is smaller than 8 KB, the whole file is in the buffer.
    const SCAN = 8 * 1024;
    const start = Math.max(0, stat.size - SCAN);
    const length = stat.size - start;
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, start);
    let lastNl = -1;
    for (let i = length - 1; i >= 0; i--) {
      if (buf[i] === 0x0A) { lastNl = i; break; }
    }
    if (lastNl === length - 1) return; // file already ends with \n
    if (lastNl < 0) {
      // No newline at all — the file is one big partial line. Truncate
      // the entire file to zero.
      fs.ftruncateSync(fd, 0);
      return;
    }
    // Truncate to (start + lastNl + 1) bytes — the byte just after
    // the last newline, which is the start of the partial line.
    fs.ftruncateSync(fd, start + lastNl + 1);
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { archivePath, append, readChunk, deleteOne, clear, size };
