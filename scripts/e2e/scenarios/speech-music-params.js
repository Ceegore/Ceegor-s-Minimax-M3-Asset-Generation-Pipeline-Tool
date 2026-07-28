// scripts/e2e/scenarios/speech-music-params.js
// ============================================================================
// Phase-2 surface scenario (master_testplan TC_E2E_SPCH_001 / TC_E2E_MUS_001
// parameter surfaces — no paid generation).
//
// Speech, music and video tabs build their parameter rows from the mmx spec
// at init. This scenario asserts the ui_map-declared controls actually
// rendered with their documented options, and that changing a value is
// reflected (change event accepted, no renderer errors). Selectors that
// ui_map.json declares without a `dom` anchor (visual-only) are skipped —
// they live in the manual bucket of the surface report by design.
// ============================================================================

const { sel } = require('../uimap');

module.exports = {
  name: 'speech-music-params',
  needsRealApi: false,
  order: 16,
  async run(ctx) {
    // NOTE: `exec` is the harness's win.webContents.executeJavaScript() — NOT child_process.exec.
    const { exec, sleep, check } = ctx;

    // ---- speech tab: textarea + the enum params ui_map documents ----
    await exec(`showTab('speech'); true;`);
    await sleep(80);
    const spch = await exec(`(() => {
      const panel = document.querySelector('#tab-speech');
      if (!panel || !panel.children.length) return { error: 'speech panel not built' };
      const rows = [...panel.querySelectorAll('.row')];
      const labelOf = (row) => ((row.querySelector('label') || {}).textContent || '');
      const findSelect = (re) => {
        for (const row of rows) {
          if (re.test(labelOf(row))) {
            const s = row.querySelector('.combo-select-enum select') || row.querySelector('select');
            if (s) return s;
          }
        }
        return null;
      };
      const out = { rowCount: rows.length };
      out.textarea = !!panel.querySelector('textarea');
      const probes = [
        ['model', /--model\\b/, ['speech-2.8-hd']],
        ['speed', /--speed\\b/, ['0.5', '1', '2']],
        ['volume', /--volume\\b/, ['1', '5', '10']],
        ['pitch', /--pitch\\b/, ['-12', '0', '12']],
        ['format', /--format\\b/, ['mp3', 'wav', 'flac']],
        ['sampleRate', /--sample-rate\\b/, ['8000', '44100']],
        ['bitrate', /--bitrate\\b/, ['128000']],
        ['channels', /--channel/, null],
        ['subtitles', /--subtitle/, null],
      ];
      window.__smoke.errors = [];
      for (const [key, re, expect] of probes) {
        const s = findSelect(re);
        out[key] = s ? { options: [...s.options].map((o) => o.value) } : null;
        if (s && expect) {
          for (const v of expect) out[key + '_has_' + v] = [...s.options].some((o) => o.value === v);
        }
        if (s && s.options.length > 1) {
          // flip to the last option and back — the change handler must not throw
          const orig = s.value;
          s.value = s.options[s.options.length - 1].value;
          s.dispatchEvent(new Event('change', { bubbles: true }));
          s.value = orig;
          s.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
      out.voice = !!findSelect(/--voice\\b/);
      out.errors = window.__smoke.errors;
      return out;
    })()`);
    check(!spch.error, spch.error || '');
    if (!spch.error) {
      check(spch.textarea, 'speech tab: prompt textarea missing');
      check(spch.rowCount >= 8, `speech tab: expected >=8 parameter rows, got ${spch.rowCount}`);
      for (const key of ['model', 'speed', 'volume', 'pitch', 'format', 'sampleRate', 'bitrate']) {
        check(!!spch[key], `speech tab: --${key.replace(/([A-Z])/g, (m) => '-' + m.toLowerCase())} select not rendered`);
      }
      check(spch.voice, 'speech tab: --voice select not rendered');
      for (const [k, v] of [['model_has_speech-2.8-hd', true], ['speed_has_1', true], ['format_has_wav', true], ['sampleRate_has_44100', true]]) {
        check(spch[k] === v, `speech tab: expected option present (${k}=${spch[k]})`);
      }
      check(spch.errors.length === 0, `speech param changes threw: ${JSON.stringify(spch.errors).slice(0, 200)}`);
    }

    // ---- music tab: prompt + lyrics + the documented enum params ----
    await exec(`showTab('music'); true;`);
    await sleep(80);
    const mus = await exec(`(() => {
      const panel = document.querySelector('#tab-music');
      if (!panel || !panel.children.length) return { error: 'music panel not built' };
      const rows = [...panel.querySelectorAll('.row')];
      const labelOf = (row) => ((row.querySelector('label') || {}).textContent || '');
      const findSelect = (re) => {
        for (const row of rows) if (re.test(labelOf(row))) { const s = row.querySelector('select'); if (s) return s; }
        return null;
      };
      const out = { rowCount: rows.length };
      out.textarea = !!panel.querySelector('textarea');
      out.model = !!findSelect(/--model\\b/);
      out.format = !!findSelect(/--format\\b/);
      out.instrumental = !!findSelect(/--instrumental\\b/);
      const fmt = findSelect(/--format\\b/);
      out.formatOptions = fmt ? [...fmt.options].map((o) => o.value) : [];
      const model = findSelect(/--model\\b/);
      out.modelOptions = model ? [...model.options].map((o) => o.value) : [];
      return out;
    })()`);
    check(!mus.error, mus.error || '');
    if (!mus.error) {
      check(mus.textarea, 'music tab: prompt textarea missing');
      check(mus.model, 'music tab: --model select not rendered');
      check(mus.format, 'music tab: --format select not rendered');
      check(mus.modelOptions.some((v) => /music-2/.test(v)), `music tab: no music-2.x model option (has ${JSON.stringify(mus.modelOptions)})`);
      check(mus.formatOptions.includes('mp3') && mus.formatOptions.includes('wav'), `music tab: --format must offer mp3+wav (has ${JSON.stringify(mus.formatOptions)})`);
    }

    // ---- video tab: model/duration/resolution + the quota warning ----
    await exec(`showTab('video'); true;`);
    await sleep(80);
    const vid = await exec(`(() => {
      const panel = document.querySelector('#tab-video');
      if (!panel || !panel.children.length) return { error: 'video panel not built' };
      const rows = [...panel.querySelectorAll('.row')];
      const labelOf = (row) => ((row.querySelector('label') || {}).textContent || '');
      const findSelect = (re) => {
        for (const row of rows) if (re.test(labelOf(row))) { const s = row.querySelector('select'); if (s) return s; }
        return null;
      };
      const model = findSelect(/--model\\b/);
      const dur = findSelect(/--duration\\b/);
      const res = findSelect(/--resolution\\b/);
      return {
        textarea: !!panel.querySelector('textarea'),
        modelOptions: model ? [...model.options].map((o) => o.value) : [],
        durationOptions: dur ? [...dur.options].map((o) => o.value) : [],
        resolutionOptions: res ? [...res.options].map((o) => o.value) : [],
      };
    })()`);
    check(!vid.error, vid.error || '');
    if (!vid.error) {
      check(vid.textarea, 'video tab: prompt textarea missing');
      check(vid.modelOptions.some((v) => /Hailuo|S2V/i.test(v)), `video tab: no Hailuo/S2V model option (has ${JSON.stringify(vid.modelOptions)})`);
      check(vid.durationOptions.length > 0, 'video tab: --duration select has no options');
      check(vid.resolutionOptions.some((v) => /768/.test(v)), `video tab: --resolution must offer 768P (has ${JSON.stringify(vid.resolutionOptions)})`);
    }

    await exec(`showTab('image'); true;`);
  },
};
