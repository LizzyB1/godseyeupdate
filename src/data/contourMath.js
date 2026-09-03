/**
 * @file Pure marching-squares contour-line extraction over a regular height
 * grid. Cesium-free and unit-testable — `src/data/mapOverlays.js` samples
 * real terrain heights into a grid and calls this to get line segments,
 * then converts the fractional (row, col) segment endpoints to lon/lat and
 * draws them.
 *
 * @module data/contourMath
 */

/**
 * Extract every line segment where `heights` crosses `level`, cell by cell.
 * Segment endpoints are in fractional grid coordinates: `x` is a column
 * index (0..cols-1, possibly fractional where the level crosses an edge),
 * `y` is a row index (0..rows-1) the same way. The caller maps those to
 * lon/lat with a simple linear interpolation over the sampled rectangle.
 *
 * Standard 2D marching squares: each cell (4 corners) contributes 0, 1, or 2
 * segments depending on which of its 4 edges the level crosses. A cell with
 * exactly 2 crossing edges gets one segment; a saddle cell (all 4 edges
 * cross, diagonally-opposite corners on the same side of the level) is
 * split into two segments, paired by comparing the cell's average corner
 * value to the level — the standard disambiguation heuristic. Cells with a
 * NaN corner (missing/failed terrain sample) are skipped entirely.
 *
 * @param {ArrayLike<number>} heights - Row-major grid, length `rows*cols`.
 * @param {number} rows
 * @param {number} cols
 * @param {number} level - The height value to trace a contour line at.
 * @returns {Array<[{x:number,y:number}, {x:number,y:number}]>}
 */
export function marchingSquaresSegments(heights, rows, cols, level) {
  const segments = [];
  if (rows < 2 || cols < 2) return segments;
  const at = (r, c) => heights[r * cols + c];

  for (let r = 0; r < rows - 1; r += 1) {
    for (let c = 0; c < cols - 1; c += 1) {
      const tl = at(r, c);
      const tr = at(r, c + 1);
      const bl = at(r + 1, c);
      const br = at(r + 1, c + 1);
      if (!Number.isFinite(tl) || !Number.isFinite(tr) || !Number.isFinite(bl) || !Number.isFinite(br)) continue;

      const edges = {};
      if ((tl - level) * (tr - level) < 0) {
        const t = (level - tl) / (tr - tl);
        edges.top = { x: c + t, y: r };
      }
      if ((tr - level) * (br - level) < 0) {
        const t = (level - tr) / (br - tr);
        edges.right = { x: c + 1, y: r + t };
      }
      if ((bl - level) * (br - level) < 0) {
        const t = (level - bl) / (br - bl);
        edges.bottom = { x: c + t, y: r + 1 };
      }
      if ((tl - level) * (bl - level) < 0) {
        const t = (level - tl) / (bl - tl);
        edges.left = { x: c, y: r + t };
      }

      const keys = Object.keys(edges);
      if (keys.length === 2) {
        segments.push([edges[keys[0]], edges[keys[1]]]);
      } else if (keys.length === 4) {
        const avg = (tl + tr + bl + br) / 4;
        if (avg > level) {
          segments.push([edges.top, edges.left]);
          segments.push([edges.right, edges.bottom]);
        } else {
          segments.push([edges.top, edges.right]);
          segments.push([edges.left, edges.bottom]);
        }
      }
      // 0 crossings: cell entirely above/below the level, nothing to draw.
      // 1 or 3 crossings can't happen for a well-formed (finite) cell.
    }
  }
  return segments;
}

/**
 * Convert a marching-squares fractional grid coordinate to lon/lat, given
 * the sampled rectangle's bounds and grid dimensions. Row 0 is the
 * rectangle's north edge (matches how `mapOverlays.js` samples top-to-bottom).
 */
export function gridToLonLat(x, y, rows, cols, west, south, east, north) {
  const lon = west + (x / (cols - 1)) * (east - west);
  const lat = north - (y / (rows - 1)) * (north - south);
  return { lon, lat };
}

/**
 * Given one contour level's segments (as returned by
 * `marchingSquaresSegments`, already converted through `gridToLonLat`'s
 * coordinate space), find the segment endpoint most extreme in the given
 * geographic direction — smallest longitude for 'west', largest for 'east',
 * largest latitude for 'north', smallest for 'south'. Used to place a
 * per-level label/flag biased toward a chosen edge of the current view
 * instead of at the view's geographic center, so a returning viewer always
 * finds a level's flag in the same relative spot rather than wherever the
 * view happened to be centered — see `data/contourFlags.js`'s edge-based
 * flag placement, which calls this once per selected edge.
 *
 * @param {Array<[{x:number,y:number}, {x:number,y:number}]>} segments - one level's segments, fractional grid coords.
 * @param {number} rows @param {number} cols
 * @param {number} west @param {number} south @param {number} east @param {number} north
 * @param {'west'|'east'|'north'|'south'} direction
 * @returns {?{lon:number, lat:number}} null if `segments` is empty.
 */
export function extremeSegmentPoint(segments, rows, cols, west, south, east, north, direction) {
  let best = null;
  for (const [a, b] of segments) {
    for (const pt of [a, b]) {
      const { lon, lat } = gridToLonLat(pt.x, pt.y, rows, cols, west, south, east, north);
      if (!best) { best = { lon, lat }; continue; }
      if (direction === 'east' ? lon > best.lon
        : direction === 'north' ? lat > best.lat
        : direction === 'south' ? lat < best.lat
        : lon < best.lon) { // 'west' (and the default) — smallest longitude
        best = { lon, lat };
      }
    }
  }
  return best;
}

/**
 * `extremeSegmentPoint(..., 'west')` — kept as its own name since it's the
 * long-standing default flag placement and the most-called of the four
 * directions; every other direction goes through `extremeSegmentPoint`
 * directly.
 * @param {Array<[{x:number,y:number}, {x:number,y:number}]>} segments
 * @param {number} rows @param {number} cols
 * @param {number} west @param {number} south @param {number} east @param {number} north
 * @returns {?{lon:number, lat:number}}
 */
export function westmostSegmentPoint(segments, rows, cols, west, south, east, north) {
  return extremeSegmentPoint(segments, rows, cols, west, south, east, north, 'west');
}

/**
 * Joins the 2-point segments `marchingSquaresSegments` returns for one
 * level into continuous polylines, by repeatedly merging any two chains
 * that share an endpoint (segments arrive in raster cell-scan order, so a
 * ring's pieces are scattered through the array, not adjacent). A chain
 * whose two ends meet back up is a closed ring — an isolated hilltop or
 * basin fully inside the sampled view — flagged `closed: true` so callers
 * can both smooth it as a loop (`smoothPolyline`) and label it as one (see
 * `data/mapOverlays.js`'s ring-label pass). A segment that never joins
 * anything else stays a 2-point chain of its own (open, `closed: false`) —
 * the common case at the sampled rectangle's edge, where a level's line
 * runs off the visible area rather than closing.
 *
 * @param {Array<[{x:number,y:number}, {x:number,y:number}]>} segments - one level's segments, fractional grid coords.
 * @param {number} [eps] - endpoint match tolerance, in fractional grid units. The default is generous relative to typical float roundoff between two cells computing the same shared edge crossing from opposite sides.
 * @returns {Array<{points: Array<{x:number,y:number}>, closed: boolean}>}
 */
export function stitchSegmentsIntoPolylines(segments, eps = 1e-6) {
  const key = (p) => `${Math.round(p.x / eps)},${Math.round(p.y / eps)}`;
  const chains = segments.map(([a, b]) => ({ points: [a, b], closed: false }));

  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < chains.length && !merged; i += 1) {
      const A = chains[i];
      if (A.closed) continue;
      const aStart = A.points[0];
      const aEnd = A.points[A.points.length - 1];
      for (let j = 0; j < chains.length; j += 1) {
        if (i === j) continue;
        const B = chains[j];
        if (B.closed) continue;
        const bStart = B.points[0];
        const bEnd = B.points[B.points.length - 1];
        if (key(aEnd) === key(bStart)) {
          A.points = A.points.concat(B.points.slice(1));
        } else if (key(aEnd) === key(bEnd)) {
          A.points = A.points.concat([...B.points].reverse().slice(1));
        } else if (key(aStart) === key(bEnd)) {
          A.points = B.points.concat(A.points.slice(1));
        } else if (key(aStart) === key(bStart)) {
          A.points = [...B.points].reverse().concat(A.points.slice(1));
        } else {
          continue;
        }
        chains.splice(j, 1);
        merged = true;
        break;
      }
    }
  }

  for (const chain of chains) {
    if (chain.points.length > 2 && key(chain.points[0]) === key(chain.points[chain.points.length - 1])) {
      chain.closed = true;
    }
  }
  return chains;
}

/**
 * Chaikin corner-cutting smoothing: each pass replaces every vertex pair
 * with two new points 1/4 and 3/4 of the way along their segment, rounding
 * the polyline's corners without moving it far from the original data (the
 * standard cheap "smoother lines" approach — no spline solve, just repeated
 * corner-cutting, which is why more `iterations` reads as more precision/
 * refinement rather than a heavier distortion). An open polyline keeps its
 * two endpoints fixed across every pass; a closed one cuts every corner,
 * itself included, and stays closed.
 * @param {Array<{x:number,y:number}>} points
 * @param {number} iterations - 0 returns `points` unchanged.
 * @param {boolean} closed
 * @returns {Array<{x:number,y:number}>}
 */
export function smoothPolyline(points, iterations, closed) {
  const n = Math.max(0, Math.round(iterations) || 0);
  if (n === 0 || points.length < 3) return points;
  let pts = points;
  for (let iter = 0; iter < n; iter += 1) {
    const next = [];
    const count = pts.length;
    const limit = closed ? count : count - 1;
    if (!closed) next.push(pts[0]);
    for (let i = 0; i < limit; i += 1) {
      const p0 = pts[i];
      const p1 = pts[(i + 1) % count];
      next.push({ x: p0.x + 0.25 * (p1.x - p0.x), y: p0.y + 0.25 * (p1.y - p0.y) });
      next.push({ x: p0.x + 0.75 * (p1.x - p0.x), y: p0.y + 0.75 * (p1.y - p0.y) });
    }
    if (!closed) next.push(pts[count - 1]);
    pts = next;
  }
  return pts;
}
