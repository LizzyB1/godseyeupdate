import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  thinSpotsByStep, computeCenterBiasOffset, estimateLabelBox, resolveLabelOverlap,
} from './contourFlags.js';

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

// estimateLabelBox / resolveLabelOverlap back installFlagAvoidance's
// mutual label-avoidance (labels nudging apart from EACH OTHER, not just
// away from control panels) — both are plain arithmetic, covered directly
// the same way computeCenterBiasOffset is above.

test('estimateLabelBox centers a box above its anchor (CENTER/BOTTOM label origin)', () => {
  const box = estimateLabelBox(100, 200, '350m', 20);
  assert.ok(box.left < 100 && box.right > 100, 'box should straddle the anchor x horizontally');
  assert.equal(box.bottom, 200, 'box bottom should sit exactly at the anchor (VerticalOrigin.BOTTOM)');
  assert.ok(box.top < 200, 'box should extend upward from the anchor');
  assert.ok(box.right - box.left > 0 && box.bottom - box.top > 0);
});

test('estimateLabelBox widens with longer text and larger font size', () => {
  const short = estimateLabelBox(0, 0, '5m', 20);
  const long = estimateLabelBox(0, 0, '1,250m', 20);
  assert.ok((long.right - long.left) > (short.right - short.left));
  const small = estimateLabelBox(0, 0, '350m', 12);
  const big = estimateLabelBox(0, 0, '350m', 40);
  assert.ok((big.right - big.left) > (small.right - small.left));
  assert.ok((big.bottom - big.top) > (small.bottom - small.top));
});

test('resolveLabelOverlap keeps a label at its natural position when nothing else is placed yet', () => {
  const box = estimateLabelBox(100, 100, '350m', 20);
  const result = resolveLabelOverlap(box, []);
  assert.deepEqual(result, { visible: true, extraY: 0 });
});

test('resolveLabelOverlap nudges a label clear of one directly on top of it', () => {
  const box = estimateLabelBox(100, 100, '350m', 20);
  const placed = [estimateLabelBox(100, 100, '400m', 20)]; // identical position — a direct hit
  const result = resolveLabelOverlap(box, placed);
  assert.equal(result.visible, true);
  assert.notEqual(result.extraY, 0, 'a colliding label must move off its natural position');
  const shifted = { left: box.left, right: box.right, top: box.top + result.extraY, bottom: box.bottom + result.extraY };
  const stillOverlaps = shifted.left < placed[0].right && shifted.right > placed[0].left
    && shifted.top < placed[0].bottom && shifted.bottom > placed[0].top;
  assert.equal(stillOverlaps, false, 'the resolved nudge must actually clear the placed box');
});

test('resolveLabelOverlap leaves a label untouched when it only overlaps boxes far away horizontally', () => {
  const box = estimateLabelBox(100, 100, '350m', 20);
  const placed = [estimateLabelBox(900, 100, '400m', 20)]; // same y, far enough away in x not to overlap
  const result = resolveLabelOverlap(box, placed);
  assert.deepEqual(result, { visible: true, extraY: 0 });
});

test('resolveLabelOverlap hides a label that cannot find a clear spot among many stacked competitors', () => {
  const box = estimateLabelBox(100, 100, '350m', 20);
  // Densely stack same-position boxes at every vertical step the resolver
  // would try, so none of its candidate offsets clears all of them.
  const placed = [];
  for (let step = -4; step <= 4; step += 1) {
    placed.push(estimateLabelBox(100, 100 + step * 8, '400m', 20));
  }
  const result = resolveLabelOverlap(box, placed);
  assert.equal(result.visible, false);
});
