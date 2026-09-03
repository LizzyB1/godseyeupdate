import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getMagneticDeclination } from './magneticDeclination.js';

test('returns null for a non-finite lat/lon rather than throwing', () => {
  assert.equal(getMagneticDeclination(NaN, 5), null);
  assert.equal(getMagneticDeclination(5, undefined), null);
  assert.equal(getMagneticDeclination(5, Infinity), null);
});

test('returns a finite declination and a model name for an ordinary location', () => {
  const result = getMagneticDeclination(51.5, -0.1); // London
  assert.ok(result);
  assert.equal(typeof result.declinationDeg, 'number');
  assert.ok(Number.isFinite(result.declinationDeg));
  assert.equal(typeof result.modelName, 'string');
  assert.ok(result.modelName.length > 0);
});

test('declination stays within a sane real-world range', () => {
  // Nowhere on Earth currently has more than ~30deg of declination either way.
  for (const [lat, lon] of [[51.5, -0.1], [37.77, -122.4], [-33.87, 151.2], [35.68, 139.65], [0, 0]]) {
    const result = getMagneticDeclination(lat, lon);
    assert.ok(result, `expected a result for ${lat},${lon}`);
    assert.ok(Math.abs(result.declinationDeg) < 40, `declination ${result.declinationDeg} out of sane range for ${lat},${lon}`);
  }
});

test('repeated calls for the same day are consistent (cached model reused)', () => {
  const a = getMagneticDeclination(48.85, 2.35); // Paris
  const b = getMagneticDeclination(48.85, 2.35);
  assert.equal(a.declinationDeg, b.declinationDeg);
});

test('an explicit Date is honored (different epoch -> a valid, finite result)', () => {
  const result = getMagneticDeclination(40.71, -74.0, new Date('2021-06-01T00:00:00Z'));
  assert.ok(result);
  assert.ok(Number.isFinite(result.declinationDeg));
});
