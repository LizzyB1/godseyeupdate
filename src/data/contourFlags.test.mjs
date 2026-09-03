import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampToCenterCircle, thinSpotsByStep, spreadRingAngles } from './contourFlags.js';

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

test('spreadRingAngles leaves 0 or 1 angles alone', () => {
  assert.deepEqual(spreadRingAngles([], 0.5), []);
  assert.deepEqual(spreadRingAngles([1.2], 0.5), [1.2]);
});

test('spreadRingAngles leaves already-separated angles untouched', () => {
  const angles = [0, 1, 2, 3]; // 1 rad apart, well over a small minSep
  const result = spreadRingAngles(angles, 0.2);
  assert.deepEqual(result, angles);
});

test('spreadRingAngles pushes a too-close neighbor apart, preserving sort order', () => {
  const angles = [0, 0.01, 2]; // first two are nearly on top of each other
  const result = spreadRingAngles(angles, 0.5);
  // Sorted order was [0(idx0), 0.01(idx1), 2(idx2)] -> idx1 gets pushed to 0+0.5
  assert.equal(result[0], 0);
  assert.ok(Math.abs(result[1] - 0.5) < 1e-9);
  assert.equal(result[2], 2);
});

test('spreadRingAngles preserves the input order/length regardless of internal sorting', () => {
  const angles = [2, 0, 1]; // deliberately out of order
  const result = spreadRingAngles(angles, 0.1);
  assert.equal(result.length, 3);
  // Values close to originals since they're already > 0.1 apart pairwise.
  assert.ok(Math.abs(result[0] - 2) < 1e-9);
  assert.ok(Math.abs(result[1] - 0) < 1e-9);
  assert.ok(Math.abs(result[2] - 1) < 1e-9);
});

test('spreadRingAngles fans everything out evenly when crowded past what sequential spreading can fit', () => {
  // 5 angles all crammed within a tiny arc — sequential push alone can't
  // give them all room without a fallback fan-out.
  const angles = [0, 0.01, 0.02, 0.03, 0.04];
  const minSep = 0.5;
  const result = spreadRingAngles(angles, minSep);
  const sorted = [...result].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i += 1) {
    assert.ok(sorted[i] - sorted[i - 1] >= minSep - 1e-9, `gap ${sorted[i] - sorted[i - 1]} < ${minSep}`);
  }
});

test('spreadRingAngles falls back to an even fan when sequential spreading would overshoot a full circle', () => {
  // 8 angles all near 0, with a minSep large enough that pushing them
  // sequentially (7 gaps of 1.0 rad = 7 rad total) overshoots 2*PI (~6.28)
  // — this must trigger the fallback fan rather than leave them wrapped
  // past a full turn.
  const angles = Array.from({ length: 8 }, (_, i) => i * 0.001);
  const result = spreadRingAngles(angles, 1.0);
  assert.equal(result.length, 8);
  for (const a of result) assert.ok(Number.isFinite(a));
  // Every value stays within one turn of the start.
  const sorted = [...result].sort((a, b) => a - b);
  assert.ok(sorted[sorted.length - 1] - sorted[0] <= Math.PI * 2 + 1e-9);
});

test('spreadRingAngles never throws and returns finite angles for a large crowded set', () => {
  const angles = Array.from({ length: 20 }, (_, i) => i * 0.001); // 20 flags, all within ~0.02 rad
  const result = spreadRingAngles(angles, 0.3);
  assert.equal(result.length, 20);
  for (const a of result) assert.ok(Number.isFinite(a));
});
