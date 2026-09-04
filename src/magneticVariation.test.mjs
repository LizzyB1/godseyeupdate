import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  declinationDegrees,
  declinationSampleStale,
  formatVariation,
  magneticHeadingDegrees,
  normalizeCompassDegrees,
} from './magneticVariation.js';

const DATE = new Date('2026-06-01T00:00:00Z');

test('east variation is subtracted from true heading, west added', () => {
  assert.equal(magneticHeadingDegrees(100, 12), 88);
  assert.equal(magneticHeadingDegrees(100, -12), 112);
  assert.equal(magneticHeadingDegrees(100, 0), 100);
});

test('magnetic heading wraps through north rather than reading negative or over 360', () => {
  assert.equal(magneticHeadingDegrees(5, 12), 353);
  assert.equal(magneticHeadingDegrees(355, -12), 7);
});

test('magnetic heading is unavailable without a true heading or a variation', () => {
  assert.equal(magneticHeadingDegrees(100, null), null);
  assert.equal(magneticHeadingDegrees(null, 12), null);
  assert.equal(magneticHeadingDegrees(Number.NaN, 12), null);
});

test('variation formats with its hemisphere, and reports when unavailable', () => {
  assert.equal(formatVariation(12.4), '12°E');
  assert.equal(formatVariation(-3.2), '3°W');
  assert.equal(formatVariation(0.1), '0°');
  assert.equal(formatVariation(null), '---');
});

test('normalizeCompassDegrees folds any angle into [0, 360)', () => {
  assert.equal(normalizeCompassDegrees(-10), 350);
  assert.equal(normalizeCompassDegrees(370), 10);
  assert.equal(normalizeCompassDegrees(360), 0);
  assert.equal(normalizeCompassDegrees(Number.NaN), null);
});

test('a cached variation sample survives small camera moves but not large ones', () => {
  const cached = { latitude: 37.77, longitude: -122.42, sampledMs: 1000 };
  assert.equal(declinationSampleStale(cached, 37.78, -122.43, 2000), false);
  assert.equal(declinationSampleStale(cached, 39, -122.42, 2000), true);
  assert.equal(declinationSampleStale(cached, 37.77, -120, 2000), true);
  assert.equal(declinationSampleStale(null, 37.77, -122.42, 2000), true);
});

test('a cached variation sample ages out even when the camera has not moved', () => {
  const cached = { latitude: 0, longitude: 0, sampledMs: 0 };
  assert.equal(declinationSampleStale(cached, 0, 0, 599000), false);
  assert.equal(declinationSampleStale(cached, 0, 0, 600000), true);
});

test('variation matches the published model within a degree at known locations', () => {
  // Reference values from NOAA's WMM calculator for 2026-06-01, sea level.
  assert.ok(Math.abs(declinationDegrees(37.77, -122.42, 0, DATE) - 12.9) < 1);
  assert.ok(Math.abs(declinationDegrees(51.5, -0.12, 0, DATE) - 1.1) < 1);
  assert.ok(Math.abs(declinationDegrees(-33.87, 151.21, 0, DATE) - 12.8) < 1);
});

test('variation is unavailable rather than fabricated outside the model window', () => {
  assert.equal(declinationDegrees(37.77, -122.42, 0, new Date('2099-01-01T00:00:00Z')), null);
  assert.equal(declinationDegrees(Number.NaN, -122.42, 0, DATE), null);
});
