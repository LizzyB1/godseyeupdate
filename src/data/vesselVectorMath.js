/**
 * @file Pure spherical-trig helpers for the AIS course/speed predictor vector
 * (classic ECDIS/radar "where will it be" line). Cesium-free and
 * unit-testable — `src/data/aisLiveVessels.js` feeds a vessel's current
 * lat/lon/course/speed through `projectVesselPosition` and converts the
 * returned lat/lon back to a Cartesian3 at the same sea-surface datum the
 * vessel's own billboard uses, so the vector never floats above or clips
 * below the rendered hull.
 *
 * @module data/vesselVectorMath
 */

/** Mean WGS84 radius (m). Adequate for a short-range display vector — this
 *  is not a navigation-grade great-circle calculation, and the ellipsoid's
 *  ~0.3% flattening is invisible over the few-km reach of a 20-minute leg. */
const EARTH_RADIUS_M = 6371000;

/** Minutes ahead for the bright/near leg of the predictor vector. */
export const VECTOR_NEAR_MINUTES = 6;

/** Minutes ahead for the dim/far leg of the predictor vector. */
export const VECTOR_FAR_MINUTES = 20;

/** 1 knot = 1 nautical mile/hour = 1852 m/h. */
const METERS_PER_KNOT_HOUR = 1852;

/**
 * Destination point given a start point, initial bearing, and distance along
 * a great circle — the standard spherical "direct" geodesy problem.
 * @param {number} lat - Start latitude, degrees.
 * @param {number} lon - Start longitude, degrees.
 * @param {number} bearingDeg - Initial bearing, degrees clockwise from north.
 * @param {number} distanceM - Distance to travel, meters.
 * @returns {{lat: number, lon: number}}
 */
export function destinationPoint(lat, lon, bearingDeg, distanceM) {
  const delta = distanceM / EARTH_RADIUS_M;
  const theta = (bearingDeg * Math.PI) / 180;
  const phi1 = (lat * Math.PI) / 180;
  const lambda1 = (lon * Math.PI) / 180;

  const phi2 = Math.asin(
    Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta)
  );
  const lambda2 = lambda1 + Math.atan2(
    Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
    Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2)
  );

  return {
    lat: (phi2 * 180) / Math.PI,
    lon: (lambda2 * 180) / Math.PI,
  };
}

/**
 * Project where a vessel will be `minutesAhead` from now, assuming it holds
 * its current course and speed — the standard ECDIS/radar dead-reckoning
 * vector. Returns null for anything that can't produce a meaningful vector:
 * a non-finite course, a non-finite speed, or a vessel that isn't actually
 * making way (speed <= 0 — including exactly 0, which is a stopped/anchored
 * vessel with no direction of travel to draw). Feature B's "inferred
 * anchored" state is a separate, sustained-low-speed judgment layered on top
 * by the caller; this function only guards the arithmetic.
 * @param {number} lat - Current latitude, degrees.
 * @param {number} lon - Current longitude, degrees.
 * @param {number} courseDeg - Current course/heading, degrees clockwise from north.
 * @param {number} speedKt - Current speed over ground, knots.
 * @param {number} minutesAhead - Minutes to project forward.
 * @returns {{lat: number, lon: number}|null}
 */
export function projectVesselPosition(lat, lon, courseDeg, speedKt, minutesAhead) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (!Number.isFinite(courseDeg) || !Number.isFinite(speedKt)) return null;
  if (!Number.isFinite(minutesAhead) || minutesAhead <= 0) return null;
  if (speedKt <= 0) return null;

  const distanceM = speedKt * METERS_PER_KNOT_HOUR * (minutesAhead / 60);
  return destinationPoint(lat, lon, courseDeg, distanceM);
}
