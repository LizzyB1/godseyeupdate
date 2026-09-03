/**
 * @file Thin wrapper over the `geomagnetism` package (a pure-JS World
 * Magnetic Model implementation, bundled WMM-2025/2020/2015 coefficient
 * sets, zero runtime deps) — gives `compassBox.js` the local magnetic
 * declination (the angle between true north and magnetic north) for
 * wherever the camera currently is.
 *
 * The model itself only depends on the DATE (Earth's field drifts slowly
 * year over year), not on lat/lon — `geomagnetism.model()` returns a model
 * object valid for a multi-year window and evaluates `.point([lat, lon])`
 * cheaply for any location. So the model is built once and reused across
 * every declination query until the calendar day rolls over, rather than
 * rebuilt per call.
 *
 * @module data/magneticDeclination
 */

import geomagnetism from 'geomagnetism';

let cachedModel = null;
let cachedModelDay = null; // 'YYYY-MM-DD', local to whichever Date got passed in

function dayKey(date) {
  return date.toISOString().slice(0, 10);
}

function getModel(date) {
  const key = dayKey(date);
  if (cachedModel && cachedModelDay === key) return cachedModel;
  try {
    cachedModel = geomagnetism.model(date, { allowOutOfBoundsModel: true });
    cachedModelDay = key;
  } catch (err) {
    // Genuinely out-of-range date (centuries away) — geomagnetism throws
    // even with allowOutOfBoundsModel in some edge cases; fall back to
    // "no model" rather than let a bad Date crash the compass box.
    cachedModel = null;
    cachedModelDay = key;
  }
  return cachedModel;
}

/**
 * Magnetic declination (variation) at a location: the angle you'd add to a
 * true bearing to get the corresponding magnetic-compass bearing.
 * Convention matches WMM: positive = magnetic north is EAST of true north,
 * negative = WEST.
 *
 * @param {number} lat - degrees, -90..90
 * @param {number} lon - degrees, -180..180
 * @param {Date} [date] - defaults to now
 * @returns {?{ declinationDeg: number, modelName: string }} null if the
 *   model couldn't be evaluated (e.g. a wildly out-of-range date).
 */
export function getMagneticDeclination(lat, lon, date = new Date()) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const model = getModel(date);
  if (!model) return null;
  try {
    const point = model.point([lat, lon]);
    if (!point || !Number.isFinite(point.decl)) return null;
    return { declinationDeg: point.decl, modelName: model.name || 'WMM' };
  } catch (err) {
    return null;
  }
}
