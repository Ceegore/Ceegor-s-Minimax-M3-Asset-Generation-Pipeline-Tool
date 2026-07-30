// scripts/generate-sbom.js
// M-035 (360° Audit): CycloneDX SBOM generation for release artifacts.
//
// Usage: node scripts/generate-sbom.js
// Output: dist-out/MiniMaxAssetTool-<version>-x64.sbom.json
//
// Produces a CycloneDX 1.5 JSON BOM from the production dependency tree.
// No network access required — reads from the installed node_modules.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = PKG.version;
const DIST = path.join(ROOT, 'dist-out');
const OUT_PATH = path.join(DIST, `MiniMaxAssetTool-${VERSION}-x64.sbom.json`);

function log(m) { process.stdout.write(m + '\n'); }

// Collect production dependencies via npm ls (offline, reads node_modules).
function collectDeps() {
  const r = spawnSync('npm', ['ls', '--prod', '--json', '--depth=0'], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024,
  });
  let tree;
  try { tree = JSON.parse(r.stdout); } catch (_) { tree = { dependencies: {} }; }
  return tree.dependencies || {};
}

function purl(name, version) {
  const scope = name.startsWith('@') ? name.split('/')[0] : null;
  const base = scope ? name.split('/')[1] : name;
  const ns = scope ? `/${encodeURIComponent(scope.slice(1))}` : '';
  return `pkg:npm${ns}/${encodeURIComponent(base)}@${version}`;
}

function hashContent(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function main() {
  const deps = collectDeps();
  const components = [];

  for (const [name, info] of Object.entries(deps)) {
    const depPkgPath = path.join(ROOT, 'node_modules', name, 'package.json');
    let depPkg = {};
    try { depPkg = JSON.parse(fs.readFileSync(depPkgPath, 'utf8')); } catch (_) {}
    const version = info.version || depPkg.version || 'unknown';
    const component = {
      type: 'library',
      name,
      version,
      purl: purl(name, version),
      'bom-ref': purl(name, version),
    };
    if (depPkg.license) {
      component.licenses = [{ license: { id: depPkg.license } }];
    }
    if (depPkg.description) {
      component.description = depPkg.description.slice(0, 200);
    }
    // Hash the package.json for integrity verification.
    try {
      const raw = fs.readFileSync(depPkgPath);
      component.hashes = [{ alg: 'SHA-256', content: hashContent(raw) }];
    } catch (_) {}
    components.push(component);
  }

  // Include Electron itself.
  try {
    const elPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8'));
    components.push({
      type: 'framework',
      name: 'electron',
      version: elPkg.version,
      purl: purl('electron', elPkg.version),
      'bom-ref': purl('electron', elPkg.version),
      licenses: [{ license: { id: 'MIT' } }],
    });
  } catch (_) {}

  const bom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${crypto.randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      tools: [{ vendor: 'MiniMaxAssetTool', name: 'generate-sbom', version: '1.0.0' }],
      component: {
        type: 'application',
        name: PKG.name,
        version: VERSION,
        purl: purl(PKG.name, VERSION),
        'bom-ref': purl(PKG.name, VERSION),
      },
    },
    components,
  };

  if (!fs.existsSync(DIST)) fs.mkdirSync(DIST, { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(bom, null, 2) + '\n', 'utf8');
  log(`SBOM written: ${OUT_PATH}`);
  log(`Components: ${components.length}`);
}

main();
