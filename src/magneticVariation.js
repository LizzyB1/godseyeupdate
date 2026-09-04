import { getMagneticDeclination } from './data/magneticDeclination.js';

/**
 * @file Magnetic variation (declination) for the camera orientation readout.
 *
 * A compass heading is only meaningful against a stated reference: Cesium
 * reports heading relative to true north, while a handheld/aircraft compass
 * reads relative to magnetic north. The difference — variation, east
 * positive — comes from the World Magnetic Model via
 * `data/magneticDeclination.js`, the same wrapper the Compass mini-box
 * uses, evaluated at the camera's own ground position.
 *
 * That box recomputes on a debounced `moveEnd`; this readout is driven from
 * `postRender`, so it needs its own guard against evaluating the model
 * every frame. Variation changes by well under a tenth of a degree over a
 * few kilometres, so `declinationDegrees` caches the last result and only
 * recomputes once the sample point has moved appreciably or the cache has
 * aged out.
 *
 * @module magneticVariation
 */

/** Cache invalidation distance, in degrees of latitude/longitude. */
const RESAMPLE_DEGREES = 0.25;
/** Cache lifetime, in milliseconds — covers secular drift and date rollover. */
const RESAMPLE_INTERVAL_MS = 600000;

/** Degrees → [0, 360). */
export function normalizeCompassDegrees(deg) {
  if (!Number.isFinite(deg)) return null;
  const wrapped = deg % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/**
 * Magnetic heading for a true heading and the local variation.
 * @param {number} trueHeadingDeg - heading relative to true north.
 * @param {?number} declinationDeg - variation, east positive.
 * @returns {?number} null when either input is unavailable.
 */
export function magneticHeadingDegrees(trueHeadingDeg, declinationDeg) {
  if (!Number.isFinite(trueHeadingDeg) || !Number.isFinite(declinationDeg)) return null;
  return normalizeCompassDegrees(trueHeadingDeg - declinationDeg);
}

/**
 * Variation as a compact `12°E` / `3°W` / `0°` string.
 * @param {?number} declinationDeg - east positive.
 * @returns {string} `'---'` when unavailable.
 */
export function formatVariation(declinationDeg) {
  if (!Number.isFinite(declinationDeg)) return '---';
  const rounded = Math.round(declinationDeg);
  if (rounded === 0) return '0°';
  return `${Math.abs(rounded)}°${rounded > 0 ? 'E' : 'W'}`;
}

/**
 * Whether a cached variation sample still describes this position and time.
 * @param {?{latitude: number, longitude: number, sampledMs: number}} cached
 * @param {number} latitude
 * @param {number} longitude
 * @param {number} nowMs
 * @returns {boolean}
 */
export function declinationSampleStale(cached, latitude, longitude, nowMs) {
  if (!cached) return true;
  if (nowMs - cached.sampledMs >= RESAMPLE_INTERVAL_MS) return true;
  return Math.abs(cached.latitude - latitude) >= RESAMPLE_DEGREES
    || Math.abs(cached.longitude - longitude) >= RESAMPLE_DEGREES;
}

let cachedSample = null;

/**
 * Magnetic variation at a position, east positive, cached between calls so it
 * is safe to call every rendered frame.
 * @param {number} latitude - degrees.
 * @param {number} longitude - degrees.
 * @param {Date} [date]
 * @returns {?number} null when the model cannot be evaluated for this position/date.
 */
export function declinationDegrees(latitude, longitude, date = new Date()) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const nowMs = date.getTime();
  if (!declinationSampleStale(cachedSample, latitude, longitude, nowMs)) {
    return cachedSample.declination;
  }
  const sample = getMagneticDeclination(latitude, longitude, date);
  const declination = sample ? sample.declinationDeg : null;
  cachedSample = { latitude, longitude, sampledMs: nowMs, declination };
  return declination;
}
