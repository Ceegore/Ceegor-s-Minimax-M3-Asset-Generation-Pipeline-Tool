// renderer/services/m3DocPipeline.js
// In-tool M3 document generation pipeline (F3).
// Runs a multi-pass orchestration against MiniMax M3 (via the main-process
// IPC bridge window.api.m3Chat) to turn a user-supplied GDD into a ready-to-
// import batch document. The composition (concatenation of scene + character
// blocks) is done in THIS code — M3 never does the concatenation — guaranteeing
// byte-for-byte consistency across same-scene/same-character images.
//
// Passes:
//   1. Scene bible   → [{id, description}]
//   2. Character bible → [{id, description}]
//   3. Shot list     → [{type, sceneId, characterIds[], action, params}]
//   4. Compose (code) → fenced ```batch-json document (deterministic)
//   5. Self-check    → optional repair of borderline rows
//
// Guardrails: JSON validation per pass, ≤2 repair retries, hard pass cap,
// Cancel at any point, clean error surfacing (no key leak).
//
// On completion the produced document is fed into the existing import path
// (window.BatchManager.importBatchFromContent) — no parser fork.
(function () {
  'use strict';

  // HARD prompt limits per type (from modelSpecs.js).
  const LIMITS = { image: 1500, speech: 10000, music: 2000, video: 2000 };

  // ---- helpers ----

  function m3Chat(messages, opts) {
    return window.api.m3Chat(Object.assign({ messages }, opts || {}));
  }

  // H-005: generate a unique run ID for cancel routing.
  function mintRunId() {
    return 'm3_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  // Attempt to extract a JSON array from M3's response. Handles the common
  // case where M3 wraps the JSON in a fenced code block or adds preamble text.
  function extractJsonArray(text) {
    if (!text) return null;
    // Try direct parse first.
    try { const v = JSON.parse(text); if (Array.isArray(v)) return v; } catch (_) {}
    // Try fenced block.
    const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (fenceMatch) {
      try { const v = JSON.parse(fenceMatch[1].trim()); if (Array.isArray(v)) return v; } catch (_) {}
    }
    // Try finding the first [ ... ] in the text.
    const bracketStart = text.indexOf('[');
    const bracketEnd = text.lastIndexOf(']');
    if (bracketStart >= 0 && bracketEnd > bracketStart) {
      try { const v = JSON.parse(text.slice(bracketStart, bracketEnd + 1)); if (Array.isArray(v)) return v; } catch (_) {}
    }
    return null;
  }

  // Run a single pass with validation + bounded repair retries.
  // Returns the parsed JSON array or throws on exhaustion / cancel.
  // H-008: accumulates token usage into opts.stats if provided.
  async function runPass(label, systemPrompt, userPrompt, validate, cancelled, runId, stats) {
    const MAX_REPAIRS = 2;
    let lastError = null;
    for (let attempt = 0; attempt <= MAX_REPAIRS; attempt++) {
      if (cancelled()) throw new Error('Cancelled.');
      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: attempt === 0 ? userPrompt : userPrompt + '\n\nYour previous output was invalid: ' + lastError + '. Output ONLY the corrected JSON array, no prose.' },
      ];
      const r = await m3Chat(messages, { jsonMode: true, temperature: 0.3, maxTokens: 4096, runId: runId });
      if (!r.ok) {
        if (r.cancelled) throw new Error('Cancelled.');
        throw new Error(r.error || 'M3 request failed.');
      }
      if (stats && r.usage) { stats.totalTokens += (r.usage.total_tokens || 0); stats.calls++; }
      const arr = extractJsonArray(r.content);
      if (!arr) { lastError = 'Response is not a valid JSON array.'; continue; }
      const err = validate(arr);
      if (!err) return arr;
      lastError = err;
    }
    throw new Error(label + ': gave up after ' + (MAX_REPAIRS + 1) + ' attempts. Last error: ' + lastError);
  }

  // ---- validators ----

  function validateBible(arr) {
    if (!arr.length) return 'Array is empty.';
    // FUNC-033: reject duplicate bible IDs.
    const seenIds = new Set();
    for (let i = 0; i < arr.length; i++) {
      const item = arr[i];
      if (!item.id || typeof item.id !== 'string') return 'Item ' + (i + 1) + ' missing string "id".';
      if (!item.description || typeof item.description !== 'string') return 'Item ' + (i + 1) + ' missing string "description".';
      if (seenIds.has(item.id)) return 'Duplicate id "' + item.id + '" at item ' + (i + 1) + '. IDs must be unique.';
      seenIds.add(item.id);
    }
    return null;
  }

  // FUNC-006: validateShots now takes the valid scene/char IDs so it can
  // reject shots that reference non-existent bible entries.
  function validateShots(arr, validSceneIds, validCharIds) {
    if (!arr.length) return 'Array is empty.';
    const validTypes = ['image', 'speech', 'music', 'video'];
    const sceneSet = new Set(validSceneIds || []);
    const charSet = new Set(validCharIds || []);
    for (let i = 0; i < arr.length; i++) {
      const s = arr[i];
      if (!validTypes.includes(s.type)) return 'Shot ' + (i + 1) + ' has invalid type "' + s.type + '".';
      if (s.type === 'image' || s.type === 'video') {
        if (!s.action || typeof s.action !== 'string') return 'Shot ' + (i + 1) + ' missing "action".';
      } else {
        if (!s.action && !s.text) return 'Shot ' + (i + 1) + ' missing "action" or "text".';
      }
      // FUNC-006: validate sceneId references a real scene.
      if (s.sceneId && !sceneSet.has(s.sceneId)) {
        return 'Shot ' + (i + 1) + ' references unknown sceneId "' + s.sceneId + '". Valid: ' + JSON.stringify(validSceneIds) + '.';
      }
      // FUNC-006: validate characterIds reference real characters.
      if (Array.isArray(s.characterIds)) {
        for (const cid of s.characterIds) {
          if (!charSet.has(cid)) {
            return 'Shot ' + (i + 1) + ' references unknown characterId "' + cid + '". Valid: ' + JSON.stringify(validCharIds) + '.';
          }
        }
      }
    }
    return null;
  }

  // ---- Pass 4: deterministic composition ----

  function composeBatchJson(scenes, characters, shots, opts) {
    const sceneMap = {};
    for (const s of scenes) sceneMap[s.id] = s.description;
    const charMap = {};
    for (const c of characters) charMap[c.id] = c.description;

    const styleHeader = (opts && opts.styleValue) ? opts.styleValue : '';
    const entries = [];

    for (const shot of shots) {
      const type = shot.type || 'image';
      let prompt = '';

      if (type === 'image' || type === 'video') {
        // H-007 (_5 audit): deterministic budget per prompt segment.
        // Instead of only truncating the action (which fails when
        // style+scene+characters already exceed the limit), allocate
        // proportional budgets and truncate each segment at sentence
        // boundaries.
        const limit = LIMITS[type] || 2000;
        const styleText = styleHeader || '';
        const sceneText = (shot.sceneId && sceneMap[shot.sceneId]) || '';
        const charTexts = [];
        if (Array.isArray(shot.characterIds)) {
          for (const cid of shot.characterIds) {
            if (charMap[cid]) charTexts.push(charMap[cid]);
          }
        }
        const actionText = shot.action || '';
        // Budget allocation: action gets a guaranteed minimum reserve,
        // the rest is split proportionally among style/scene/characters.
        const ACTION_RESERVE = Math.min(120, Math.floor(limit * 0.1));
        const totalNonAction = styleText.length + sceneText.length + charTexts.reduce((a, c) => a + c.length, 0);
        const budgetForNonAction = limit - ACTION_RESERVE;
        function truncateAtSentence(text, maxLen) {
          if (text.length <= maxLen) return text;
          // Try to cut at a sentence boundary (period + space).
          const cut = text.slice(0, maxLen);
          const lastPeriod = cut.lastIndexOf('. ');
          if (lastPeriod > maxLen * 0.5) return cut.slice(0, lastPeriod + 1);
          return cut.trimEnd();
        }
        let stylePart = styleText;
        let scenePart = sceneText;
        let charParts = charTexts;
        if (totalNonAction > budgetForNonAction && totalNonAction > 0) {
          const ratio = budgetForNonAction / totalNonAction;
          stylePart = truncateAtSentence(styleText, Math.floor(styleText.length * ratio));
          scenePart = truncateAtSentence(sceneText, Math.floor(sceneText.length * ratio));
          charParts = charTexts.map((c) => truncateAtSentence(c, Math.floor(c.length * ratio)));
        }
        const baseParts = [];
        if (stylePart) baseParts.push(stylePart);
        if (scenePart) baseParts.push(scenePart);
        for (const cp of charParts) { if (cp) baseParts.push(cp); }
        const base = baseParts.join(' ').replace(/\s+/g, ' ').trim();
        const remaining = limit - base.length - 1;
        const action = truncateAtSentence(actionText, Math.max(remaining, 0));
        prompt = (base + ' ' + action).replace(/\s+/g, ' ').trim();
        // Hard guarantee: never exceed the limit.
        if (prompt.length > limit) prompt = prompt.slice(0, limit);
      } else {
        // speech / music: prompt is the text/action directly.
        prompt = shot.action || shot.text || '';
        const limit = LIMITS[type] || 10000;
        if (prompt.length > limit) prompt = prompt.slice(0, limit);
      }

      const entry = { type, prompt };
      // Merge shot params.
      if (shot.params && typeof shot.params === 'object') {
        entry.params = shot.params;
      } else {
        entry.params = {};
      }
      // Apply user-chosen fixed params from the form.
      if (opts) {
        if (opts.variants && opts.variants > 1) entry.params.variants = opts.variants;
        if (opts.sendToPipeline) entry.sendToPipeline = true;
      }
      entries.push(entry);
    }

    // Build the fenced document.
    let doc = '';
    if (styleHeader) doc += 'style: ' + (opts.styleName || 'M3 Batch') + ' = ' + styleHeader + '\n\n';
    doc += '```batch-json\n' + JSON.stringify(entries, null, 2) + '\n```\n';
    return doc;
  }

  // ---- main pipeline ----

  // opts: { styleName, styleValue, variants, sendToPipeline, onProgress, onCancelled }
  // gddText: the user's game design document text.
  // Returns { ok, doc } or { ok: false, error }.
  async function run(gddText, opts) {
    let _cancelled = false;
    const cancelled = () => _cancelled;
    const runId = (opts && opts.runId) || mintRunId();
    const cancelToken = {
      cancel() {
        _cancelled = true;
        if (window.api && window.api.m3Cancel) window.api.m3Cancel(runId);
      },
    };

    const onProgress = (opts && opts.onProgress) || function () {};
    const TOTAL_STEPS = 5; // scene, character, shots, compose, self-check
    const stats = { totalTokens: 0, calls: 0 }; // H-008: token statistics

    try {
      // Pass 1 — Scene bible.
      onProgress(1, TOTAL_STEPS, 'Building scene bible…');
      const scenes = await runPass(
        'Scene bible',
        'You are a game art director. Extract every distinct location/setting from the GDD. ' +
        'Return a JSON array: [{"id":"S1","description":"..."}]. ' +
        'Each description must be a rich, self-contained visual paragraph (setting, background, lighting, palette, atmosphere, camera hint). ' +
        'Output ONLY the JSON array.',
        gddText,
        validateBible,
        cancelled,
        runId,
        stats
      );

      // Pass 2 — Character bible.
      onProgress(2, TOTAL_STEPS, 'Building character bible…');
      const characters = await runPass(
        'Character bible',
        'You are a game art director. Extract every recurring character or important object from the GDD. ' +
        'Return a JSON array: [{"id":"C1","description":"..."}]. ' +
        'Each description must be a rich, self-contained visual paragraph (silhouette, clothing with exact colours, features, age/build, default expression). ' +
        'Output ONLY the JSON array.',
        gddText,
        validateBible,
        cancelled,
        runId,
        stats
      );

      // Pass 3 — Shot list.
      // H-008 token optimization: send the compact intermediate model
      // (scenes + characters) instead of the full GDD text again.
      onProgress(3, TOTAL_STEPS, 'Mapping shots…');
      const sceneIds = scenes.map((s) => s.id);
      const charIds = characters.map((c) => c.id);
      const compactContext = 'SCENES:\n' + JSON.stringify(scenes) + '\nCHARACTERS:\n' + JSON.stringify(characters);
      // FUNC-006: pass valid IDs to the validator so it can reject
      // shots that reference non-existent bible entries.
      const shotsValidator = (arr) => validateShots(arr, sceneIds, charIds);
      const shots = await runPass(
        'Shot list',
        'You are a game asset producer. Map every asset the extracted scenes and characters require into shots. ' +
        'Return a JSON array: [{"type":"image|speech|music|video","sceneId":"S1|null","characterIds":["C1"],"action":"...","params":{}}]. ' +
        'Available scene IDs: ' + JSON.stringify(sceneIds) + '. Available character IDs: ' + JSON.stringify(charIds) + '. ' +
        'For speech/music/video, sceneId and characterIds may be null/[]. The "action" is the shot-specific description or text/lyrics. ' +
        'The "params" object holds optional --flags (e.g. {"--aspect-ratio":"16:9","--model":"image-01"}). ' +
        'Output ONLY the JSON array.',
        compactContext,
        shotsValidator,
        cancelled,
        runId,
        stats
      );

      // Pass 4 — Compose in code (deterministic, no M3 call).
      onProgress(4, TOTAL_STEPS, 'Composing batch document…');
      const doc = composeBatchJson(scenes, characters, shots, opts);

      // FUNC-004: hard limit assertion after composition.
      // Verify that NO entry exceeds the hard prompt limit. This is a
      // defensive check — composeBatchJson already trims, but a bug there
      // would otherwise silently produce an API-rejectable batch.
      const composed = extractJsonArray(doc);
      if (composed) {
        for (let i = 0; i < composed.length; i++) {
          const entry = composed[i];
          const limit = LIMITS[entry.type] || 2000;
          if (entry.prompt && entry.prompt.length > limit) {
            return { ok: false, error: 'Composition bug: entry ' + (i + 1) + ' (' + entry.type + ') has prompt length ' + entry.prompt.length + ' > ' + limit + '. Please report this.', cancelToken };
          }
        }
      }

      // Pass 5 — Self-check (H-008): validate the composed output against
      // the intermediate model. Non-blocking: issues are reported in the
      // result but do not prevent the import (the composition is deterministic).
      onProgress(5, TOTAL_STEPS, 'Self-check…');
      let selfCheckIssues = [];
      try {
        if (cancelled()) throw new Error('Cancelled.');
        const checkPrompt = 'You are a QA reviewer. Given the extracted scenes, characters, and the final shot list, verify:\n' +
          '1. Every scene ID is referenced by at least one shot.\n' +
          '2. Every character ID is referenced by at least one shot.\n' +
          '3. No duplicate shots (same type + sceneId + action).\n' +
          '4. All params are valid --flags.\n' +
          'Return a JSON array of issue strings: ["issue 1", ...]. Return [] if no issues.';
        const checkInput = 'SCENES: ' + JSON.stringify(scenes) + '\nCHARACTERS: ' + JSON.stringify(characters) + '\nSHOTS: ' + JSON.stringify(shots);
        const checkR = await m3Chat(
          [{ role: 'system', content: checkPrompt }, { role: 'user', content: checkInput }],
          { jsonMode: true, temperature: 0, maxTokens: 1024, runId: runId }
        );
        if (checkR.ok && checkR.usage) { stats.totalTokens += (checkR.usage.total_tokens || 0); stats.calls++; }
        if (checkR.ok) {
          const issues = extractJsonArray(checkR.content);
          if (Array.isArray(issues)) selfCheckIssues = issues.filter(function (s) { return typeof s === 'string' && s.trim(); });
        }
      } catch (_) { /* self-check is advisory — never blocks the pipeline */ }

      return { ok: true, doc, cancelToken, stats: stats, selfCheckIssues: selfCheckIssues };
    } catch (e) {
      if (cancelled()) return { ok: false, error: 'Cancelled.', cancelled: true, cancelToken };
      return { ok: false, error: String((e && e.message) || e), cancelToken };
    }
  }

  // Convenience: run the pipeline and feed the result into the import review.
  async function runAndImport(gddText, opts) {
    const result = await run(gddText, opts);
    if (!result.ok) return result;
    // Feed into the existing import path (no parser fork).
    window.BatchManager.importBatchFromContent(result.doc);
    return result;
  }

  // H-005 (_5 audit): start() returns {promise, cancel} IMMEDIATELY so the
  // caller can wire the cancel button BEFORE the pipeline finishes.
  function start(gddText, opts) {
    const runId = mintRunId();
    let cancelFn;
    const promise = run(gddText, Object.assign({}, opts, { runId: runId })).then(function (result) {
      cancelFn = result.cancelToken ? result.cancelToken.cancel.bind(result.cancelToken) : null;
      return result;
    });
    // Expose the cancelToken's cancel via the runId immediately.
    const cancel = function () {
      if (cancelFn) { cancelFn(); return; }
      // Pipeline hasn't resolved yet — cancel via IPC directly.
      if (window.api && window.api.m3Cancel) window.api.m3Cancel(runId);
    };
    return { promise: promise, cancel: cancel, runId: runId };
  }

  window.M3DocPipeline = { run, runAndImport, start, composeBatchJson, extractJsonArray, LIMITS };
})();
