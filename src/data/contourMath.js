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
 * coordinate space), find the segment endpoint closest to the sampled
 * rectangle's west edge — i.e. whichever endpoint has the smallest
 * longitude. Used to place a single per-level label/flag biased toward the
 * left/west side of the current view instead of at the view's geographic
 * center, so a returning viewer always finds a level's flag in the same
 * relative spot (the west edge) rather than wherever the view happened to
 * be centered.
 *
 * @param {Array<[{x:number,y:number}, {x:number,y:number}]>} segments - one level's segments, fractional grid coords.
 * @param {number} rows @param {number} cols
 * @param {number} west @param {number} south @param {number} east @param {number} north
 * @returns {?{lon:number, lat:number}} null if `segments` is empty.
 */
export function westmostSegmentPoint(segments, rows, cols, west, south, east, north) {
  let best = null;
  for (const [a, b] of segments) {
    for (const pt of [a, b]) {
      const { lon, lat } = gridToLonLat(pt.x, pt.y, rows, cols, west, south, east, north);
      if (!best || lon < best.lon) best = { lon, lat };
    }
  }
  return best;
}
