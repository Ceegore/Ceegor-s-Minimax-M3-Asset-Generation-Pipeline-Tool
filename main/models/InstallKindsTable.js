// main/models/InstallKindsTable.js
// Tabelle der unterstützten "Pick file…" Install-Kinds mit ihren
// Dialog-Titeln, Filter-Sets und Ziel-Pfaden.
//
// Sicherheit: `destName` und `destSubdir` werden **vom Main-Process
// festgelegt** — der Renderer kann sie nicht beeinflussen. Damit ist
// der Install-Handler immun gegen einen kompromittierten Renderer,
// der versucht, in C:\Windows zu schreiben.

const path = require('path');

/**
 * @typedef {(
 *   'realesrgan-binary' | 'isnetbg-binary' | 'isnetbg-model'
 * )} InstallKind
 */

/** @type {Record<InstallKind, {title: string, filters: Array<{name: string, extensions: string[]}>, destSubdir: string, destName: string}>} */
const INSTALL_KINDS = {
  'realesrgan-binary': {
    title: 'Pick the realesrgan-ncnn-vulkan binary you downloaded',
    filters: [
      { name: 'Executable', extensions: ['exe'] },
      { name: 'All files', extensions: ['*'] },
    ],
    destSubdir: '',
    // After copy, the binary ends up at <binDir>/<basename>. We
    // want it to be at <binDir>/realesrgan-ncnn-vulkan.exe (the
    // name src/realesrgan.js probes for) so the wrapper's PATH
    // lookup finds it without renaming.
    destName: process.platform === 'win32' ? 'realesrgan-ncnn-vulkan.exe' : 'realesrgan-ncnn-vulkan',
  },
  'isnetbg-binary': {
    title: 'Pick the isnetbg binary you built (from the C# reference in the README)',
    filters: [
      { name: 'Executable', extensions: ['exe'] },
      { name: 'All files', extensions: ['*'] },
    ],
    destSubdir: '',
    destName: process.platform === 'win32' ? 'isnetbg.exe' : 'isnetbg',
  },
  'isnetbg-model': {
    title: 'Pick the isnet-general-use.onnx model file (~170 MB, MIT)',
    filters: [
      { name: 'ONNX model', extensions: ['onnx'] },
      { name: 'All files', extensions: ['*'] },
    ],
    destSubdir: 'models',
    destName: 'isnet-general-use.onnx',
  },
};

/**
 * Liefert die Ziel-Spec zu einem Kind.
 * @param {string} kind
 * @returns {object|null}
 */
function getSpec(kind) {
  return INSTALL_KINDS[kind] || null;
}

/**
 * Berechnet den absoluten Ziel-Pfad für ein Kind.
 * @param {string} kind
 * @param {string} appRoot
 * @returns {string|null}
 */
function getDestPath(kind, appRoot) {
  const spec = getSpec(kind);
  if (!spec) return null;
  const assetPaths = require('../../src/assetPaths');
  return assetPaths.resolveAsset(spec.destSubdir || '', spec.destName, { appRoot });
}

module.exports = { INSTALL_KINDS, getSpec, getDestPath };
