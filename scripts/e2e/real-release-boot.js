// scripts/e2e/real-release-boot.js
// ============================================================================
// V104-B001 / V104-M001: REAL packaged-release boot acceptance.
//
// The v1.0.4 requalification found that "packaged" acceptance actually
// rebuilt a temp ASAR from the checkout and booted it with node_modules
// Electron plus --no-sandbox — none of which exercises the shipped
// product. This script instead boots the EXACT packaged executable from
// the downloaded/built release tree (dist-out/win-unpacked by default):
//
//   * the real MiniMaxAssetTool.exe (Authenticode-signed PE),
//   * the real resources/app.asar and bundled runtime,
//   * NO dev dependencies, NO --no-sandbox dev shim,
//   * an isolated MINIMAX_CONFIG_DIR so no host state leaks in.
//
// It probes the live renderer over the Chrome DevTools Protocol using
// Node 22 built-ins only (fetch + WebSocket), asserts the preload bridge
// (window.api), the rendered DOM and the intact sandbox, then kills the
// process tree. Because it uses only Node built-ins, the clean-VM job can
// run it without `npm ci`.
//
// Usage:
//   node scripts/e2e/real-release-boot.js [releaseDir]
//   MINIMAX_RELEASE_DIR=<dir holding MiniMaxAssetTool.exe>
// ============================================================================

'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

function log(m) { process.stdout.write(`[real-release-boot] ${m}\n`); }

function resolveReleaseDir() {
  if (process.argv[2]) return path.resolve(process.argv[2]);
  if (process.env.MINIMAX_RELEASE_DIR) return path.resolve(process.env.MINIMAX_RELEASE_DIR);
  return path.join(ROOT, 'dist-out', 'win-unpacked');
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Poll the CDP endpoint until a page target appears (or timeout).
async function waitForPageTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const targets = await res.json();
        const page = targets.find((t) => t.type === 'page');
        if (page && page.webSocketDebuggerUrl) return page;
      }
    } catch (e) {
      lastErr = e;
    }
    await sleep(500);
  }
  throw new Error(`no CDP page target appeared within ${timeoutMs} ms${lastErr ? ` (last error: ${lastErr.message})` : ''}`);
}

// The same functional smoke packaged-boot.js runs — but evaluated inside
// the REAL shipped renderer/preload via CDP instead of a wrapper shell.
const SMOKE_EXPRESSION = `(() => {
  const out = { api: false, apiKeys: 0, dom: false, require: false, process: false };
  try {
    out.api = !!(window.api && typeof window.api === 'object');
    out.apiKeys = out.api ? Object.keys(window.api).length : 0;
    out.dom = !!document.getElementById('tab-image') && !!document.body;
    out.require = (typeof require !== 'undefined');
    out.process = (typeof process !== 'undefined');
  } catch (e) { out.error = String(e && e.message || e); }
  return JSON.stringify(out);
})()`;

async function evaluateOverCdp(wsUrl, expression, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      try { ws.close(); } catch (_) {}
      reject(new Error('CDP evaluate timed out'));
    }, timeoutMs);
    ws.onopen = () => {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    };
    ws.onmessage = (ev) => {
      let msg = null;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch (_) { return; }
      if (!msg || msg.id !== 1) return;
      clearTimeout(timer);
      try { ws.close(); } catch (_) {}
      if (msg.error) { reject(new Error(`CDP error: ${JSON.stringify(msg.error)}`)); return; }
      const value = msg.result && msg.result.result ? msg.result.result.value : undefined;
      resolve(value);
    };
    ws.onerror = (ev) => {
      clearTimeout(timer);
      reject(new Error(`CDP websocket error: ${ev && ev.message ? ev.message : 'unknown'}`));
    };
  });
}

function killTree(child) {
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      child.kill('SIGKILL');
    }
  } catch (_) {}
}

// Boot the real release exe once and run the CDP smoke. Exported so the
// installer acceptance suite (test-release-acceptance.js) can boot the
// INSTALLED copy with the identical probe.
async function bootAndProbe(exePath, opts = {}) {
  if (!fs.existsSync(exePath)) {
    throw new Error(`release executable not found: ${exePath}`);
  }
  // Sanity: a packaged Electron product must ship its asar beside the exe.
  const asarPath = path.join(path.dirname(exePath), 'resources', 'app.asar');
  if (!fs.existsSync(asarPath)) {
    throw new Error(`packaged app.asar missing beside ${exePath} — not a real release tree`);
  }

  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-release-boot-'));
  const port = await getFreePort();
  const child = spawn(exePath, [`--remote-debugging-port=${port}`, '--disable-gpu'], {
    cwd: path.dirname(exePath),
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      // Isolated state: src/config.js honours MINIMAX_CONFIG_DIR first, so
      // the boot never touches the host config or the exe directory.
      MINIMAX_CONFIG_DIR: configDir,
      ...(opts.extraEnv || {}),
    },
  });

  let exitedEarly = false;
  let exitCode = null;
  child.on('exit', (code) => { exitedEarly = true; exitCode = code; });

  try {
    const bootTimeout = opts.bootTimeoutMs || 60000;
    let target;
    try {
      target = await waitForPageTarget(port, bootTimeout);
    } catch (e) {
      if (exitedEarly) throw new Error(`release process exited early (code ${exitCode}) before a renderer came up: ${e.message}`);
      throw e;
    }
    const raw = await evaluateOverCdp(target.webSocketDebuggerUrl, SMOKE_EXPRESSION, 20000);
    let smoke = null;
    try { smoke = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) { smoke = null; }
    if (!smoke) throw new Error('renderer smoke probe returned no parseable result');
    const problems = [];
    if (!smoke.api || !(smoke.apiKeys > 0)) problems.push('preload bridge window.api missing/empty');
    if (!smoke.dom) problems.push('renderer DOM did not render (tab-image absent)');
    if (smoke.require) problems.push('sandbox leak: require visible in renderer');
    if (smoke.process) problems.push('sandbox leak: process visible in renderer');
    if (problems.length) throw new Error(`release boot smoke failed: ${problems.join('; ')} — ${JSON.stringify(smoke)}`);
    log(`smoke OK (window.api keys=${smoke.apiKeys}, sandbox intact)`);
    return { ok: true, smoke };
  } finally {
    killTree(child);
    try { fs.rmSync(configDir, { recursive: true, force: true }); } catch (_) {}
  }
}

async function main() {
  if (process.platform !== 'win32') {
    log('SKIP: the shipped release is Windows-only');
    return;
  }
  const releaseDir = resolveReleaseDir();
  const exe = path.join(releaseDir, 'MiniMaxAssetTool.exe');
  log(`Booting the REAL packaged release: ${exe}`);
  if (!fs.existsSync(exe)) {
    // Fail CLOSED: B001 demands the exact downloaded release. There is no
    // dev-harness fallback that could silently substitute a rebuilt ASAR.
    throw new Error(`real release not found at ${releaseDir}. Download/extract the release (or point MINIMAX_RELEASE_DIR at it) — acceptance must boot the exact shipped executable.`);
  }
  await bootAndProbe(exe);
  log('PASS: real packaged release booted and passed the functional smoke');
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => {
    log(`FAIL: ${e.message}`);
    process.exit(1);
  });
}

module.exports = { bootAndProbe, resolveReleaseDir };
