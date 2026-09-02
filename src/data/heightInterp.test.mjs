import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickSampleIndices, interpolateHeights } from './heightInterp.js';

test('pickSampleIndices returns every index when count is under the cap', () => {
  assert.deepEqual(pickSampleIndices(5, 10), [0, 1, 2, 3, 4]);
});

test('pickSampleIndices always includes both endpoints', () => {
  const idx = pickSampleIndices(1000, 20);
  assert.equal(idx[0], 0);
  assert.equal(idx[idx.length - 1], 999);
  assert.ok(idx.length <= 20);
});

test('pickSampleIndices is strictly ascending with no duplicates', () => {
  const idx = pickSampleIndices(37, 9);
  for (let i = 1; i < idx.length; i += 1) assert.ok(idx[i] > idx[i - 1]);
});

test('pickSampleIndices handles a single point', () => {
  assert.deepEqual(pickSampleIndices(1, 10), [0]);
});

test('pickSampleIndices handles zero/negative count', () => {
  assert.deepEqual(pickSampleIndices(0, 10), []);
  assert.deepEqual(pickSampleIndices(-3, 10), []);
});

test('interpolateHeights reproduces exact values at sampled indices', () => {
  const out = interpolateHeights(5, [0, 4], [100, 200]);
  assert.equal(out[0], 100);
  assert.equal(out[4], 200);
});

test('interpolateHeights linearly interpolates between two samples', () => {
  const out = interpolateHeights(5, [0, 4], [0, 40]);
  assert.deepEqual(out, [0, 10, 20, 30, 40]);
});

test('interpolateHeights flat-extrapolates before the first and after the last sample', () => {
  const out = interpolateHeights(6, [2, 4], [50, 60]);
  assert.equal(out[0], 50);
  assert.equal(out[1], 50);
  assert.equal(out[5], 60);
});

test('interpolateHeights skips NaN samples when choosing interpolation endpoints', () => {
  const out = interpolateHeights(5, [0, 2, 4], [0, NaN, 40]);
  // Should interpolate straight from index 0 to index 4, ignoring the NaN at 2.
  assert.deepEqual(out, [0, 10, 20, 30, 40]);
});

test('interpolateHeights returns all-NaN when every sample failed', () => {
  const out = interpolateHeights(4, [0, 3], [NaN, NaN]);
  assert.ok(out.every((h) => Number.isNaN(h)));
});

test('interpolateHeights handles a single usable sample by flat-filling everything', () => {
  const out = interpolateHeights(4, [1], [77]);
  assert.deepEqual(out, [77, 77, 77, 77]);
});

test('interpolateHeights handles duplicate-index samples without dividing by zero', () => {
  const out = interpolateHeights(3, [1, 1], [10, 20]);
  assert.ok(out.every((h) => Number.isFinite(h)));
});
