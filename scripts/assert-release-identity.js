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
  // M-018 (hhhhu2 audit): the lockfile is REQUIRED for a release build.
  const lockPath = path.join(ROOT, 'package-lock.json');
  if (!fs.existsSync(lockPath)) {
    fail('package-lock.json is missing. Run npm install to generate it before releasing.');
  }
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const lockVersion = lock.version;
  if (lockVersion !== pkgVersion) {
    fail(`package-lock.json version (${lockVersion}) does not match package.json (${pkgVersion}). Run npm install to sync.`);
  }
  console.log(`  package-lock.json version: ${lockVersion} (matches)`);

  // 3. Check Git HEAD is a tag or matches expected tag format
  const headCommit = git(['rev-parse', 'HEAD']);
  console.log(`  HEAD commit: ${headCommit}`);

  // Check if HEAD has a tag
  // M-018 (hhhhu2 audit): on a tag release, require EXACTLY ONE tag
  // matching v${package.version}. Multiple tags or no tag is a failure
  // unless the GITHUB_REF environment variable indicates a non-tag build.
  let tag = '';
  let allTags = [];
  try {
    const tagOutput = execFileSync('git', ['tag', '--points-at', 'HEAD'], {
      cwd: ROOT, encoding: 'utf8', windowsHide: true,
    }).trim();
    allTags = tagOutput ? tagOutput.split('\n').filter(Boolean) : [];
  } catch (_) {}

  const isTagRelease = process.env.GITHUB_REF
    ? process.env.GITHUB_REF.startsWith('refs/tags/')
    : allTags.length > 0;

  // M-001 (hhhhu3 audit): a workflow_dispatch run is NOT a tag release. It
  // must explicitly declare the version it intends to release via the
  // RELEASE_EXPECTED_VERSION input, and that version must match package.json.
  // A manual run without a tag must never be treated as publishable.
  const isManualDispatch = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';
  if (isManualDispatch && !process.env.GITHUB_REF?.startsWith('refs/tags/')) {
    const expected = process.env.RELEASE_EXPECTED_VERSION;
    if (!expected) {
      fail('Manual (workflow_dispatch) run without a tag must pass the release version as the "version" input (RELEASE_EXPECTED_VERSION). Untagged manual runs cannot publish release artifacts.');
    }
    if (expected !== pkgVersion) {
      fail(`Manual run requested version "${expected}" but package.json is at "${pkgVersion}". Tag the matching commit instead of publishing a manual build.`);
    }
    console.log(`  Manual dispatch build for version ${expected} (NOT a tagged release — no publication).`);
  }

  if (isTagRelease) {
    // Strict mode: exactly one tag, matching v<version>
    const expectedTag = `v${pkgVersion}`;
    if (allTags.length === 0) {
      fail('This is a tag release but no tag points at HEAD.');
    }
    if (allTags.length > 1) {
      fail(`Multiple tags point at HEAD (${allTags.join(', ')}). A release commit must have exactly one tag.`);
    }
    tag = allTags[0];
    if (tag !== expectedTag) {
      fail(`Tag "${tag}" does not match the expected tag "${expectedTag}" for version ${pkgVersion}.`);
    }
    console.log(`  Tag at HEAD: ${tag} (exactly one, matches version)`);
    // M-018: compare against the triggering GitHub ref and SHA if available.
    if (process.env.GITHUB_REF) {
      const refTag = process.env.GITHUB_REF.replace('refs/tags/', '');
      if (refTag !== tag) {
        fail(`GitHub ref tag "${refTag}" does not match the local tag "${tag}".`);
      }
    }
    if (process.env.GITHUB_SHA) {
      if (process.env.GITHUB_SHA !== headCommit) {
        fail(`GitHub SHA (${process.env.GITHUB_SHA}) does not match local HEAD (${headCommit}).`);
      }
    }
  } else if (allTags.length > 0) {
    // Non-release build but tags exist — use the first for build-info.
    tag = allTags[0];
    const tagVersion = tag.replace(/^v/, '');
    if (tagVersion !== pkgVersion) {
      fail(`Tag "${tag}" (version ${tagVersion}) does not match package.json version (${pkgVersion}).`);
    }
    console.log(`  Tag at HEAD: ${tag} (pre-release build)`);
  } else {
    console.log('  No tag at HEAD (development build — not for release).');
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
