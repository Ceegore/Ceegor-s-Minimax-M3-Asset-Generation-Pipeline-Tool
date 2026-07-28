/**
 * Pure planning logic for segmenting sound clips (NO ffmpeg, NO fs).
 */

function sanitizeAutoCutRules(raw) {
  const r = raw || {};
  
  const minSegmentSec = (() => {
    const n = Number(r.minSegmentSec);
    return (Number.isFinite(n) && n >= 0.01) ? Math.min(60, n) : 0.15;
  })();

  const maxSegmentSec = (() => {
    const n = Number(r.maxSegmentSec);
    // 0 = unlimited is a valid EXPLICIT choice; a negative or non-finite value
    // is invalid → fall back to the documented default (3.0). The prior
    // `Math.max(0, ...)` clamped a corrupted -50 to 0 (unlimited), silently
    // switching the policy.
    return (Number.isFinite(n) && n >= 0) ? Math.min(300, n) : 3.0;
  })();

  const longSegmentPolicy = ['skip', 'truncate', 'split'].includes(r.longSegmentPolicy)
    ? r.longSegmentPolicy
    : 'truncate';

  const padMs = (() => {
    const n = Number(r.padMs);
    return Number.isFinite(n) ? Math.max(0, Math.min(5000, Math.round(n))) : 25;
  })();

  const maxSegments = (() => {
    const n = Number(r.maxSegments);
    return Number.isFinite(n) ? Math.max(0, Math.min(1000, Math.round(n))) : 20; // 0 = unlimited
  })();

  return {
    minSegmentSec,
    maxSegmentSec,
    longSegmentPolicy,
    padMs,
    maxSegments
  };
}

/**
 * Plans the auto-cut segments based on rules.
 *
 * @param {{start: number, end: number}[]} segments
 * @param {object} rules
 * @param {number} [duration]  total clip duration in seconds; used to clamp the
 *   end-padding of the final segment. The IPC handler always passes it (from
 *   probe()). When omitted, the clamp is skipped (treated as unbounded), which
 *   is acceptable for unit tests that supply already-bounded segments.
 */
function planAutoCut(segments, rules, duration) {
  const r = sanitizeAutoCutRules(rules);
  const { minSegmentSec, maxSegmentSec, longSegmentPolicy, padMs, maxSegments } = r;
  // Normalise duration: a finite positive number, else Infinity (= no upper clamp).
  const dur = (typeof duration === 'number' && Number.isFinite(duration) && duration > 0)
    ? duration
    : Infinity;

  let droppedShort = 0;
  let droppedLong = 0;   // segments dropped by the 'skip' policy (too long), kept separate from droppedShort
  let truncated = 0;
  let split = 0;

  // 1. Sort by start; drop segments shorter than minSegmentSec
  const sorted = segments
    .slice()
    .sort((a, b) => a.start - b.start);

  const currentSegments = [];

  for (const seg of sorted) {
    const len = seg.end - seg.start;
    if (len < minSegmentSec) {
      droppedShort++;
      continue;
    }

    if (maxSegmentSec > 0 && len > maxSegmentSec) {
      if (longSegmentPolicy === 'skip') {
        droppedLong++; // too-long segment dropped by 'skip' policy (distinct from too-short drops)
        continue;
      } else if (longSegmentPolicy === 'truncate') {
        currentSegments.push({ start: seg.start, end: seg.start + maxSegmentSec });
        truncated++;
      } else if (longSegmentPolicy === 'split') {
        split++;
        let tempStart = seg.start;
        const pieces = [];
        while (tempStart < seg.end) {
          let tempEnd = tempStart + maxSegmentSec;
          if (tempEnd >= seg.end) {
            pieces.push({ start: tempStart, end: seg.end });
            break;
          } else {
            pieces.push({ start: tempStart, end: tempEnd });
            tempStart = tempEnd;
          }
        }
        
        // merge last piece if too short
        if (pieces.length > 1) {
          const lastPiece = pieces[pieces.length - 1];
          const lastLen = lastPiece.end - lastPiece.start;
          if (lastLen < minSegmentSec) {
            const prevPiece = pieces[pieces.length - 2];
            prevPiece.end = lastPiece.end;
            pieces.pop();
          }
        }
        currentSegments.push(...pieces);
      }
    } else {
      currentSegments.push(seg);
    }
  }

  // 3. Apply padding
  const paddedSegments = [];
  for (let i = 0; i < currentSegments.length; i++) {
    const seg = currentSegments[i];
    let start = seg.start;
    let end = seg.end;

    const padSec = padMs / 1000;

    let maxStartPad = padSec;
    if (i > 0) {
      const gap = seg.start - currentSegments[i - 1].end;
      const halfGap = Math.max(0, gap / 2);
      if (halfGap < maxStartPad) maxStartPad = halfGap;
    }
    start -= maxStartPad;
    if (start < 0) start = 0;

    let maxEndPad = padSec;
    if (i < currentSegments.length - 1) {
      const gap = currentSegments[i + 1].start - seg.end;
      const halfGap = Math.max(0, gap / 2);
      if (halfGap < maxEndPad) maxEndPad = halfGap;
    }
    end += maxEndPad;
    if (end > dur) end = dur;

    paddedSegments.push({
      startSec: parseFloat(start.toFixed(4)),
      endSec: parseFloat(end.toFixed(4))
    });
  }

  // 4. Cap at maxSegments
  // `keptBeforeCap` is the number of segments that survived length/policy
  // filtering (the "planned" count). The renderer's stats line uses this for
  // "N segments planned" so the count is accurate even when maxSegments caps
  // some of them out of the final export list.
  const keptBeforeCap = paddedSegments.length;
  let finalSegments = paddedSegments;
  let capped = 0;
  if (maxSegments > 0 && finalSegments.length > maxSegments) {
    capped = finalSegments.length - maxSegments;
    finalSegments = finalSegments.slice(0, maxSegments);
  }

  return {
    segments: finalSegments,
    stats: {
      kept: keptBeforeCap,
      droppedShort,
      droppedLong,
      truncated,
      split,
      capped
    }
  };
}

module.exports = {
  sanitizeAutoCutRules,
  planAutoCut
};
