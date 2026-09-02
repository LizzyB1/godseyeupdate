/**
 * @file Pure sparse-sample-then-interpolate height assignment. Given real
 * heights sampled at only a subset of indices into a longer point array
 * (because sampling every point of a very long GPS track against the live
 * scene isn't worth doing point-by-point), fill in the rest by linear
 * interpolation between the surrounding sampled indices, with flat
 * extrapolation past the first/last sample. Cesium-free and
 * unit-testable, mirroring `contourMath.js`'s pure-logic convention —
 * `data/gpsTracks.js` is the caller.
 *
 * @module data/heightInterp
 */

/**
 * Pick which indices of a `count`-long array to actually sample, evenly
 * spaced and always including both endpoints, capped at `maxSamples`.
 * @param {number} count - total number of points needing a height.
 * @param {number} maxSamples - cap on how many indices to sample.
 * @returns {number[]} strictly increasing sample indices.
 */
export function pickSampleIndices(count, maxSamples) {
  if (!(count > 0)) return [];
  if (count === 1) return [0];
  const cap = Math.max(2, Math.min(Math.floor(maxSamples) || 2, count));
  if (cap >= count) return Array.from({ length: count }, (_, i) => i);
  const picked = [];
  for (let i = 0; i < cap; i += 1) {
    picked.push(Math.round((i / (cap - 1)) * (count - 1)));
  }
  // Rounding can collide at high sample density near either end — de-dupe
  // while preserving ascending order.
  return [...new Set(picked)];
}

/**
 * Fill heights for every index `0..count-1` by linearly interpolating
 * between the given sparse `(index, height)` samples. A `NaN` sample
 * (failed scene lookup at that index) is skipped when choosing
 * interpolation endpoints, exactly as if it had never been sampled.
 * Indices before the first usable sample or after the last reuse that
 * sample's height (flat extrapolation). If no sample is usable at all,
 * every entry comes back `NaN` — callers are expected to fall back further
 * (e.g. to a file's own recorded elevation) themselves.
 * @param {number} count
 * @param {number[]} sampleIndices - ascending; same length as `sampleHeights`.
 * @param {number[]} sampleHeights - may contain `NaN` for a failed sample.
 * @returns {number[]} length `count`.
 */
export function interpolateHeights(count, sampleIndices, sampleHeights) {
  const out = new Array(Math.max(0, count)).fill(NaN);
  const pairs = [];
  for (let i = 0; i < sampleIndices.length; i += 1) {
    const h = sampleHeights[i];
    if (Number.isFinite(h)) pairs.push({ idx: sampleIndices[i], h });
  }
  if (!pairs.length) return out;

  for (let i = 0; i < out.length; i += 1) {
    if (i <= pairs[0].idx) { out[i] = pairs[0].h; continue; }
    const last = pairs[pairs.length - 1];
    if (i >= last.idx) { out[i] = last.h; continue; }

    // Binary search for the bracketing pair (pairs is ascending by idx).
    let lo = 0;
    let hi = pairs.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (pairs[mid].idx <= i) lo = mid; else hi = mid;
    }
    const a = pairs[lo];
    const b = pairs[hi];
    const t = a.idx === b.idx ? 0 : (i - a.idx) / (b.idx - a.idx);
    out[i] = a.h + (b.h - a.h) * t;
  }
  return out;
}
