// tests/helpers/sourceScan.js
// Source scanning for the repo-wide anti-pattern guards.
//
// Regex-over-raw-source is not good enough: the first draft of those guards
// flagged their OWN explanatory comments and a textarea placeholder that
// happened to read "prepended to your prompt (e.g. …)". A guard that cries wolf
// gets deleted, so the scanner blanks comments and string/template literals
// (preserving line numbers) and only then matches.

const fs = require('fs');
const path = require('path');

/**
 * Replace every comment and string/template literal with spaces, keeping line
 * numbers and overall length intact. Character scanner, not regexes — a regex
 * cannot tell a quote inside a comment from a real string opener.
 */
function stripNonCode(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') { out += ' '; i++; }
    } else if (c === '/' && d === '*') {
      out += '  '; i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
      out += '  '; i += 2;
    } else if (c === '"' || c === "'" || c === '`') {
      const q = c;
      out += ' '; i++;
      while (i < n) {
        if (src[i] === '\\') { out += '  '; i += 2; continue; }
        if (src[i] === q) { out += ' '; i++; break; }
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
    } else { out += c; i++; }
  }
  return out;
}

/**
 * Blank COMMENTS ONLY, keeping string literals intact.
 *
 * Needed because some anti-patterns legitimately live inside strings — a shell
 * pipeline is written as `execSync('npm test | tail -20')`. Using stripNonCode
 * for those made the guard unable to match anything, i.e. permanently green and
 * worthless. Use this variant whenever the defect is string-resident.
 */
function stripCommentsOnly(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') { out += ' '; i++; }
    } else if (c === '/' && d === '*') {
      out += '  '; i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
      out += '  '; i += 2;
    } else if (c === '"' || c === "'" || c === '`') {
      // Copy the literal through verbatim.
      const q = c;
      out += c; i++;
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        out += src[i];
        if (src[i] === q) { i++; break; }
        i++;
      }
    } else { out += c; i++; }
  }
  return out;
}

/** Every .js file under `rel`, repo-relative with forward slashes. */
function walkJs(root, rel, out = []) {
  const dir = path.join(root, rel);
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkJs(root, path.relative(root, p), out);
    else if (e.name.endsWith('.js')) out.push(path.relative(root, p).split(path.sep).join('/'));
  }
  return out;
}

/** Lines of real code matching `re`, reported with their ORIGINAL text. */
function scan(root, files, re) {
  const hits = [];
  for (const rel of files) {
    const raw = fs.readFileSync(path.join(root, rel), 'utf8');
    const orig = raw.split('\n');
    stripNonCode(raw).split('\n').forEach((line, i) => {
      re.lastIndex = 0;
      if (re.test(line)) hits.push(`${rel}:${i + 1}: ${String(orig[i] || '').trim().slice(0, 90)}`);
    });
  }
  return hits;
}

/**
 * Like `scan`, but keeps string literals intact (only strips comments).
 * Use for anti-patterns that legitimately live inside strings — e.g. a
 * shell pipeline written as `execSync('npm test | tail -20')`.
 */
function scanWithStrings(root, files, re) {
  const hits = [];
  for (const rel of files) {
    const raw = fs.readFileSync(path.join(root, rel), 'utf8');
    const orig = raw.split('\n');
    stripCommentsOnly(raw).split('\n').forEach((line, i) => {
      re.lastIndex = 0;
      if (re.test(line)) hits.push(`${rel}:${i + 1}: ${String(orig[i] || '').trim().slice(0, 90)}`);
    });
  }
  return hits;
}

/** Per-file count of real-code matches for `re`. Files with 0 are omitted. */
function countPerFile(root, files, re) {
  const counts = {};
  for (const rel of files) {
    const code = stripNonCode(fs.readFileSync(path.join(root, rel), 'utf8'));
    const m = code.match(re) || [];
    if (m.length) counts[rel] = m.length;
  }
  return counts;
}

module.exports = { stripNonCode, stripCommentsOnly, walkJs, scan, scanWithStrings, countPerFile };
