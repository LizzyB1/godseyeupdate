import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  marchingSquaresSegments, gridToLonLat, westmostSegmentPoint,
  extremeSegmentPoint, stitchSegmentsIntoPolylines, smoothPolyline,
} from './contourMath.js';

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

test('extremeSegmentPoint picks east/north/south correctly, matching westmostSegmentPoint for west', () => {
  const bounds = { west: -10, south: 30, east: 10, north: 50 };
  const segments = [
    [{ x: 2, y: 0 }, { x: 2, y: 2 }], // lon = 10 (east edge), lat spans 50..30
    [{ x: 0, y: 1 }, { x: 1, y: 1 }], // lon = -10 (west edge), lon = 0
  ];
  const east = extremeSegmentPoint(segments, 3, 3, bounds.west, bounds.south, bounds.east, bounds.north, 'east');
  assert.equal(east.lon, 10);
  const north = extremeSegmentPoint(segments, 3, 3, bounds.west, bounds.south, bounds.east, bounds.north, 'north');
  assert.equal(north.lat, 50);
  const south = extremeSegmentPoint(segments, 3, 3, bounds.west, bounds.south, bounds.east, bounds.north, 'south');
  assert.equal(south.lat, 30);
  const west = extremeSegmentPoint(segments, 3, 3, bounds.west, bounds.south, bounds.east, bounds.north, 'west');
  assert.deepEqual(west, westmostSegmentPoint(segments, 3, 3, bounds.west, bounds.south, bounds.east, bounds.north));
});

test('extremeSegmentPoint returns null for an empty segment list', () => {
  assert.equal(extremeSegmentPoint([], 3, 3, -10, 30, 10, 50, 'north'), null);
});

test('stitchSegmentsIntoPolylines joins two segments sharing an endpoint into one open chain', () => {
  const segments = [
    [{ x: 0, y: 0 }, { x: 1, y: 0 }],
    [{ x: 1, y: 0 }, { x: 2, y: 1 }],
  ];
  const chains = stitchSegmentsIntoPolylines(segments);
  assert.equal(chains.length, 1);
  assert.equal(chains[0].closed, false);
  assert.deepEqual(chains[0].points, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 1 }]);
});

test('stitchSegmentsIntoPolylines joins segments arriving in scattered order, reversing as needed', () => {
  const segments = [
    [{ x: 2, y: 1 }, { x: 1, y: 0 }], // reversed relative to chain direction
    [{ x: 3, y: 2 }, { x: 2, y: 1 }], // shares end with first segment's start
    [{ x: 0, y: 0 }, { x: 1, y: 0 }],
  ];
  const chains = stitchSegmentsIntoPolylines(segments);
  assert.equal(chains.length, 1);
  assert.equal(chains[0].closed, false);
  assert.equal(chains[0].points.length, 4);
  // Endpoints of the fully-joined chain must be the two never-shared ends.
  const ends = [chains[0].points[0], chains[0].points[chains[0].points.length - 1]];
  const hasPoint = (p) => ends.some((e) => e.x === p.x && e.y === p.y);
  assert.ok(hasPoint({ x: 0, y: 0 }));
  assert.ok(hasPoint({ x: 3, y: 2 }));
});

test('stitchSegmentsIntoPolylines detects a closed ring (a small square)', () => {
  const segments = [
    [{ x: 0, y: 0 }, { x: 1, y: 0 }],
    [{ x: 1, y: 0 }, { x: 1, y: 1 }],
    [{ x: 1, y: 1 }, { x: 0, y: 1 }],
    [{ x: 0, y: 1 }, { x: 0, y: 0 }],
  ];
  const chains = stitchSegmentsIntoPolylines(segments);
  assert.equal(chains.length, 1);
  assert.equal(chains[0].closed, true);
  assert.deepEqual(chains[0].points[0], chains[0].points[chains[0].points.length - 1]);
});

test('stitchSegmentsIntoPolylines leaves an unjoinable segment as its own open 2-point chain', () => {
  const segments = [[{ x: 5, y: 5 }, { x: 6, y: 6 }]];
  const chains = stitchSegmentsIntoPolylines(segments);
  assert.equal(chains.length, 1);
  assert.equal(chains[0].closed, false);
  assert.deepEqual(chains[0].points, segments[0]);
});

test('stitchSegmentsIntoPolylines handles many fully-disjoint segments without merging any of them', () => {
  // Regression guard for the endpoint-map rewrite (2026-09-03): every
  // segment here is isolated (no shared endpoints at all), which used to
  // be exactly the pathological case for the old restart-from-scratch
  // nested-loop merge (worst-case O(n^3) in segment count). 2000 segments
  // finishing well under a second is the actual behavioral guarantee that
  // matters — the previous implementation would have been unusably slow
  // at this count, not merely slower.
  const segments = [];
  for (let i = 0; i < 2000; i += 1) {
    segments.push([{ x: i * 10, y: 0 }, { x: i * 10 + 1, y: 1 }]);
  }
  const start = Date.now();
  const chains = stitchSegmentsIntoPolylines(segments);
  const elapsedMs = Date.now() - start;
  assert.equal(chains.length, 2000);
  for (const chain of chains) assert.equal(chain.closed, false);
  assert.ok(elapsedMs < 2000, `expected well under 2s for 2000 disjoint segments, took ${elapsedMs}ms`);
});

test('stitchSegmentsIntoPolylines stitches a long chain of many segments end-to-end', () => {
  // A single 2000-segment zigzag chain, submitted in scrambled order —
  // exercises the same "many chains, lots of merging" shape that used to
  // trigger the O(n^3) worst case, this time actually merging down to one.
  const points = [];
  for (let i = 0; i <= 2000; i += 1) points.push({ x: i, y: i % 2 });
  const segments = [];
  for (let i = 0; i < points.length - 1; i += 1) segments.push([points[i], points[i + 1]]);
  for (let i = segments.length - 1; i > 0; i -= 1) {
    const j = (i * 2654435761) % (i + 1);
    [segments[i], segments[j]] = [segments[j], segments[i]];
  }
  const start = Date.now();
  const chains = stitchSegmentsIntoPolylines(segments);
  const elapsedMs = Date.now() - start;
  assert.equal(chains.length, 1);
  assert.equal(chains[0].closed, false);
  assert.equal(chains[0].points.length, points.length);
  const ends = [chains[0].points[0], chains[0].points[chains[0].points.length - 1]];
  const hasPoint = (p) => ends.some((e) => e.x === p.x && e.y === p.y);
  assert.ok(hasPoint(points[0]));
  assert.ok(hasPoint(points[points.length - 1]));
  assert.ok(elapsedMs < 2000, `expected well under 2s for a 2000-segment chain, took ${elapsedMs}ms`);
});

test('smoothPolyline with 0 iterations (or too few points) returns the input unchanged', () => {
  const pts = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 1 }];
  assert.equal(smoothPolyline(pts, 0, false), pts);
  assert.equal(smoothPolyline([{ x: 0, y: 0 }, { x: 1, y: 1 }], 3, false).length, 2);
});

test('smoothPolyline keeps an open polyline\'s two endpoints fixed', () => {
  const pts = [{ x: 0, y: 0 }, { x: 1, y: 2 }, { x: 2, y: 0 }];
  const smoothed = smoothPolyline(pts, 2, false);
  assert.deepEqual(smoothed[0], pts[0]);
  assert.deepEqual(smoothed[smoothed.length - 1], pts[pts.length - 1]);
  assert.ok(smoothed.length > pts.length);
});

test('smoothPolyline rounds a closed ring\'s corners without an explicit fixed endpoint', () => {
  const pts = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }];
  const smoothed = smoothPolyline(pts, 1, true);
  assert.equal(smoothed.length, pts.length * 2);
  // No vertex of the smoothed ring should still sit exactly on a sharp
  // original corner — that's the point of corner-cutting.
  for (const s of smoothed) {
    for (const p of pts) {
      assert.ok(!(s.x === p.x && s.y === p.y));
    }
  }
});
