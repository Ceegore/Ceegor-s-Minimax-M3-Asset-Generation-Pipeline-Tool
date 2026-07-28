// scripts/test-affected.js
// Affected-test router: the fast inner-loop check.
//
// Maps files changed vs HEAD (tracked + untracked) to their unit tests and
// runs only those. Falls back to the full `npm test` glob when any changed
// source file has no mapped test, so nothing silently escapes coverage.
// `npm test` remains the pre-commit and CI gate — this script only shortens
// the edit-check loop (docs/DECISIONS_AND_RULES.md §8).
//
// Run with:
//   npm run test:affected            — auto-detect changes vs HEAD
//   npm run test:affected -- --list  — only print the mapping, run nothing
//
// Mapping rules (in order):
//   1. A changed test file selects itself.
//   2. tests/unit mirrors the source tree: renderer/services/batchPostprocess.js
//      → tests/unit/renderer/services/batchPostprocess.test.js (if it exists).
//   3. Content match: any test file that mentions the changed file's basename
//      (e.g. "batchPostprocess") is selected.
//   4. Changed files outside main/, renderer/, src/, scripts/, preload.js,
//      main.js (docs, images, workflows, …) are ignored.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TEST_ROOT = path.join(ROOT, 'tests', 'unit');
const listOnly = process.argv.includes('--list');

function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', shell: false });
  if (r.status !== 0) {
    console.error(`test:affected — git ${args.join(' ')} failed:\n${r.stderr || ''}`);
    process.exit(1);
  }
  return r.stdout.split('\n').map(s => s.trim()).filter(Boolean);
}

function* walkTests(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkTests(full);
    else if (entry.isFile() && full.endsWith('.test.js')) yield full;
  }
}

function isSource(rel) {
  const norm = rel.replace(/\\/g, '/');
  if (norm.startsWith('tests/')) return false;
  return norm.startsWith('main/') || norm.startsWith('renderer/') ||
    norm.startsWith('src/') || norm.startsWith('scripts/') ||
    norm === 'preload.js' || norm === 'main.js';
}

// 1) Collect changed files (tracked changes + untracked, .gitignore honored).
const changed = new Set([
  ...git(['diff', '--name-only', 'HEAD', '--']),
  ...git(['ls-files', '--others', '--exclude-standard']),
].map(p => p.replace(/\\/g, '/')));

if (changed.size === 0) {
  console.log('test:affected — no changes vs HEAD, nothing to run.');
  process.exit(0);
}

// 2) Index all unit tests once (path + content) for the mapping rules.
const allTests = [...walkTests(TEST_ROOT)].map(abs => ({
  abs,
  rel: path.relative(ROOT, abs).replace(/\\/g, '/'),
  src: fs.readFileSync(abs, 'utf8'),
}));

const selected = new Set();
const unmapped = [];

for (const rel of changed) {
  if (rel.startsWith('tests/unit/') && rel.endsWith('.test.js')) {
    if (fs.existsSync(path.join(ROOT, rel))) selected.add(rel); // rule 1
    continue;
  }
  if (!isSource(rel) || !rel.endsWith('.js')) continue; // rule 4
  const base = path.basename(rel, '.js');

  // rule 2: mirrored path tests/unit/<dir>/<base>.test.js
  const mirror = `tests/unit/${rel.replace(/\.js$/, '.test.js')}`;
  let hit = false;
  if (fs.existsSync(path.join(ROOT, mirror))) { selected.add(mirror); hit = true; }

  // rule 3: content mention of the basename (word-boundary match)
  const needle = new RegExp(`\\b${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  for (const t of allTests) {
    if (needle.test(t.src)) { selected.add(t.rel); hit = true; }
  }
  if (!hit) unmapped.push(rel);
}

if (unmapped.length > 0) {
  console.log(`test:affected — ${unmapped.length} changed source file(s) have no mapped test:`);
  for (const u of unmapped.slice(0, 10)) console.log(`  ? ${u}`);
  if (unmapped.length > 10) console.log(`  … and ${unmapped.length - 10} more`);
  console.log('Falling back to the full unit suite (npm test glob).');
}

const runFull = unmapped.length > 0;
const files = runFull ? null : [...selected].sort();

if (!runFull && files.length === 0) {
  console.log('test:affected — changes touch no JS source with unit coverage; nothing to run.');
  process.exit(0);
}

console.log(runFull
  ? `test:affected — running FULL suite (${changed.size} changed paths).`
  : `test:affected — running ${files.length} mapped test file(s) for ${changed.size} changed path(s):`);
if (!runFull) for (const f of files) console.log(`  → ${f}`);
if (listOnly) process.exit(0);

const args = runFull
  ? ['--test', 'tests/unit/**/*.test.js']
  : ['--test', ...files];
const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit', shell: false });
process.exit(r.status ?? 1);
