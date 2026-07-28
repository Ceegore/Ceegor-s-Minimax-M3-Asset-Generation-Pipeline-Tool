// main/ipc/registerInpaintOnnxIpc.js
// IPC handler for the editor's AI Heal tier (Feature 5 §6.4): LaMa / MI-GAN
// ONNX inpainting via the spawned src/inpaint/inpaint_node.js worker.
//
// Channel: inpaint:runOnnx
// args: { srcPath, maskB64, outPath?, model?, useGpu?, areaShare?, grantId?, ... }
//   maskB64: base64 PNG (white = fill) — written to a temp file for the worker.
// The worker composites the AI fill back into only the masked region (feathered),
// preserving unmasked pixels byte-for-byte, and writes the result atomically.
//
// R3.2.2: result passes through the ImageOperationResult legacy
// adapter (validates the 9 contract fields, maps `path` →
// `outputPath`, preserves `path` as legacy alias). Backend is
// 'inpaint' (default; explicit for ONNX-based inpainting).
//
// R1.5b.3: `inpaint:runOnnx` now requires a `grantId` (passed as a
// named field inside `args`, same pattern as R1.5a.5's
// `inpaint:runTelea`). The grant must authorise:
//   - 'read' on srcPath (the source image the AI is editing)
//   - 'write' on outPath (the result; defaults to a sibling of
//     srcPath if not provided)
// A directory grant for dirname(srcPath) covers the src + the
// temp mask file (sibling) + the derived outPath (sibling); a
// file grant for srcPath covers only src (the temp mask +
// outPath would need their own authorisation).
// The legacy `pathUtils.isPathUnderAny` +
// `PathSecurityService.getAllowedRoots` gate has been replaced
// by the grant check. The 3 model management handlers
// (`inpaint:modelsAvailable`, `inpaint:replaceModel`,
// `inpaint:restoreModel`) are unchanged: the model paths are
// fully Main-derived (from a fixed MODELS list +
// `assetPaths.writableAssetsDir()`), and the renderer can't
// influence which files are touched.

const { ipcMain, dialog } = require('electron');
const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const sharp = require('sharp'); // KGO8-009: mask/source dimension check
const assetPaths = require('../../src/assetPaths');
const inpaint = require('../../src/inpaint');
const { MODELS, getModel } = require('../../src/inpaint/modelRegistry');
const { wrapInpaintHandler } = require('./legacyAdapter');
// R1.5b.3: shared grant authoriser (R1.5a.6) replaces the legacy
// path-under-any gate for the renderer's file paths. The grant is
// the source of truth for "is the renderer allowed to invoke
// inpainting on this file?".
const { authorizePath: _authorizePath } = require('./grantAuthorizer');

function bad(msg) { return { ok: false, error: msg }; }

/**
 * @param {{ appRoot: string }} deps
 */
function register(_deps) {
  // inpaint:runOnnx — run LaMa / MI-GAN on the source + mask.
  // R1.5b.3: requires a grantId (passed as args.grantId). The
  // grant must authorise 'read' on srcPath AND 'write' on outPath
  // (or the derived sibling if outPath is omitted). The temp
  // mask file is a sibling of srcPath; a directory grant for
  // dirname(srcPath) covers the src + mask + outPath triplet.
  // R3.2.2: result passes through the ImageOperationResult legacy
  // adapter (validates the 9 contract fields, maps `path` →
  // `outputPath`, preserves `path` as legacy alias).
  ipcMain.handle('inpaint:runOnnx', wrapInpaintHandler(async (_e, args) => {
    if (!args || typeof args !== 'object') return bad('Arguments required.');
    // R1.5b.3: pre-validate the arg shape BEFORE the grant
    // check, so a missing srcPath yields the legacy "Source
    // path required." error (the user-facing surface is
    // unchanged) rather than a grant error.
    const srcPath = args.srcPath;
    if (!srcPath || typeof srcPath !== 'string') return bad('Source path required.');
    if (!args.maskB64 || typeof args.maskB64 !== 'string') return bad('A mask (base64 PNG) is required.');
    const outPath = args.outPath || deriveOutPath(srcPath, '_resynthesized');
    if (typeof outPath !== 'string' || !outPath) return bad('Output path is invalid.');
    // R1.5b.3: authorise srcPath (read) and outPath (write)
    // against the grant. A single grant must cover BOTH paths
    // (a directory grant for their common parent is the
    // natural fit for the "edit + save" use case).
    const grantId = args.grantId;
    if (!grantId || typeof grantId !== 'string') {
      return bad('A grantId is required to invoke inpainting (use a Main-minted grant from the picker or app-output).');
    }
    const srcAuthz = _authorizePath(grantId, 'read', srcPath);
    if (!srcAuthz.ok) {
      return bad(`Source path "${srcPath}" is not authorised by the grant (${srcAuthz.error})`);
    }
    const outAuthz = _authorizePath(grantId, 'write', outPath);
    if (!outAuthz.ok) {
      return bad(`Output path "${outPath}" is not authorised by the grant (${outAuthz.error})`);
    }
    // Write the mask to a temp PNG next to the source (covered
    // by the same directory grant as srcPath). The mask is a
    // child of dirname(srcPath) — if the grant is a directory
    // grant for that parent, the 'write' authorisation on
    // srcPath's parent covers the mask write. If the grant is a
    // file grant for srcPath, the mask write is NOT covered
    // — that's the renderer's responsibility to set up the
    // right grant kind for the workflow.
    const dir = path.dirname(srcPath);
    const maskPath = path.join(dir, '.ie_inpaint_mask_' + randomUUID() + '.png');

    // KGO8-009: reject a mask whose dimensions differ from the source, for
    // the same reason as the Telea handler — inpaint_node.js rescales the
    // mask to the source, so a mismatch silently heals the wrong region and
    // still reports ok:true. Checked before the temp file is written so a
    // rejected call leaves nothing behind.
    // KGO10-001: read the source BYTES — `sharp(srcPath)` keeps the file open
    // (libvips' webp decoder holds the handle), and the editor deletes or
    // replaces the source right after a heal. The Telea handler already does
    // it this way (registerInpaintIpc.js reads srcBuf first); this call was
    // the odd one out.
    const maskBuf = Buffer.from(args.maskB64, 'base64');
    // R3: cap the source read — a multi-GB "image" would OOM the main process
    // (same class as the pipeline:thumb fix). 256 MB matches the other
    // image-source caps in the app. The whole-file read is still required (see
    // KGO10-001: sharp(srcPath) holds the handle), so we stat first and reject.
    const MAX_INPAINT_SOURCE = 256 * 1024 * 1024; // 256 MB
    try {
      const st = await fsp.stat(srcPath);
      if (st.size > MAX_INPAINT_SOURCE) {
        return bad('Source image too large for heal (' + Math.round(st.size / 1048576) + ' MB, cap 256 MB).');
      }
      const mm = await sharp(maskBuf).metadata();
      const sm = await sharp(await fsp.readFile(srcPath)).metadata();
      if (mm.width !== sm.width || mm.height !== sm.height) {
        return bad(`Mask is ${mm.width}×${mm.height} but the image is ${sm.width}×${sm.height} — they must match.`);
      }
    } catch (e) { return bad('Could not read the image or mask: ' + ((e && e.message) || e)); }

    // KGO6-002: actually write the mask to disk. The worker expects
    // this file to exist (inpaint_node.js checks fs.existsSync(mask)).
    await fsp.writeFile(maskPath, maskBuf);

    const r = await inpaint.runOnnx(srcPath, maskPath, outPath, {
      model: args.model || 'migan',
      useGpu: args.useGpu !== false,
      areaShare: args.areaShare,
      jobId: args.jobId,
    });
    // tidy the temp mask
    try { await fsp.unlink(maskPath); } catch (_) {}
    if (!r || !r.ok) return bad((r && r.stderr) || 'inpaint failed');
    return { ok: true, path: outPath };
    // R3.2.2: result passes through `adaptInpaintResult` (validates
    // the 9 contract fields, maps `path` → `outputPath`, preserves
    // `path` as legacy alias). Backend defaults to 'inpaint'
    // (overridable via wrapInpaintHandler(h, backend)).
  }));

  // inpaint:modelsAvailable — list bundled AI models + their on-disk presence,
  // used by the Settings card + the Heal popover's engine picker.
  // Wrapped end-to-end in try/catch (H8-004): the handler used to have NO error
  // handling, so any throw inside (assetPaths.resolveAsset does fs.mkdirSync,
  // findModelPath can throw on a malformed override) rejected the invoke and the
  // renderer overlay hung on "Loading model status…" forever. Now every failure
  // path resolves to { ok:false, error } so the UI can show a Retry button.
  //
  // R1.5b.3: no grant required. The model paths are Main-derived
  // (from a fixed MODELS list + assetPaths.writableAssetsDir()).
  // The renderer can't influence which files are touched.
  ipcMain.handle('inpaint:modelsAvailable', async () => {
    try {
      const out = {};
      // Per-model try: a single broken path must not kill the whole list.
      for (const key of Object.keys(MODELS)) {
        try {
          const m = getModel(key);
          const p = inpaint.findModelPath(m.file);
          const overridePath = assetPaths.resolveAsset('models', m.file);
          const isOverride = !!(p && overridePath && userDataModelsDir() &&
            p.startsWith(userDataModelsDir()) && fs.existsSync(p));
          out[key] = { key, label: m.label, license: m.license, sizeMB: m.sizeMB, file: m.file,
            present: !!p, path: p, bestFor: m.bestFor, isOverride };
        } catch (perModelErr) {
          out[key] = { key, label: key, license: '?', sizeMB: '?', file: '?',
            present: false, path: null, bestFor: '?', isOverride: false,
            error: String((perModelErr && perModelErr.message) || perModelErr) };
        }
      }
      return { ok: true, models: out };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  // inpaint:replaceModel — Settings "Replace file…": let the user pick a newer
  // model file, copy it into the writable override dir (<userData>/assets/models/),
  // and self-test it loads + produces output. A bad file is rejected so the
  // bundled model stays in use. The override transparently shadows the bundled
  // file because resolveAsset() checks the override dir first.
  //
  // R1.5b.3: no grant required. The source file is user-picked
  // via the native Save-As dialog (the dialog itself is the
  // trust gesture per S1 §3 "Starten eines External Tools
  // mit einer Datei benötigt ... einen Read-Grant" — but the
  // dialog-EXPLICIT user gesture overrides the renderer-
  // supplied path contract). The dest is fully Main-derived
  // (assetPaths.writableAssetsDir() + MODELS[m.file]).
  ipcMain.handle('inpaint:replaceModel', async (event, modelKey) => {
    try {
      if (!modelKey || !MODELS[modelKey]) return bad('Unknown model.');
      const m = getModel(modelKey);
      const win = event && event.sender;
      const dlgR = await dialog.showOpenDialog(win, {
        title: 'Replace ' + m.label + ' with a custom ONNX file',
        filters: [{ name: 'ONNX model', extensions: ['onnx'] }],
      });
      if (dlgR.canceled || !dlgR.filePaths || !dlgR.filePaths[0]) return { ok: false, canceled: true };
      const src = dlgR.filePaths[0];
      if (!path.isAbsolute(src)) return bad('Path must be absolute.');
      const destDir = path.join(assetPaths.writableAssetsDir(), 'models');
      await fsp.mkdir(destDir, { recursive: true });
      const dest = path.join(destDir, m.file);
      // copy atomically: tmp + rename
      const tmp = dest + '.tmp-' + randomUUID();
      await copyFileAtomic(src, tmp);
      // PE-023: validate the candidate BEFORE activating. Try to create
      // an ONNX InferenceSession and check the input count matches the
      // model's expected input style. If validation fails, delete the
      // temp and return an error — the existing model stays active.
      const validationErr = await validateOnnxCandidate(tmp, m);
      if (validationErr) {
        try { await fsp.unlink(tmp); } catch (_) {}
        return bad('Model validation failed: ' + validationErr);
      }
      await fsp.rename(tmp, dest);
      return { ok: true, path: dest, file: m.file };
    } catch (e) {
      return bad(String((e && e.message) || e));
    }
  });

  // inpaint:restoreModel — delete the user override so the bundled file is used again.
  //
  // R1.5b.3: no grant required. The deleted file path is fully
  // Main-derived (assetPaths.writableAssetsDir() + MODELS[m.file]).
  // The modelKey is just an opaque identifier from a fixed
  // MODELS list — the renderer can't influence which file is
  // deleted.
  ipcMain.handle('inpaint:restoreModel', async (_e, modelKey) => {
    try {
      if (!modelKey || !MODELS[modelKey]) return bad('Unknown model.');
      const m = getModel(modelKey);
      const override = path.join(assetPaths.writableAssetsDir(), 'models', m.file);
      if (fs.existsSync(override)) await fsp.unlink(override);
      return { ok: true };
    } catch (e) {
      return bad(String((e && e.message) || e));
    }
  });
}

function userDataModelsDir() {
  try { return path.join(assetPaths.writableAssetsDir(), 'models'); } catch (_) { return null; }
}

async function copyFileAtomic(src, dest) {
  const { pipeline } = require('stream').promises;
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await pipeline(fs.createReadStream(src), fs.createWriteStream(dest));
}

function deriveOutPath(srcPath, suffix) {
  const dot = srcPath.lastIndexOf('.');
  const ext = dot >= 0 ? srcPath.slice(dot) : '.png';
  const base = dot >= 0 ? srcPath.slice(0, dot) : srcPath;
  return base + suffix + ext;
}

// PE-023: validate a candidate ONNX model before activating it.
// Creates an InferenceSession and checks the input count matches the
// model's expected input style (concat=1, split-float=2). Returns
// null on success, or an error string on failure.
async function validateOnnxCandidate(modelPath, modelSpec) {
  let ort;
  try {
    ort = require('onnxruntime-node');
  } catch (_) {
    return 'onnxruntime-node not available — cannot validate the model.';
  }
  let session;
  try {
    session = await ort.InferenceSession.create(modelPath, {
      executionProviders: ['cpu'],
      intraOpNumThreads: 1,
      interOpNumThreads: 1,
    });
  } catch (e) {
    return 'failed to create InferenceSession: ' + ((e && e.message) || e);
  }
  try {
    const names = session.inputNames || [];
    const style = modelSpec.inputStyle || 'concat';
    const expectedInputs = (style === 'concat') ? 1 : 2;
    if (names.length < expectedInputs) {
      return 'model expects ' + expectedInputs + ' input(s) (' + style +
        ') but the ONNX session exposes ' + names.length +
        ' (' + JSON.stringify(names) + '). The file may be a different export.';
    }
    return null; // validation passed
  } finally {
    try { await session.release(); } catch (_) {}
  }
}

module.exports = { register };
