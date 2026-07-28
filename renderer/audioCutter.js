// renderer/audioCutter.js
// The "✂ Audio cut…" modal — the renderer half of the audio-trim feature.
// Entry point: the right-click "✂ Audio cut…" menu (fileBrowser2b.js)
// and the bulk "✂ Trim" toolbar button (app.js) both call
// window.showAudioCutter(path). The main-process backend
// (audio:probe / decodePeaks / findZeroCrossing / trimSilence / cut)
// lives elsewhere; this module draws the waveform UI and wires it to
// that backend.
//
// What it does:
//   - probes the file (duration / codec / sample-rate / channels),
//   - decodes a downsampled peak list and draws a mirror waveform on a
//     <canvas>,
//   - lets the user set a start + end selection by dragging on the
//     waveform or dragging the two markers, or by typing m:ss.mmm times,
//   - previews the selection with an <audio> element (play / stop, with
//     a moving play cursor),
//   - offers a one-click "Auto-detect silence" that calls trimSilence,
//   - exports the trimmed range via audio:cut (optional micro-fade to
//     mask edge clicks; optional lossless stream-copy), then refreshes
//     the folder browser so the new file appears.
//
// Everything is best-effort and non-throwing: any backend failure shows
// the inline .ac-error banner / a toast instead of rejecting.

(function () {
  const el = window.el || window.createElement || ((t) => document.createElement(t));

  // ---- small helpers ----------------------------------------------------
  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    const ms = Math.round((sec - Math.floor(sec)) * 1000);
    return `${m}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
  }
  // Parse "m:ss.mmm", "ss.mmm", or a bare seconds number. Accept at
  // most ONE colon: an input like "1:2:3" is rejected with NaN so the
  // input field's onChange handler can surface an "invalid format"
  // error (splitting on every ':' and taking parts[0]/parts[1] would
  // silently swallow the extra segment).
  function parseTime(str) {
    if (str == null) return NaN;
    str = String(str).trim();
    if (!str) return NaN;
    if (str.includes(':')) {
      const parts = str.split(':');
      if (parts.length > 2) return NaN; // too many colons
      const m = parseFloat(parts[0]);
      const s = parseFloat(parts[1]);
      if (!isFinite(m) || !isFinite(s)) return NaN;
      return m * 60 + s;
    }
    const v = parseFloat(str);
    return isFinite(v) ? v : NaN;
  }
  function baseName(p) {
    const s = String(p || '').replace(/\\/g, '/');
    const i = s.lastIndexOf('/');
    return i >= 0 ? s.slice(i + 1) : s;
  }
  function dirName(p) {
    const s = String(p || '');
    const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return i >= 0 ? s.slice(0, i) : '';
  }
  function extOf(name) {
    const b = baseName(name);
    const i = b.lastIndexOf('.');
    return i > 0 ? b.slice(i + 1).toLowerCase() : '';
  }
  function stripExt(name) {
    const b = baseName(name);
    const i = b.lastIndexOf('.');
    return i > 0 ? b.slice(0, i) : b;
  }
  function joinPath(dir, name) {
    if (!dir) return name;
    const sep = dir.includes('\\') ? '\\' : '/';
    return dir.replace(/[\\/]+$/, '') + sep + name;
  }
  const toast = (m, k, ms) => (typeof window.toast === 'function' ? window.toast(m, k, ms) : undefined);
  // Single-line breadcrumb helpers for the audio-cut modal.
  const _logAct = (act, det) => { if (typeof window.logAction === 'function') window.logAction('audio-cut', act, det); };
  const _logWarn = (act, det) => { if (typeof window.logWarn === 'function') window.logWarn('audio-cut', act, det); };

  async function showAudioCutter(srcPath) {
    if (!srcPath) { toast('No file selected.', 'warn'); return; }
    if (typeof showModal !== 'function') { toast('Modal system not available.', 'err'); return; }
    if (!window.api || typeof window.api.audioProbe !== 'function') {
      _logWarn('open-failed', 'audio tools unavailable');
      toast('Audio tools are not available in this build.', 'err');
      return;
    }
    _logAct('open', { src: srcPath });

    // R7.5 (S1 §6 R1.5a): the audio IPC handlers (audio:probe, audio:decodePeaks,
    // audio:trimSilence, audio:cut, audio:autocutDetect) are grant-gated. Mint a
    // directory grant on the source file's folder — read for probe/decode/trim,
    // write for the cut output which lands beside the source (joinPath(dirName(src),
    // outName)). A plain directory grant (strict descendants) covers both the source
    // and the sibling output; coversRoot is not needed. ensurePathGrant returns the
    // grantId, or an {ok:false} envelope (no throw) on mint failure.
    let audioGrant;
    if (window.api && typeof window.api.mintGrant === 'function' && window.GrantCache) {
      audioGrant = await window.GrantCache.ensurePathGrant(
        window.api.pathDirname(srcPath), 'read',
        { kind: 'directory', capabilities: ['read', 'write'] }
      );
      if (audioGrant && audioGrant.ok === false) {
        _logWarn('open-failed', 'audio grant: ' + (audioGrant.error || 'mint failed'));
        toast('Audio access grant failed: ' + (audioGrant.error || 'unknown'), 'err');
        return;
      }
    }

    showModal((m, close) => {
      m.classList.add('audio-cutter-modal');
      // ---- header + meta ----
      m.appendChild(el('h2', {}, ['✂ Audio cut', el('span', { class: 'ac-status', id: '' }, '')]));
      const meta = el('div', { class: 'ac-meta' }, [
        el('span', { class: 'ac-filename' }, baseName(srcPath)),
      ]);
      m.appendChild(meta);
      const errBox = el('div', { class: 'ac-error' }, '');
      m.appendChild(errBox);
      const showErr = (msg) => { errBox.textContent = msg; errBox.style.display = msg ? 'block' : 'none'; };
      // ---- waveform stage ----
      const stage = el('div', { class: 'ac-stage' });
      const canvas = el('canvas', { class: 'ac-canvas' });
      const selOverlay = el('div', { class: 'ac-sel-overlay' });
      const playCursor = el('div', { class: 'ac-play-cursor' });
      const mStart = el('div', { class: 'ac-marker ac-marker-start' }, [el('div', { class: 'ac-marker-handle' })]);
      const mEnd = el('div', { class: 'ac-marker ac-marker-end' }, [el('div', { class: 'ac-marker-handle' })]);
      stage.append(canvas, selOverlay, mStart, mEnd, playCursor);
      m.appendChild(stage);

      // ---- time row ----
      const startInp = el('input', { type: 'text', class: 'ac-time-inp', value: '0:00.000' });
      const endInp = el('input', { type: 'text', class: 'ac-time-inp', value: '0:00.000' });
      const selLabel = el('span', { class: 'ac-playtime' }, '');
      m.appendChild(el('div', { class: 'ac-time-row' }, [
        el('label', {}, 'Start'), startInp,
        el('label', {}, 'End'), endInp,
        selLabel,
      ]));

      // ---- tool row (play / stop / auto-silence / reset) ----
      const playBtn = el('button', { class: 'btn-mini', type: 'button' }, '▶ Play selection');
      const stopBtn = el('button', { class: 'btn-mini', type: 'button' }, '■ Stop');
      const silenceBtn = el('button', { class: 'btn-mini', type: 'button', title: 'Auto-detect leading / trailing silence and set the markers' }, '✨ Auto-trim silence');
      const resetBtn = el('button', { class: 'btn-mini', type: 'button', title: 'Reset the selection to the whole file' }, '↺ Whole file');
      const playtime = el('span', { class: 'ac-playtime' }, '');
      m.appendChild(el('div', { class: 'ac-tool-row' }, [playBtn, stopBtn, silenceBtn, resetBtn, playtime]));
      // ---- export row ----
      const fadeCb = el('input', { type: 'checkbox' });
      fadeCb.checked = true;
      const fadeMsInp = el('input', { type: 'number', class: 'ac-fade-ms', value: '5', min: '0', max: '200', step: '1', title: 'Fade length in milliseconds applied to both edges' });
      const losslessCb = el('input', { type: 'checkbox', title: 'Stream-copy without re-encoding (faster, lossless, but cut points snap to the nearest keyframe so they may be slightly off)' });
      const fmtSel = el('select', { class: 'ac-format', title: 'Output container / codec' });
      const srcExt = extOf(srcPath) || 'mp3';
      for (const f of ['(keep source)', 'mp3', 'wav', 'flac', 'ogg', 'm4a', 'opus']) {
        if (f !== '(keep source)' && f === srcExt) continue;
        const v = f === '(keep source)' ? srcExt : f;
        fmtSel.appendChild(el('option', { value: v }, f === '(keep source)' ? `Keep source (.${srcExt})` : `.${f}`));
      }
      const nameInp = el('input', { type: 'text', class: 'ac-name-inp', value: `${stripExt(srcPath)}_trim.${srcExt}` });
      const exportBtn = el('button', { class: 'primary', type: 'button' }, '✂ Export trimmed clip');
      m.appendChild(el('div', { class: 'ac-tool-row' }, [
        el('label', {}, [fadeCb, 'Fade edges']), fadeMsInp, el('span', {}, 'ms'),
        el('label', {}, [losslessCb, 'Lossless (stream copy)']),
      ]));
      m.appendChild(el('div', { class: 'ac-exp-row' }, [
        el('label', {}, 'Format'), fmtSel,
        el('label', {}, 'Save as'), nameInp,
        el('span', { class: 'ac-ctrl-spacer' }),
        exportBtn,
      ]));

      // ---- Auto-cut configuration ----
      const acSettings = (window.state && window.state.autoCutSettings) || {
        thresholdDb: -35,
        minSilenceMs: 250,
        minSegmentSec: 0.15,
        maxSegmentSec: 3.0,
        longSegmentPolicy: 'truncate',
        padMs: 25,
        maxSegments: 20,
        fade: true,
        format: 'wav',
      };

      const acThresh = el('input', { type: 'number', style: 'width: 50px;', value: acSettings.thresholdDb, min: '-80', max: '-10', step: '1' });
      const acGap = el('input', { type: 'number', style: 'width: 60px;', value: acSettings.minSilenceMs, min: '50', step: '10' });
      const acMinLen = el('input', { type: 'number', style: 'width: 50px;', value: acSettings.minSegmentSec, min: '0.01', step: '0.05' });
      const acMaxLen = el('input', { type: 'number', style: 'width: 50px;', value: acSettings.maxSegmentSec, min: '0', step: '0.1', title: '0 = unlimited' });
      const acPolicy = el('select', { style: 'width: 80px;' }, [
        el('option', { value: 'truncate' }, 'truncate'),
        el('option', { value: 'skip' }, 'skip'),
        el('option', { value: 'split' }, 'split'),
      ]);
      acPolicy.value = acSettings.longSegmentPolicy;
      const acPad = el('input', { type: 'number', style: 'width: 50px;', value: acSettings.padMs, min: '0', step: '5' });
      const acMaxSeg = el('input', { type: 'number', style: 'width: 50px;', value: acSettings.maxSegments, min: '0', step: '1', title: '0 = unlimited' });
      
      const acFade = el('input', { type: 'checkbox' });
      acFade.checked = acSettings.fade !== false;

      const acFmt = el('select', { style: 'width: 80px;' });
      for (const f of ['wav', 'mp3', 'ogg', 'opus', 'flac', 'm4a', 'aac']) {
        acFmt.appendChild(el('option', { value: f }, `.${f}`));
      }
      acFmt.value = acSettings.format || 'wav';

      const saveAcSettings = () => {
        if (!window.state) return;
        // For the "0 = unlimited" fields (maxSegmentSec, maxSegments),
        // distinguish an explicit 0 (the user wants unlimited) from an
        // empty / non-numeric field (fall back to the default). A naive
        // `parseFloat(x) || 0` collapses both into 0 and silently switches
        // the policy to "unlimited" whenever the field is cleared.
        const parsedMaxLen = parseFloat(acMaxLen.value);
        const parsedMaxSeg = parseInt(acMaxSeg.value, 10);
        // padMs 0 (no padding) is an explicit, backend-supported choice
        // (sanitizeAutoCutRules clamps to [0, 5000]) — `|| 25` silently
        // rewrote it to the default, so "no padding" was unreachable.
        const parsedPad = parseInt(acPad.value, 10);
        window.state.autoCutSettings = {
          thresholdDb: parseInt(acThresh.value, 10) || -35,
          minSilenceMs: parseInt(acGap.value, 10) || 250,
          minSegmentSec: parseFloat(acMinLen.value) || 0.15,
          maxSegmentSec: Number.isFinite(parsedMaxLen) && parsedMaxLen >= 0 ? parsedMaxLen : 3.0,
          longSegmentPolicy: acPolicy.value,
          padMs: Number.isFinite(parsedPad) && parsedPad >= 0 ? parsedPad : 25,
          maxSegments: Number.isFinite(parsedMaxSeg) && parsedMaxSeg >= 0 ? parsedMaxSeg : 20,
          fade: acFade.checked,
          format: acFmt.value,
        };
        if (typeof window.scheduleStateSave === 'function') {
          window.scheduleStateSave();
        }
      };

      [acThresh, acGap, acMinLen, acMaxLen, acPolicy, acPad, acMaxSeg, acFade, acFmt].forEach(inp => {
        inp.addEventListener('change', saveAcSettings);
      });

      const acList = el('div', { class: 'ac-autocut-list', style: 'margin-top: 8px;' });
      const acStats = el('span', { class: 'ac-autocut-stats', style: 'margin-left: 8px; font-size: 12px; color: var(--fg-2);' }, '');
      const acDetectBtn = el('button', { class: 'btn-mini', type: 'button' }, '⚡ Detect segments');
      const acExportBtn = el('button', { class: 'primary', type: 'button', disabled: true }, 'Export checked segments');

      const acOptionsPanel = el('div', { class: 'ac-autocut-options' }, [
        el('div', { class: 'ac-opt-grid' }, [
          el('label', {}, ['Thresh (dB)', acThresh]),
          el('label', {}, ['Min gap (ms)', acGap]),
          el('label', {}, ['Min len (s)', acMinLen]),
          el('label', {}, ['Max len (s)', acMaxLen]),
          el('label', {}, ['Long policy', acPolicy]),
          el('label', {}, ['Padding (ms)', acPad]),
          el('label', {}, ['Max segs', acMaxSeg]),
          el('label', {}, ['Micro-fade', acFade]),
          el('label', {}, ['Format', acFmt]),
        ])
      ]);

      const helpBtn = (typeof helpButton === 'function') ? helpButton('ctx.audioAutoCut') : el('span');
      const acDetails = el('details', { class: 'ac-autocut-details' }, [
        el('summary', {}, ['⚡ Auto-cut ', helpBtn]),
        el('div', { class: 'ac-autocut-section' }, [
          acOptionsPanel,
          el('div', { class: 'ac-autocut-actions', style: 'margin-top: 8px; display: flex; gap: 8px; align-items: center;' }, [
            acDetectBtn, acStats
          ]),
          acList,
          el('div', { class: 'ac-autocut-export-row', style: 'margin-top: 8px; display: flex; justify-content: flex-end;' }, [
            acExportBtn
          ])
        ])
      ]);
      m.appendChild(acDetails);

      // close row
      m.appendChild(el('div', { class: 'footer' }, [el('button', { type: 'button', onclick: close }, 'Close')]));
      // ---- state ----
      let duration = 0;
      let peaks = null;       // Float32Array-like (plain array from IPC)
      let peakAbsMax = 1;
      let startSec = 0;
      let endSec = 0;
      let dragging = null;    // 'start' | 'end' | 'new' | null
      let currentPlan = [];   // holds [{ startSec, endSec, included: boolean }]
      const audio = new Audio();
      audio.src = (window.FileUrl ? window.FileUrl.fileUrl(srcPath) : ('file:///' + String(srcPath).replace(/\\/g, '/'))) + '?t=' + Date.now();
      audio.preload = 'metadata';

      function stageWidth() { return stage.clientWidth || 1; }
      function secToX(sec) { return duration > 0 ? (sec / duration) * stageWidth() : 0; }
      function xToSec(x) { return duration > 0 ? Math.max(0, Math.min(duration, (x / stageWidth()) * duration)) : 0; }

      function syncInputs() {
        startInp.value = fmtTime(startSec);
        endInp.value = fmtTime(endSec);
        const len = Math.max(0, endSec - startSec);
        selLabel.textContent = `Selection: ${fmtTime(len)} (${fmtTime(startSec)} → ${fmtTime(endSec)})`;
      }
      function layoutMarkers() {
        const sx = secToX(startSec);
        const ex = secToX(endSec);
        mStart.style.transform = `translateX(${sx}px)`;
        mEnd.style.transform = `translateX(${ex}px)`;
        selOverlay.style.left = Math.min(sx, ex) + 'px';
        selOverlay.style.width = Math.abs(ex - sx) + 'px';
      }
      function drawWave() {
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const dpr = window.devicePixelRatio || 1;
        const w = stageWidth();
        const h = stage.clientHeight || 200;
        canvas.width = Math.max(1, Math.floor(w * dpr));
        canvas.height = Math.max(1, Math.floor(h * dpr));
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        if (!peaks || !peaks.length) {
          ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--fg-3') || '#888';
          ctx.font = '12px sans-serif';
          ctx.fillText('Decoding waveform…', 10, h / 2);
          return;
        }
        const mid = h / 2;
        const norm = peakAbsMax > 0 ? peakAbsMax : 1;
        const accent = (getComputedStyle(document.documentElement).getPropertyValue('--accent') || '#4d9aff').trim() || '#4d9aff';
        ctx.strokeStyle = (getComputedStyle(document.documentElement).getPropertyValue('--fg-2') || '#aaa').trim();
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let x = 0; x < w; x++) {
          const b = Math.floor((x / w) * peaks.length);
          const amp = (peaks[b] || 0) / norm * (mid - 2);
          ctx.moveTo(x + 0.5, mid - amp);
          ctx.lineTo(x + 0.5, mid + amp);
        }
        ctx.stroke();
        // centre line
        ctx.strokeStyle = accent;
        ctx.globalAlpha = 0.25;
        ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();
        ctx.globalAlpha = 1;

        // Draw auto-cut overlays.
        // NOTE: canvas fillStyle/strokeStyle do NOT resolve CSS variables —
        // 'var(--fg-1)' is an invalid canvas color and is silently ignored,
        // so we resolve the theme color via getComputedStyle (same pattern as
        // the waveform's --accent/--fg-2 reads above) and fall back to a
        // hard-coded color if the var is missing.
        if (currentPlan && currentPlan.length) {
          const acFg = (getComputedStyle(document.documentElement).getPropertyValue('--fg-1') || '#fff').trim() || '#fff';
          currentPlan.forEach((seg, idx) => {
            if (!seg.included) return;
            const sx = secToX(seg.startSec);
            const ex = secToX(seg.endSec);
            const width = ex - sx;

            ctx.fillStyle = 'rgba(255, 150, 0, 0.08)'; // translucent orange
            ctx.fillRect(sx, 0, width, h);

            ctx.strokeStyle = 'rgba(255, 150, 0, 0.3)';
            ctx.lineWidth = 1;
            ctx.strokeRect(sx, 0, width, h);

            ctx.fillStyle = acFg;
            ctx.font = '10px monospace';
            ctx.fillText(`#${String(idx + 1).padStart(2, '0')}`, sx + 3, 12);
          });
        }
      }
      function redraw() { drawWave(); layoutMarkers(); syncInputs(); }

      // ---- pointer interaction on the stage ----
      function clampSel() {
        startSec = Math.max(0, Math.min(duration, startSec));
        endSec = Math.max(0, Math.min(duration, endSec));
        if (endSec < startSec) { const t = startSec; startSec = endSec; endSec = t; }
      }
      function nearestMarker(x) {
        const ds = Math.abs(x - secToX(startSec));
        const de = Math.abs(x - secToX(endSec));
        return ds <= de ? 'start' : 'end';
      }
      function onPointerDown(e) {
        if (!duration) return;
        const rect = stage.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const target = e.target;
        if (target === mStart || mStart.contains(target)) dragging = 'start';
        else if (target === mEnd || mEnd.contains(target)) dragging = 'end';
        else {
          const near = nearestMarker(x);
          const dist = Math.abs(x - secToX(near === 'start' ? startSec : endSec));
          if (dist < 8) dragging = near;
          else { startSec = xToSec(x); endSec = startSec; dragging = 'new'; }
        }
        try { stage.setPointerCapture(e.pointerId); } catch (_) {}
        onPointerMove(e);
      }
      function onPointerMove(e) {
        if (!dragging) return;
        const rect = stage.getBoundingClientRect();
        const sec = xToSec(e.clientX - rect.left);
        if (dragging === 'start') startSec = sec;
        else if (dragging === 'end') endSec = sec;
        else if (dragging === 'new') endSec = sec;
        clampSel();
        redraw();
      }
      function onPointerUp(e) {
        if (!dragging) return;
        dragging = null;
        try { stage.releasePointerCapture(e.pointerId); } catch (_) {}
        clampSel();
        redraw();
      }
      stage.addEventListener('pointerdown', onPointerDown);
      stage.addEventListener('pointermove', onPointerMove);
      stage.addEventListener('pointerup', onPointerUp);
      stage.addEventListener('pointercancel', onPointerUp);

      // ---- time input editing ----
      startInp.addEventListener('change', () => {
        const v = parseTime(startInp.value);
        if (isFinite(v)) { startSec = v; clampSel(); redraw(); } else syncInputs();
      });
      endInp.addEventListener('change', () => {
        const v = parseTime(endInp.value);
        if (isFinite(v)) { endSec = v; clampSel(); redraw(); } else syncInputs();
      });

      // ---- playback ----
      let rafId = null;
      function tickCursor() {
        if (audio.paused) { rafId = null; return; }
        const x = secToX(audio.currentTime);
        playCursor.style.transform = `translateX(${x}px)`;
        playtime.textContent = fmtTime(audio.currentTime);
        if (audio.currentTime >= endSec) { audio.pause(); }
        rafId = requestAnimationFrame(tickCursor);
      }
      function stopPlay() {
        try { audio.pause(); } catch (_) {}
        playCursor.style.display = 'none';
        if (rafId) cancelAnimationFrame(rafId);
        rafId = null;
      }
      playBtn.addEventListener('click', () => {
        if (!duration) return;
        try {
          audio.currentTime = startSec;
          playCursor.style.display = 'block';
          audio.play().then(() => { if (!rafId) rafId = requestAnimationFrame(tickCursor); }).catch(() => {});
        } catch (_) {}
      });
      stopBtn.addEventListener('click', stopPlay);

      resetBtn.addEventListener('click', () => { startSec = 0; endSec = duration; clampSel(); redraw(); });

      silenceBtn.addEventListener('click', async () => {
        silenceBtn.disabled = true; silenceBtn.textContent = 'Detecting…';
        try {
          const adv = (window.state && window.state.pipelineAdvancedSettings && window.state.pipelineAdvancedSettings.audio) || {};
          const r = await window.api.audioTrimSilence(srcPath, {
            thresholdDb: adv.silenceThresholdDb,
            minSilenceMs: adv.minSilenceMs,
          }, audioGrant);
          if (r && r.ok) {
            startSec = r.startSec || 0;
            endSec = (r.endSec != null) ? r.endSec : duration;
            clampSel(); redraw();
            if (r.note) toast(`Silence detection: ${r.note}`, 'warn', 4000);
            else toast(`Trimmed ${fmtTime(r.leadSilenceSec || 0)} lead + ${fmtTime(r.tailSilenceSec || 0)} tail.`, 'ok', 3000);
          } else {
            showErr('Silence detection failed: ' + ((r && r.error) || 'unknown'));
          }
        } catch (e) { showErr('Silence detection error: ' + (e && e.message || e)); }
        silenceBtn.disabled = false; silenceBtn.textContent = '✨ Auto-trim silence';
      });

      // Keep the output extension in sync with the chosen format.
      fmtSel.addEventListener('change', () => {
        const ext = fmtSel.value || srcExt;
        nameInp.value = stripExt(nameInp.value) + '.' + ext;
      });

      exportBtn.addEventListener('click', async () => {
        showErr('');
        _logAct('click-export', { src: srcPath, has_duration: !!duration });
        if (!duration) { _logWarn('export-blocked', 'no-duration'); showErr('Audio not loaded yet.'); return; }
        clampSel();
        if (endSec - startSec < 0.02) { _logWarn('export-blocked', 'selection-too-short'); showErr('Selection is too short (min 20 ms).'); return; }
        const outName = (nameInp.value || '').trim();
        if (!outName) { _logWarn('export-blocked', 'no-name'); showErr('Enter an output file name.'); return; }
        const dstPath = joinPath(dirName(srcPath), baseName(outName));
        // R7: audioCut runs ffmpeg with -y (force overwrite) — refuse to clobber an existing file.
        const _ex = await window.api.fbExists(dstPath, audioGrant).catch(() => null);
        if (_ex && (_ex.ok === false || _ex.exists)) { _logWarn('export-blocked', 'dst-exists'); showErr('"' + baseName(outName) + '" already exists — pick a different name.'); return; } // R10: a {ok:false} fbExists (stale/revoked grant) must fail SAFE (treat as occupied), not pass the guard and let ffmpeg -y clobber
        _logAct('export-start', { src: srcPath, dst: dstPath });
        exportBtn.disabled = true; exportBtn.textContent = 'Exporting…';
        stopPlay();
        const cutGroup = 'cut-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
        const addLog = (opts) => {
          if (typeof window.addLogEvent === 'function') {
            try { window.addLogEvent(opts); } catch (_) { /* best-effort */ }
          }
        };
        addLog({
          category: 'gen',
          groupId: cutGroup,
          headline: `Audio trim started: ${baseName(srcPath)}`,
          details: [
            `Source: ${srcPath}`,
            `Selection: ${fmtTime(startSec)} → ${fmtTime(endSec)} (${(endSec - startSec).toFixed(2)}s)`,
            `Fade: ${fadeCb.checked ? Math.max(0, parseInt(fadeMsInp.value, 10) || 0) + 'ms' : 'off'}`,
            `Lossless: ${!!losslessCb.checked}`,
            `Output: ${baseName(outName)}`,
          ],
        });
        try {
          const adv = (window.state && window.state.pipelineAdvancedSettings && window.state.pipelineAdvancedSettings.audio) || {};
          const r = await window.api.audioCut(srcPath, dstPath, {
            startSec, endSec,
            fade: !!fadeCb.checked,
            fadeMs: Math.max(0, parseInt(fadeMsInp.value, 10) || 0),
            copy: !!losslessCb.checked,
            quality: {
              mp3Quality: adv.mp3Quality,
              oggQuality: adv.oggQuality,
              opusBitrate: adv.opusBitrate,
              m4aBitrate: adv.m4aBitrate,
            },
          }, audioGrant);
          if (r && r.ok) {
            addLog({
              category: 'gen',
              groupId: cutGroup,
              result: 'ok',
              headline: `Audio trim complete: ${baseName(r.outputPath || dstPath)}`,
              details: [`Output: ${r.outputPath || dstPath}`],
            });
            toast(`Saved trimmed clip: ${baseName(r.outputPath || dstPath)}`, 'ok', 4000);
            if (typeof refreshBrowser === 'function') { try { await refreshBrowser(); } catch (_) {} }
            close();
          } else {
            addLog({
              category: 'error',
              groupId: cutGroup,
              result: 'err',
              headline: `Audio trim failed: ${(r && r.error) || 'unknown error'}`,
            });
            showErr('Export failed: ' + ((r && r.error) || 'unknown error'));
          }
        } catch (e) {
          addLog({
            category: 'error',
            groupId: cutGroup,
            result: 'err',
            headline: `Audio trim failed: ${(e && e.message) || e}`,
          });
          showErr('Export error: ' + (e && e.message || e));
        }
        exportBtn.disabled = false; exportBtn.textContent = '✂ Export trimmed clip';
      });

      // ---- Auto-cut logic ----
      function renderAutocutList(stats) {
        acList.innerHTML = '';
        if (currentPlan.length === 0) {
          acList.appendChild(el('div', { class: 'ac-empty-list' }, 'No segments detected. Try adjusting the threshold or gap.'));
          acStats.textContent = '0 segments planned.';
          return;
        }

        // Stats line: list each non-zero bucket so the user sees why the
        // count is what it is. droppedShort = too short, droppedLong =
        // dropped by 'skip' policy (too long).
        const parts = [`${stats.kept} segments planned`];
        if (stats.droppedShort) parts.push(`${stats.droppedShort} dropped: too short`);
        if (stats.droppedLong)  parts.push(`${stats.droppedLong} dropped: too long (skip)`);
        if (stats.truncated)    parts.push(`${stats.truncated} truncated`);
        if (stats.split)        parts.push(`${stats.split} split`);
        if (stats.capped)       parts.push(`${stats.capped} capped`);
        const statsText = parts.join(', ') + '.';
        acStats.textContent = statsText;

        currentPlan.forEach((seg, index) => {
          const cb = el('input', { type: 'checkbox' });
          cb.checked = seg.included;
          cb.addEventListener('change', () => {
            seg.included = cb.checked;
            acExportBtn.disabled = currentPlan.filter(x => x.included).length === 0;
            acExportBtn.textContent = `Export ${currentPlan.filter(x => x.included).length} segments`;
            redraw();
          });

          const durationText = (seg.endSec - seg.startSec).toFixed(3);
          const rowText = `#${String(index + 1).padStart(2, '0')}  ${fmtTime(seg.startSec)} – ${fmtTime(seg.endSec)} (${durationText} s)`;
          
          const label = el('label', { style: 'display: flex; align-items: center; justify-content: space-between; width: 100%;' }, [
            el('span', {}, rowText),
            cb
          ]);
          
          const rowDiv = el('div', { class: 'ac-autocut-row', style: 'padding: 4px; border-bottom: 1px solid var(--border); display: flex; align-items: center; cursor: pointer;' }, [
            label
          ]);

          rowDiv.addEventListener('click', (e) => {
            if (e.target === cb || cb.contains(e.target)) return;
            startSec = seg.startSec;
            endSec = seg.endSec;
            clampSel();
            redraw();
          });

          acList.appendChild(rowDiv);
        });
      }

      acDetectBtn.addEventListener('click', async () => {
        acDetectBtn.disabled = true;
        acDetectBtn.textContent = 'Detecting…';
        showErr('');
        try {
          const rules = {
            minSegmentSec: parseFloat(acMinLen.value) || 0.15,
            // Distinguish explicit 0 (unlimited) from cleared/invalid (default).
            maxSegmentSec: (() => { const v = parseFloat(acMaxLen.value); return Number.isFinite(v) && v >= 0 ? v : 3.0; })(),
            longSegmentPolicy: acPolicy.value,
            // padMs 0 = "no padding" is explicit and backend-supported.
            padMs: (() => { const v = parseInt(acPad.value, 10); return Number.isFinite(v) && v >= 0 ? v : 25; })(),
            maxSegments: (() => { const v = parseInt(acMaxSeg.value, 10); return Number.isFinite(v) && v >= 0 ? v : 20; })(),
            thresholdDb: parseInt(acThresh.value, 10) || -35,
            minSilenceMs: parseInt(acGap.value, 10) || 250,
          };
          const r = await window.api.audioAutocutDetect(srcPath, rules, audioGrant);
          if (r && r.ok) {
            currentPlan = (r.plan || []).map(seg => ({ ...seg, included: true }));
            renderAutocutList(r.stats);
            acExportBtn.disabled = currentPlan.length === 0;
            acExportBtn.textContent = `Export ${currentPlan.filter(x => x.included).length} segments`;
            redraw();
          } else {
            showErr('Auto-cut detection failed: ' + ((r && r.error) || 'unknown'));
          }
        } catch (e) {
          showErr('Auto-cut detection error: ' + (e && e.message || e));
        }
        acDetectBtn.disabled = false;
        acDetectBtn.textContent = '⚡ Detect segments';
      });

      acExportBtn.addEventListener('click', async () => {
        showErr('');
        const checkedSegments = currentPlan.filter(x => x.included);
        if (checkedSegments.length === 0) return;

        acExportBtn.disabled = true;
        acDetectBtn.disabled = true;
        stopPlay();

        const cutGroup = 'autocut-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
        const addLog = (opts) => {
          if (typeof window.addLogEvent === 'function') {
            try { window.addLogEvent(opts); } catch (_) {}
          }
        };

        addLog({
          category: 'gen',
          groupId: cutGroup,
          headline: `Auto-cut export started: ${baseName(srcPath)}`,
          details: [
            `Source: ${srcPath}`,
            `Segments to export: ${checkedSegments.length}`,
            `Format: ${acFmt.value}`,
            `Micro-fade: ${acFade.checked ? '5ms' : 'off'}`,
          ],
        });

        let successCount = 0;
        let failCount = 0;

        const adv = (window.state && window.state.pipelineAdvancedSettings && window.state.pipelineAdvancedSettings.audio) || {};

        const fsExists = async (p) => {
          try {
            // BGR-009 fix: mint read grant for fbExists (R1.3 gate).
            const existsGrant = (window.GrantHelper) ? await window.GrantHelper.ensureRead(p) : undefined;
            // R6: a failed grant envelope must not be forwarded — fb:exists would resolve {ok:false,exists:false} and the collision loop would accept an occupied name (silent overwrite). Treat as occupied; the capped loop falls back to a fresh _collisionN name.
            const res = (existsGrant && existsGrant.ok === false) ? { exists: true } : await window.api.fbExists(p, existsGrant);
            return !!(res && res.exists);
          } catch (_) {
            return false;
          }
        };

        const getCollisionFreePath = async (dir, stem, index, ext) => {
          const baseNameCandidate = `${stem}_sfx${String(index + 1).padStart(2, '0')}`;
          let candidate = joinPath(dir, `${baseNameCandidate}.${ext}`);
          let attempt = 0;
          // R6: cap the probe loop — a consistently-true fsExists (e.g. an
          // always-failing grant treated as occupied) must not hang the export.
          while (attempt < 1000 && await fsExists(candidate)) {
            attempt++;
            candidate = joinPath(dir, `${baseNameCandidate}_collision${attempt}.${ext}`);
          }
          return candidate;
        };

        for (let i = 0; i < checkedSegments.length; i++) {
          const seg = checkedSegments[i];
          acExportBtn.textContent = `Exporting ${i + 1}/${checkedSegments.length}…`;

          const dir = dirName(srcPath);
          const stem = stripExt(srcPath);
          const ext = acFmt.value;
          
          // Number files sequentially across the checked segments (01, 02,
          // 03…) so unchecking one doesn't leave a gap in the exported
          // filenames. Uses the loop index, not the original plan index, so
          // unchecked segments don't leave holes.
          const dstPath = await getCollisionFreePath(dir, stem, i, ext);

          const dur = seg.endSec - seg.startSec;
          const fadeMs = 5;
          const wantFade = acFade.checked && (dur >= (4 * fadeMs / 1000));

          try {
            const r = await window.api.audioCut(srcPath, dstPath, {
              startSec: seg.startSec,
              endSec: seg.endSec,
              fade: wantFade,
              fadeMs: fadeMs,
              copy: false,
              quality: {
                mp3Quality: adv.mp3Quality,
                oggQuality: adv.oggQuality,
                opusBitrate: adv.opusBitrate,
                m4aBitrate: adv.m4aBitrate,
              },
            }, audioGrant);

            if (r && r.ok) {
              successCount++;
            } else {
              failCount++;
              addLog({
                category: 'error',
                groupId: cutGroup,
                result: 'err',
                headline: `Segment #${i + 1} export failed: ${r.error || 'unknown'}`,
              });
            }
          } catch (e) {
            failCount++;
            addLog({
              category: 'error',
              groupId: cutGroup,
              result: 'err',
              headline: `Segment #${i + 1} export error: ${e.message || e}`,
            });
          }
        }

        addLog({
          category: 'gen',
          groupId: cutGroup,
          result: failCount > 0 ? 'warn' : 'ok',
          headline: `Auto-cut completed: ${successCount} exported successfully, ${failCount} failed.`,
        });

        toast(`Exported ${successCount} segments (${failCount} failed)`, failCount > 0 ? 'warn' : 'ok', 4000);

        if (typeof refreshBrowser === 'function') {
          try { await refreshBrowser(); } catch (_) {}
        }

        acExportBtn.disabled = false;
        acExportBtn.textContent = `Export ${checkedSegments.length} segments`;
        acDetectBtn.disabled = false;
        
        if (failCount === 0) {
          close();
        }
      });

      // Redraw on window resize so the canvas + markers stay aligned.
      const onResize = () => redraw();
      window.addEventListener('resize', onResize);

      // Tidy up (stop playback, drop the resize listener, release the
      // audio element) whenever the modal is removed — Esc, the Close
      // button, and the X all funnel through showModal's m.remove().
      const origRemove = m.remove.bind(m);
      m.remove = () => {
        stopPlay();
        window.removeEventListener('resize', onResize);
        try { audio.src = ''; } catch (_) {}
        origRemove();
      };

      // ---- load: probe + decode peaks ----
      (async () => {
        try {
          const p = await window.api.audioProbe(srcPath, audioGrant);
          if (!p || !p.ok) { showErr('Could not read the audio file: ' + ((p && p.error) || 'unknown')); return; }
          duration = p.duration || 0;
          endSec = duration;
          meta.append(
            el('span', { class: 'ac-meta-sep' }, '·'),
            el('span', {}, `${fmtTime(duration)}`),
            el('span', { class: 'ac-meta-sep' }, '·'),
            el('span', {}, `${p.sampleRate || '?'} Hz`),
            el('span', { class: 'ac-meta-sep' }, '·'),
            el('span', {}, `${p.channels === 1 ? 'mono' : (p.channels === 2 ? 'stereo' : (p.channels + 'ch'))}`),
            el('span', { class: 'ac-meta-sep' }, '·'),
            el('span', {}, (p.codec || p.format || '').toUpperCase()),
          );
          syncInputs();
          layoutMarkers();
          drawWave();
          const pk = await window.api.audioDecodePeaks(srcPath, { maxBuckets: 2000, withPcm: false }, audioGrant);
          if (pk && pk.ok && Array.isArray(pk.peaks)) {
            peaks = pk.peaks;
            peakAbsMax = pk.peakAbsMax || 1;
          } else {
            showErr('Waveform preview unavailable: ' + ((pk && pk.error) || 'decode failed') + ' (you can still trim by typing times).');
          }
          redraw();
        } catch (e) {
          showErr('Failed to load audio: ' + (e && e.message || e));
        }
      })();

      // First layout after the modal is on screen (clientWidth is 0
      // until then).
      requestAnimationFrame(() => redraw());
    }, { id: 'audio-cutter:' + srcPath });
  }

  window.showAudioCutter = showAudioCutter;
})();
