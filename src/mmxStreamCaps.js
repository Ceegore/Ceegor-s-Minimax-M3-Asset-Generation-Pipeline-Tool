// src/mmxStreamCaps.js
// stdout/stderr buffer cap + truncation-marker logic for runMmx.
//
// The mmx child process can produce unbounded output (verbose logs, embedded
// base64, runaway progress). Accumulating that into a single JS string grows
// the V8 heap until the process crashes. Each stream is capped at a generous
// limit; the first time data is dropped, a single "[output truncated at N
// bytes]" marker is emitted so the user knows truncation happened. The marker
// fires regardless of whether the cap was reached by a single straddling
// chunk or by an aligned-chunk sequence.

const MAX_STDOUT_BYTES = 16 * 1024 * 1024;  // 16 MB
const MAX_STDERR_BYTES = 4 * 1024 * 1024;   // 4 MB

function makeCappedAppender() {
  const truncated = { stdout: false, stderr: false };
  return function append(stream, buf, s, max) {
    if (buf.length >= max) {
      // Already capped. Emit the marker ONCE on the first drop
      // so the user knows the output was truncated, then drop
      // the new data silently.
      if (!truncated[stream]) {
        truncated[stream] = true;
        return buf + '\n[output truncated at ' + max + ' bytes]\n';
      }
      return buf;
    }
    if (buf.length + s.length <= max) return buf + s;
    // Single-chunk straddle: truncate the new data so the final
    // error message (usually at the END of stderr) isn't the
    // part we drop. Keep the head + the marker.
    truncated[stream] = true;
    return buf + s.slice(0, Math.max(0, max - buf.length)) + '\n[output truncated at ' + max + ' bytes]\n';
  };
}

module.exports = { MAX_STDOUT_BYTES, MAX_STDERR_BYTES, makeCappedAppender };
