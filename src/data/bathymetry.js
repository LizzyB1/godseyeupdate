import * as Cesium from 'cesium';
import { getSharedCache } from './apiCache.js';
import { registerDynamicCredit, GEBCO_DEPTH_CREDIT } from './dataCredits.js';
import { marchingSquaresSegments, gridToLonLat, westmostSegmentPoint } from './contourMath.js';
import { buildContourFlags, installFlagAvoidance, thinSpotsByStep, DEFAULT_FLAG_FONT_SIZE, DEFAULT_FLAG_BG_ALPHA } from './contourFlags.js';
import { DEPTH_CONTOUR_PALETTE, paletteColorHex } from './contourColors.js';

/**
 * @file Cesium-facing engine behind the "Bathymetry" control box: undersea
 * depth contour lines (isobaths), a grid of point depth-marker readouts,
 * and big numbered "flag" call-outs on the contour lines (see
 * `data/contourFlags.js` — shared with the land-elevation contour flags in
 * `data/mapOverlays.js`), all drawn over the currently-visible ocean area
 * and refreshed as the camera moves. See `src/bathymetryBox.js` for the
 * control box.
 *
 * Single free, no-API-key data source, used for BOTH layers: Open Topo
 * Data's public REST API (api.opentopodata.org), querying the GEBCO2020
 * global bathymetry/elevation grid at a regular grid of points across the
 * current view. No key, but it IS rate-limited (1 request/second, 100
 * locations/request, 1000 requests/day on the free public instance) — every
 * lookup is cached durably (see `data/apiCache.js`) so re-visiting an area
 * never re-queries it, and each recompute cycle costs at most one request
 * regardless of whether one or both toggles are on, since contours and
 * markers now share a single fetched grid.
 *
 * This module calls it through the same-origin `/api/bathymetry` proxy
 * (`vite.config.js`'s `bathymetryProxy`), NOT directly — the public
 * api.opentopodata.org instance sends no CORS headers, so a browser-side
 * `fetch()` straight to it fails every time with `TypeError: Failed to
 * fetch`, confirmed with a live cross-origin fetch (see
 * https://github.com/ajnisbet/opentopodata/issues/53). The proxy is a
 * plain server-to-server forward — not subject to CORS — that relays the
 * exact same query/response shape, so this module only had to change its
 * base URL.
 *
 * Depth contours are computed locally from that sampled grid with the same
 * marching-squares logic (`data/contourMath.js`) the land-elevation contour
 * system in `data/mapOverlays.js` already uses and this project's test
 * suite already covers — there is no pre-drawn isobath service involved.
 *
 * (An earlier version of this module queried NOAA's "OceanReports/
 * BathymetricContours" ArcGIS layer for pre-drawn contour lines. That layer
 * turned out to be scoped to U.S. territorial/coastal waters only — it
 * returned empty for genuine open ocean elsewhere, confirmed against a
 * mid-Atlantic point Open Topo Data correctly reported as -3578 m deep — so
 * it has been dropped entirely in favor of this self-computed approach,
 * which works anywhere Open Topo Data has GEBCO coverage, i.e. globally.)
 *
 * Both layers are drawn flat at sea level (height 0) with depth-test
 * disabled, like a chart overlay laid on top of the water rather than
 * literal 3D geometry buried under the rendered ocean surface — the Google
 * Photorealistic 3D Tileset's water surface would otherwise occlude
 * anything placed at its true (negative) depth.
 *
 * @module data/bathymetry
 */

const STORAGE_KEY = 'godsEyeView.bathymetry.state';
const RECOMPUTE_DEBOUNCE_MS = 900; // gentler than the land-contour engine's — this hits a real, rate-limited network API.
const MAX_VIEW_SPAN_DEG = 25; // above this a fixed-size sample grid is too coarse relative to the area to be meaningful.
const MAX_CONTOUR_FEATURES = 2500; // hard safety cap on rendered segments.

// Shared sample grid used for BOTH contours and markers — one fetch/cache
// pass per recompute cycle serves both layers. 9 rows x 10 cols = 90 points,
// safely under Open Topo Data's 100-locations-per-request cap.
const GRID_ROWS = 9;
const GRID_COLS = 10;

// Markers render at a subsample of the shared grid so the view isn't
// cluttered with 90 labels — evenly spaced picks, endpoints included.
const MARKER_TARGET_ROWS = 4;
const MARKER_TARGET_COLS = 5;

// Standard-ish nautical depth bands; only the ones strictly inside the
// fetched grid's [min, max] range are actually traced each recompute.
const CONTOUR_LEVELS = [-10, -20, -50, -100, -200, -500, -1000, -1500, -2000, -3000, -4000, -5000, -6000, -7000, -8000, -9000, -10000];

const GRID_CACHE_STORE = 'bathyDepth';
const GRID_CACHE_PRECISION = 2; // decimal degrees (~1.1km) — cache key rounding.
// Same-origin proxy (see vite.config.js's bathymetryProxy) — NOT
// api.opentopodata.org directly, which sends no CORS headers and always
// fails a browser-side fetch(). Same query/response shape either way.
const OPENTOPODATA_URL = '/api/bathymetry';

const MARKER_TEXT_COLOR = Cesium.Color.fromCssColorString('#bfe6ff');

export const DEFAULT_STATE = Object.freeze({
  contoursEnabled: false,
  markersEnabled: false,
  // Big "flag" call-outs (pole + numbered plaque) on every depth contour
  // level currently on screen — separate from `contoursEnabled` (the
  // lines themselves), though it has nothing to draw unless contours are
  // also being computed. See data/contourFlags.js.
  depthFlagsEnabled: false,
  // Flag label style — independent of the contour LINE colors (which cycle
  // through data/contourColors.js's depth palette): the plaque background
  // is a single user-picked color/opacity/text-size.
  flagFontSize: DEFAULT_FLAG_FONT_SIZE,
  flagBgColor: '#8e24aa',
  flagBgAlpha: DEFAULT_FLAG_BG_ALPHA,
  // "Label every contour / every other / every 3rd…" — 1 = every depth
  // level gets a flag (today's behavior), 2 = every other, etc.
  flagLabelStep: 1,
});

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_STATE };
    return { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function saveState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch { /* storage unavailable */ }
}

function gridCacheKey(lon, lat) {
  return `${lat.toFixed(GRID_CACHE_PRECISION)},${lon.toFixed(GRID_CACHE_PRECISION)}`;
}

function formatDepth(meters) {
  const rounded = Math.round(Math.abs(meters));
  return `${rounded.toLocaleString('en-US')} m`;
}

/** Evenly-spaced picks of `target` indices out of `[0, total)`, endpoints
 * included, deduplicated (only matters when target >= total). */
function subsampleIndices(total, target) {
  if (target >= total) return Array.from({ length: total }, (_, i) => i);
  if (target <= 1) return [0];
  const out = [];
  for (let i = 0; i < target; i += 1) {
    out.push(Math.round((i / (target - 1)) * (total - 1)));
  }
  return [...new Set(out)];
}

export class BathymetryEngine {
  constructor(viewer) {
    this.viewer = viewer;
    this.state = loadState();

    this._contourDataSource = new Cesium.CustomDataSource('bathymetryContours');
    this._markerDataSource = new Cesium.CustomDataSource('bathymetryMarkers');
    this._flagDataSource = new Cesium.CustomDataSource('bathymetryDepthFlags');
    this.viewer.dataSources.add(this._contourDataSource);
    this.viewer.dataSources.add(this._markerDataSource);
    this.viewer.dataSources.add(this._flagDataSource);
    this._flagEntities = [];
    this._removeFlagAvoidance = installFlagAvoidance(this.viewer, () => this._flagEntities);

    this._recomputeTimer = null;
    this._gridToken = 0;
    this._lastGridFetchAt = 0;
    this._cache = getSharedCache();

    // `_gridStatusText` covers conditions that apply to the whole shared
    // fetch (camera unavailable, view too large, network error) and takes
    // priority when set; otherwise the per-layer result texts are joined —
    // this is why a report of both layers failing independently would never
    // show two near-duplicate messages any more.
    this._gridStatusText = '';
    this._contourResultText = '';
    this._markerResultText = '';
    /** @type {?Function} UI callback: (statusText) => void */
    this.onStatusChange = null;

    this._onCameraMoveEnd = this._onCameraMoveEnd.bind(this);
    this.viewer.camera.moveEnd.addEventListener(this._onCameraMoveEnd);

    // A prior session may have left either toggle on (state is persisted) —
    // register the credit now rather than only from the setters, which this
    // restore path bypasses.
    if (this.state.contoursEnabled || this.state.markersEnabled) {
      registerDynamicCredit(this.viewer, GEBCO_DEPTH_CREDIT);
      this._scheduleRecompute();
    }
  }

  _persist() {
    saveState(this.state);
  }

  _emitStatus() {
    if (this._gridStatusText) {
      this._status = this._gridStatusText;
    } else {
      const parts = [];
      if (this.state.contoursEnabled && this._contourResultText) parts.push(this._contourResultText);
      if (this.state.markersEnabled && this._markerResultText) parts.push(this._markerResultText);
      this._status = parts.join(' · ');
    }
    this.onStatusChange?.(this._status);
  }

  getStatus() {
    return this._status;
  }

  // ── toggles ──────────────────────────────────────────────────────────
  setContoursEnabled(enabled) {
    this.state.contoursEnabled = Boolean(enabled);
    this._persist();
    if (this.state.contoursEnabled) {
      registerDynamicCredit(this.viewer, GEBCO_DEPTH_CREDIT);
      this._scheduleRecompute();
    } else {
      this._contourDataSource.entities.removeAll();
      this._contourResultText = '';
      this._clearDepthFlags(); // flags have nothing to attach to without the lines
      this._emitStatus();
    }
  }

  setMarkersEnabled(enabled) {
    this.state.markersEnabled = Boolean(enabled);
    this._persist();
    if (this.state.markersEnabled) {
      registerDynamicCredit(this.viewer, GEBCO_DEPTH_CREDIT);
      this._scheduleRecompute();
    } else {
      this._markerDataSource.entities.removeAll();
      this._markerResultText = '';
      this._emitStatus();
    }
  }

  /**
   * Big "flag" call-outs (pole + numbered plaque, see data/contourFlags.js)
   * on every depth contour level currently on screen. Separate from
   * `contoursEnabled` (the lines themselves) — toggles independently,
   * though it has nothing to draw unless contours are also being computed.
   */
  setDepthFlagsEnabled(enabled) {
    this.state.depthFlagsEnabled = Boolean(enabled);
    this._persist();
    if (this.state.depthFlagsEnabled && this.state.contoursEnabled) this._scheduleRecompute();
    else if (!this.state.depthFlagsEnabled) this._clearDepthFlags();
  }

  _clearDepthFlags() {
    this._flagDataSource.entities.removeAll();
    this._flagEntities = [];
    this._lastFlagSpotByLevel = null;
    this._lastLevelPaletteIndex = null;
  }

  // ── depth flag label style ──────────────────────────────────────────
  setFlagFontSize(px) {
    this.state.flagFontSize = Cesium.Math.clamp(Number(px) || DEFAULT_FLAG_FONT_SIZE, 12, 48);
    this._persist();
    if (this.state.depthFlagsEnabled) this._rebuildDepthFlagsOnly();
  }

  setFlagBgColor(hex) {
    this.state.flagBgColor = hex || DEFAULT_STATE.flagBgColor;
    this._persist();
    if (this.state.depthFlagsEnabled) this._rebuildDepthFlagsOnly();
  }

  setFlagBgAlpha(alpha) {
    this.state.flagBgAlpha = Cesium.Math.clamp(Number(alpha), 0, 1);
    this._persist();
    if (this.state.depthFlagsEnabled) this._rebuildDepthFlagsOnly();
  }

  setFlagLabelStep(step) {
    this.state.flagLabelStep = Math.max(1, Math.round(Number(step)) || 1);
    this._persist();
    if (this.state.depthFlagsEnabled) this._rebuildDepthFlagsOnly();
  }

  /** Re-draws just the flag layer from the last-computed depth spots, without a full re-fetch — used when only a label-style control (font/bg/step) changes. */
  _rebuildDepthFlagsOnly() {
    if (!this._lastFlagSpotByLevel) return;
    this._applyDepthFlags(this._lastFlagSpotByLevel);
  }

  /** Builds (or clears) the flag layer from a full `Map<level, spot>` — applies the frequency thinning and current label style. `levelPaletteIndex` maps each level to the palette index its contour LINE was drawn with, so a flag's pole always matches its line even after thinning changes iteration order. */
  _applyDepthFlags(flagSpotByLevel, levelPaletteIndex = this._lastLevelPaletteIndex) {
    this._lastFlagSpotByLevel = flagSpotByLevel;
    this._lastLevelPaletteIndex = levelPaletteIndex;
    if (!this.state.depthFlagsEnabled) { this._clearDepthFlags(); return; }
    const thinned = thinSpotsByStep(flagSpotByLevel, this.state.flagLabelStep);
    this._flagEntities = buildContourFlags({
      viewer: this.viewer,
      dataSource: this._flagDataSource,
      spots: thinned,
      formatValue: formatDepth,
      poleColorForLevel: (level) => Cesium.Color.fromCssColorString(paletteColorHex(DEPTH_CONTOUR_PALETTE, levelPaletteIndex?.get(level) ?? 0)),
      bgColor: Cesium.Color.fromCssColorString(this.state.flagBgColor),
      bgAlpha: this.state.flagBgAlpha,
      fontSize: this.state.flagFontSize,
    });
  }

  _onCameraMoveEnd() {
    if (this.state.contoursEnabled || this.state.markersEnabled) this._scheduleRecompute();
  }

  _scheduleRecompute() {
    if (this._recomputeTimer) clearTimeout(this._recomputeTimer);
    this._recomputeTimer = setTimeout(() => this._recompute(), RECOMPUTE_DEBOUNCE_MS);
  }

  // ── shared grid fetch (feeds both contours and markers) ─────────────
  async _fetchDepthGrid(rect, token) {
    const west = Cesium.Math.toDegrees(rect.west);
    const south = Cesium.Math.toDegrees(rect.south);
    const east = Cesium.Math.toDegrees(rect.east);
    const north = Cesium.Math.toDegrees(rect.north);

    const points = [];
    for (let r = 0; r < GRID_ROWS; r += 1) {
      // Row 0 = north edge, matching contourMath's gridToLonLat convention.
      const lat = north - (r / (GRID_ROWS - 1)) * (north - south);
      for (let c = 0; c < GRID_COLS; c += 1) {
        const lon = west + (c / (GRID_COLS - 1)) * (east - west);
        points.push({ lon, lat });
      }
    }

    const heights = new Array(points.length).fill(NaN);
    const misses = [];
    for (let i = 0; i < points.length; i += 1) {
      const { lon, lat } = points[i];
      const key = gridCacheKey(lon, lat);
      const cached = await this._cache.get(GRID_CACHE_STORE, key);
      if (token !== this._gridToken) return null; // superseded mid-cache-read
      if (cached !== undefined) {
        heights[i] = cached == null ? NaN : cached;
      } else {
        misses.push({ i, lon, lat, key });
      }
    }

    if (misses.length) {
      // Respect the free tier's 1 request/second ceiling — wait out
      // whatever's left of the last call's 1.1s cooldown before firing.
      const waitMs = Math.max(0, 1100 - (Date.now() - this._lastGridFetchAt));
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      if (token !== this._gridToken) return null;
      this._lastGridFetchAt = Date.now();

      const locations = misses.map((p) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`).join('|');
      const res = await fetch(`${OPENTOPODATA_URL}?locations=${encodeURIComponent(locations)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const results = Array.isArray(data?.results) ? data.results : [];
      results.forEach((r, idx) => {
        const miss = misses[idx];
        if (!miss) return;
        const depth = Number.isFinite(r?.elevation) ? r.elevation : null;
        heights[miss.i] = depth == null ? NaN : depth;
        this._cache.put(GRID_CACHE_STORE, miss.key, depth);
      });
    }

    return { heights, rows: GRID_ROWS, cols: GRID_COLS, west, south, east, north };
  }

  // ── one shared recompute cycle: fetch once, render whichever is on ──
  async _recompute() {
    const wantContours = this.state.contoursEnabled;
    const wantMarkers = this.state.markersEnabled;
    if (!wantContours && !wantMarkers) return;

    const token = ++this._gridToken;
    const rect = this.viewer.camera.computeViewRectangle();
    if (!rect) {
      this._gridStatusText = 'Camera view unavailable.';
      this._emitStatus();
      return;
    }

    const spanDeg = Cesium.Math.toDegrees(Math.max(rect.width, rect.height));
    if (spanDeg > MAX_VIEW_SPAN_DEG) {
      this._contourDataSource.entities.removeAll();
      this._markerDataSource.entities.removeAll();
      this._clearDepthFlags();
      this._contourResultText = '';
      this._markerResultText = '';
      this._gridStatusText = `Zoom in for bathymetry data (view is ${spanDeg.toFixed(1)}° wide, need < ${MAX_VIEW_SPAN_DEG}°).`;
      this._emitStatus();
      return;
    }

    this._gridStatusText = 'Loading bathymetry data…';
    this._emitStatus();

    let grid;
    try {
      grid = await this._fetchDepthGrid(rect, token);
    } catch (err) {
      if (token !== this._gridToken) return;
      this._gridStatusText = `Bathymetry data unavailable (${err.message || 'network error'}).`;
      this._emitStatus();
      return;
    }
    if (!grid || token !== this._gridToken) return; // superseded by a newer view

    this._gridStatusText = '';
    if (wantContours) this._renderContours(grid);
    if (wantMarkers) this._renderMarkers(grid);
    this._emitStatus();
  }

  // ── contour lines (self-computed isobaths via marching squares) ─────
  _renderContours(grid) {
    const { heights, rows, cols, west, south, east, north } = grid;

    let min = Infinity;
    let max = -Infinity;
    for (const h of heights) {
      if (!Number.isFinite(h)) continue;
      if (h < min) min = h;
      if (h > max) max = h;
    }
    const levels = Number.isFinite(min) && Number.isFinite(max)
      ? CONTOUR_LEVELS.filter((lvl) => lvl > min && lvl < max)
      : [];

    // One flag spot per level — the segment endpoint closest to the view's
    // west edge (see data/contourFlags.js) — for every level actually drawn,
    // not just the "major" (round-thousand) ones: at ocean scale even the
    // finer bands (10/20/50/100/200/500 m) are worth calling out by number.
    const flagSpotByLevel = new Map();
    // `levels` is already in CONTOUR_LEVELS' fixed monotonic order, so its
    // array index doubles as each level's position for palette-color
    // cycling — consecutive (on-screen-neighboring) levels land on
    // contrasting colors.
    const levelPaletteIndex = new Map(levels.map((lvl, i) => [lvl, i]));
    const colorForLevel = (level) => Cesium.Color.fromCssColorString(paletteColorHex(DEPTH_CONTOUR_PALETTE, levelPaletteIndex.get(level) ?? 0));

    this._contourDataSource.entities.removeAll();
    let segmentCount = 0;
    for (const level of levels) {
      if (segmentCount >= MAX_CONTOUR_FEATURES) break;
      const isMajor = Math.abs(level) % 1000 === 0;
      const lineColor = colorForLevel(level).withAlpha(isMajor ? 0.9 : 0.55);
      const segments = marchingSquaresSegments(heights, rows, cols, level);
      for (const [a, b] of segments) {
        if (segmentCount >= MAX_CONTOUR_FEATURES) break;
        const p1 = gridToLonLat(a.x, a.y, rows, cols, west, south, east, north);
        const p2 = gridToLonLat(b.x, b.y, rows, cols, west, south, east, north);
        const positions = Cesium.Cartesian3.fromDegreesArray([p1.lon, p1.lat, p2.lon, p2.lat]);
        this._contourDataSource.entities.add({
          polyline: {
            positions,
            width: isMajor ? 2.5 : 1.25,
            material: lineColor,
            clampToGround: false,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
        segmentCount += 1;
      }
      const spot = westmostSegmentPoint(segments, rows, cols, west, south, east, north);
      if (spot) flagSpotByLevel.set(level, spot);
    }

    this._contourResultText = segmentCount > 0
      ? `${segmentCount} isobath segment${segmentCount === 1 ? '' : 's'} · GEBCO`
      : 'No depth contours in this view (likely over land or a uniform depth band).';

    this._applyDepthFlags(flagSpotByLevel, levelPaletteIndex);
  }

  // ── depth markers (subsample of the same shared grid) ───────────────
  _renderMarkers(grid) {
    const { heights, rows, cols, west, south, east, north } = grid;
    const rowIdx = subsampleIndices(rows, MARKER_TARGET_ROWS);
    const colIdx = subsampleIndices(cols, MARKER_TARGET_COLS);

    this._markerDataSource.entities.removeAll();
    let shown = 0;
    for (const r of rowIdx) {
      for (const c of colIdx) {
        const depth = heights[r * cols + c];
        if (!Number.isFinite(depth) || depth >= 0) continue; // land, or missing sample
        const { lon, lat } = gridToLonLat(c, r, rows, cols, west, south, east, north);
        this._markerDataSource.entities.add({
          position: Cesium.Cartesian3.fromDegrees(lon, lat, 0),
          point: {
            pixelSize: 4,
            color: MARKER_TEXT_COLOR,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 1,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          label: {
            text: formatDepth(depth),
            font: '600 12px monospace',
            fillColor: MARKER_TEXT_COLOR,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 3,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new Cesium.Cartesian2(0, -12),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
        shown += 1;
      }
    }
    this._markerResultText = shown > 0
      ? `${shown} depth marker${shown === 1 ? '' : 's'} · GEBCO`
      : 'No ocean depth points in this view (likely over land).';
  }

  destroy() {
    this.viewer.camera.moveEnd.removeEventListener(this._onCameraMoveEnd);
    if (this._recomputeTimer) clearTimeout(this._recomputeTimer);
    this._removeFlagAvoidance?.();
    this.viewer.dataSources.remove(this._contourDataSource, true);
    this.viewer.dataSources.remove(this._markerDataSource, true);
    this.viewer.dataSources.remove(this._flagDataSource, true);
  }
}

/** @param {Cesium.Viewer} viewer @returns {BathymetryEngine} */
export function initBathymetry(viewer) {
  return new BathymetryEngine(viewer);
}
