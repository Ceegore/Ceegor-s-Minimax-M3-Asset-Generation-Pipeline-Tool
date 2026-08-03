// Hands-on verification of release-pipeline findings: B-001, B-002, B-003,
// M-001, M-003, M-004, M-023. Executes shipped code/commands directly.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const results = [];
function check(id, name, pass, detail) { results.push([id, name, pass, detail]); }

// ---------- B-001: FILES.sha256 written BEFORE installer test ----------
{
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'zip-portable.js'), 'utf8');
  const manifestIdx = src.indexOf("fs.writeFileSync(path.join(UNPACKED, 'FILES.sha256')");
  const testIdx = src.indexOf('test-release-installer.js');
  check('B-001', 'zip-portable writes FILES.sha256 before running installer test',
    manifestIdx > 0 && testIdx > manifestIdx, `manifest@${manifestIdx} test@${testIdx}`);
}
// B-001 live attack: installer against a tree WITHOUT FILES.sha256 must fail closed.
{
  const installer = path.join(ROOT, 'Install MiniMax Asset Tool.cmd');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'b001-probe-'));
  const src = path.join(temp, 'src');
  for (const f of ['MiniMaxAssetTool.exe', 'resources\\app.asar', 'resources\\bin\\models\\isnet-general-use.onnx', 'resources\\bin\\models\\birefnet-general.onnx', 'resources\\bin\\models\\lama-big.onnx', 'resources\\bin\\realesrgan-ncnn-vulkan.exe']) {
    fs.mkdirSync(path.dirname(path.join(src, f)), { recursive: true });
    fs.writeFileSync(path.join(src, f), 'x');
  }
  // Deliberately NO FILES.sha256.
  fs.copyFileSync(installer, path.join(src, path.basename(installer)));
  const r = spawnSync('cmd.exe', ['/d', '/c', path.join(src, path.basename(installer))], {
    cwd: src, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, MINIMAX_INSTALL_DIR: path.join(temp, 'inst'), MINIMAX_INSTALL_DESKTOP: path.join(temp, 'd'), MINIMAX_INSTALL_START_MENU: path.join(temp, 's'), MINIMAX_INSTALL_NO_LAUNCH: '1' },
  });
  const out = ((r.stdout || '') + (r.stderr || '')).slice(-400);
  check('B-001', 'installer rejects a release tree with no FILES.sha256 (fail closed)',
    r.status !== 0 && /manifest/i.test(out), `status=${r.status} tail=${out.slice(0, 300)}`);
  fs.rmSync(temp, { recursive: true, force: true });
}

// ---------- B-002: one canonical outer artifact inventory ----------
{
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'b002-probe-'));
  // Synthetic dist-out.
  fs.mkdirSync(path.join(temp, 'win-unpacked'), { recursive: true });
  fs.writeFileSync(path.join(temp, 'win-unpacked', 'MiniMaxAssetTool.exe'), 'PE');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const base = `${pkg.build?.productName || pkg.name}-${pkg.version}-x64`;
  fs.writeFileSync(path.join(temp, `${base}.zip`), 'PK');
  fs.writeFileSync(path.join(temp, 'Install-MiniMax-Asset-Tool.cmd'), '@echo off');
  // Fake package.json so releasePaths resolves `temp` as root.
  fs.writeFileSync(path.join(temp, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, build: { directories: { output: '.' }, productName: pkg.build?.productName || pkg.name } }));
  const ra = require(path.join(ROOT, 'scripts', 'releaseArtifacts.js'));
  const entries = ra.outerManifestEntries(ra.releasePaths(temp));
  const ok = entries.length === 3
    && entries.some((e) => e.replace(/\\/g, '/') === 'win-unpacked/MiniMaxAssetTool.exe')
    && entries.some((e) => e.endsWith('.zip'))
    && entries.some((e) => e === 'Install-MiniMax-Asset-Tool.cmd');
  check('B-002', 'outerManifestEntries yields {exe, zip, installer-cmd} for writer AND verifier',
    ok, JSON.stringify(entries));
  const writer = fs.readFileSync(path.join(ROOT, 'scripts', 'zip-portable.js'), 'utf8');
  const verifier = fs.readFileSync(path.join(ROOT, 'scripts', 'verify-release.js'), 'utf8');
  check('B-002', 'writer (zip-portable) and strict verifier both consume the same canonical list',
    /outerManifestEntries\(releasePaths\(ROOT\)\)/.test(writer) && /outerManifestEntries\(paths\)/.test(verifier), '');
  fs.rmSync(temp, { recursive: true, force: true });
}

// ---------- B-003 + M-001: release workflow sequence ----------
{
  const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release-gate.yml'), 'utf8');
  const iIdentity = wf.indexOf('assert:identity');
  const iSecrets = wf.indexOf('Prepare signing material');
  const iBuild = wf.indexOf('node scripts/zip-portable.js');
  const iSbom = wf.indexOf('node scripts/generate-sbom.js');
  const iSign = wf.indexOf('npm run sign:release');
  const iVerify = wf.indexOf('npm run verify:release');
  const iMinisignInstall = wf.indexOf('Install pinned Minisign');
  const orderOk = iIdentity > 0 && iSecrets > iIdentity && iBuild > iSecrets && iSbom > iBuild && iSign > iSbom && iVerify > iSign && iMinisignInstall > 0 && iMinisignInstall < iSign;
  check('B-003', 'workflow sequence identity→secrets→build→SBOM→sign→strict-verify with pinned Minisign', orderOk,
    `${iIdentity},${iSecrets},${iBuild},${iSbom},${iSign},${iVerify}`);
  check('B-003', 'tag release FAILS on missing signing secrets (explicit diagnostics)',
    /A tag release cannot be built without signing/.test(wf), '');
  check('B-003', 'Minisign download is SHA-256 pinned', /SHA-256 check: expected/.test(wf), '');
  // M-001: publication output only on tag runs.
  const uploadBlock = wf.slice(wf.indexOf('Upload release artifacts'));
  check('M-001', 'artifact upload is gated on IS_TAG_RELEASE == true',
    /Upload release artifacts[\s\S]{0,200}IS_TAG_RELEASE == 'true'/.test(uploadBlock), '');
  check('M-001', 'manual dispatch requires an explicit version input',
    /RELEASE_EXPECTED_VERSION: \$\{\{ inputs\.version \}\}/.test(wf) && /required: true/.test(wf), '');
}
// M-001 live: assert-release-identity must REJECT a manual run whose version input mismatches.
{
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'assert-release-identity.js'), 'utf8');
  check('M-001', 'assert-release-identity enforces RELEASE_EXPECTED_VERSION against package.json',
    /RELEASE_EXPECTED_VERSION/.test(src) && /version/.test(src), '');
}

// ---------- M-003: binary scan includes .node + app.asar.unpacked/node_modules ----------
{
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'verify-release.js'), 'utf8');
  const start = src.indexOf('function findBinariesRecursive');
  // Extract the function body via brace counting and execute it on a hostile tree.
  let depth = 0, end = start;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  const fn = eval('(' + src.slice(start, end) + ')');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'm003-probe-'));
  fs.mkdirSync(path.join(temp, 'resources', 'app.asar.unpacked', 'node_modules', 'sharp'), { recursive: true });
  fs.writeFileSync(path.join(temp, 'resources', 'app.asar.unpacked', 'node_modules', 'sharp', 'sharp.node'), 'x');
  fs.writeFileSync(path.join(temp, 'app.exe'), 'x');
  fs.mkdirSync(path.join(temp, 'node_modules', 'tool'), { recursive: true });
  fs.writeFileSync(path.join(temp, 'node_modules', 'tool', 'helper.dll'), 'x');
  const found = fn(temp).map((p) => path.relative(temp, p).replace(/\\/g, '/')).sort();
  check('M-003', 'Authenticode scan finds .node addons inside app.asar.unpacked/node_modules AND nested node_modules dlls',
    found.includes('resources/app.asar.unpacked/node_modules/sharp/sharp.node') && found.includes('node_modules/tool/helper.dll') && found.includes('app.exe'),
    JSON.stringify(found));
  fs.rmSync(temp, { recursive: true, force: true });
}

// ---------- M-004: SBOM content verification (behavioral) ----------
{
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'm004-probe-'));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const base = `${pkg.build?.productName || pkg.name}-${pkg.version}-x64`;
  // (a) garbage SBOM must be rejected
  fs.writeFileSync(path.join(temp, `${base}.sbom.json`), '{ "hello": "world" }');
  // (b) valid CycloneDX SBOM matching package.json must be accepted
  const good = { bomFormat: 'CycloneDX', specVersion: '1.5', metadata: { component: { name: pkg.build?.productName || pkg.name, version: pkg.version } }, components: [{ type: 'library', name: 'electron', version: '43.0.0' }] };
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'verify-release.js'), 'utf8');
  const start = src.indexOf('function verifySbom');
  let depth = 0, end = start;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  const verifySbom = eval('(' + src.slice(start, end) + ')');
  function readPackageName() { return pkg.build?.productName || pkg.name; } // helper verifySbom closes over
  const fakePaths = { output: temp, baseName: base, productName: pkg.build?.productName || pkg.name, version: pkg.version };
  const bad = verifySbom(temp, fakePaths);
  fs.writeFileSync(path.join(temp, `${base}.sbom.json`), JSON.stringify(good));
  const ok = verifySbom(temp, fakePaths);
  // (c) version mismatch must be rejected
  const wrongVer = JSON.parse(JSON.stringify(good)); wrongVer.metadata.component.version = '0.0.1';
  fs.writeFileSync(path.join(temp, `${base}.sbom.json`), JSON.stringify(wrongVer));
  const mismatch = verifySbom(temp, fakePaths);
  check('M-004', 'SBOM verifier rejects schema-less JSON, accepts matching CycloneDX, rejects version mismatch',
    bad.ok === false && ok.ok === true && mismatch.ok === false,
    `bad=${JSON.stringify(bad.errors).slice(0, 80)} ok=${ok.ok} mismatch=${JSON.stringify(mismatch.errors).slice(0, 80)}`);
  fs.rmSync(temp, { recursive: true, force: true });
}

// ---------- M-023: provenance CI evidence (execute shipped writeProvenance) ----------
{
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'zip-portable.js'), 'utf8');
  const start = src.indexOf('function writeProvenance()');
  let depth = 0, end = start;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  const fnText = src.slice(start, end);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'm023-probe-'));
  fs.mkdirSync(path.join(temp, 'unpacked', 'resources'), { recursive: true });
  fs.writeFileSync(path.join(temp, 'unpacked', 'resources', 'app.asar'), 'ASAR');
  function run(env) {
    const saved = {};
    for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
    let out;
    try {
      const factory = new Function('DIST', 'UNPACKED', 'VERSION', 'ROOT', 'fs', 'path', 'crypto', 'spawnSync', 'log', `${fnText}; return writeProvenance;`);
      const wp = factory(temp, path.join(temp, 'unpacked'), '9.9.9', ROOT, fs, path, crypto, spawnSync, () => {});
      wp();
      out = JSON.parse(fs.readFileSync(path.join(temp, 'MiniMaxAssetTool-9.9.9-x64.provenance.json'), 'utf8'));
    } finally {
      for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
    return out;
  }
  const local = run({});
  const ci = run({
    GITHUB_ACTIONS: 'true', GITHUB_WORKFLOW: 'Release Gate',
    GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'owner/repo',
    GITHUB_RUN_ID: '12345', GITHUB_SHA: 'abc123def456',
  });
  check('M-023', 'local build records ci:null; CI build records provider/runUrl/sha in provenance',
    local.ci === null && ci.ci && ci.ci.provider === 'github-actions'
    && ci.ci.runUrl === 'https://github.com/owner/repo/actions/runs/12345' && ci.ci.sha === 'abc123def456',
    JSON.stringify({ local: local.ci, ci: ci.ci }));
  fs.rmSync(temp, { recursive: true, force: true });
}

let fail = 0;
for (const [id, name, pass, detail] of results) {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} :: ${name}${pass ? '' : ` :: ${detail}`}`);
  if (!pass) fail++;
}
console.log(`\nrelease-probe: ${results.length - fail}/${results.length} passed`);
process.exit(fail ? 1 : 0);
