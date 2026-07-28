// tests/unit/src/mmxCapability.test.js
// R7.2: CapabilitySnapshot — tests for the mmx CLI capability probing service.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..', '..', '..');

// Load mmxCapability with mocked mmxResolve (no real CLI needed).
function loadWithMocks(mockSpawnSync) {
  const realLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'child_process') {
      return { spawnSync: mockSpawnSync, spawn: () => { throw new Error('not used'); } };
    }
    if (request.endsWith('mmxResolve') || request === './mmxResolve') {
      return {
        findNodeExe: () => 'C:\\fake\\node.exe',
        findMmxEntry: () => 'C:\\fake\\mmx\\index.js',
        needsRunAsNode: () => false,
        isWindows: true,
      };
    }
    return realLoad.call(this, request, parent, isMain);
  };
  const capPath = require.resolve(path.join(ROOT, 'src', 'mmxCapability.js'));
  delete require.cache[capPath];
  try {
    return require(capPath);
  } finally {
    Module._load = realLoad;
  }
}

test('R7.2.A: _parseFlags extracts --flags from help text', () => {
  const cap = loadWithMocks(() => ({ stdout: '', stderr: '', status: 0 }));
  const flags = cap._parseFlags(`
Usage: mmx image [options]

Options:
  --model <name>       Model to use
  --dry-run            Print request without sending
  --output-dir <path>  Output directory
  -v, --verbose        Verbose output
`);
  assert.ok(flags.includes('--model'));
  assert.ok(flags.includes('--dry-run'));
  assert.ok(flags.includes('--output-dir'));
  assert.ok(flags.includes('--verbose'));
  assert.ok(!flags.includes('-v'), 'short flags should not be included');
});

test('R7.2.B: _parseFlags returns empty array for null/empty input', () => {
  const cap = loadWithMocks(() => ({ stdout: '', stderr: '', status: 0 }));
  assert.deepEqual(cap._parseFlags(null), []);
  assert.deepEqual(cap._parseFlags(''), []);
  assert.deepEqual(cap._parseFlags('no flags here'), []);
});

test('R7.2.C: _parseModels extracts model names from help text', () => {
  const cap = loadWithMocks(() => ({ stdout: '', stderr: '', status: 0 }));
  const models = cap._parseModels(`
Usage: mmx image [options]

Available Models:
  flux-dev
  flux-pro
  sd3-medium

Options:
  --model <name>
`);
  assert.deepEqual(models, ['flux-dev', 'flux-pro', 'sd3-medium']);
});

test('R7.2.D: _parseModels returns empty array when no models section', () => {
  const cap = loadWithMocks(() => ({ stdout: '', stderr: '', status: 0 }));
  assert.deepEqual(cap._parseModels('Usage: mmx image [options]\n\nOptions:\n  --model <name>'), []);
  assert.deepEqual(cap._parseModels(null), []);
});

test('R7.2.E: getSnapshot caches and invalidate clears', () => {
  let callCount = 0;
  const cap = loadWithMocks((node, args) => {
    callCount++;
    if (args.includes('--version')) return { stdout: 'mmx-cli/1.0.16', stderr: '', status: 0 };
    if (args.includes('--help')) return { stdout: 'Usage: mmx\n\nOptions:\n  --version\n  --help', stderr: '', status: 0 };
    return { stdout: '', stderr: 'unknown command', status: 1 };
  });

  const snap1 = cap.getSnapshot();
  assert.ok(snap1, 'snapshot should not be null');
  assert.equal(snap1.version, '1.0.16');
  const countAfterFirst = callCount;

  // Second call should use cache (no additional spawns).
  const snap2 = cap.getSnapshot();
  assert.equal(snap2, snap1, 'cached snapshot should be the same object');
  assert.equal(callCount, countAfterFirst, 'no additional probes on cache hit');

  // Invalidate and re-probe.
  cap.invalidate();
  const snap3 = cap.getSnapshot();
  assert.ok(callCount > countAfterFirst, 'invalidation should trigger re-probe');
  assert.equal(snap3.version, '1.0.16');
});

test('R7.2.F: getSnapshot returns null when CLI not found', () => {
  const realLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'child_process') {
      return { spawnSync: () => { throw new Error('ENOENT'); }, spawn: () => { throw new Error('not used'); } };
    }
    if (request.endsWith('mmxResolve') || request === './mmxResolve') {
      return {
        findNodeExe: () => null,
        findMmxEntry: () => null,
        needsRunAsNode: () => false,
        isWindows: true,
      };
    }
    return realLoad.call(this, request, parent, isMain);
  };
  const capPath = require.resolve(path.join(ROOT, 'src', 'mmxCapability.js'));
  delete require.cache[capPath];
  try {
    const cap = require(capPath);
    assert.equal(cap.getSnapshot(), null, 'should return null when CLI not found');
  } finally {
    Module._load = realLoad;
    delete require.cache[capPath];
  }
});

test('R7.2.G: isSubcommandAvailable and isFlagSupported work with snapshot', () => {
  const cap = loadWithMocks((node, args) => {
    // args = [entry, ...cliArgs], so cliArgs = args.slice(1).
    const cliArgs = args.slice(1);
    if (cliArgs.includes('--version')) return { stdout: '1.0.16', stderr: '', status: 0 };
    if (cliArgs[0] === 'image' && cliArgs.includes('--help')) {
      return { stdout: 'Usage: mmx image\n\nOptions:\n  --model <name>\n  --dry-run', stderr: '', status: 0 };
    }
    if (cliArgs.length === 1 && cliArgs[0] === '--help') return { stdout: 'Usage: mmx', stderr: '', status: 0 };
    // All other subcommands (speech, music, etc.) are unavailable.
    return { stdout: '', stderr: 'unknown command', status: 1 };
  });

  assert.equal(cap.isSubcommandAvailable('image'), true);
  assert.equal(cap.isSubcommandAvailable('speech'), false, 'speech not probed as available');
  assert.equal(cap.isFlagSupported('image', '--model'), true);
  assert.equal(cap.isFlagSupported('image', '--dry-run'), true);
  assert.equal(cap.isFlagSupported('image', '--nonexistent'), false);
  assert.equal(cap.isFlagSupported('speech', '--model'), false, 'unavailable subcommand has no flags');
});

test('R7.2.H: KNOWN_SUBCOMMANDS includes all app-used subcommands', () => {
  const cap = loadWithMocks(() => ({ stdout: '', stderr: '', status: 0 }));
  assert.ok(cap.KNOWN_SUBCOMMANDS.includes('image'));
  assert.ok(cap.KNOWN_SUBCOMMANDS.includes('speech'));
  assert.ok(cap.KNOWN_SUBCOMMANDS.includes('music'));
  assert.ok(cap.KNOWN_SUBCOMMANDS.includes('video'));
  // Note: 'sound-effect' is NOT a subcommand — it's a flag (--sound-effect)
  // on the speech subcommand. It must NOT be in KNOWN_SUBCOMMANDS.
  assert.ok(!cap.KNOWN_SUBCOMMANDS.includes('sound-effect'), 'sound-effect is a flag, not a subcommand');
});

test('R7.2.I: diagnoseSnapshot includes capability fields when snapshot provided', () => {
  const { buildDiagnoseSnapshot } = require(path.join(ROOT, 'main', 'ipc', 'diagnoseSnapshot.js'));
  const snap = {
    version: '1.0.16',
    topFlags: ['--version', '--help'],
    subcommands: {
      image: { available: true, flags: ['--model', '--dry-run'], models: ['flux-dev'] },
      speech: { available: false, flags: [], models: [] },
    },
    hasDryRun: true,
    probedAt: 1700000000000,
  };
  const result = buildDiagnoseSnapshot({
    cfg: { api_key: 'sk-test' },
    state: {},
    mmxResolve: { node: 'C:\\node.exe', entry: 'C:\\mmx.mjs', command: 'node' },
    cliVersion: '1.0.16',
    cliSupported: true,
    supportedMin: '1.0.16',
    capabilitySnapshot: snap,
  });
  assert.equal(result.capabilityAvailable, true);
  assert.ok(result.capability, 'capability object should be present');
  assert.equal(result.capability.version, '1.0.16');
  assert.equal(result.capability.hasDryRun, true);
  assert.equal(result.capability.subcommands.image.available, true);
  assert.ok(result.capability.subcommands.image.flags.includes('--model'));
  assert.equal(result.capability.subcommands.speech.available, false);
  assert.equal(result.capability.probedAt, 1700000000000);
});

test('R7.2.J: diagnoseSnapshot returns capabilityAvailable=false when snapshot is null', () => {
  const { buildDiagnoseSnapshot } = require(path.join(ROOT, 'main', 'ipc', 'diagnoseSnapshot.js'));
  const result = buildDiagnoseSnapshot({
    cfg: {},
    state: {},
    mmxResolve: {},
    cliVersion: null,
    cliSupported: null,
    supportedMin: '1.0.16',
    capabilitySnapshot: null,
  });
  assert.equal(result.capabilityAvailable, false);
  assert.equal(result.capability, null);
});
