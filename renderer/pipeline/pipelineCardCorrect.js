// Pipeline Crop-column editor round-trip. Kept separate from pipelineCard.js
// because it is an async I/O bridge, not card-rendering logic.
(function () {
  function correctInEditor(item, column) {
    const current = item.files[column];
    if (!current || typeof window.showImageEditOverlay !== 'function') {
      PipelineBoard.toast('Image editor is unavailable.', 'err');
      return;
    }
    window.showImageEditOverlay(current, [current], {
      saveLabel: '💾 Save to pipeline',
      modalId: 'pipeline-correct-' + item.id,
      hideExternal: true,
      onSaveOverride: async (b64, fmt) => {
        const ext = fmt === 'jpeg' ? 'jpg' : fmt;
        const folder = current.replace(/[\\/][^\\/]+$/, '');
        const sep = folder.includes('\\') ? '\\' : '/';
        const temp = folder + sep + '.correct-' + item.id + '-' + Date.now() + '.' + ext;
        try {
          const write = window.api.writeImageBase64 || window.api.fbWrite;
          // QA-002 fix: mint the required write grant before saving (R1.3 gate).
          const writeGrant = (window.GrantHelper) ? await window.GrantHelper.ensureWrite(temp) : undefined;
          const written = await write(temp, b64, writeGrant);
          if (!written || !written.ok) throw new Error((written && written.error) || 'Could not save corrected image.');
          const res = await window.api.pipelineReplace({
            srcAbsPath: temp, workspaceId: window.state.pipeline.image.workspaceId, column,
            imageId: item.id, displayName: (item.name || 'image') + '.' + ext,
          });
          if (!res || !res.ok || !res.dst) throw new Error((res && res.error) || 'Could not place corrected image.');
          item.files[column] = res.dst;
          item.history.push({ action: 'correct', column, file: res.dst, ts: Date.now() });
          PipelineBoard.save();
          PipelineBoard.updateCard(item);
          return res.dst;
        } finally {
          // BGR-009 fix: mint delete grant for temp cleanup (R1.3 gate).
          const delGrant = (window.GrantHelper) ? await window.GrantHelper.ensureDelete(temp) : undefined;
          // B-007 (hhhhu3 audit): delete via native confirmation (window.FbIntent).
          window.FbIntent.del(temp, delGrant).catch(() => {});
        }
      },
      onSaved: () => {
        PipelineBoard.toast('Corrected image saved to pipeline.', 'ok');
        const editor = window.__ieCtrl;
        // PE-007: route through the idempotent requestClose (saved → skip
        // the dirty-confirm; dispose/prefs/cleanup still run exactly once).
        if (editor && typeof editor.requestClose === 'function') editor.requestClose('pipeline-save', { saved: true });
        else if (editor && typeof editor.close === 'function') editor.close();
      },
    });
  }
  window.PipelineCardCorrect = { correctInEditor };
})();
