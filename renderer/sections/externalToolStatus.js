// renderer/sections/externalToolStatus.js
// Extracted H10-7: status label + probe helper for the Settings → Add-ons
// external-tool editor.
//
// The Add-ons editor previously showed the Test button's result as a 2-second
// flash on the button label itself, which was unreadable. This helper builds a
// persistent status <div> below the inputs/buttons and writes the probe result
// (✓ Found <path> (<size>) / ✗ Not found / ✗ <error>) into it. It also probes
// the in-memory draft path directly (via the `exe` override on
// externalTools:probe) so the Test button works BEFORE the tool is saved.
//
// Kept as a standalone module so section03_Settings_tab_panes.js stays within
// its frozen size budget.

(function () {
  'use strict';

  // Build a status label element and return it plus a small API.
  //   setStatusOk(r, exePath)   — write a probe result into the label
  //   setStatusErr(msg)         — write an error message into the label
  //   probeAndShow(exePath)     — probe one exe path (string) and display it
  function create() {
    const statusLbl = el('div', {
      class: 'external-tool-status',
      style: 'font-size: 11px; color: var(--fg-3); margin-top: 2px; min-height: 14px; word-break: break-all;',
    }, '');

    function setStatusOk(r, exePath) {
      const ok = 'var(--ok, #4caf50)';
      const danger = 'var(--danger, #e53935)';
      if (r && r.ok && r.exists && r.isFile) {
        const kb = (typeof r.size === 'number') ? (r.size / 1024).toFixed(0) + ' KB' : '';
        statusLbl.textContent = '✓ Found: ' + (r.path || exePath) + (kb ? ' (' + kb + ')' : '');
        statusLbl.style.color = ok;
      } else if (r && r.ok && r.exists === false) {
        statusLbl.textContent = '✗ Not found: ' + (r.path || exePath);
        statusLbl.style.color = danger;
      } else {
        statusLbl.textContent = '✗ ' + ((r && r.error) ? String(r.error) : 'No .exe set.');
        statusLbl.style.color = danger;
      }
    }

    function setStatusErr(msg) {
      statusLbl.textContent = '✗ ' + String(msg || 'Error.');
      statusLbl.style.color = 'var(--danger, #e53935)';
    }

    async function probeAndShow(exePath) {
      const trimmed = (exePath || '').trim();
      try {
        const payload = trimmed ? { exe: trimmed } : { name: '' };
        const r = await window.api.externalToolsProbe(payload);
        setStatusOk(r, trimmed);
      } catch (e) {
        setStatusErr(String((e && e.message) || e));
      }
    }

    return { statusLbl, setStatusOk, setStatusErr, probeAndShow };
  }

  window.ExternalToolStatus = { create };
})();
