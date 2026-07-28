// renderer/overlays/imageOverlayContextMenu.js
// Extracted H10-2.2: the right-click "Save to…" context menu shown on the
// image-viewer overlay.
//
// Previously the menu only closed on a document `click` registered via
// setTimeout, so a right-click, a scroll, or a keypress could leave it
// stuck on screen. Now it dismisses on ANY interaction outside the menu
// (click, mousedown, contextmenu, wheel, keydown) and tears itself down
// the moment the save item is clicked (before the native Save-As dialog
// opens), so it reliably disappears.
//
// Kept as a standalone module so musicTab.js (the image-viewer host) stays
// within its frozen size budget.

(function () {
  'use strict';

  /**
   * Build + show the "Save to…" context menu at the event's coordinates.
   *
   * @param {string} filePath   the image file to save
   * @param {Event}  e          the triggering contextmenu event
   * @param {(fn:Function)=>void} setCloseFn  the host stores the menu's
   *        close() so its own close()/Esc path can tear it down too
   */
  function showSaveMenu(filePath, e, setCloseFn) {
    e.preventDefault();
    e.stopPropagation();
    const menu = el('div', { class: 'custom-context-menu' });
    const saveItem = el('div', { class: 'custom-context-menu-item' }, '💾 Save to…');
    // Tear the menu down (and unregister its listeners) the moment the user
    // clicks the save item, before opening the native dialog.
    saveItem.addEventListener('click', (ev) => {
      ev.stopPropagation();
      closeMenu();
      window.api.fileSaveAs(filePath).then((r) => {
        if (r && r.ok) {
          if (typeof toast === 'function') toast('Image saved successfully.', 'ok');
        } else if (r && r.error) {
          if (typeof toast === 'function') toast('Save failed: ' + r.error, 'err');
        }
      }).catch((err) => {
        if (typeof toast === 'function') toast('Save failed: ' + err.message, 'err');
      });
    });
    menu.appendChild(saveItem);
    document.body.appendChild(menu);
    // Clamp after insertion so the actual menu dimensions are known.
    menu.style.left = Math.max(4, Math.min(e.clientX, window.innerWidth - menu.offsetWidth - 4)) + 'px';
    menu.style.top = Math.max(4, Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 4)) + 'px';

    const isOutside = (evt) => {
      const t = evt.target;
      return !(t && (t === menu || menu.contains(t)));
    };
    // Capture-phase listeners so we see the event before the menu's own handlers.
    const onOutside = (evt) => { if (isOutside(evt)) closeMenu(); };
    function closeMenu() {
      menu.remove();
      document.removeEventListener('click', closeMenu);
      document.removeEventListener('mousedown', onOutside, true);
      document.removeEventListener('contextmenu', onOutside, true);
      document.removeEventListener('wheel', onOutside, true);
      document.removeEventListener('keydown', onOutside, true);
      if (typeof setCloseFn === 'function') setCloseFn(() => {});
    }
    if (typeof setCloseFn === 'function') setCloseFn(closeMenu);
    document.addEventListener('click', closeMenu);
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('contextmenu', onOutside, true);
    document.addEventListener('wheel', onOutside, true);
    document.addEventListener('keydown', onOutside, true);
  }

  window.ImageOverlayContextMenu = { showSaveMenu };
})();
