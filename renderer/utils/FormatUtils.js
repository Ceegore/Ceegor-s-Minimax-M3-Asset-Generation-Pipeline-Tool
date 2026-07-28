// renderer/utils/FormatUtils.js
// Reine Format-Helfer ohne externen State.

function bytesToHuman(n) {
  if (typeof n !== 'number' || !isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function secondsToHMS(s) {
  if (typeof s !== 'number' || !isFinite(s) || s < 0) return '—';
  const total = Math.round(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function pad2(n) { return String(n).padStart(2, '0'); }

function isoLocal(d) {
  d = d || new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
         `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/**
 * "YYYY-MM-DD HH:MM" im lokalen Timezone. Locale-agnostisch,
 * damit zwei User in unterschiedlichen Zeitzonen dasselbe Bild
 * teilen können. Gibt "—" zurück für null/NaN/0.
 * @param {number} ms
 * @returns {string}
 */
function formatLocalShort(ms) {
  if (!ms || typeof ms !== 'number') return '—';
  const d = new Date(ms);
  if (isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
         `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

window.FormatUtils = { bytesToHuman, secondsToHMS, pad2, isoLocal, formatLocalShort };
