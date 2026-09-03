/**
 * @file Pure coordinate-formatting helpers — degrees/minutes/seconds in
 * maritime/aviation convention (no decimal degrees), plus small link/text
 * builders for the cursor-tool output box. Cesium-free by design so it's
 * unit-testable without a DOM/WebGL context.
 *
 * @module data/coordFormat
 */

/**
 * One signed decimal-degree value → maritime DMS: `DD°MM'SS"H` (latitude,
 * 2-digit degrees) or `DDD°MM'SS"H` (longitude, 3-digit degrees), hemisphere
 * letter instead of a sign, seconds rounded to a whole number (never a
 * decimal — that's the point of DMS over decimal degrees).
 * @param {number} deg - Signed decimal degrees.
 * @param {boolean} isLatitude - true for latitude (N/S, 2-digit degrees), false for longitude (E/W, 3-digit degrees).
 * @returns {string}
 */
export function toDMS(deg, isLatitude) {
  if (!Number.isFinite(deg)) return '—';
  const hemisphere = isLatitude ? (deg < 0 ? 'S' : 'N') : (deg < 0 ? 'W' : 'E');
  const abs = Math.abs(deg);
  let wholeDeg = Math.floor(abs);
  let minutesFull = (abs - wholeDeg) * 60;
  let minutes = Math.floor(minutesFull);
  let seconds = Math.round((minutesFull - minutes) * 60);
  if (seconds >= 60) { seconds -= 60; minutes += 1; }
  if (minutes >= 60) { minutes -= 60; wholeDeg += 1; }
  const degPad = String(wholeDeg).padStart(isLatitude ? 2 : 3, '0');
  const minPad = String(minutes).padStart(2, '0');
  const secPad = String(seconds).padStart(2, '0');
  return `${degPad}°${minPad}'${secPad}"${hemisphere}`;
}

/**
 * A lat/lon pair as a single maritime-DMS string, e.g. `38°54'26"N 077°02'13"W`.
 * @param {number} lat
 * @param {number} lon
 * @returns {string}
 */
export function formatLatLonDMS(lat, lon) {
  return `${toDMS(lat, true)} ${toDMS(lon, false)}`;
}

/**
 * Decimal-degree pair, fixed to 6 places (~0.1 m precision) — offered
 * alongside DMS in the cursor output box for anyone who wants to paste
 * decimal coordinates instead.
 */
export function formatLatLonDecimal(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return '—';
  return `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
}

/** A Google Maps link for a lat/lon pair, shareable as-is. */
export function googleMapsLink(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return '';
  return `https://www.google.com/maps?q=${lat.toFixed(6)},${lon.toFixed(6)}`;
}

/** Meters → a short human height string, whole meters, metric only. */
export function formatHeight(meters) {
  if (!Number.isFinite(meters)) return '—';
  return `${Math.round(meters).toLocaleString('en-US')} m`;
}
