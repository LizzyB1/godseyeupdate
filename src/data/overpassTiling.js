/**
 * @file Pure tiling/dedup helpers for OSM Overpass queries — snapping a
 * viewport rectangle to a coarse, fixed-size lat/lon tile grid so that
 * panning or zooming near an already-queried area reuses cached tiles
 * instead of firing a fresh Overpass request for every camera move (the
 * actual persistent cache is `data/apiCache.js`; `data/signpostLabels.js`
 * is the only caller of this module). Cesium-free and unit-testable,
 * mirroring `contourMath.js`'s pure-logic convention.
 *
 * @module data/overpassTiling
 */

/** Tile size in degrees — coarse enough that nearby/repeated viewports reuse the same tile(s). */
export const TILE_DEG = 0.5;
/** Above this many tiles, a viewport is better served by one direct (uncached) query than by fetching that many tiles individually. */
export const MAX_TILES_PER_FETCH = 16;

/**
 * The fixed-grid tiles (`{south,west,north,east,key}`) needed to fully
 * cover a view rectangle, or `null` if that would take more than
 * `maxTiles` tiles (caller should fall back to one direct query instead)
 * or the rectangle is degenerate.
 * @param {number} south
 * @param {number} west
 * @param {number} north
 * @param {number} east
 * @param {number} [tileDeg]
 * @param {number} [maxTiles]
 * @returns {?Array<{south:number, west:number, north:number, east:number, key:string}>}
 */
export function tilesForRect(south, west, north, east, tileDeg = TILE_DEG, maxTiles = MAX_TILES_PER_FETCH) {
  if (!(north > south) || !(east > west) || !(tileDeg > 0)) return null;

  const sIdx = Math.floor(south / tileDeg);
  const nIdx = Math.ceil(north / tileDeg) - 1;
  const wIdx = Math.floor(west / tileDeg);
  const eIdx = Math.ceil(east / tileDeg) - 1;
  const rows = nIdx - sIdx + 1;
  const cols = eIdx - wIdx + 1;
  if (rows <= 0 || cols <= 0 || rows * cols > maxTiles) return null;

  const tiles = [];
  for (let r = sIdx; r <= nIdx; r += 1) {
    for (let c = wIdx; c <= eIdx; c += 1) {
      tiles.push({
        south: r * tileDeg,
        north: (r + 1) * tileDeg,
        west: c * tileDeg,
        east: (c + 1) * tileDeg,
        key: `${tileDeg}:${r}:${c}`,
      });
    }
  }
  return tiles;
}

/**
 * Drop exact duplicate elements (same kind/name/rounded position) that can
 * appear when adjacent tiles both return a point sitting right at their
 * shared edge.
 * @param {Array<{kind:string, name:string, lat:number, lon:number}>} elements
 */
export function dedupeElements(elements) {
  const seen = new Set();
  const out = [];
  for (const el of elements) {
    const key = `${el.kind}|${el.name}|${el.lat.toFixed(5)}|${el.lon.toFixed(5)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(el);
  }
  return out;
}
