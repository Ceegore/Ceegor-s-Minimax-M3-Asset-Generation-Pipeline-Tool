// renderer/sections/section13_Image_dim_guards.js
// Extracted: Image-dim guards

// ----------------- Image-dim guards -----------------
// Three live warnings below the image tab's W × H row:
//   1. "W × H doesn't match aspect ratio 1:1" — when the user
//      has an aspect ratio selected AND has manually entered both
//      W and H such that their ratio is off by more than 1%.
//      "Correct" auto-fills the offending dimension (W is the
//      source of truth, per the user's spec).
//   2. "W must be a multiple of 8" / "H must be a multiple of
//      8" — mmx rejects non-multiple-of-8 dimensions with a
//      cryptic 400. "Correct" rounds to the nearest multiple.
//   3. Same for the subject-ref field — it must be a valid
//      filesystem path or http(s) URL; mmx rejects everything
//      else.
//
// All three are wired to the param objects returned by
// buildParamRow() so they read the current value via getValue()
// and write back via the underlying input/select (which also
// fires 'input' / 'change' for the per-tab state autosave).

// Validate the --subject-ref value. mmx accepts:
//   - a local filesystem path that exists (PNG / JPG / JPEG / WebP)
//   - an http(s) URL (and seemingly URLs to a CDN)
//   - an empty string (no character ref)
// Everything else is rejected with a "file not found" or
// "invalid URL" 400. We watch the input and surface a warning
// when the value doesn't look like one of the above.
function attachSubjectRefGuard(subjRef) {
  const warning = el('div', { class: 'subject-ref-warning', style: 'display: none;' });
  const input = subjRef.el;
  function recheck() {
    const v = (input.value || '').trim();
    if (!v) { warning.style.display = 'none'; warning.innerHTML = ''; return; }
    if (/^https?:\/\//i.test(v)) { warning.style.display = 'none'; warning.innerHTML = ''; return; }
    // For local paths we can't easily async-check existence from
    // the renderer (no fs access in the renderer's main world),
    // and the renderer's fb:list already validates this on click.
    // We just sanity-check the shape: must look like a path and
    // have a recognised image extension.
    const looksLikePath = /[\\/]/.test(v) || /^[a-zA-Z]:[\\/]/.test(v) || v.startsWith('./') || v.startsWith('../') || v.startsWith('/') || /^[a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+$/.test(v);
    if (!looksLikePath) {
      warning.innerHTML = '';
      warning.appendChild(el('span', { style: 'flex: 1;' },
        'Subject reference must be a local image path or an http(s) URL. Examples: C:\\Users\\me\\char.png  ·  https://example.com/char.png'));
      warning.style.display = '';
      return;
    }
    const ext = v.toLowerCase().split('.').pop();
    if (!['png', 'jpg', 'jpeg', 'webp'].includes(ext)) {
      warning.innerHTML = '';
      warning.appendChild(el('span', { style: 'flex: 1;' },
        `Subject reference must be a .png, .jpg, .jpeg or .webp file. Got: .${ext}`));
      warning.style.display = '';
      return;
    }
    warning.style.display = 'none';
    warning.innerHTML = '';
  }
  input.addEventListener('input', recheck);
  recheck();
  return warning;
}

