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
  async function runPass(label, systemPrompt, userPrompt, validate, cancelled) {
    const MAX_REPAIRS = 2;
    let lastError = null;
    for (let attempt = 0; attempt <= MAX_REPAIRS; attempt++) {
      if (cancelled()) throw new Error('Cancelled.');
      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: attempt === 0 ? userPrompt : userPrompt + '\n\nYour previous output was invalid: ' + lastError + '. Output ONLY the corrected JSON array, no prose.' },
      ];
      const r = await m3Chat(messages, { jsonMode: true, temperature: 0.3, maxTokens: 4096 });
      if (!r.ok) throw new Error(r.error || 'M3 request failed.');
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
        // Concatenate: [style] + scene (verbatim) + characters (verbatim) + action
        const parts = [];
        if (styleHeader) parts.push(styleHeader);
        if (shot.sceneId && sceneMap[shot.sceneId]) parts.push(sceneMap[shot.sceneId]);
        if (Array.isArray(shot.characterIds)) {
          for (const cid of shot.characterIds) {
            if (charMap[cid]) parts.push(charMap[cid]);
          }
        }
        parts.push(shot.action || '');
        prompt = parts.join(' ').replace(/\s+/g, ' ').trim();
        // Enforce HARD limit: trim the action (last part) if over.
        const limit = LIMITS[type] || 2000;
        if (prompt.length > limit) {
          // Rebuild without action, then append truncated action.
          const baseParts = [];
          if (styleHeader) baseParts.push(styleHeader);
          if (shot.sceneId && sceneMap[shot.sceneId]) baseParts.push(sceneMap[shot.sceneId]);
          if (Array.isArray(shot.characterIds)) {
            for (const cid of shot.characterIds) {
              if (charMap[cid]) baseParts.push(charMap[cid]);
            }
          }
          const base = baseParts.join(' ').replace(/\s+/g, ' ').trim();
          const remaining = limit - base.length - 1;
          const action = (shot.action || '').slice(0, Math.max(remaining, 40));
          prompt = (base + ' ' + action).trim();
        }
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
    const cancelToken = { cancel() { _cancelled = true; } };

    const onProgress = (opts && opts.onProgress) || function () {};
    const TOTAL_STEPS = 4; // scene, character, shots, compose

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
        cancelled
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
        cancelled
      );

      // Pass 3 — Shot list.
      onProgress(3, TOTAL_STEPS, 'Mapping shots…');
      const sceneIds = scenes.map((s) => s.id);
      const charIds = characters.map((c) => c.id);
      // FUNC-006: pass valid IDs to the validator so it can reject
      // shots that reference non-existent bible entries.
      const shotsValidator = (arr) => validateShots(arr, sceneIds, charIds);
      const shots = await runPass(
        'Shot list',
        'You are a game asset producer. Map every asset the GDD requires into shots. ' +
        'Return a JSON array: [{"type":"image|speech|music|video","sceneId":"S1|null","characterIds":["C1"],"action":"...","params":{}}]. ' +
        'Available scene IDs: ' + JSON.stringify(sceneIds) + '. Available character IDs: ' + JSON.stringify(charIds) + '. ' +
        'For speech/music/video, sceneId and characterIds may be null/[]. The "action" is the shot-specific description or text/lyrics. ' +
        'The "params" object holds optional --flags (e.g. {"--aspect-ratio":"16:9","--model":"image-01"}). ' +
        'Output ONLY the JSON array.',
        gddText,
        shotsValidator,
        cancelled
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

      return { ok: true, doc, cancelToken };
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

  window.M3DocPipeline = { run, runAndImport, composeBatchJson, extractJsonArray, LIMITS };
})();
