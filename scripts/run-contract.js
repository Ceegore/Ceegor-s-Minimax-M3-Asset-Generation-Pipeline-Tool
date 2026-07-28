#!/usr/bin/env node
// scripts/run-contract.js — wrapper for `npm run test:contract`.
//
// KGO8-010: the contract gate used to read GREEN while running nothing.
// Every test in tests/contract/ is gated behind RUN_CONTRACT_TESTS=1 (they
// spend real API credits), so without it `node --test` reported
// "tests 8, pass 0, fail 0, skipped 8" and exited 0. In a gate matrix that is
// indistinguishable from "the contract holds" — the same dishonest-green as
// the advisory visual gate (KGO8-003).
//
// The opt-in default is correct; the silent success was not. This wrapper
// keeps the default (no credits spent unless asked) but makes the outcome
// unmistakable, and it verifies that tests ACTUALLY RAN rather than trusting
// the exit code. tests/contract/_env.js has a second silent-skip path — enabled
// but no MINIMAX_API_KEY in .env/env skips every test and still exits 0 — so
// the pass count is parsed out of the runner's own summary.
//
// CI that legitimately wants the skip can set MMX_CONTRACT_OPTIONAL=1.

const { spawnSync } = require('child_process');
const path = require('path');

const enabled = process.env.RUN_CONTRACT_TESTS === '1' || process.env.RUN_CONTRACT_TESTS === 'true';
const optional = process.env.MMX_CONTRACT_OPTIONAL === '1';

function banner(lines) {
  process.stdout.write('\n' + '='.repeat(64) + '\n' + lines.join('\n') + '\n' + '='.repeat(64) + '\n\n');
}

if (!enabled) {
  banner([
    'CONTRACT TESTS NOT RUN — 0 of the contract tests were executed.',
    '',
    'They call the real MiniMax API and spend credits, so they are opt-in.',
    'Nothing about the provider contract has been verified by this command.',
    '',
    '  Run them:      RUN_CONTRACT_TESTS=1 npm run test:contract',
    '  Accept a skip: MMX_CONTRACT_OPTIONAL=1 npm run test:contract',
  ]);
  process.exit(optional ? 0 : 1);
}

// Same selector the npm script used before this wrapper existed — a bare
// directory arg makes the runner report a spurious top-level failure.
const r = spawnSync(process.execPath, ['--test', 'tests/contract/**/*.test.js'], {
  encoding: 'utf8',
  env: process.env,
});
process.stdout.write(r.stdout || '');
process.stderr.write(r.stderr || '');

if (r.status !== 0) process.exit(r.status == null ? 1 : r.status);

// Green exit code is not proof anything ran — parse the summary.
const out = (r.stdout || '') + (r.stderr || '');
const passed = Number((out.match(/^\s*(?:ℹ\s*)?pass\s+(\d+)/m) || [])[1] || 0);
const skipped = Number((out.match(/^\s*(?:ℹ\s*)?skipped\s+(\d+)/m) || [])[1] || 0);

if (passed === 0) {
  banner([
    `CONTRACT TESTS DID NOT RUN — pass: ${passed}, skipped: ${skipped}.`,
    '',
    'RUN_CONTRACT_TESTS is set, but every test still skipped. The usual cause',
    'is a missing API key: tests/contract/_env.js needs MINIMAX_API_KEY in the',
    'environment or in a .env file at the repo root.',
    '',
    'Exiting non-zero so this cannot be mistaken for a passing contract gate.',
  ]);
  process.exit(optional ? 0 : 1);
}

process.stdout.write(`\n[contract] ${passed} contract test(s) actually ran against the real API.\n`);
process.exit(0);
