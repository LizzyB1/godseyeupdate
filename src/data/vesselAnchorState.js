/**
 * @file Pure sustained-low-speed tracker behind the AIS "inferred anchored"
 * icon. Cesium-free and unit-testable — `src/data/aisLiveVessels.js` calls
 * `trackLowSpeed` once per refresh per vessel and carries the returned
 * `lowSpeedSinceMs`/`inferredAnchored` pair forward on the persistent vessel
 * record (never on the throwaway freshly-normalized row), the same way it
 * carries every other piece of cross-refresh vessel identity.
 *
 * WHY THIS EXISTS: this AIS feed does not surface a reliable AIS
 * NavigationalStatus ("at anchor") field, so "anchored" here is always a
 * guess inferred from speed alone — hence "inferred" and the "?" badge on
 * the rendered icon (see `aisLiveVessels.js`'s `anchoredIcon`). A single slow
 * reading proves nothing (a vessel mid-turn, easing into a berth, or riding
 * a momentary GPS/AIS glitch can all report near-zero speed for one fix), so
 * the state only flips once the low reading has been sustained.
 *
 * @module data/vesselAnchorState
 */

/** Below this speed (kt) a report counts as "low" — strictly less than, so a
 *  reading of exactly the threshold does NOT start/continue the sustain
 *  timer. AIS speed-over-ground noise floor sits well under this. */
export const ANCHOR_SPEED_THRESHOLD_KT = 0.2;

/**
 * How long a vessel must report continuous sub-threshold speed before it is
 * flagged as inferred-anchored. AIS refreshes in this feed land roughly
 * every 60 s (REFRESH_MS in aisLiveVessels.js), so 15 minutes is a dozen-plus
 * consecutive low readings — long enough that a momentary slow-down, a tight
 * turn, or one bad fix can't trip it, short enough that a vessel actually
 * anchoring or mooring gets flagged promptly rather than many refreshes late.
 */
export const ANCHOR_SUSTAIN_MS = 15 * 60 * 1000;

/**
 * Fold one fresh speed reading into a vessel's low-speed sustain tracking.
 * Any invalid or at-or-above-threshold reading resets the timer outright —
 * deliberately conservative, so a single bad/missing sample can't either
 * start a false countdown or (worse) silently keep an old one running past
 * a vessel that has since got underway again.
 * @param {{lowSpeedSinceMs: number|null}|null|undefined} prevState - The
 *   vessel record's own previous tracking fields, or nothing for a vessel
 *   seen for the first time this session.
 * @param {number} speedKt - This refresh's reported speed over ground, knots.
 * @param {number} nowMs - Current time (epoch ms).
 * @returns {{lowSpeedSinceMs: number|null, inferredAnchored: boolean}}
 */
export function trackLowSpeed(prevState, speedKt, nowMs) {
  if (!Number.isFinite(speedKt) || speedKt < 0 || speedKt >= ANCHOR_SPEED_THRESHOLD_KT) {
    return { lowSpeedSinceMs: null, inferredAnchored: false };
  }
  const since = Number.isFinite(prevState?.lowSpeedSinceMs) ? prevState.lowSpeedSinceMs : nowMs;
  return {
    lowSpeedSinceMs: since,
    inferredAnchored: (nowMs - since) >= ANCHOR_SUSTAIN_MS,
  };
}
