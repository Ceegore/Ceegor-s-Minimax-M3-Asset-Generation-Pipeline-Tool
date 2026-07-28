// renderer/tabs/speechTabVoices.js
// Voice-list population for the speech tab, split out from speechTab.js.
// The main tab file calls `this.populateVoices(voice.input.el || voice.input)`
// and delegates the rest to this module via the `speechVoices` global.
//
// populateVoices fetches the 300+ voice list from the API
// (`window.api.voices()`) and populates the inner <select>.
// The fetch is cached in state.voices / state.voicesLoaded so
// repeated tab switches don't re-fetch.
//
// fillVoices is the synchronous helper that puts <option> elements
// into the <select>. Clears innerHTML first so a refresh (e.g. after a
// config change) replaces the old list cleanly. The current value is
// preserved.

(function () {
  function fillVoices(sel, voices) {
    const current = sel.value;
    sel.innerHTML = '';
    for (const v of voices) sel.appendChild(el('option', { value: v }, v));
    if (voices.includes(current)) sel.value = current;
  }

  async function populateVoices(sel, state) {
    if (state.voicesLoaded) { fillVoices(sel, state.voices); return; }
    const v = await window.api.voices();
    if (Array.isArray(v) && v.length) {
      state.voices = v;
      state.voicesLoaded = true;
      fillVoices(sel, v);
    }
  }

  window.speechVoices = { fillVoices, populateVoices };
})();