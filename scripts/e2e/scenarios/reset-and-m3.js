// scripts/e2e/scenarios/reset-and-m3.js
// ============================================================================
// KGO7-004 — coverage for the two registrars that were missing from every
// harness list, and whose channels had therefore NEVER been executed by any
// automated test:
//
//   registerResetIpc  →  app:resetAllData      (DESTRUCTIVE — deletes the
//                                               tool's own settings/state)
//                        app:relaunch          (kills the process — see
//                        app:resetAndRelaunch   INTENTIONALLY_UNINVOKED in
//                                               scripts/e2e/ipc-coverage.js)
//   registerM3Ipc     →  m3:chat
//
// Safety: the harness sets MINIMAX_CONFIG_DIR to a fresh mkdtemp for every
// run, and `app:resetAllData` only ever touches `configDir()` — so this
// deletes the harness's own throwaway config.txt / state.json / batches.json
// and NEVER the user's. The scenario runs LAST (high `order`) so no later
// scenario is surprised by the wiped config.
//
// `m3:chat` is exercised without spending quota: the isolated config holds a
// fake key in fake mode, so the handler's own "no key" / network-failure path
// returns `{ ok:false, error }` — which is exactly the contract under test.
// ============================================================================

const fs = require('fs');
const path = require('path');

module.exports = {
  name: 'reset-and-m3',
  needsRealApi: false,
  // Runs after every other fake-tier scenario: it deletes the harness's
  // config.txt + state.json.
  order: 995,
  async run(ctx) {
    const { exec, check, TMP } = ctx;

    // ---- m3:chat — the MiniMax M3 text endpoint ----
    // In fake mode the isolated config has a fake key, so this exercises
    // the handler + the error envelope rather than the live API.
    const m3 = await exec(`(async () => {
      try {
        return await window.api.m3Chat({ messages: [{ role: 'user', content: 'e2e ping' }], maxTokens: 8 });
      } catch (e) { return { threw: String(e && e.message || e) }; }
    })()`);
    check(m3 && typeof m3 === 'object', 'm3:chat must resolve with an envelope, not throw');
    check(!m3.threw, `m3:chat must not reject the invoke: ${m3 && m3.threw}`);
    check(typeof m3.ok === 'boolean', `m3:chat envelope must carry a boolean ok (got ${JSON.stringify(m3).slice(0, 200)})`);
    if (m3.ok === false) {
      check(typeof m3.error === 'string' && m3.error.length > 0,
        'm3:chat failure envelope must explain why (ok:false requires a non-empty error)');
    }

    // ---- app:resetAllData — the destructive "Delete all local data" ----
    // Seed the files it is supposed to remove so the assertion is real.
    const seeded = [];
    for (const base of ['config.txt', 'state.json', 'batches.json']) {
      const p = path.join(TMP, base);
      try {
        if (!fs.existsSync(p)) fs.writeFileSync(p, base === 'config.txt' ? 'api_key=e2e\n' : '{}', 'utf8');
        seeded.push(p);
      } catch (_) { /* best-effort */ }
    }
    // A temp sibling too — deleteLocalDataFiles() matches `base.*`.
    const tmpSibling = path.join(TMP, 'state.json.tmp-e2e-kgo7');
    try { fs.writeFileSync(tmpSibling, '{}', 'utf8'); } catch (_) {}

    // KGO8-001 part 1 — drive the REAL BUTTON through the agreed flow.
    //
    // B-009 current flow: danger button -> ONE asyncPrompt DOM modal
    // ("Type DELETE…", Confirm stays disabled until the exact word) ->
    // window.api.confirmResetAndRelaunch() (Main-owned native dialog +
    // delete + verify + relaunch). The walk deliberately STOPS before the
    // final Confirm: completing it would relaunch the app and abort the
    // run (app:confirmResetAndRelaunch stays INTENTIONALLY_UNINVOKED in
    // ipc-coverage). The destructive deletion itself is asserted against
    // the token-gated app:resetAllData below — production security
    // (typed pre-gate + native dialog + single-use token) untouched.
    const ui = await exec(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const err = [];
      addEventListener('unhandledrejection', (e) => err.push(String((e.reason && e.reason.message) || e.reason)));
      // The prompt modal STACKS on top of the still-open Settings modal, so
      // every lookup must be scoped to the TOPMOST modal — querying
      // #modal-root globally finds the Settings pane's own API-key field.
      const top = () => [...document.querySelectorAll('#modal-root .modal')].pop() || document;
      try {
        openSettings();
        await sleep(600);
        const btn = [...top().querySelectorAll('button')]
          .find((b) => /Delete all local data/i.test(b.textContent || ''));
        if (!btn) return { noButton: true, unhandled: err };
        btn.click();
        await sleep(400);
        // B-009: exactly ONE typed-confirmation modal (asyncPrompt) — the
        // old two-dialog walk (asyncConfirm then prompt) no longer exists.
        const promptModal = top();
        const input = promptModal.querySelector('input[type=text]');
        if (!input) return { noPromptInput: true, unhandled: err };
        const go = [...promptModal.querySelectorAll('button')]
          .find((b) => (b.textContent || '').trim() === 'Confirm');
        const disabledBeforeTyping = !!(go && go.disabled);
        // asyncPrompt enables Confirm from its own 'input' listener. A bare
        // value assignment fires nothing, and the app's global keydown/input
        // handlers can swallow or re-dispatch synthetic events — so drive
        // the enablement through the SAME path a user click takes (focus +
        // per-char insertText) and back it up with a direct event on the
        // input itself. The assertion is about the production enablement
        // rule (exact word only), which both paths exercise.
        input.focus();
        try { document.execCommand('insertText', false, 'DELETE'); } catch (_) {}
        if (input.value !== 'DELETE') {
          input.value = 'DELETE';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'E', bubbles: true }));
          input.dispatchEvent(new KeyboardEvent('keyup', { key: 'E', bubbles: true }));
        }
        await sleep(150);
        const enabledAfterTyping = !!(go && !go.disabled);
        // Do NOT click Confirm: that calls confirmResetAndRelaunch, which
        // deletes and RELAUNCHES the app mid-run.
        //
        // Clean up DETERMINISTICALLY. This scenario has order:995, so it is
        // the last thing to touch the DOM before the visual-capture phase —
        // a modal left open here is photographed into every baseline.
        for (let i = 0; i < 6; i++) {
          const m = [...document.querySelectorAll('#modal-root .modal')].pop();
          if (!m) break;
          const cancel = [...m.querySelectorAll('button')].find((b) => /^(Cancel|Close)$/i.test((b.textContent || '').trim()));
          if (cancel) cancel.click();
          else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          await sleep(180);
        }
        const modalsLeft = document.querySelectorAll('#modal-root .modal').length;
        return { walked: true, disabledBeforeTyping, enabledAfterTyping, modalsLeft, unhandled: err };
      } catch (e) { return { threw: String((e && e.message) || e), unhandled: err }; }
    })()`);
    check(ui && !ui.threw, `the danger-zone click must not throw: ${ui && ui.threw}`);
    check(!ui.noButton, 'Settings must expose a "Delete all local data…" button');
    check(!ui.noPromptInput,
      'the type-DELETE step must be a DOM modal with a text input — window.prompt() THROWS in Electron (KGO8-001)');
    check(ui.disabledBeforeTyping === true, 'the typed-confirmation button must start disabled');
    check(ui.enabledAfterTyping === true, 'typing the expected word must enable the confirm button');
    check(Array.isArray(ui.unhandled) && ui.unhandled.length === 0,
      `the reset flow raised unhandled rejections (this is exactly how KGO8-001 hid): ${JSON.stringify(ui && ui.unhandled)}`);
    // order:995 puts this scenario immediately before the visual capture — a
    // modal left open here lands in every baseline.
    check(ui.modalsLeft === 0,
      `the reset walk must close every dialog it opened (${ui.modalsLeft} left open — the visual phase would photograph them)`);

    // KGO8-001 part 2 — the destructive handler itself, through the P1-G
    // (H-016) confirmation-token gate. Invoked directly because the UI path
    // (confirmResetAndRelaunch) would relaunch the app mid-run.

    // Fail-closed first: without a token, NOTHING may be deleted.
    const gateless = await exec(`(async () => {
      try { return await window.api.resetAllData(); }
      catch (e) { return { threw: String(e && e.message || e) }; }
    })()`);
    check(gateless && !gateless.threw, `token-less app:resetAllData must return an envelope, not throw: ${gateless && gateless.threw}`);
    check(gateless && gateless.ok === false && gateless.confirmationRequired === true,
      `app:resetAllData without a token must fail closed with confirmationRequired (got ${JSON.stringify(gateless).slice(0, 200)})`);
    check(seeded.every((p) => fs.existsSync(p)),
      'a token-less resetAllData attempt must not delete anything');

    // Mint a single-use token via confirm:request (the harness answers the
    // Main-owned native dialog with Confirm — production shows the real
    // immutable warning text from ConfirmationTokenService).
    const minted = await exec(`(async () => {
      try { return await window.api.confirmRequest({ action: 'app:resetAllData' }); }
      catch (e) { return { threw: String(e && e.message || e) }; }
    })()`);
    check(minted && minted.ok === true && typeof minted.token === 'string' && minted.token.length > 0,
      `confirm:request must mint a token for app:resetAllData (got ${JSON.stringify(minted).slice(0, 200)})`);

    const reset = await exec(`(async () => {
      try { return await window.api.resetAllData({ confirmationToken: ${JSON.stringify((minted && minted.token) || null)} }); }
      catch (e) { return { threw: String(e && e.message || e) }; }
    })()`);
    check(reset && !reset.threw, `app:resetAllData must not reject the invoke: ${reset && reset.threw}`);
    check(reset && reset.ok === true, `app:resetAllData with a fresh token must succeed (got ${JSON.stringify(reset).slice(0, 300)})`);
    check(Array.isArray(reset.results) && reset.results.length > 0,
      'app:resetAllData must report a per-file result array so partial failures are honest');

    // It must actually have deleted them.
    const survivors = seeded.filter((p) => fs.existsSync(p));
    check(survivors.length === 0,
      `app:resetAllData left files behind: ${JSON.stringify(survivors)}`);
    check(!fs.existsSync(tmpSibling),
      'app:resetAllData must also remove <base>.tmp-* siblings (a stale temp would restore settings)');

    // Single-use: replaying the consumed token must be rejected.
    const replay = await exec(`(async () => {
      try { return await window.api.resetAllData({ confirmationToken: ${JSON.stringify((minted && minted.token) || null)} }); }
      catch (e) { return { threw: String(e && e.message || e) }; }
    })()`);
    check(replay && replay.ok === false && replay.confirmationRequired === true,
      `a consumed confirmation token must be rejected (single-use, got ${JSON.stringify(replay).slice(0, 200)})`);

    // ...and it must NOT have touched generated assets.
    check(fs.existsSync(ctx.OUT),
      'app:resetAllData must never delete the user\'s generated-assets folder');

    // Restore a minimal config so anything running after this (the visual
    // capture phase) still has an output_dir.
    try {
      fs.writeFileSync(path.join(TMP, 'config.txt'),
        `api_key=sk-smoke-test-key-0000000000\noutput_dir=${ctx.OUT}\nregion=global\ntheme=dark\n`, 'utf8');
    } catch (_) { /* best-effort */ }
  },
};
