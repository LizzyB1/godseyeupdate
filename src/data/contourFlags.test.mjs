import { test } from 'node:test';
import assert from 'node:assert/strict';
import { thinSpotsByStep, computeCenterBiasOffset } from './contourFlags.js';

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

// computePanelAvoidanceOffset/installFlagAvoidance aren't unit-tested here:
// both need a live `document` (panel element lookups) and a Cesium
// scene/viewer respectively, neither of which this DOM-free Node test
// environment provides — see hudAltitudeDatum.test.mjs for how a live
// Cesium/DOM test is done when it's actually worth the setup cost.
// computeCenterBiasOffset is plain arithmetic, so it's covered directly.

test('computeCenterBiasOffset returns no nudge for a point already in the central 3/4', () => {
  // 1000x800 canvas: central band is x in [125, 875], y in [100, 700].
  assert.deepEqual(computeCenterBiasOffset(500, 400, 1000, 800), { x: 0, y: 0 });
  assert.deepEqual(computeCenterBiasOffset(125, 100, 1000, 800), { x: 0, y: 0 });
  assert.deepEqual(computeCenterBiasOffset(875, 700, 1000, 800), { x: 0, y: 0 });
});

test('computeCenterBiasOffset nudges a point in the left/top margin inward', () => {
  const result = computeCenterBiasOffset(50, 30, 1000, 800);
  assert.equal(result.x, 75); // 125 - 50
  assert.equal(result.y, 70); // 100 - 30
});

test('computeCenterBiasOffset nudges a point in the right/bottom margin inward', () => {
  const result = computeCenterBiasOffset(950, 770, 1000, 800);
  assert.equal(result.x, -75); // 875 - 950
  assert.equal(result.y, -70); // 700 - 770
});

test('computeCenterBiasOffset nudges only the axis that is out of band', () => {
  const result = computeCenterBiasOffset(50, 400, 1000, 800);
  assert.equal(result.x, 75);
  assert.equal(result.y, 0);
});
