// renderer/sections/section01_Diagnose_dialog.js
// Diagnose dialog

// ----------------- Diagnose dialog -----------------
// Read-only diagnostic dump that walks the user through what the
// app sees on their machine: platform, Electron + Node versions,
// the node.exe and CLI entry it found, API key presence, region.
// Opened from the "Diagnose" button in ⚙ Settings → General.
// Useful when "Test connection" fails and the user wants to know
// which prerequisite is missing (e.g. mmx-cli not installed,
// node.js not on PATH, wrong region).
function showDiagnose() {
  showModal(async (m, close) => {
    m.appendChild(el('h2', {}, 'Diagnose'));
    m.appendChild(el('p', { style: 'color: var(--fg-2); font-size: 12px; margin-top: 0;' },
      'Shows what the app sees on your machine. Useful when "Test connection" fails — copy the output and share it with support if you need help.'));
    const box = el('pre', { style: 'background: var(--bg-3); padding: 10px; border-radius: var(--radius); font-size: 12px; white-space: pre-wrap; max-height: 50vh; overflow: auto;' }, 'Loading…');
    m.appendChild(box);

    const d = await window.api.diagnose();
    const lines = [
      `Platform:               ${d.platform}`,
      `Electron version:       ${d.electronVersion}`,
      `Node version:           ${d.nodeVersion}`,
      `Detected node.exe:      ${d.nodePath || '(NOT FOUND)'}`,
      `Detected mmx-cli entry: ${d.mmxEntry || '(NOT FOUND)'}`,
      `Region:                 ${d.region || 'global'}`,
      `API key present:        ${d.apiKeyPresent ? 'yes' : 'no'}`,
      `API key length:         ${d.apiKeyLength} chars`,
      '',
      d.error ? '⚠ ' + d.error : '✓ All prerequisites found.',
    ];
    box.textContent = lines.join('\n');

    // Concurrency hint. When the user has multiple jobs in flight,
    // the profile fetch tells us whether the upstream exposes a hard
    // concurrentLimit. Surface a coloured hint (recommendation, not a
    // hard block). If the upstream doesn't expose concurrentLimit,
    // show a neutral message; do NOT invent a number.
    if (window.api.mmxProfile) {
      const hintBox = el('div', {
        id: 'diagnose-concurrency-hint',
        style: 'margin-top: 12px; padding: 10px; border-radius: var(--radius); font-size: 12px; background: var(--bg-2); border: 1px solid var(--border);',
      }, 'Checking plan concurrency…');
      m.appendChild(hintBox);
      window.api.mmxProfile().then((profile) => {
        try {
          const m0 = (window.JobRunner && typeof window.JobRunner.activeJobs === 'function')
            ? window.JobRunner.activeJobs().length : 0;
          if (!profile || !profile.ok) {
            hintBox.textContent = 'Plan concurrency: unknown (no quota response).';
            hintBox.style.color = 'var(--fg-3)';
            return;
          }
          if (profile.concurrentLimit == null) {
            hintBox.textContent = 'Plan concurrency: parallel mode is enabled; the upstream may throttle you. If generations are slow, switch to sequential in Settings.';
            hintBox.style.color = 'var(--fg-2)';
            return;
          }
          const limit = profile.concurrentLimit;
          const planType = profile.planType ? ` (${profile.planType})` : '';
          if (m0 > limit) {
            hintBox.innerHTML = '';
            hintBox.appendChild(document.createTextNode(`Plan concurrency: ${limit}${planType}. You currently have ${m0} running. `));
            const seq = el('button', { class: 'btn-mini' }, 'Switch to sequential');
            seq.addEventListener('click', async () => {
              // Best-effort: try to open Settings. The actual setting
              // is in section03 (Settings tab panes). We just toast
              // for now.
              if (window.toast) window.toast('Open Settings → Generation to switch to sequential mode.', 'info', 4000);
            });
            hintBox.appendChild(seq);
            hintBox.style.background = 'rgba(255, 87, 87, 0.10)';
            hintBox.style.borderColor = 'var(--danger)';
          } else {
            hintBox.textContent = `Plan concurrency: ${limit}${planType}. You currently have ${m0} running.`;
            hintBox.style.color = 'var(--fg-2)';
          }
        } catch (e) {
          hintBox.textContent = 'Plan concurrency: error reading profile.';
          hintBox.style.color = 'var(--danger)';
        }
      }).catch(() => {
        hintBox.textContent = 'Plan concurrency: profile fetch failed.';
        hintBox.style.color = 'var(--fg-3)';
      });
    }

    if (d.nodePath && d.mmxEntry) {
      const test = el('button', { class: 'btn-mini' }, 'Run real quota test');
      m.appendChild(el('div', { style: 'margin-top: 12px;' }, test));
      const out = el('pre', { style: 'background: var(--bg-3); padding: 10px; border-radius: var(--radius); font-size: 12px; white-space: pre-wrap; max-height: 200px; overflow: auto; margin-top: 8px; display: none;' });
      m.appendChild(out);
      test.addEventListener('click', async () => {
        test.disabled = true; test.innerHTML = '<span class="spinner"></span> Running…';
        out.style.display = 'block';
        out.textContent = 'Running quota check…\n';
        const r = await window.api.authStatus();
        out.textContent += `exit code: ${r.code ?? 'n/a'}\n`;
        out.textContent += `ok flag:   ${r.ok}\n`;
        if (r.canceled) out.textContent += `canceled:  true\n`;
        out.textContent += `error:     ${r.error || '(none)'}\n`;
        out.textContent += `command:   ${r.command || '(none)'}\n`;
        // Defense-in-depth (H7-013): never print raw argv. The main process
        // already returns a redacted argv, but redact again here so a future
        // IPC change can't leak the key into the Diagnose output the user
        // might copy-paste into a support request.
        if (r.argv) {
          const safe = r.argv.map((a, i) => (i > 0 && r.argv[i - 1] === '--api-key') ? '***' : a);
          out.textContent += `argv:      ${safe.join(' ')}\n`;
        }
        test.disabled = false; test.textContent = 'Run real quota test';
      });
    }

    m.appendChild(el('div', { class: 'footer' }, el('button', { onclick: close }, 'Close')));
  });
}

// showHelp is defined in renderer/sections/section23_Centralized_help_system.js
// (where the centralized help modal lives), along with the
// `window.showHelp = showHelp` export. It is intentionally NOT
// re-exported here — a bare `showHelp` reference would throw a
// ReferenceError at load time. section23 handles it.

