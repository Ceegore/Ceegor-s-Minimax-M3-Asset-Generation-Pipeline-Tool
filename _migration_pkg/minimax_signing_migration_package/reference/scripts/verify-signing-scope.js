'use strict';

const fs = require('fs');
const path = require('path');
const { getSignatureInfo } = require('./merge-signed-bundle');
const { hashFile, hasPeMagic, isPe, normalize, walkFiles } = require('./capture-legacy-shell-lock');

function globToRegExp(pattern) {
  const normalized = normalize(pattern);
  let output = '^';
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    if (char === '*') {
      if (normalized[i + 1] === '*') {
        i += 1;
        if (normalized[i + 1] === '/') { i += 1; output += '(?:.*/)?'; }
        else output += '.*';
      } else output += '[^/]*';
    } else if (char === '?') output += '[^/]';
    else output += char.replace(/[\\^$+?.()|[\]{}]/g, '\\$&');
  }
  return new RegExp(`${output}$`, 'i');
}

function matchesAny(relativePath, patterns) { return patterns.some((pattern) => globToRegExp(pattern).test(normalize(relativePath))); }
function classifyPath(relativePath, policy) {
  const rel = normalize(relativePath);
  const owned = (policy.ownedSigned || []).find((item) => normalize(item.path).toLowerCase() === rel.toLowerCase());
  if (owned) return { kind: 'owned', rule: owned };
  if (matchesAny(rel, policy.upstreamPatterns || [])) return { kind: 'upstream' };
  return { kind: 'unknown' };
}

function collectPe(root) {
  const result = {};
  for (const absolute of walkFiles(root)) {
    const relative = normalize(path.relative(root, absolute));
    if (isPe(relative) || hasPeMagic(absolute)) result[relative] = { absolute, sha256: hashFile(absolute), size: fs.statSync(absolute).size };
  }
  return result;
}

function verifyLegacy(root, lock) {
  const actual = collectPe(root);
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(lock.peFiles).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) throw new Error('legacy PE path set differs from lock');
  for (const key of expectedKeys) {
    if (actual[key].sha256 !== lock.peFiles[key].sha256 || actual[key].size !== lock.peFiles[key].size) throw new Error(`legacy PE mismatch: ${key}`);
  }
  return { mode: 'legacy', peCount: expectedKeys.length };
}

function verifySignPath(root, policy, signatureProvider = getSignatureInfo) {
  const pe = collectPe(root);
  const results = [];
  for (const [relative, info] of Object.entries(pe)) {
    const classification = classifyPath(relative, policy);
    if (classification.kind === 'unknown') throw new Error(`unclassified PE file: ${relative}`);
    const signature = signatureProvider(info.absolute);
    if (classification.kind === 'owned') {
      if (signature.Status !== 'Valid') throw new Error(`owned PE is not validly signed: ${relative} (${signature.Status})`);
      const expectedSigner = classification.rule.expectedSigner || 'SignPath Foundation';
      if (!new RegExp(expectedSigner, 'i').test(signature.SignerSubject || '')) throw new Error(`owned PE has wrong signer: ${relative} (${signature.SignerSubject || 'none'})`);
    } else if (/SignPath Foundation/i.test(signature.SignerSubject || '')) throw new Error(`upstream PE must not carry the project SignPath signature: ${relative}`);
    results.push({ relative, kind: classification.kind, sha256: info.sha256, signature });
  }
  for (const owned of policy.ownedSigned || []) if (!fs.existsSync(path.join(root, owned.path))) throw new Error(`missing owned signed PE: ${owned.path}`);
  return { mode: 'signpath', peCount: results.length, files: results };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.root || !args.mode) throw new Error('usage: --root <dir> --mode <legacy|signpath>');
  const root = path.resolve(args.root);
  let result;
  if (args.mode === 'legacy') {
    if (!args['legacy-lock']) throw new Error('legacy mode requires --legacy-lock');
    result = verifyLegacy(root, JSON.parse(fs.readFileSync(path.resolve(args['legacy-lock']), 'utf8')));
  } else if (args.mode === 'signpath') {
    if (!args.policy) throw new Error('signpath mode requires --policy');
    result = verifySignPath(root, JSON.parse(fs.readFileSync(path.resolve(args.policy), 'utf8')));
  } else throw new Error(`unsupported mode: ${args.mode}`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  try { main(); }
  catch (error) { process.stderr.write(`ERROR: ${error.message}\n`); process.exit(1); }
}

module.exports = { classifyPath, collectPe, globToRegExp, matchesAny, verifyLegacy, verifySignPath };
