// scripts/generate-sbom.js
// M-035 (360° Audit): CycloneDX SBOM generation for release artifacts.
// V104-H003: the v1.0.4 requalification rejected an SBOM built from the
// DIRECT production dependencies only (top-level npm enumeration) that
// swallowed npm/parse errors into an EMPTY tree (fail-open). A release
// SBOM must be COMPLETE:
//
//   1. FULL TRANSITIVE production dependency tree (`npm ls --prod --all`),
//      flattened and deduplicated. ANY npm launch failure, unparsable
//      output or empty tree aborts the release (fail-closed).
//   2. RUNTIME ASSET inventory: every offline executable, native DLL and
//      ML model from scripts/runtime-assets.json, with the manifest's
//      pinned SHA-256 hash (type: file / machine-learning-model).
//   3. NATIVE inventory markers: the metadata records tree completeness
//      and asset counts so verify-release can fail-closed on a SBOM that
//      omits dependencies or runtime assets.
//
// Usage: node scripts/generate-sbom.js
// Output: dist-out/MiniMaxAssetTool-<version>-x64.sbom.json
//
// No network access required — reads from the installed node_modules.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function log(m) { process.stdout.write(`[sbom] ${m}\n`); }
function fatal(m) { log(`FATAL: ${m}`); process.exit(1); }

function purl(name, version) {
  const scope = name.startsWith('@') ? name.split('/')[0] : null;
  const base = scope ? name.split('/')[1] : name;
  const ns = scope ? `/${encodeURIComponent(scope.slice(1))}` : '';
  return `pkg:npm${ns}/${encodeURIComponent(base)}@${version}`;
}

function hashContent(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

// Collect the FULL production dependency tree via npm ls (offline, reads
// node_modules). V104-H003: fail-CLOSED — an unparseable or empty tree
// aborts the release instead of degrading to an empty SBOM.
function collectDeps(root = ROOT) {
  // KNOWN FALSE POSITIVE: spawnSync launches the npm CLI with fixed
  // read-only arguments — it is NOT arbitrary command execution. On Windows
  // npm is a .cmd shim, so resolution needs the shell (the old generator
  // silently degraded this exact failure into an empty tree).
  const r = spawnSync('npm', ['ls', '--prod', '--all', '--json'], {
    cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === 'win32',
  });
  if (r.error) {
    fatal(`cannot launch npm to enumerate the dependency tree: ${r.error.message}`);
  }
  let tree;
  try {
    tree = JSON.parse(r.stdout);
  } catch (e) {
    fatal(`npm ls produced unparsable JSON (${e.message}). Refusing to emit an incomplete SBOM.\n${(r.stdout || '').slice(0, 400)}`);
  }
  const deps = tree.dependencies || {};
  if (Object.keys(deps).length === 0) {
    fatal('the production dependency tree is EMPTY — refusing to emit an SBOM with no components.');
  }
  if (tree.problems && tree.problems.length > 0) {
    // Optional platform packages left over from a cross-platform install
    // are extraneous on THIS platform (CI runs `npm ci`, which drops them).
    // They do not compromise the shipped tree; every other problem aborts.
    const real = tree.problems.filter((p) => !/^extraneous:/.test(String(p)));
    if (real.length > 0) {
      fatal(`npm reports dependency-tree problems; fix the tree before releasing:\n  ${real.slice(0, 10).join('\n  ')}`);
    }
    log(`tolerating ${tree.problems.length} extraneous optional platform package(s) not shipped by npm ci`);
  }
  return deps;
}

// Flatten npm's nested `dependencies` tree into a deduplicated map of
// name -> { version }. Pure — unit-tested directly.
function flattenDepTree(deps, acc = new Map()) {
  for (const [name, info] of Object.entries(deps || {})) {
    const version = info && info.version;
    if (!version) {
      // npm ls lists UNINSTALLED optional platform dependencies as empty
      // stubs (no version, no subtree). They are not part of the shipped
      // tree — skip them. A genuinely MISSING dependency is reported by npm
      // as a "missing" problem above and aborts the release. Any actually-
      // shipped package omitted from the SBOM is still caught by
      // verify-release's package-lock completeness check.
      if (!info || (!version && !info.dependencies)) continue;
      fatal(`dependency "${name}" has no resolvable version in the npm tree.`);
    }
    const key = `${name}@${version}`;
    if (!acc.has(key)) acc.set(key, { name, version });
    if (info && info.dependencies) flattenDepTree(info.dependencies, acc);
  }
  return acc;
}

// Resolve a dependency's on-disk package.json (npm hoists, but nested
// copies exist when version ranges conflict). Returns null when missing.
function resolveDepPackageJson(root, name) {
  const segments = name.split('/');
  const scan = [path.join(root, 'node_modules')];
  while (scan.length) {
    const dir = scan.pop();
    const candidate = path.join(dir, ...segments, 'package.json');
    if (fs.existsSync(candidate)) return candidate;
    // Look for nested node_modules one level down (bounded depth).
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name !== '.bin') {
          const nested = path.join(dir, entry.name, 'node_modules');
          if (fs.existsSync(nested)) scan.push(nested);
        }
      }
    } catch (_) { /* unreadable dir: skip */ }
  }
  return null;
}

function libraryComponent(root, name, version) {
  const component = {
    type: 'library',
    name,
    version,
    purl: purl(name, version),
    'bom-ref': purl(name, version),
  };
  const depPkgPath = resolveDepPackageJson(root, name);
  if (!depPkgPath) {
    // A locally drifted install can list a package that is not on disk.
    // Warn loudly but still emit the component — verify-release's
    // package-lock completeness check fails closed on any real omission.
    log(`WARNING: ${name}@${version} is listed by npm but missing on disk (stale install; npm ci before release)`);
    return component;
  }
  let depPkg = {};
  try { depPkg = JSON.parse(fs.readFileSync(depPkgPath, 'utf8')); } catch (_) {}
  if (depPkg.license) {
    component.licenses = [{ license: { id: depPkg.license } }];
  }
  if (depPkg.description) {
    component.description = depPkg.description.slice(0, 200);
  }
  component.hashes = [{ alg: 'SHA-256', content: hashContent(fs.readFileSync(depPkgPath)) }];
  return component;
}

// V104-H003: the offline runtime payload (executables, native DLLs, ML
// models) is part of the shipped product and belongs in the SBOM, with the
// manifest's pinned hashes. Pure — unit-tested directly.
function runtimeAssetComponents(manifest) {
  const components = [];
  for (const asset of (manifest && manifest.assets) || []) {
    const isModel = /models\//.test(asset.path) || /\.(onnx|bin|param)$/.test(asset.path);
    const component = {
      type: isModel ? 'machine-learning-model' : 'file',
      name: path.posix.basename(asset.path),
      version: `runtime-manifest-v${manifest.schemaVersion || 1}`,
      'bom-ref': `runtime-asset:${asset.path}`,
      properties: [{ name: 'asset:path', value: asset.path }],
      hashes: [{ alg: 'SHA-256', content: asset.sha256 }],
    };
    components.push(component);
  }
  return components;
}

function loadRuntimeManifest(root) {
  const manifestPath = path.join(root, 'scripts', 'runtime-assets.json');
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    fatal(`cannot read the runtime asset manifest ${manifestPath}: ${e.message}`);
  }
}

function buildBom(root = ROOT) {
  const PKG = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const VERSION = PKG.version;

  const deps = collectDeps(root);
  const flat = flattenDepTree(deps);
  const components = [];
  for (const { name, version } of flat.values()) {
    components.push(libraryComponent(root, name, version));
  }

  // Include Electron itself (shipped runtime, not a node_modules dep only).
  const elPkgPath = path.join(root, 'node_modules', 'electron', 'package.json');
  if (fs.existsSync(elPkgPath)) {
    const elPkg = JSON.parse(fs.readFileSync(elPkgPath, 'utf8'));
    components.push({
      type: 'framework',
      name: 'electron',
      version: elPkg.version,
      purl: purl('electron', elPkg.version),
      'bom-ref': purl('electron', elPkg.version),
      licenses: [{ license: { id: 'MIT' } }],
    });
  }

  const manifest = loadRuntimeManifest(root);
  const assetComponents = runtimeAssetComponents(manifest);
  components.push(...assetComponents);

  const bom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${crypto.randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      tools: [{ vendor: 'MiniMaxAssetTool', name: 'generate-sbom', version: '2.0.0' }],
      component: {
        type: 'application',
        name: PKG.name,
        version: VERSION,
        purl: purl(PKG.name, VERSION),
        'bom-ref': purl(PKG.name, VERSION),
      },
      // V104-H003: completeness markers — verify-release fails closed when
      // these are absent or stale.
      properties: [
        { name: 'sbom:dependencyTree', value: 'full-transitive' },
        { name: 'sbom:npmComponentCount', value: String(flat.size) },
        { name: 'sbom:runtimeAssetCount', value: String(assetComponents.length) },
      ],
    },
    components,
  };
  return { bom, VERSION, npmCount: flat.size, assetCount: assetComponents.length };
}

function main() {
  const root = ROOT;
  const PKG = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const DIST = path.join(root, 'dist-out');
  const OUT_PATH = path.join(DIST, `MiniMaxAssetTool-${PKG.version}-x64.sbom.json`);

  const { bom, npmCount, assetCount } = buildBom(root);

  if (!fs.existsSync(DIST)) fs.mkdirSync(DIST, { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(bom, null, 2) + '\n', 'utf8');
  log(`SBOM written: ${OUT_PATH}`);
  log(`Components: ${bom.components.length} (npm full-transitive: ${npmCount}, runtime assets: ${assetCount})`);
}

if (require.main === module) main();

module.exports = { buildBom, collectDeps, flattenDepTree, runtimeAssetComponents, purl };
