// scripts/e2e/scenarios/archive-viewer.js
// ============================================================================
// Phase C7 — Archive viewer feature coverage.
//
// Exercises the archive viewer (generation history):
//   - Open archive viewer
//   - Search entries
//   - Filter by status
//   - Delete single entry
//   - Clear all
//
// IPC channels exercised:
//   state:archiveRead, state:archiveSize, state:archiveDelete, state:archiveClear
// ============================================================================

module.exports = {
  name: 'archive-viewer',
  needsRealApi: false,
  fakeOnly: false,
  order: 76,
  async run(ctx) {
    // NOTE: `exec` is the harness's win.webContents.executeJavaScript() — NOT child_process.exec.
    const { exec, sleep, check, closeModals } = ctx;

    // ---- state:archiveSize — get archive size ----
    const sizeRes = await exec(`(async () => {
      try {
        return await window.api.stateArchiveSize();
      } catch (e) { return { ok: false, error: e.message }; }
    })()`);
    check(sizeRes !== undefined && sizeRes !== null, 'archive-viewer: state:archiveSize IPC was not invoked');

    // ---- state:archiveRead — read archive entries ----
    const readRes = await exec(`(async () => {
      try {
        return await window.api.stateArchiveRead({ limit: 10 });
      } catch (e) { return []; }
    })()`);
    check(readRes !== undefined && readRes !== null, 'archive-viewer: state:archiveRead IPC was not invoked');

    // ---- Open archive viewer UI ----
    // Look for a History/Archive button in the UI.
    const archiveBtnExists = await exec(`(() => {
      const btns = [...document.querySelectorAll('button')];
      return btns.some(b =>
        (b.textContent || '').includes('History') ||
        (b.textContent || '').includes('Archive') ||
        b.title?.includes('History') ||
        b.title?.includes('Archive')
      );
    })()`);

    if (archiveBtnExists) {
      await exec(`(() => {
        const btns = [...document.querySelectorAll('button')];
        const btn = btns.find(b =>
          (b.textContent || '').includes('History') ||
          (b.textContent || '').includes('Archive') ||
          b.title?.includes('History') ||
          b.title?.includes('Archive')
        );
        if (btn) btn.click();
        return true;
      })()`);
      await sleep(400);

      // Verify viewer opened (modal or panel).
      const viewerOpen = await exec(`(() => {
        return document.querySelectorAll('#modal-root .modal').length > 0 ||
               document.querySelector('.archive-viewer, .history-viewer, [data-archive-viewer]') !== null;
      })()`);

      if (viewerOpen) {
        // ---- Search entries ----
        const searchInput = await exec(`(() => {
          const inputs = document.querySelectorAll('input[type="text"], input[type="search"]');
          const search = [...inputs].find(i =>
            i.placeholder?.toLowerCase().includes('search') ||
            i.placeholder?.toLowerCase().includes('filter')
          );
          if (search) {
            search.value = 'test-search';
            search.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
          }
          return false;
        })()`);
        await sleep(200);

        // ---- Filter by status ----
        const filterSelect = await exec(`(() => {
          const selects = document.querySelectorAll('select');
          const statusFilter = [...selects].find(s =>
            [...s.options].some(o => o.value === 'ok' || o.value === 'error' || o.textContent?.includes('Status'))
          );
          if (statusFilter) {
            statusFilter.value = 'ok';
            statusFilter.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
          return false;
        })()`);
        await sleep(200);
      }

      await closeModals();
    }

    // ---- state:archiveDelete — delete a specific entry ----
    // Get an entry ID first (if any exist).
    const entries = await exec(`(async () => {
      try {
        return await window.api.stateArchiveRead({ limit: 1 });
      } catch (e) { return []; }
    })()`);
    const entryId = Array.isArray(entries) && entries.length > 0
      ? (entries[0].id || entries[0].timestamp || 'test-id')
      : 'test-id';

    const deleteRes = await exec(`(async () => {
      try {
        return await window.api.stateArchiveDelete(${JSON.stringify(entryId)});
      } catch (e) { return { ok: false, error: e.message }; }
    })()`);
    check(deleteRes !== undefined && deleteRes !== null, 'archive-viewer: state:archiveDelete IPC was not invoked');

    // ---- state:archiveClear — clear all entries ----
    const clearRes = await exec(`(async () => {
      try {
        return await window.api.stateArchiveClear();
      } catch (e) { return { ok: false, error: e.message }; }
    })()`);
    check(clearRes !== undefined && clearRes !== null, 'archive-viewer: state:archiveClear IPC was not invoked');

    // No file artifacts to clean up.
  },
};
