// main/interfaces/IInstallTarget.d.ts
// Verbindlicher Vertrag für die Install-Pipeline der optionalen Add-ons
// (Real-ESRGAN, IS-Net). Implementierungen:
//   - main/services/InstallDownloadService.js (Download-Handler)
//   - main/services/InstallPickCopyService.js (Pick-File-Handler)
//   - main/models/InstallKindsTable.js           (kind-Metadaten)

/** @typedef {import('./IMmxRunner').InstallKind} InstallKind */

/**
 * Dialog-Filter, die Electron `showOpenDialog` versteht.
 * Wird vom "Pick file…" Button im Optional-Addons-Popup genutzt.
 *
 * @typedef {object} DialogFilter
 * @property {string} name
 * @property {string[]} extensions
 */

/**
 * Pro `InstallKind`: Titel, Filter, Ziel-Unterverzeichnis und Ziel-Dateiname
 * relativ zu `__dirname/bin[/<subdir>]/`. Ziel-Datei wird vom Main-Process
 * **eigenmächtig** gesetzt — der Renderer kann sie nicht beeinflussen.
 *
 * @typedef {object} InstallTargetSpec
 * @property {string} title
 * @property {DialogFilter[]} filters
 * @property {string} destSubdir     '' oder 'models' (für ONNX).
 * @property {string} destName       Fester Ziel-Dateiname (z. B. 'realesrgan-ncnn-vulkan.exe').
 */

/**
 * @typedef {object} DownloadProgress
 * @property {'download' | 'extract'} phase
 * @property {number} downloaded
 * @property {number} total
 * @property {'starting' | 'started' | 'progress' | 'done' | 'error'} status
 */

/**
 * @typedef {object} IInstallDownloader
 * @property {(send: (p: DownloadProgress) => void) => Promise<{ok: boolean, binDir?: string, error?: string}>} downloadRealesrgan
 *   Lädt die v0.2.5.0 Windows-Zip von GitHub, entpackt sie via
 *   PowerShell-Expand-Archive in `./bin/`, gibt Fortschritt über
 *   `send` aus.
 */

/**
 * @typedef {object} IInstallPickCopy
 * @property {(kind: InstallKind) => Promise<{ok: boolean, destPath?: string, kind?: InstallKind, canceled?: boolean, error?: string}>} pickAndCopy
 *   Öffnet File-Picker mit kind-spezifischem Titel + Filtern, kopiert
 *   die gewählte Datei atomar (tmp + rename) ins Ziel.
 * @property {() => InstallTargetSpec} getSpec
 *   Liefert die Ziel-Spec für einen Kind (hauptsächlich für Tests).
 */

module.exports = {};
