// src/data/vesselVectorMath.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  destinationPoint,
  projectVesselPosition,
  VECTOR_NEAR_MINUTES,
  VECTOR_FAR_MINUTES,
} from './vesselVectorMath.js';

const EARTH_RADIUS_M = 6371000;

/** Great-circle distance (m) between two lat/lon points — haversine, used
 *  only to verify destinationPoint's own output in these tests. */
function haversineM(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dPhi = toRad(lat2 - lat1);
  const dLambda = toRad(lon2 - lon1);
  const a = Math.sin(dPhi / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLambda / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

test('VECTOR_NEAR_MINUTES / VECTOR_FAR_MINUTES are the documented 6 and 20', () => {
  assert.equal(VECTOR_NEAR_MINUTES, 6);
  assert.equal(VECTOR_FAR_MINUTES, 20);
});

test('destinationPoint: due-north travel only changes latitude', () => {
  const start = { lat: 10, lon: 20 };
  const end = destinationPoint(start.lat, start.lon, 0, 10000);
  assert.ok(end.lat > start.lat);
  assert.ok(Math.abs(end.lon - start.lon) < 1e-9);
});

test('destinationPoint: due-east travel at the equator only changes longitude', () => {
  const start = { lat: 0, lon: 20 };
  const end = destinationPoint(start.lat, start.lon, 90, 10000);
  assert.ok(end.lon > start.lon);
  assert.ok(Math.abs(end.lat - start.lat) < 1e-9);
});

test('destinationPoint: known-distance sanity check via haversine round-trip', () => {
  const start = { lat: 29.7, lon: -95.1 };
  const bearing = 47;
  const distanceM = 10000;
  const end = destinationPoint(start.lat, start.lon, bearing, distanceM);
  const roundTrip = haversineM(start.lat, start.lon, end.lat, end.lon);
  assert.ok(
    Math.abs(roundTrip - distanceM) < 1,
    `expected ~${distanceM} m, got ${roundTrip} m`,
  );
});

test('projectVesselPosition: 30 kt for 6 minutes travels ~5556 m', () => {
  const start = { lat: 29.7, lon: -95.1 };
  const end = projectVesselPosition(start.lat, start.lon, 90, 30, 6);
  assert.ok(end, 'expected a projected point');
  const distanceM = haversineM(start.lat, start.lon, end.lat, end.lon);
  // 30 kt * 1852 m/nm * (6/60) h = 5556 m exactly.
  assert.ok(
    Math.abs(distanceM - 5556) < 1,
    `expected ~5556 m, got ${distanceM} m`,
  );
});

test('projectVesselPosition: null speed inputs all return null', () => {
  assert.equal(projectVesselPosition(10, 20, 90, 0, 6), null);
  assert.equal(projectVesselPosition(10, 20, 90, null, 6), null);
  assert.equal(projectVesselPosition(10, 20, 90, undefined, 6), null);
  assert.equal(projectVesselPosition(10, 20, 90, NaN, 6), null);
});

test('projectVesselPosition: missing/invalid course returns null', () => {
  assert.equal(projectVesselPosition(10, 20, null, 12, 6), null);
  assert.equal(projectVesselPosition(10, 20, undefined, 12, 6), null);
  assert.equal(projectVesselPosition(10, 20, NaN, 12, 6), null);
});

test('projectVesselPosition: negative speed returns null', () => {
  assert.equal(projectVesselPosition(10, 20, 90, -5, 6), null);
});

test('projectVesselPosition: a stationary but not-yet-anchored vessel (0 kt) draws no vector', () => {
  assert.equal(projectVesselPosition(10, 20, 90, 0, VECTOR_NEAR_MINUTES), null);
});
