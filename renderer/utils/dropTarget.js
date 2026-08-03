// renderer/utils/dropTarget.js
// Drag-and-drop target setup for the file browser.

/**
 * Mark an element as a drag-and-drop target. When a file (or ".." entry)
 * from the file browser is dropped on it, it is moved to `destDir`.
 * Highlights the element visually during drag-over.
 *
 * Expects `window.toast` (ToastService) and `window.refreshBrowser`.
 *
 * @param {HTMLElement} elNode  The target element (e.g. a directory-list entry)
 * @param {string} destDir      Destination directory (absolute path)
 */
function attachDropTarget(elNode, destDir) {
  if (!elNode || !destDir) return;
  elNode.addEventListener('dragover', (e) => {
    // Only accept our internal MIME type; ignore OS file drops.
    if (Array.from(e.dataTransfer.types || []).includes('application/x-minimax-fb')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      elNode.classList.add('fb-drop-target');
    }
  });
  elNode.addEventListener('dragleave', () => {
    elNode.classList.remove('fb-drop-target');
  });
  elNode.addEventListener('drop', async (e) => {
    e.preventDefault();
    elNode.classList.remove('fb-drop-target');
    const path = e.dataTransfer.getData('application/x-minimax-fb');
    if (!path) return;
    if (path.toLowerCase() === destDir.toLowerCase()) return;
    // Refuse to move a folder into itself or any descendant.
    const pLow = path.replace(/[\\/]+$/, '').toLowerCase();
    const dLow = destDir.replace(/[\\/]+$/, '').toLowerCase();
    if (dLow.startsWith(pLow + (destDir.includes('\\') ? '\\' : '/'))) {
      if (window.ToastService) window.ToastService.show('Cannot move a folder into itself.', { type: 'warn' });
      return;
    }
    // BGR-009 fix: mint move grant (R1.3 gate).
    // gewv2 GEW-002 fix: ensureMove returns { ok, srcGrant, destGrant }.
    const mv = (window.GrantHelper) ? await window.GrantHelper.ensureMove(path, destDir) : undefined;
    // B-007 (hhhhu3 audit): move needs a one-shot intent token minted by
    // the native confirmation (window.FbIntent).
    const r = await window.FbIntent.move(path, destDir, mv && mv.srcGrant, mv && mv.destGrant);
    if (window.FbIntent.isCanceled(r)) return; // user declined the native confirmation
    if (r.ok) {
      if (window.ToastService) window.ToastService.show('Moved.', { type: 'ok' });
      if (typeof window.refreshBrowser === 'function') await window.refreshBrowser();
    } else {
      if (window.ToastService) window.ToastService.show('Move failed: ' + (r.error || 'unknown error'), { type: 'err' });
    }
  });
}

window.DropTarget = { attachDropTarget };
