import * as Cesium from 'cesium';

/**
 * @file Shared scene-based height sampling/clamping helper. This app's
 * visuals come entirely from the Google Photorealistic 3D Tileset
 * (`viewer.scene.globe.show = false`, no terrain provider ever assigned —
 * see main.js), so any feature that needs "how high is the ground here"
 * has to ask the SCENE what it's actually rendering, not a separate DEM /
 * terrain provider or a file's own recorded elevation field — those can
 * (and, per field testing, do) disagree with the visible tileset surface
 * by a meaningful margin. That mismatch was the root cause of elevation
 * contours and GPS tracks appearing off the rendered ground.
 *
 * Mirrors the synchronous, already-loaded-tiles-only sampling
 * `data/traffic.js` already uses for road base heights
 * (`scene.sampleHeightSupported` + `scene.sampleHeight(cartographic)`):
 * cheap, no network/promise-per-point cost, and it ray-picks against
 * whatever is currently loaded and pickable in the scene — 3D Tiles
 * included, regardless of `globe.show`. It can come back `undefined` for a
 * point whose tile hasn't streamed in yet; callers get `NaN` back and are
 * expected to fall back gracefully, exactly like `traffic.js` already does.
 *
 * @module data/sceneHeight
 */

/** Vertical offset (meters) lifting a clamped point clear of the rendered mesh to avoid z-fighting — mirrors `data/traffic.js`'s `DOT_HEIGHT_OFFSET` precedent. */
export const DEFAULT_HEIGHT_OFFSET = 1.5;

/**
 * Sanity bounds for a scene-sampled height (meters above the WGS84
 * ellipsoid). Real terrain never leaves this range (Everest ~8,849 m, the
 * Mariana Trench floor ~-10,935 m — both well inside it). `scene.sampleHeight`
 * has been observed to occasionally return a huge, wildly wrong FINITE value
 * — on the order of negative Earth-radius (~-6,340,000 m) — instead of
 * `undefined`/NaN when its ray finds no real geometry to hit, most likely an
 * internal ellipsoid-intersection fallback kicking in. That value sails
 * straight through a plain `Number.isFinite` check, and one such outlier is
 * enough to blow out an entire min/max height range for every consumer:
 * this was the root cause of elevation contours going dark (every level
 * lands in the bogus ~6,000 km-deep range, so none of the real terrain ever
 * crosses one) while a cluster of flags with nonsensical "-6344490 m"
 * labels appeared at the one rogue sample point. Rejecting anything outside
 * this range and treating it the same as an unresolved sample (NaN) fixes
 * every caller at the source instead of needing a per-consumer guard.
 */
const PLAUSIBLE_HEIGHT_MIN_M = -12000;
const PLAUSIBLE_HEIGHT_MAX_M = 9500;

function isPlausibleHeight(h) {
  return Number.isFinite(h) && h >= PLAUSIBLE_HEIGHT_MIN_M && h <= PLAUSIBLE_HEIGHT_MAX_M;
}

/** True only in 3D scene mode with the depth-texture support `sampleHeight` needs. */
export function sceneHeightSupported(scene) {
  return Boolean(scene) && scene.mode === Cesium.SceneMode.SCENE3D && Boolean(scene.sampleHeightSupported);
}

/**
 * Sample the scene's actual rendered height (meters above the ellipsoid) at
 * each `{lon, lat}` pair (degrees). Returns one entry per input, `NaN`
 * where the scene has nothing pickable loaded there yet or sampling isn't
 * supported at all.
 * @param {Cesium.Scene} scene
 * @param {Array<{lon:number, lat:number}>} lonLatPairs
 * @returns {number[]}
 */
export function sampleSceneHeights(scene, lonLatPairs) {
  if (!sceneHeightSupported(scene)) return lonLatPairs.map(() => NaN);
  return lonLatPairs.map(({ lon, lat }) => {
    try {
      const carto = Cesium.Cartographic.fromDegrees(lon, lat);
      const h = scene.sampleHeight(carto);
      return isPlausibleHeight(h) ? h : NaN;
    } catch {
      return NaN;
    }
  });
}

/**
 * Clamp `{lon, lat}` pairs to the scene's actual rendered surface, returning
 * Cartesian3 positions lifted by `heightOffset` meters. A pair the scene
 * can't yet resolve falls back to `fallbackHeight` meters above the
 * ellipsoid (default 0) so callers always get a usable position instead of
 * a hole.
 * @param {Cesium.Scene} scene
 * @param {Array<{lon:number, lat:number}>} lonLatPairs
 * @param {{heightOffset?:number, fallbackHeight?:number}} [opts]
 * @returns {Cesium.Cartesian3[]}
 */
export function clampPositionsToScene(scene, lonLatPairs, opts = {}) {
  const heightOffset = Number.isFinite(opts.heightOffset) ? opts.heightOffset : DEFAULT_HEIGHT_OFFSET;
  const fallbackHeight = Number.isFinite(opts.fallbackHeight) ? opts.fallbackHeight : 0;
  const heights = sampleSceneHeights(scene, lonLatPairs);
  return lonLatPairs.map(({ lon, lat }, i) => {
    const h = Number.isFinite(heights[i]) ? heights[i] : fallbackHeight;
    return Cesium.Cartesian3.fromDegrees(lon, lat, h + heightOffset);
  });
}
