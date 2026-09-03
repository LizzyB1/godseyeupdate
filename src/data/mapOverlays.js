import * as Cesium from 'cesium';
import { marchingSquaresSegments, gridToLonLat, westmostSegmentPoint } from './contourMath.js';
import { formatLatLonDMS, formatLatLonDecimal, googleMapsLink, formatHeight, toDMS } from './coordFormat.js';
import { resolveApiKey } from '../apiKeys.js';
import { sampleSceneHeights } from './sceneHeight.js';
import { getSharedCache } from './apiCache.js';
import { buildContourFlags, installFlagAvoidance, thinSpotsByStep, DEFAULT_FLAG_FONT_SIZE, DEFAULT_FLAG_BG_ALPHA } from './contourFlags.js';
import { LAND_CONTOUR_PALETTE, paletteColorHex } from './contourColors.js';

/**
 * @file Cesium-facing engine behind the "Map Overlays" control box: elevation
 * contour lines, vertical (height-relief) exaggeration, a lat/lon graticule,
 * and a click-to-place coordinate cursor with reverse geocoding + a
 * viewport-screenshot capture. Kept as one module since all of it shares the
 * same height plumbing and the same control box.
 *
 * The globe mesh itself is hidden in this app (`viewer.scene.globe.show =
 * false` — visuals come from the Google Photorealistic 3D Tileset instead,
 * see main.js), and no terrain provider is otherwise configured. Contour
 * heights used to come from a separate Cesium World Terrain provider
 * fetched purely for height queries — but that DEM can (and did, per field
 * testing) disagree with the visible tileset surface by a meaningful
 * margin, making contours sit off the rendered ground. Heights now come
 * from `data/sceneHeight.js`, which samples the SAME scene the operator is
 * looking at (`scene.sampleHeight`, the pattern `data/traffic.js` already
 * uses for road base heights) — this also drops the Cesium Ion terrain
 * dependency entirely, so contours no longer need any token/network access
 * beyond the tileset the app is already streaming.
 *
 * Contour lines don't need ground-clamping/draping tricks: each contour
 * level IS a height, so its polyline vertices are simply placed at that
 * exact height above the ellipsoid (`Cartesian3.fromDegrees(lon, lat,
 * level)`) at the (lon, lat) marching-squares found for that level — no
 * `GroundPolylinePrimitive`/3D-tile classification needed.
 *
 * @module data/mapOverlays
 */

const STORAGE_KEY = 'godsEyeView.mapOverlays.state';
const RECOMPUTE_DEBOUNCE_MS = 550;
// Sampling the live scene is a synchronous per-point ray-pick rather than a
// batched DEM-tile fetch, so the grid is kept smaller than the old
// terrain-provider version to stay cheap on every recompute.
const CONTOUR_GRID_COLS = 28;
const CONTOUR_GRID_ROWS = 20;
const MAX_CONTOUR_VIEW_SPAN_DEG = 1.5; // ~165km — above this, contours are too coarse to be meaningful
const MAX_CONTOUR_LEVELS = 60; // hard cap so pathological relief can't spawn thousands of polylines
const MAX_GRID_LINES_PER_AXIS = 60;
// If more than this fraction of the sampled grid comes back unresolved
// (tiles for a freshly-panned-to area haven't streamed in yet), retry once
// after a short delay instead of leaving contours sparse/missing.
const RETRY_MIN_FINITE_FRACTION = 0.6;
const RETRY_DELAY_MS = 800;
/** Cache store name (see data/apiCache.js) for reverse-geocode results — addresses for a given point essentially never change. */
const GEOCODE_CACHE_STORE = 'geocode';
/** The only vertical-exaggeration multipliers the UI (and this engine) accept — see `setVerticalExaggeration`. */
const EXAGGERATION_OPTIONS = [1, 1.5, 2];

export const DEFAULT_STATE = Object.freeze({
  contoursEnabled: false,
  contourMajorSpacing: 50,
  contourMinorEnabled: false,
  contourMinorSpacing: 10,
  verticalExaggeration: 1,
  gridEnabled: false,
  gridSpacingDeg: 1,
  gridColor: '#00d4ff',
  gridMinorColor: '#3a5a66',
  // Large-text lat/long labels on whichever grid lines are currently shown.
  // Only ever drawn for lines already computed for the current viewport
  // (see `_recomputeGrid`), so there's nothing extra to cull: on screen ==
  // in the visible viewport, by construction.
  lineLabelsEnabled: false,
  // Big "flag" call-outs (pole + numbered plaque) on every major contour
  // line currently on screen — a separate toggle from `lineLabelsEnabled`
  // (grid) and from `contoursEnabled` (the lines themselves): the flags can
  // be shown/hidden independently of both. See `data/contourFlags.js`.
  contourFlagsEnabled: false,
  // Flag label style — independent of the contour LINE colors (which cycle
  // through data/contourColors.js's palette): the plaque background is a
  // single user-picked color/opacity/text-size, same idea as the existing
  // grid-color picker.
  flagFontSize: DEFAULT_FLAG_FONT_SIZE,
  flagBgColor: '#c62828',
  flagBgAlpha: DEFAULT_FLAG_BG_ALPHA,
  // "Label every contour / every other / every 3rd…" — 1 = every major
  // contour line gets a flag (today's behavior), 2 = every other, etc.
  flagLabelStep: 1,
});

/** Font for grid/contour line value labels — deliberately large, per the
 * feature's own purpose: readable at a glance, not a fine-print readout
 * like the rest of the HUD. */
const LINE_LABEL_FONT = '700 20px sans-serif';

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_STATE };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_STATE, ...parsed };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function saveState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch { /* storage unavailable */ }
}

export class MapOverlaysEngine {
  constructor(viewer) {
    this.viewer = viewer;
    this.state = loadState();

    this._contourPrimitive = null;
    this._gridPrimitive = null;
    this._gridLabelPrimitive = null;
    this._recomputeTimer = null;
    this._contourStatus = ''; // status line shown in the UI
    this._computeToken = 0;
    /** Whether a sparse-height retry has already fired for the in-flight recompute cycle — bounds it to one retry, never a loop. */
    this._retriedThisCycle = false;

    // Elevation-flag entities (see data/contourFlags.js) — a separate
    // CustomDataSource from the plain contour lines (which are raw
    // PolylineCollection primitives) since flags toggle independently.
    this._contourFlagDataSource = new Cesium.CustomDataSource('mapOverlaysContourFlags');
    this.viewer.dataSources.add(this._contourFlagDataSource);
    this._contourFlagEntities = [];
    this._removeFlagAvoidance = installFlagAvoidance(this.viewer, () => this._contourFlagEntities);

    this._cursorActive = false;
    this._cursorEntity = null;
    this._cursorHandler = null;
    this._cursorData = null; // last resolved {lat, lon, height, address}
    this._geocodeToken = 0;

    /** @type {?Function} UI callback: (statusText) => void */
    this.onStatusChange = null;
    /** @type {?Function} UI callback: (cursorData) => void */
    this.onCursorChange = null;

    this._onCameraMoveEnd = this._onCameraMoveEnd.bind(this);
    this.viewer.camera.moveEnd.addEventListener(this._onCameraMoveEnd);

    // Re-run through the setter (not just `_applyVerticalExaggeration`) so a
    // value restored from an older session's saved state — before the UI was
    // limited to 1.0×/1.5×/2.0× — gets snapped to the nearest valid option.
    this.setVerticalExaggeration(this.state.verticalExaggeration);
    if (this.state.contoursEnabled) this._scheduleRecompute();
    if (this.state.gridEnabled) this._recomputeGrid();
  }

  // ── persistence ──────────────────────────────────────────────────────
  _persist() {
    saveState(this.state);
  }

  _setStatus(text) {
    this._contourStatus = text;
    this.onStatusChange?.(text);
  }

  // ── vertical exaggeration ───────────────────────────────────────────
  /**
   * Sets the terrain height-relief multiplier. Only {@link EXAGGERATION_OPTIONS}
   * (1.0×, 1.5×, 2.0×) are valid — any other value (including a stale
   * value restored from an older session's saved state) snaps to whichever
   * option is numerically closest, so the engine's state can never drift
   * out of sync with what the UI is able to offer/display.
   */
  setVerticalExaggeration(value) {
    const num = Number(value);
    const target = Number.isFinite(num) ? num : 1;
    let snapped = EXAGGERATION_OPTIONS[0];
    let bestDelta = Infinity;
    for (const option of EXAGGERATION_OPTIONS) {
      const delta = Math.abs(option - target);
      if (delta < bestDelta) {
        bestDelta = delta;
        snapped = option;
      }
    }
    this.state.verticalExaggeration = snapped;
    this._applyVerticalExaggeration();
    this._persist();
  }

  _applyVerticalExaggeration() {
    this.viewer.scene.verticalExaggeration = this.state.verticalExaggeration;
    this.viewer.scene.verticalExaggerationRelativeHeight = 0;
  }

  // ── contours ─────────────────────────────────────────────────────────
  setContoursEnabled(enabled) {
    this.state.contoursEnabled = Boolean(enabled);
    this._persist();
    if (this.state.contoursEnabled) this._scheduleRecompute();
    else this._clearContours();
  }

  setContourMajorSpacing(meters) {
    const clamped = Cesium.Math.clamp(Number(meters) || 50, 5, 1000);
    this.state.contourMajorSpacing = clamped;
    this._persist();
    if (this.state.contoursEnabled) this._scheduleRecompute();
  }

  setContourMinorEnabled(enabled) {
    this.state.contourMinorEnabled = Boolean(enabled);
    this._persist();
    if (this.state.contoursEnabled) this._scheduleRecompute();
  }

  setContourMinorSpacing(meters) {
    const clamped = Cesium.Math.clamp(Number(meters) || 10, 1, 500);
    this.state.contourMinorSpacing = clamped;
    this._persist();
    if (this.state.contoursEnabled && this.state.contourMinorEnabled) this._scheduleRecompute();
  }

  // ── grid line value labels ──────────────────────────────────────────
  /**
   * Large-text lat/long value labels on whichever grid lines are currently
   * on screen. Separate from `contourFlagsEnabled` (the elevation flags on
   * contour lines) — the two used to share one toggle, but each now
   * switches on/off independently.
   */
  setLineLabelsEnabled(enabled) {
    this.state.lineLabelsEnabled = Boolean(enabled);
    this._persist();
    // Labels ride along with the grid's own recompute (synchronous) so the
    // add-or-clear decision only has to live in `_recomputeGrid`'s own
    // `this.state.lineLabelsEnabled` check, which does nothing if the grid
    // itself isn't enabled.
    if (this.state.gridEnabled) this._recomputeGrid();
  }

  // ── contour elevation flags ─────────────────────────────────────────
  /**
   * Big "flag" call-outs (pole + numbered plaque, see data/contourFlags.js)
   * on every major contour line currently on screen. Separate from
   * `contoursEnabled` (the lines themselves) and from `lineLabelsEnabled`
   * (grid labels) — this can be toggled independently of both, though it
   * has nothing to draw unless contour lines are also being computed.
   */
  setContourFlagsEnabled(enabled) {
    this.state.contourFlagsEnabled = Boolean(enabled);
    this._persist();
    if (this.state.contourFlagsEnabled && this.state.contoursEnabled) this._scheduleRecompute();
    else if (!this.state.contourFlagsEnabled) this._clearContourFlags();
  }

  _clearContourFlags() {
    this._contourFlagDataSource.entities.removeAll();
    this._contourFlagEntities = [];
    this._lastFlagSpotByLevel = null;
    this._lastLevelPaletteIndex = null;
  }

  // ── contour flag label style ────────────────────────────────────────
  setFlagFontSize(px) {
    this.state.flagFontSize = Cesium.Math.clamp(Number(px) || DEFAULT_FLAG_FONT_SIZE, 12, 48);
    this._persist();
    if (this.state.contourFlagsEnabled) this._rebuildContourFlagsOnly();
  }

  setFlagBgColor(hex) {
    this.state.flagBgColor = hex || DEFAULT_STATE.flagBgColor;
    this._persist();
    if (this.state.contourFlagsEnabled) this._rebuildContourFlagsOnly();
  }

  setFlagBgAlpha(alpha) {
    this.state.flagBgAlpha = Cesium.Math.clamp(Number(alpha), 0, 1);
    this._persist();
    if (this.state.contourFlagsEnabled) this._rebuildContourFlagsOnly();
  }

  setFlagLabelStep(step) {
    this.state.flagLabelStep = Math.max(1, Math.round(Number(step)) || 1);
    this._persist();
    if (this.state.contourFlagsEnabled) this._rebuildContourFlagsOnly();
  }

  /** Re-draws just the flag layer from the last-computed contour spots, without a full re-sample of scene heights — used when only a label-style control (font/bg/step) changes. */
  _rebuildContourFlagsOnly() {
    if (!this._lastFlagSpotByLevel) return;
    this._applyContourFlags(this._lastFlagSpotByLevel);
  }

  /** Builds (or clears) the flag layer from a full `Map<level, spot>` — applies the frequency thinning and current label style. `levelPaletteIndex` maps each level to the palette index its contour LINE was drawn with, so a flag's pole always matches its line even after thinning changes iteration order. */
  _applyContourFlags(flagSpotByLevel, levelPaletteIndex = this._lastLevelPaletteIndex) {
    this._lastFlagSpotByLevel = flagSpotByLevel;
    this._lastLevelPaletteIndex = levelPaletteIndex;
    if (!this.state.contourFlagsEnabled) { this._clearContourFlags(); return; }
    const thinned = thinSpotsByStep(flagSpotByLevel, this.state.flagLabelStep);
    this._contourFlagEntities = buildContourFlags({
      viewer: this.viewer,
      dataSource: this._contourFlagDataSource,
      spots: thinned,
      formatValue: formatHeight,
      poleColorForLevel: (level) => Cesium.Color.fromCssColorString(paletteColorHex(LAND_CONTOUR_PALETTE, levelPaletteIndex?.get(level) ?? 0)),
      bgColor: Cesium.Color.fromCssColorString(this.state.flagBgColor),
      bgAlpha: this.state.flagBgAlpha,
      fontSize: this.state.flagFontSize,
    });
  }

  _clearGridLabels() {
    if (this._gridLabelPrimitive) {
      this.viewer.scene.primitives.remove(this._gridLabelPrimitive);
      this._gridLabelPrimitive = null;
    }
  }

  _clearContours() {
    if (this._contourPrimitive) {
      this.viewer.scene.primitives.remove(this._contourPrimitive);
      this._contourPrimitive = null;
    }
    this._clearContourFlags();
    this._setStatus('');
  }

  _scheduleRecompute() {
    if (this._recomputeTimer) clearTimeout(this._recomputeTimer);
    this._retriedThisCycle = false;
    this._recomputeTimer = setTimeout(() => this._recomputeContours(), RECOMPUTE_DEBOUNCE_MS);
  }

  async _recomputeContours() {
    if (!this.state.contoursEnabled) return;
    const token = ++this._computeToken;
    const rect = this.viewer.camera.computeViewRectangle();
    if (!rect) { this._setStatus('Camera view unavailable.'); return; }

    const spanDeg = Cesium.Math.toDegrees(Math.max(rect.width, rect.height));
    if (spanDeg > MAX_CONTOUR_VIEW_SPAN_DEG) {
      this._clearContours();
      this._setStatus(`Zoom in to compute contours (view is ${spanDeg.toFixed(1)}° wide, need < ${MAX_CONTOUR_VIEW_SPAN_DEG}°).`);
      return;
    }

    const west = Cesium.Math.toDegrees(rect.west);
    const south = Cesium.Math.toDegrees(rect.south);
    const east = Cesium.Math.toDegrees(rect.east);
    const north = Cesium.Math.toDegrees(rect.north);

    const rows = CONTOUR_GRID_ROWS;
    const cols = CONTOUR_GRID_COLS;
    const lonLatPairs = [];
    for (let r = 0; r < rows; r += 1) {
      const lat = north - (r / (rows - 1)) * (north - south);
      for (let c = 0; c < cols; c += 1) {
        const lon = west + (c / (cols - 1)) * (east - west);
        lonLatPairs.push({ lon, lat });
      }
    }

    this._setStatus('Sampling scene heights…');
    const heights = sampleSceneHeights(this.viewer.scene, lonLatPairs);
    if (token !== this._computeToken) return; // superseded by a newer request

    const finite = heights.filter(Number.isFinite);
    if (finite.length / heights.length < RETRY_MIN_FINITE_FRACTION && !this._retriedThisCycle) {
      // Likely a freshly-panned-to area whose tiles haven't streamed in yet
      // — retry once shortly rather than leaving contours sparse or absent.
      this._retriedThisCycle = true;
      setTimeout(() => { if (token === this._computeToken) this._recomputeContours(); }, RETRY_DELAY_MS);
    }
    if (!finite.length) {
      this._clearContours();
      this._setStatus('No renderable surface here yet — move the view or wait for tiles to load.');
      return;
    }
    const minH = Math.min(...finite);
    const maxH = Math.max(...finite);

    const levels = [];
    const major = this.state.contourMajorSpacing;
    const firstMajor = Math.ceil(minH / major) * major;
    for (let lvl = firstMajor; lvl <= maxH && levels.length < MAX_CONTOUR_LEVELS; lvl += major) {
      levels.push({ height: lvl, major: true });
    }
    if (this.state.contourMinorEnabled) {
      const minor = this.state.contourMinorSpacing;
      const firstMinor = Math.ceil(minH / minor) * minor;
      for (let lvl = firstMinor; lvl <= maxH && levels.length < MAX_CONTOUR_LEVELS; lvl += minor) {
        if (Math.abs(lvl % major) < 1e-6) continue; // already a major level
        levels.push({ height: lvl, major: false });
      }
    }

    // Sorted by height (not push order — majors and minors are pushed in
    // two separate passes above) so that a level's index reflects its
    // actual neighbors on screen: consecutive palette colors then land on
    // lines that are genuinely next to each other, giving real
    // "contrast between neighbours" rather than an arbitrary one.
    const sortedLevels = [...levels].sort((a, b) => a.height - b.height);
    const levelPaletteIndex = new Map(sortedLevels.map((lvl, i) => [lvl.height, i]));
    const colorForLevel = (height) => Cesium.Color.fromCssColorString(paletteColorHex(LAND_CONTOUR_PALETTE, levelPaletteIndex.get(height) ?? 0));

    // For each major level, remember whichever segment endpoint sits
    // closest to the view's west edge — that's where its flag goes (see
    // data/contourFlags.js), one per level rather than one per segment so a
    // level with many crossings doesn't spam the screen with repeated
    // flags. Biased west rather than view-center so a returning viewer
    // always finds a level's flag in the same relative spot.
    const flagSpotByLevel = new Map();

    const newPrimitive = new Cesium.PolylineCollection();
    let segmentCount = 0;
    for (const { height, major: isMajor } of sortedLevels) {
      const segs = marchingSquaresSegments(heights, rows, cols, height);
      const lineColor = colorForLevel(height).withAlpha(isMajor ? 0.85 : 0.35);
      for (const [a, b] of segs) {
        const aLL = gridToLonLat(a.x, a.y, rows, cols, west, south, east, north);
        const bLL = gridToLonLat(b.x, b.y, rows, cols, west, south, east, north);
        newPrimitive.add({
          positions: [
            Cesium.Cartesian3.fromDegrees(aLL.lon, aLL.lat, height),
            Cesium.Cartesian3.fromDegrees(bLL.lon, bLL.lat, height),
          ],
          width: isMajor ? 2 : 1,
          material: Cesium.Material.fromType('Color', { color: lineColor }),
        });
        segmentCount += 1;
      }

      if (isMajor) {
        const spot = westmostSegmentPoint(segs, rows, cols, west, south, east, north);
        if (spot) flagSpotByLevel.set(height, spot);
      }
    }

    if (token !== this._computeToken) { newPrimitive.destroy(); return; }
    this._clearContours();
    if (segmentCount > 0) {
      this._contourPrimitive = this.viewer.scene.primitives.add(newPrimitive);
      this._setStatus(`${levels.length} level${levels.length === 1 ? '' : 's'}, ${segmentCount} segments (${Math.round(minH)}–${Math.round(maxH)} m relief).`);
    } else {
      newPrimitive.destroy();
      this._setStatus(`Flat here — ${Math.round(minH)}–${Math.round(maxH)} m relief, no contour crossing.`);
    }

    this._applyContourFlags(flagSpotByLevel, levelPaletteIndex);
  }

  // ── lat/lon grid ─────────────────────────────────────────────────────
  setGridEnabled(enabled) {
    this.state.gridEnabled = Boolean(enabled);
    this._persist();
    if (this.state.gridEnabled) this._recomputeGrid();
    else this._clearGrid();
  }

  setGridSpacingDeg(deg) {
    const clamped = Cesium.Math.clamp(Number(deg) || 1, 0.001, 45);
    this.state.gridSpacingDeg = clamped;
    this._persist();
    if (this.state.gridEnabled) this._recomputeGrid();
  }

  setGridColor(hex) {
    this.state.gridColor = hex || DEFAULT_STATE.gridColor;
    this._persist();
    if (this.state.gridEnabled) this._recomputeGrid();
  }

  _clearGrid() {
    if (this._gridPrimitive) {
      this.viewer.scene.primitives.remove(this._gridPrimitive);
      this._gridPrimitive = null;
    }
    this._clearGridLabels();
  }

  _recomputeGrid() {
    if (!this.state.gridEnabled) return;
    const rect = this.viewer.camera.computeViewRectangle();
    if (!rect) return;
    const west = Cesium.Math.toDegrees(rect.west);
    const south = Cesium.Math.clamp(Cesium.Math.toDegrees(rect.south), -89.9, 89.9);
    const east = Cesium.Math.toDegrees(rect.east);
    const north = Cesium.Math.clamp(Cesium.Math.toDegrees(rect.north), -89.9, 89.9);
    const spacing = this.state.gridSpacingDeg;

    const meridians = [];
    let start = Math.ceil(west / spacing) * spacing;
    for (let lon = start; lon <= east; lon += spacing) meridians.push(lon);
    const parallels = [];
    start = Math.ceil(south / spacing) * spacing;
    for (let lat = start; lat <= north; lat += spacing) parallels.push(lat);

    const thin = (arr, cap) => {
      if (arr.length <= cap) return arr;
      const step = Math.ceil(arr.length / cap);
      return arr.filter((_, i) => i % step === 0);
    };
    const thinnedMeridians = thin(meridians, MAX_GRID_LINES_PER_AXIS);
    const thinnedParallels = thin(parallels, MAX_GRID_LINES_PER_AXIS);

    const color = Cesium.Color.fromCssColorString(this.state.gridColor).withAlpha(0.55);
    const newPrimitive = new Cesium.PolylineCollection();
    for (const lon of thinnedMeridians) {
      newPrimitive.add({
        positions: [
          Cesium.Cartesian3.fromDegrees(lon, south, 0),
          Cesium.Cartesian3.fromDegrees(lon, north, 0),
        ],
        width: 1,
        material: Cesium.Material.fromType('Color', { color }),
      });
    }
    for (const lat of thinnedParallels) {
      newPrimitive.add({
        positions: [
          Cesium.Cartesian3.fromDegrees(west, lat, 0),
          Cesium.Cartesian3.fromDegrees(east, lat, 0),
        ],
        width: 1,
        material: Cesium.Material.fromType('Color', { color }),
      });
    }

    this._clearGrid();
    this._gridPrimitive = this.viewer.scene.primitives.add(newPrimitive);

    if (this.state.lineLabelsEnabled) {
      // One label per line, placed at its midpoint through the current
      // viewport — a meridian's label sits at the view's vertical center,
      // a parallel's at the horizontal center, so labels spread out along
      // the middle of the screen rather than piling up at an edge.
      const midLat = (south + north) / 2;
      const midLon = (west + east) / 2;
      const labelPrimitive = new Cesium.LabelCollection();
      for (const lon of thinnedMeridians) {
        labelPrimitive.add({
          position: Cesium.Cartesian3.fromDegrees(lon, midLat, 0),
          text: toDMS(lon, false),
          font: LINE_LABEL_FONT,
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 4,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
        });
      }
      for (const lat of thinnedParallels) {
        labelPrimitive.add({
          position: Cesium.Cartesian3.fromDegrees(midLon, lat, 0),
          text: toDMS(lat, true),
          font: LINE_LABEL_FONT,
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 4,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
        });
      }
      this._gridLabelPrimitive = this.viewer.scene.primitives.add(labelPrimitive);
    }
  }

  _onCameraMoveEnd() {
    if (this.state.contoursEnabled) this._scheduleRecompute();
    if (this.state.gridEnabled) this._recomputeGrid();
  }

  // ── cursor / pin tool ────────────────────────────────────────────────
  setCursorActive(active) {
    this._cursorActive = Boolean(active);
    if (this._cursorActive) this._installCursorHandler();
    else this._uninstallCursorHandler();
    // Fire onCursorChange on activation flips too (not just on a new pin),
    // so a UI subscribing to it — e.g. coordinatesBox.js's toggle button —
    // can stay in sync even when active state changes from elsewhere (for
    // instance MapOverlaysEngine#reset(), called from a separate box now
    // that the coordinate tool has its own).
    this.onCursorChange?.(this._cursorData);
  }

  isCursorActive() {
    return this._cursorActive;
  }

  _installCursorHandler() {
    if (this._cursorHandler) return;
    this._cursorHandler = new Cesium.ScreenSpaceEventHandler(this.viewer.scene.canvas);
    this._cursorHandler.setInputAction((movement) => {
      this._placeCursor(movement.position);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  _uninstallCursorHandler() {
    if (!this._cursorHandler) return;
    this._cursorHandler.destroy();
    this._cursorHandler = null;
  }

  clearCursor() {
    if (this._cursorEntity) {
      this.viewer.entities.remove(this._cursorEntity);
      this._cursorEntity = null;
    }
    this._cursorData = null;
    this.onCursorChange?.(null);
  }

  _placeCursor(windowPosition) {
    const scene = this.viewer.scene;
    let cartesian = scene.pickPositionSupported ? scene.pickPosition(windowPosition) : undefined;
    if (!Cesium.defined(cartesian)) {
      const ray = this.viewer.camera.getPickRay(windowPosition);
      cartesian = ray ? scene.globe.pick(ray, scene) : undefined;
    }
    if (!Cesium.defined(cartesian)) {
      cartesian = this.viewer.camera.pickEllipsoid(windowPosition, scene.globe.ellipsoid);
    }
    if (!Cesium.defined(cartesian)) return;

    const carto = Cesium.Cartographic.fromCartesian(cartesian);
    const lat = Cesium.Math.toDegrees(carto.latitude);
    const lon = Cesium.Math.toDegrees(carto.longitude);
    const height = carto.height;

    if (!this._cursorEntity) {
      this._cursorEntity = this.viewer.entities.add({
        id: 'map-overlays-cursor-pin',
        position: cartesian,
        point: { pixelSize: 12, color: Cesium.Color.fromCssColorString('#00d4ff'), outlineColor: Cesium.Color.BLACK, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        label: {
          text: '📍',
          font: '20px sans-serif',
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          pixelOffset: new Cesium.Cartesian2(0, -4),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          showBackground: false,
        },
      });
    } else {
      this._cursorEntity.position = cartesian;
    }

    this._cursorData = { lat, lon, height, address: null, addressStatus: 'loading' };
    this.onCursorChange?.(this._cursorData);
    this._reverseGeocode(lat, lon);
  }

  async _reverseGeocode(lat, lon) {
    const token = ++this._geocodeToken;
    const apiKey = resolveApiKey('GOOGLE_MAPS_API_KEY', import.meta.env?.GOOGLE_MAPS_API_KEY) || window.__GOOGLE_MAPS_API_KEY__;
    if (!apiKey) {
      if (this._cursorData) { this._cursorData.address = null; this._cursorData.addressStatus = 'no-key'; this.onCursorChange?.(this._cursorData); }
      return;
    }

    // Reverse-geocoded addresses are "broadly unchangeable content" for a
    // given point — cache them durably (data/apiCache.js) so re-clicking a
    // nearby spot doesn't re-hit the Google API every time.
    const cache = getSharedCache();
    const cacheKey = `${lat.toFixed(4)},${lon.toFixed(4)}`;
    try {
      const cached = await cache.get(GEOCODE_CACHE_STORE, cacheKey);
      if (cached && token === this._geocodeToken) {
        if (this._cursorData) {
          this._cursorData.address = cached.address;
          this._cursorData.addressStatus = cached.address ? 'ok' : 'not-found';
          this.onCursorChange?.(this._cursorData);
        }
        return;
      }
    } catch { /* cache unavailable — fall through to a live lookup */ }

    try {
      const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lon}&key=${apiKey}`;
      const response = await fetch(url);
      const data = await response.json();
      if (token !== this._geocodeToken) return;
      const address = (data.status === 'OK' && data.results?.length) ? data.results[0].formatted_address : null;
      try { await cache.put(GEOCODE_CACHE_STORE, cacheKey, { address }); } catch { /* best-effort */ }
      if (this._cursorData) {
        this._cursorData.address = address;
        this._cursorData.addressStatus = address ? 'ok' : 'not-found';
        this.onCursorChange?.(this._cursorData);
      }
    } catch {
      if (token !== this._geocodeToken) return;
      if (this._cursorData) { this._cursorData.address = null; this._cursorData.addressStatus = 'error'; this.onCursorChange?.(this._cursorData); }
    }
  }

  /** Formatted strings for the copyable output box, or null if no cursor is placed. */
  getCursorOutput() {
    if (!this._cursorData) return null;
    const { lat, lon, height, address, addressStatus } = this._cursorData;
    return {
      dms: formatLatLonDMS(lat, lon),
      decimal: formatLatLonDecimal(lat, lon),
      height: formatHeight(height),
      address: address || (addressStatus === 'loading' ? 'Looking up address…' : addressStatus === 'no-key' ? 'No Google Maps key configured' : 'No address found'),
      mapsLink: googleMapsLink(lat, lon),
      addressStatus,
    };
  }

  /** The live camera position, formatted the same way as the cursor output — used when no pin is placed. */
  getCameraOutput() {
    const carto = this.viewer.camera.positionCartographic;
    if (!carto) return null;
    const lat = Cesium.Math.toDegrees(carto.latitude);
    const lon = Cesium.Math.toDegrees(carto.longitude);
    return {
      dms: formatLatLonDMS(lat, lon),
      decimal: formatLatLonDecimal(lat, lon),
      height: formatHeight(carto.height),
    };
  }

  // ── screenshot ───────────────────────────────────────────────────────
  captureScreenshot() {
    return new Promise((resolve, reject) => {
      try {
        this.viewer.scene.render();
        const canvas = this.viewer.scene.canvas;
        canvas.toBlob((blob) => {
          if (!blob) { reject(new Error('Could not capture the viewport.')); return; }
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `gods-eye-view-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 5000);
          resolve();
        }, 'image/png');
      } catch (err) {
        reject(err);
      }
    });
  }

  // ── reset ────────────────────────────────────────────────────────────
  reset() {
    this.state = { ...DEFAULT_STATE };
    this._persist();
    this._applyVerticalExaggeration();
    this._clearContours();
    this._clearGrid();
    this.clearCursor();
    this.setCursorActive(false);
  }

  destroy() {
    this.viewer.camera.moveEnd.removeEventListener(this._onCameraMoveEnd);
    if (this._recomputeTimer) clearTimeout(this._recomputeTimer);
    this._removeFlagAvoidance?.();
    this._clearContours();
    this.viewer.dataSources.remove(this._contourFlagDataSource, true);
    this._clearGrid();
    this._uninstallCursorHandler();
    this.clearCursor();
  }
}

export function initMapOverlays(viewer) {
  return new MapOverlaysEngine(viewer);
}
