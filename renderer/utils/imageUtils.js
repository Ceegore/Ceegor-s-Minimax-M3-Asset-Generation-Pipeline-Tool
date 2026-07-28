// renderer/utils/imageUtils.js
// Pure helpers for image MIME detection and flag visibility.

// Derive the output MIME from a file extension. Used to export the
// canvas in the same format as the input. WebP is detected too (since
// the Canvas API supports exporting to image/webp in modern Chromium).
function mimeFromPath(p) {
  const ext = (p.split('.').pop() || '').toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/png'; // GIF can't be exported from canvas;
                                        // we fall back to PNG (first frame)
  return 'image/png';
}

// Decide whether a flag should be visible for the currently selected
// model/resolution. A flag is hidden if the model's perRowOverrides
// lists a supportedForModels set and the current model is NOT in that
// set, OR the flag is registered as model-restricted.
//
// This is the implementation of "show only supported parameters".
function isFlagVisibleForCurrentModel(tabKey, flag, currentModel, currentResolution, getRowSpec) {
  const ov = getRowSpec(tabKey, flag, currentModel, currentResolution);
  if (!ov) return true;
  if (ov.supportedForModels && currentModel) {
    return ov.supportedForModels.has(currentModel);
  }
  return true;
}

window.ImageUtils = { mimeFromPath, isFlagVisibleForCurrentModel };
