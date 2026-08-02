'use strict';

/**
 * Assert release identity — tag/version/clean-tree agreement.
 *
 * AUD-005/AUD-015 fix: The release gate must verify that the Git tag,
 * package.json version, lockfile version, HEAD commit, and build-info
 * all agree before any artifact is produced or signed.
 *
 * Usage: node scripts/assert-release-identity.js
 * Exit code 0 = all checks pass; 1 = identity mismatch.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`RELEASE IDENTITY FAILED: ${msg}`);
  process.exit(1);
}

function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true }).trim();
  } catch (e) {
    fail(`git ${args.join(' ')} failed: ${e.message}`);
  }
}

function main() {
  console.log('Asserting release identity...');

  // 1. Read package.json version
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const pkgVersion = pkg.version;
  if (!pkgVersion) fail('package.json has no version field.');
  console.log(`  package.json version: ${pkgVersion}`);

  // 2. Read package-lock.json version
  const lockPath = path.join(ROOT, 'package-lock.json');
  if (fs.existsSync(lockPath)) {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const lockVersion = lock.version;
    if (lockVersion !== pkgVersion) {
      fail(`package-lock.json version (${lockVersion}) does not match package.json (${pkgVersion}). Run npm install to sync.`);
    }
    console.log(`  package-lock.json version: ${lockVersion} (matches)`);
  }

  // 3. Check Git HEAD is a tag or matches expected tag format
  const headCommit = git(['rev-parse', 'HEAD']);
  console.log(`  HEAD commit: ${headCommit}`);

  // Check if HEAD has a tag
  let tag = '';
  try {
    tag = execFileSync('git', ['tag', '--points-at', 'HEAD'], {
      cwd: ROOT, encoding: 'utf8', windowsHide: true,
    }).trim().split('\n')[0];
  } catch (_) {}

  if (tag) {
    console.log(`  Tag at HEAD: ${tag}`);
    // Tag should match version (v1.0.3 -> 1.0.3)
    const tagVersion = tag.replace(/^v/, '');
    if (tagVersion !== pkgVersion) {
      fail(`Tag "${tag}" (version ${tagVersion}) does not match package.json version (${pkgVersion}).`);
    }
    console.log(`  Tag version matches package.json: ${tagVersion}`);
  } else {
    console.log('  No tag at HEAD (allowed for pre-release builds).');
  }

  // 4. Check working tree is clean
  const status = git(['status', '--porcelain']);
  if (status.length > 0) {
    const dirtyFiles = status.split('\n').slice(0, 10).join('\n    ');
    fail(`Working tree is dirty. Commit or stash changes before releasing:\n    ${dirtyFiles}`);
  }
  console.log('  Working tree: clean');

  // 5. Check HEAD is not behind the remote (if remote exists)
  try {
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    if (branch !== 'HEAD') { // not detached
      const remote = git(['config', '--get', `branch.${branch}.remote`]).trim();
      if (remote) {
        git(['fetch', remote, '--quiet']);
        const behind = git(['rev-list', '--count', `${remote}/${branch}..HEAD`]);
        const ahead = git(['rev-list', '--count', `HEAD..${remote}/${branch}`]);
        if (parseInt(ahead, 10) > 0) {
          fail(`Local branch is ${ahead} commit(s) behind ${remote}/${branch}. Pull before releasing.`);
        }
        console.log(`  Branch ${branch}: up to date with ${remote}/${branch}`);
      }
    }
  } catch (_) {
    console.log('  Remote tracking: not configured (skipped).');
  }

  // 6. Write build-info for the release
  const buildInfo = {
    version: pkgVersion,
    commit: headCommit,
    tag: tag || null,
    timestamp: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  };
  const buildInfoPath = path.join(ROOT, 'dist-out', 'build-info.json');
  fs.mkdirSync(path.dirname(buildInfoPath), { recursive: true });
  fs.writeFileSync(buildInfoPath, JSON.stringify(buildInfo, null, 2) + '\n', 'utf8');
  console.log(`  Build info written: ${path.relative(ROOT, buildInfoPath)}`);

  console.log('Release identity: OK');
}

main();
