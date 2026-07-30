// src/services/CappedProcessRunner.js
// ============================================================================
// P2-B (360° Audit M-009, M-010, M-011, H-012): Safe child process wrapper.
//
// All child process spawns (Real-ESRGAN, FFmpeg, IS-Net, mmx-cli) should
// go through this runner. It enforces:
//
//   1. Minimal environment allowlist (PATH, SYSTEMROOT, TEMP only)
//   2. stdout/stderr byte caps (1 MB default) — prevents OOM from verbose output
//   3. Hard timeout per job type — kills hung processes
//   4. Process tree kill on cancel/timeout — no orphaned children
//   5. Temp file cleanup in finally block
//
// Usage:
//   const { runCapped } = require('./CappedProcessRunner');
//   const result = await runCapped({
//     command: 'ffmpeg',
//     args: ['-i', 'in.mp4', 'out.mp4'],
//     timeoutMs: 60000,
//     maxOutputBytes: 1024 * 1024,
//   });
// ============================================================================
'use strict';

const { spawn } = require('child_process');
const path = require('path');

/** Default maximum stdout+stderr capture (1 MB). */
const DEFAULT_MAX_OUTPUT_BYTES = 1 * 1024 * 1024;

/** Default timeout (5 minutes). */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Build a minimal environment for child processes.
 * Only includes what's needed for the OS to function.
 * @param {object} [extra] - Additional env vars to include.
 * @returns {object}
 */
function buildMinimalEnv(extra) {
  const env = {};
  // Windows essentials
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.Path) env.Path = process.env.Path;
  if (process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT;
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  if (process.env.TEMP) env.TEMP = process.env.TEMP;
  if (process.env.TMP) env.TMP = process.env.TMP;
  if (process.env.COMSPEC) env.COMSPEC = process.env.COMSPEC;
  if (process.env.PATHEXT) env.PATHEXT = process.env.PATHEXT;
  // POSIX essentials
  if (process.env.HOME) env.HOME = process.env.HOME;
  if (process.env.LANG) env.LANG = process.env.LANG;
  // Merge caller-supplied extras (e.g. CUDA paths for Real-ESRGAN)
  if (extra && typeof extra === 'object') {
    for (const [k, v] of Object.entries(extra)) {
      if (typeof v === 'string') env[k] = v;
    }
  }
  return env;
}

/**
 * Kill a process tree (the child and all its descendants).
 * On Windows, uses taskkill /T /F. On POSIX, uses negative PID kill.
 * @param {import('child_process').ChildProcess} child
 */
function killProcessTree(child) {
  if (!child || !child.pid || child.killed) return;
  try {
    if (process.platform === 'win32') {
      // taskkill /T kills the entire process tree
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      // Negative PID kills the process group
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch (_) {
    // Fallback: direct kill
    try { child.kill('SIGKILL'); } catch (_) {}
  }
}

/**
 * Run a child process with safety caps.
 *
 * @param {{
 *   command: string,
 *   args?: string[],
 *   cwd?: string,
 *   timeoutMs?: number,
 *   maxOutputBytes?: number,
 *   env?: object,
 *   signal?: AbortSignal,
 *   onStdout?: (chunk: Buffer) => void,
 *   onStderr?: (chunk: Buffer) => void,
 *   tempFiles?: string[],
 * }} opts
 * @returns {Promise<{ok: boolean, code: number|null, stdout: string, stderr: string, timedOut: boolean, canceled: boolean}>}
 */
function runCapped(opts) {
  const {
    command,
    args = [],
    cwd,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    env: extraEnv,
    signal,
    onStdout,
    onStderr,
    tempFiles = [],
  } = opts;

  return new Promise((resolve) => {
    let stdoutBuf = [];
    let stderrBuf = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let canceled = false;
    let settled = false;
    let timer = null;
    let onAbort = null;

    const child = spawn(command, args, {
      cwd: cwd || undefined,
      env: buildMinimalEnv(extraEnv),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // On POSIX, create a new process group so we can kill the tree
      detached: process.platform !== 'win32',
    });

    function settle(result) {
      if (settled) return;
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      // HIGH-031: remove the abort listener to prevent memory leaks.
      if (onAbort && signal) {
        try { signal.removeEventListener('abort', onAbort); } catch (_) {}
      }
      // HIGH-033: cleanup temp files in finally.
      if (tempFiles.length) {
        const fs = require('fs');
        for (const tf of tempFiles) {
          try { fs.unlinkSync(tf); } catch (_) {}
        }
      }
      resolve(result);
    }

    // Timeout
    timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeoutMs);

    // External cancel (AbortSignal)
    if (signal) {
      onAbort = () => {
        canceled = true;
        killProcessTree(child);
      };
      if (signal.aborted) {
        canceled = true;
        killProcessTree(child);
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    // stdout capture with cap
    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        if (onStdout) onStdout(chunk);
        if (stdoutBytes < maxOutputBytes) {
          const remaining = maxOutputBytes - stdoutBytes;
          const slice = chunk.length > remaining ? chunk.slice(0, remaining) : chunk;
          stdoutBuf.push(slice);
          stdoutBytes += slice.length;
        }
      });
    }

    // stderr capture with cap
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        if (onStderr) onStderr(chunk);
        if (stderrBytes < maxOutputBytes) {
          const remaining = maxOutputBytes - stderrBytes;
          const slice = chunk.length > remaining ? chunk.slice(0, remaining) : chunk;
          stderrBuf.push(slice);
          stderrBytes += slice.length;
        }
      });
    }

    child.on('error', (err) => {
      settle({
        ok: false,
        code: null,
        stdout: Buffer.concat(stdoutBuf).toString('utf8'),
        stderr: `spawn error: ${err.message}`,
        timedOut,
        canceled,
      });
    });

    child.on('close', (code) => {
      settle({
        ok: code === 0 && !timedOut && !canceled,
        code,
        stdout: Buffer.concat(stdoutBuf).toString('utf8'),
        stderr: Buffer.concat(stderrBuf).toString('utf8'),
        timedOut,
        canceled,
      });
    });
  });
}

module.exports = {
  runCapped,
  killProcessTree,
  buildMinimalEnv,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
};
