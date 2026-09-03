import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampToCenterCircle, thinSpotsByStep } from './contourFlags.js';

test('clampToCenterCircle leaves a point inside the circle untouched', () => {
  // 1000x800 canvas -> center (500,400), radius = 0.38*800 = 304.
  const result = clampToCenterCircle(520, 420, 1000, 800);
  assert.equal(result.x, 520);
  assert.equal(result.y, 420);
});

test('clampToCenterCircle pulls a far point onto the circle edge, same direction', () => {
  const width = 1000;
  const height = 800;
  const radius = Math.min(width, height) * 0.38;
  // Straight right of center, far past the circle.
  const result = clampToCenterCircle(1500, 400, width, height);
  assert.ok(Math.abs(result.x - (500 + radius)) < 1e-6);
  assert.ok(Math.abs(result.y - 400) < 1e-6);
});

test('clampToCenterCircle preserves direction for an off-axis far point', () => {
  const width = 1000;
  const height = 800;
  const centerX = 500;
  const centerY = 400;
  const radius = Math.min(width, height) * 0.38;
  const result = clampToCenterCircle(2000, 1600, width, height);
  const dist = Math.hypot(result.x - centerX, result.y - centerY);
  assert.ok(Math.abs(dist - radius) < 1e-6);
  // Same direction as the original (2000,1600) point from center.
  const origAngle = Math.atan2(1600 - centerY, 2000 - centerX);
  const clampedAngle = Math.atan2(result.y - centerY, result.x - centerX);
  assert.ok(Math.abs(origAngle - clampedAngle) < 1e-9);
});

test('clampToCenterCircle leaves the exact center untouched (no divide-by-zero)', () => {
  const result = clampToCenterCircle(500, 400, 1000, 800);
  assert.equal(result.x, 500);
  assert.equal(result.y, 400);
});

test('thinSpotsByStep with step 1 returns every spot, unchanged', () => {
  const spots = new Map([[10, { lon: 1, lat: 1 }], [20, { lon: 2, lat: 2 }], [30, { lon: 3, lat: 3 }]]);
  const result = thinSpotsByStep(spots, 1);
  assert.equal(result.size, 3);
});

test('thinSpotsByStep with step 2 keeps every other spot in insertion order', () => {
  const spots = new Map([[10, { lon: 1, lat: 1 }], [20, { lon: 2, lat: 2 }], [30, { lon: 3, lat: 3 }], [40, { lon: 4, lat: 4 }]]);
  const result = thinSpotsByStep(spots, 2);
  assert.deepEqual([...result.keys()], [10, 30]);
});

test('thinSpotsByStep with step 3 keeps every third spot', () => {
  const spots = new Map([[10, {}], [20, {}], [30, {}], [40, {}], [50, {}], [60, {}], [70, {}]]);
  const result = thinSpotsByStep(spots, 3);
  assert.deepEqual([...result.keys()], [10, 40, 70]);
});

test('thinSpotsByStep treats a non-finite or sub-1 step as 1 (no thinning)', () => {
  const spots = new Map([[10, {}], [20, {}], [30, {}]]);
  assert.equal(thinSpotsByStep(spots, 0).size, 3);
  assert.equal(thinSpotsByStep(spots, -5).size, 3);
  assert.equal(thinSpotsByStep(spots, NaN).size, 3);
});
