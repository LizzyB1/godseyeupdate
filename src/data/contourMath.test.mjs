import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marchingSquaresSegments, gridToLonLat, westmostSegmentPoint } from './contourMath.js';

test('a flat grid produces no segments at any level away from its value', () => {
  const heights = [10, 10, 10, 10, 10, 10, 10, 10, 10]; // 3x3, all 10
  assert.deepEqual(marchingSquaresSegments(heights, 3, 3, 5), []);
  assert.deepEqual(marchingSquaresSegments(heights, 3, 3, 15), []);
});

test('a simple left-low/right-high ramp crosses down the middle column', () => {
  // 2x2 grid: left column 0, right column 10 — level 5 crosses the
  // midpoint of both the top and bottom edges, giving one vertical segment.
  const heights = [0, 10, 0, 10]; // row-major: (0,0)=0 (0,1)=10 (1,0)=0 (1,1)=10
  const segs = marchingSquaresSegments(heights, 2, 2, 5);
  assert.equal(segs.length, 1);
  const [a, b] = segs[0];
  // top edge crossing at x=0.5,y=0 ; bottom edge crossing at x=0.5,y=1
  const pts = [a, b].sort((p, q) => p.y - q.y);
  assert.equal(pts[0].x, 0.5);
  assert.equal(pts[0].y, 0);
  assert.equal(pts[1].x, 0.5);
  assert.equal(pts[1].y, 1);
});

test('a top-low/bottom-high ramp crosses the two vertical edges, not the horizontal ones', () => {
  const heights = [0, 0, 100, 100]; // top row 0, bottom row 100 (2x2)
  const segs = marchingSquaresSegments(heights, 2, 2, 50);
  assert.equal(segs.length, 1);
  // Should cross the two vertical edges (left and right), giving one
  // horizontal-ish segment, not the top/bottom edges (which don't cross).
  const [a, b] = segs[0];
  assert.ok((a.y === 0.5 || b.y === 0.5));
});

test('a saddle cell (diagonal corners on the same side) still produces two segments, not zero', () => {
  // Classic saddle: high corners on the main diagonal, low on the other.
  const heights = [10, 0, 0, 10]; // (0,0)=10 (0,1)=0 (1,0)=0 (1,1)=10
  const segs = marchingSquaresSegments(heights, 2, 2, 5);
  assert.equal(segs.length, 2);
});

test('a NaN corner skips the whole cell rather than throwing or producing a bogus segment', () => {
  const heights = [0, 10, NaN, 10];
  assert.doesNotThrow(() => marchingSquaresSegments(heights, 2, 2, 5));
  assert.deepEqual(marchingSquaresSegments(heights, 2, 2, 5), []);
});

test('gridToLonLat maps row 0 to the north edge and the last row to the south edge', () => {
  const bounds = { west: -10, south: 30, east: 10, north: 50 };
  const nw = gridToLonLat(0, 0, 3, 3, bounds.west, bounds.south, bounds.east, bounds.north);
  assert.equal(nw.lon, -10);
  assert.equal(nw.lat, 50);
  const se = gridToLonLat(2, 2, 3, 3, bounds.west, bounds.south, bounds.east, bounds.north);
  assert.equal(se.lon, 10);
  assert.equal(se.lat, 30);
  const center = gridToLonLat(1, 1, 3, 3, bounds.west, bounds.south, bounds.east, bounds.north);
  assert.equal(center.lon, 0);
  assert.equal(center.lat, 40);
});

test('westmostSegmentPoint returns null for an empty segment list', () => {
  assert.equal(westmostSegmentPoint([], 3, 3, -10, 30, 10, 50), null);
});

test('westmostSegmentPoint picks the endpoint with the smallest longitude, across multiple segments', () => {
  const bounds = { west: -10, south: 30, east: 10, north: 50 };
  const segments = [
    [{ x: 2, y: 0 }, { x: 2, y: 2 }], // both at grid-x=2 -> lon = -10 + (2/2)*20 = 10 (east edge)
    [{ x: 0, y: 1 }, { x: 1, y: 1 }], // grid-x=0 -> lon=-10 (west edge); grid-x=1 -> lon=0
  ];
  const result = westmostSegmentPoint(segments, 3, 3, bounds.west, bounds.south, bounds.east, bounds.north);
  assert.equal(result.lon, -10);
  assert.equal(result.lat, 40); // grid-y=1 -> mid latitude
});

test('westmostSegmentPoint is stable when every endpoint shares the same longitude', () => {
  const bounds = { west: -10, south: 30, east: 10, north: 50 };
  const segments = [[{ x: 1, y: 0 }, { x: 1, y: 2 }]];
  const result = westmostSegmentPoint(segments, 3, 3, bounds.west, bounds.south, bounds.east, bounds.north);
  assert.equal(result.lon, 0);
  assert.ok(result.lat === 50 || result.lat === 30);
});
