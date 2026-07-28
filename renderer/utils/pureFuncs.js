// renderer/utils/pureFuncs.js
// Pure helpers: aspect parsing, byte formatting, path/icon utilities.

// Parse a "W:H" aspect ratio string. Returns {w, h} or null.
function parseAspect(v) {
  if (!v) return null;
  const m = String(v).match(/^(\d+):(\d+)$/);
  if (!m) return null;
  return { w: parseInt(m[1], 10), h: parseInt(m[2], 10) };
}

// Human-readable byte count: 1234 -> "1.2 KB", 12345678 -> "11.8 MB".
function humanSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

// Parent directory of a path, handling both Windows \ and Unix /.
function parentDir(p) {
  if (!p) return '';
  // Preserve the leading separator for POSIX absolute paths and the
  // double-backslash for UNC paths. A naive split-and-rejoin would strip
  // the \\ from \\server\share\dir and turn C:\ into C: (the drive's
  // current dir on Windows, not the root).
  let s = String(p).replace(/[\\/]+$/, ''); // strip trailing slashes
  if (!s) return '';
  const isUNC = /^\\\\|^\/\//.test(s);
  const isPosixAbs = !isUNC && s.startsWith('/');
  if (isUNC) s = s.slice(2);
  else if (isPosixAbs) s = s.slice(1);
  const sep = s.includes('\\') ? '\\' : '/';
  const parts = s.split(/[\\/]/).filter(Boolean);
  parts.pop();
  // A single component directly under a root: the parent of "/a" is "/"
  // (the POSIX root); a bare relative name has no parent.
  if (!parts.length) return isPosixAbs ? '/' : '';
  let out = (isUNC ? '\\\\' : isPosixAbs ? '/' : '') + parts.join(sep);
  // A bare drive letter ("C:") is the drive's CURRENT directory on Windows,
  // not the root. When the parent is the drive root itself, keep the trailing
  // separator so "C:\work" -> "C:\" (not "C:").
  if (/^[A-Za-z]:$/.test(out)) out += sep;
  return out;
}

// Map a file extension to a single-emoji icon for the file browser.
function iconForFile(ext) {
  // Case-insensitive (Windows filenames are) and tolerant of a leading dot.
  const e = String(ext || '').toLowerCase().replace(/^\./, '');
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'].includes(e)) return '🖼️';
  // 🎶 is brighter than 🎵 so the icon stays visible on the dark theme.
  if (['mp3', 'wav', 'flac', 'ogg', 'm4a', 'opus', 'pcm', 'aac', 'wma', 'aif', 'aiff'].includes(e)) return '🎶';
  if (['mp4', 'mov', 'webm', 'mkv', 'avi'].includes(e)) return '🎞️';
  if (['srt', 'txt', 'json', 'md', 'lrc'].includes(e)) return '📝';
  return '📄';
}
// Per-type CSS class so the file browser row can colour-tint the icon
// background and keep it visible on the dark theme. Kept next to
// iconForFile so icon/class changes stay paired.
function iconClassForFile(ext) {
  const e = String(ext || '').toLowerCase().replace(/^\./, '');
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'].includes(e)) return 'fb-icon-image';
  if (['mp3', 'wav', 'flac', 'ogg', 'm4a', 'opus', 'pcm', 'aac', 'wma', 'aif', 'aiff'].includes(e)) return 'fb-icon-audio';
  if (['mp4', 'mov', 'webm', 'mkv', 'avi'].includes(e)) return 'fb-icon-video';
  if (['srt', 'txt', 'json', 'md', 'lrc'].includes(e)) return 'fb-icon-text';
  return 'fb-icon-other';
}

window.PureFuncs = { parseAspect, humanSize, parentDir, iconForFile, iconClassForFile };

// Load a local file:// image as a usable Image object (resolves once
// it is fully decoded). Used by upscale / crop / convert.
function loadImageFromFile(filePath) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      // Issue 1: force a full decode before resolving. For very large
      // images Chromium can fire onload with a deferred/partial decode,
      // which then paints as blank/white regions when drawn to a canvas.
      // decode() guarantees the whole frame is rasterised and ready. If
      // decode() rejects (rare edge cases, e.g. some animated sources) we
      // still resolve with the loaded image rather than failing the op.
      if (typeof img.decode === 'function') {
        img.decode().then(() => resolve(img)).catch(() => resolve(img));
      } else {
        resolve(img);
      }
    };
    img.onerror = () => reject(new Error("Failed to load image: " + filePath));
    img.src = fileUrl(filePath);
  });
}

// Pick a non-clobbering output path next to the source. Inserts a
// `_2x`, `_cropped_WxH`, or `_converted` infix between the stem and
// the extension. If the result already exists, a numeric suffix is
// appended to keep the original safe.
function derivedOutputPath(srcPath, infix) {
  const sep = srcPath.includes("\\") ? "\\" : "/";
  const lastSep = srcPath.lastIndexOf(sep);
  const dir = lastSep >= 0 ? srcPath.slice(0, lastSep) : "";
  const lastDot = srcPath.lastIndexOf(".");
  const stem = lastDot > lastSep ? srcPath.slice(0, lastDot) : srcPath;
  const ext = lastDot > lastSep ? srcPath.slice(lastDot) : "";
  return dir + sep + stem.split(sep).pop() + infix + ext;
}

window.PureFuncs = Object.assign(window.PureFuncs || {}, { loadImageFromFile, derivedOutputPath });
