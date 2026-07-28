// ============================================================================
// Shared helper for the renderer-function unit tests.
//
// Several renderer functions (classifyMmxError, slugify, buildFinalPrompt, …)
// live in browser-side scripts that cannot be require()d as Node modules, so
// the tests extract the function's source text out of the file and evaluate it
// in a vm context. Historically each test carried its own naive brace-matching
// extractor, which broke the moment a function body contained an UNBALANCED
// brace inside a regex character class — e.g. classifyMmxError's auth rule
// `["'\s:{]` (added for the base_resp 1004/2049 detection) has a `{` with no
// matching `}`, so a plain depth counter never returns to zero.
//
// This extractor is a tiny lexer-aware scanner: it skips line/block comments,
// string and template literals, and regex literals (detecting them with the
// standard "previous significant token" heuristic), so only REAL code braces
// are counted. It is the single correct implementation used by all the
// renderer-function tests.
// ============================================================================

const assert = require('node:assert/strict');

// Keywords after which a `/` begins a regex literal rather than division.
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'case', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete',
  'void', 'throw', 'do', 'else', 'yield', 'await',
]);
// Single characters after which a `/` begins a regex literal.
const REGEX_PRECEDING_CHARS = '(,=:[!&|?{};+-*/%<>^~';

function isRegexStart(prev) {
  if (!prev) return true; // start of input
  if (prev.length === 1) return REGEX_PRECEDING_CHARS.includes(prev);
  return REGEX_PRECEDING_KEYWORDS.has(prev);
}

function extractFnSrc(src, startMarker) {
  const start = src.indexOf(startMarker);
  assert.ok(start >= 0, `function definition not found: ${startMarker}`);

  let depth = 0;
  let end = -1;
  let i = start;
  let prev = ''; // last significant token (a keyword/identifier or single char)
  let word = ''; // identifier currently being accumulated

  const flushWord = () => { if (word) { prev = word; word = ''; } };

  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    // --- line comment ---
    if (c === '/' && next === '/') {
      flushWord();
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    // --- block comment ---
    if (c === '/' && next === '*') {
      flushWord();
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    // --- string literal (' or ") ---
    if (c === "'" || c === '"') {
      flushWord();
      const quote = c;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') i++;
        i++;
      }
      i++; // closing quote
      prev = quote;
      continue;
    }
    // --- template literal (opaque; any ${} braces inside balance pairwise) ---
    if (c === '`') {
      flushWord();
      i++;
      while (i < src.length && src[i] !== '`') {
        if (src[i] === '\\') i++;
        i++;
      }
      i++;
      prev = '`';
      continue;
    }
    // --- regex literal ---
    if (c === '/' && isRegexStart(prev)) {
      flushWord();
      i++;
      let inClass = false;
      while (i < src.length) {
        const rc = src[i];
        if (rc === '\\') { i += 2; continue; }
        if (rc === '[') inClass = true;
        else if (rc === ']') inClass = false;
        else if (rc === '/' && !inClass) break;
        else if (rc === '\n') break; // regex literals never span lines
        i++;
      }
      i++; // closing '/'
      while (i < src.length && /[a-z]/i.test(src[i])) i++; // flags
      prev = '/';
      continue;
    }

    // --- identifier / keyword accumulation ---
    if (/[A-Za-z0-9_$]/.test(c)) {
      word += c;
      i++;
      continue;
    }

    // --- any other significant character ---
    flushWord();
    if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }

  assert.ok(end > start, `could not locate end of function via brace matching: ${startMarker}`);
  return src.slice(start, end);
}

module.exports = { extractFnSrc };
