// renderer/services/shortcutRegistry.js
// Canonical global shortcut registry used for event handling and UI documentation.

(function () {
  'use strict';

  const GLOBAL_SHORTCUTS = [
    {
      combo: 'Ctrl+Enter',
      key: 'Enter',
      ctrl: true,
      label: 'Ctrl+Enter',
      description: 'Generate on the active tab (same as clicking the big Generate button)',
      shortDescription: 'Generate on the active tab',
      allowInInput: true,
      isAvailable: () => true,
      action: () => {
        const tab = state.currentTab;
        const genBtn = $(`#tab-${tab} .actions button.primary`);
        const tabRunning = !!(window.JobRunner && typeof window.JobRunner.isTabRunning === 'function' && window.JobRunner.isTabRunning(tab));
        if (typeof window.logAction === 'function') {
          window.logAction('shortcut', 'Ctrl+Enter', { tab, tabRunning, btn_state: genBtn ? genBtn.textContent : '(none)' });
        }
        if (genBtn && !tabRunning && state.generating !== tab && genBtn.textContent !== 'Cancel') {
          genBtn.click();
          return true;
        }
        return false;
      }
    },
    {
      combo: 'Ctrl+1 / 2 / 3 / 4 / 5',
      match: (e) => (e.ctrlKey || e.metaKey) && ['1', '2', '3', '4', '5'].includes(e.key),
      label: 'Ctrl+1 / 2 / 3 / 4 / 5',
      description: 'Switch to Image / Speech / Music / Video / Other APIs',
      shortDescription: 'Switch to Image / Speech / Music / Video / Other APIs',
      allowInInput: false,
      isAvailable: () => !document.querySelector('#modal-root .modal, .image-editor-modal'),
      action: (e) => {
        const tabs = ['image', 'speech', 'music', 'video', 'providers'];
        const idx = parseInt(e.key, 10) - 1;
        if (typeof window.logAction === 'function') {
          window.logAction('shortcut', `Ctrl+${parseInt(e.key, 10)}`, { to: tabs[idx] || '(unknown)' });
        }
        if (tabs[idx]) {
          showTab(tabs[idx]);
          return true;
        }
        return false;
      }
    },
    {
      combo: 'Ctrl+B',
      key: 'b',
      ctrl: true,
      label: 'Ctrl+B',
      description: 'Open BatchGen for the active tab (queue multiple prompts to run in sequence)',
      shortDescription: 'Open BatchGen for the active tab',
      allowInInput: false,
      // KGO-004 fix: block when a modal/overlay is open (prevents stacking dialogs).
      isAvailable: () => !document.querySelector('#modal-root .modal, .image-editor-modal, .pipeline-overlay'),
      action: () => {
        if (typeof window.logAction === 'function') window.logAction('shortcut', 'Ctrl+B', { tab: state.currentTab });
        openBatchManager(state.currentTab);
        return true;
      }
    },
    {
      combo: 'Ctrl+F',
      key: 'f',
      ctrl: true,
      label: 'Ctrl+F',
      description: 'Focus the file-browser filter (start typing to filter the file list)',
      shortDescription: 'Focus the file-browser filter',
      allowInInput: false,
      // KGO-004 fix: block when a modal/overlay is open.
      isAvailable: () => !document.querySelector('#modal-root .modal, .image-editor-modal, .pipeline-overlay'),
      action: () => {
        if (typeof window.logAction === 'function') window.logAction('shortcut', 'Ctrl+F');
        const s = $('#fb-search');
        if (s) {
          s.focus();
          s.select();
          return true;
        }
        return false;
      }
    },
    {
      combo: 'Ctrl+P',
      key: 'p',
      ctrl: true,
      label: 'Ctrl+P',
      description: 'Open or focus the Image Pipeline overlay',
      shortDescription: 'Open or focus the Image Pipeline',
      allowInInput: false,
      // KGO-004 fix: block when a modal is open (pipeline overlay is allowed to toggle itself).
      isAvailable: () => !document.querySelector('#modal-root .modal, .image-editor-modal'),
      action: () => {
        if (typeof window.logAction === 'function') window.logAction('shortcut', 'Ctrl+P');
        if (window.Pipeline && typeof window.Pipeline.open === 'function') {
          try {
            window.Pipeline.open();
            return true;
          } catch (err) {
            if (typeof toast === 'function') toast('Pipeline failed to open: ' + ((err && err.message) || err), 'err');
          }
        }
        return false;
      }
    },
    {
      combo: 'Ctrl+E',
      key: 'e',
      ctrl: true,
      label: 'Ctrl+E',
      description: 'Open or focus the Image Editor',
      shortDescription: 'Open or focus the Image Editor',
      allowInInput: false,
      // KGO-004 fix: block when a modal is open (editor is allowed to toggle itself).
      isAvailable: () => !document.querySelector('#modal-root .modal'),
      action: () => {
        if (typeof window.logAction === 'function') window.logAction('shortcut', 'Ctrl+E');
        if (typeof window.showImageEditOverlay === 'function') {
          window.showImageEditOverlay(null, null);
          return true;
        } else {
          if (typeof toast === 'function') toast('Image editor not loaded.', 'err', 4000);
        }
        return false;
      }
    },
    {
      combo: 'Ctrl+S',
      key: 's',
      ctrl: true,
      label: 'Ctrl+S',
      description: 'Open Settings modal',
      shortDescription: 'Open Settings modal',
      allowInInput: false,
      isAvailable: () => !document.querySelector('#modal-root .modal'),
      action: () => {
        if (typeof window.openSettingsModal === 'function') {
          window.openSettingsModal();
          return true;
        }
        const sBtn = $('#btn-settings');
        if (sBtn) { sBtn.click(); return true; }
        return false;
      }
    },
    {
      combo: 'Ctrl+T',
      key: 't',
      ctrl: true,
      label: 'Ctrl+T',
      description: 'Open Style presets modal',
      shortDescription: 'Open Style presets modal',
      allowInInput: false,
      isAvailable: () => !document.querySelector('#modal-root .modal'),
      action: () => {
        const btn = $('#btn-styles');
        if (btn) { btn.click(); return true; }
        return false;
      }
    },
    {
      combo: 'Ctrl+L',
      key: 'l',
      ctrl: true,
      label: 'Ctrl+L',
      description: 'Toggle theme (Light / Dark)',
      shortDescription: 'Toggle theme',
      allowInInput: false,
      isAvailable: () => true,
      action: () => {
        const btn = $('#btn-theme');
        if (btn) { btn.click(); return true; }
        return false;
      }
    },
    {
      combo: 'Ctrl+R',
      key: 'r',
      ctrl: true,
      label: 'Ctrl+R',
      description: 'Refresh API quota',
      shortDescription: 'Refresh API quota',
      allowInInput: false,
      isAvailable: () => true,
      action: () => {
        if (typeof window.refreshQuota === 'function') {
          window.refreshQuota();
          return true;
        }
        return false;
      }
    },
    {
      combo: 'Ctrl+U',
      key: 'u',
      ctrl: true,
      label: 'Ctrl+U',
      description: 'Navigate up one level in file browser',
      shortDescription: 'Navigate up in file browser',
      allowInInput: false,
      isAvailable: () => !document.querySelector('#modal-root .modal'),
      action: () => {
        const upBtn = $('#fb-up');
        if (upBtn && !upBtn.disabled) { upBtn.click(); return true; }
        return false;
      }
    }
  ];

  function getDocumentationList() {
    return GLOBAL_SHORTCUTS.map((s) => [s.label, s.description]);
  }

  function getSettingsList() {
    return GLOBAL_SHORTCUTS.map((s) => [s.label, s.shortDescription]);
  }

  function handleKeyEvent(e) {
    if (window.ShortcutScope && window.ShortcutScope.isGlobalSuppressed()) return false;
    if (!e.key) return false;

    const target = e.target;
    const isInput = target && (
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.tagName === 'SELECT' ||
      target.isContentEditable
    );

    const cmd = e.ctrlKey || e.metaKey;
    const keyLower = e.key.toLowerCase();

    for (const item of GLOBAL_SHORTCUTS) {
      if (isInput && !item.allowInInput) continue;
      if (typeof item.isAvailable === 'function' && !item.isAvailable()) continue;

      const wantShift = !!item.shift;
      const wantAlt = !!item.alt;
      if (!!e.shiftKey !== wantShift || !!e.altKey !== wantAlt) continue;

      let matched = false;
      if (typeof item.match === 'function') {
        matched = item.match(e);
      } else if (item.ctrl && cmd && keyLower === item.key.toLowerCase()) {
        matched = true;
      }

      if (matched) {
        const handled = item.action(e);
        if (handled) {
          e.preventDefault();
          return true;
        }
      }
    }
    return false;
  }

  window.GlobalShortcutRegistry = {
    shortcuts: GLOBAL_SHORTCUTS,
    getDocumentationList,
    getSettingsList,
    handleKeyEvent
  };
})();
