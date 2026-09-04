import * as Cesium from 'cesium';
import { marchingSquaresSegments, gridToLonLat, extremeSegmentPoint, stitchSegmentsIntoPolylines, smoothPolyline, computeCellHeightRange } from './contourMath.js';
import { formatLatLonDMS, formatLatLonDecimal, googleMapsLink, formatHeight, toDMS } from './coordFormat.js';
import { resolveApiKey } from '../apiKeys.js';
import { sampleSceneHeights } from './sceneHeight.js';
import { getSharedCache } from './apiCache.js';
import { buildContourFlags, buildRingLabels, installFlagAvoidance, installLabelCollectionAvoidance, thinSpotsByStep, DEFAULT_FLAG_FONT_SIZE } from './contourFlags.js';
import { LAND_CONTOUR_PALETTE, paletteColorHex } from './contourColors.js';

/**
 * @file Cesium-facing engine behind the "Map Overlays" control box: elevation
 * contour lines, a toggleable chart-datum (sea level) reference plane,
 * vertical (height-relief) exaggeration, a lat/lon graticule, and a
 * click-to-place coordinate cursor with reverse geocoding + a
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
/**
 * Bounds for the user-adjustable "Zoom-in requirement" slider (see
 * `setContourMaxViewSpanDeg`, `DEFAULT_STATE.contourMaxViewSpanDeg`) — the
 * widest the current camera view is allowed to be for contours to compute
 * at all. Used to be a fixed 1.5° (~165km) constant; a direct user report
 * ("this box sometimes gives feedback that it needs an amount of field of
 * view to render... add this requirement to a slidebar") turned it into a
 * live setting instead, bounded to roughly the same "too coarse above this"
 * territory the original constant picked (0.5° ~ 55km, 2.5° ~ 275km).
 */
export const CONTOUR_VIEW_SPAN_MIN_DEG = 0.5;
export const CONTOUR_VIEW_SPAN_MAX_DEG = 2.5;
const DEFAULT_CONTOUR_MAX_VIEW_SPAN_DEG = 1.5;
// `camera.computeViewRectangle()` is an AXIS-ALIGNED bounding box around
// four picked screen-corner points — for a nadir, unrotated camera that's
// close to the true visible footprint, but for a tilted/rotated (oblique)
// view the actual visible ground is a rotated, foreshortened quadrilateral
// well inside that box. Sampling and drawing the whole box wastes real
// work on geography that was never going to be on screen. Rather than
// reshape the sampling grid itself (marching squares needs a plain
// rectangular grid to stay correct), each drawn chain is screen-projected
// after the fact and dropped if none of its points land anywhere near the
// canvas — see `_anyPositionOnScreen`.
const CONTOUR_SCREEN_MARGIN_PX = 40; // generous slack so a chain right at the true edge doesn't flicker in/out
const MAX_CONTOUR_LEVELS = 60; // hard cap so pathological relief can't spawn thousands of polylines
/** Hard cap on flags per individual on-screen contour chain — see the flag-placement comment in `_recomputeContours`. A level's height must also be a clean multiple of 50 to get more than 1. */
const MAX_FLAGS_PER_CHAIN = 2;
/**
 * A grid cell whose corner-height range already spans this many
 * minor-contour intervals gets its minor lines suppressed (majors are
 * never touched) — see `computeCellHeightRange`'s comment and the
 * `cellHeightRange`/`minorSteepCutoff` use in `_recomputeContours`. This is
 * what stops the "solid smear of parallel lines" artifact on cliff-steep
 * terrain: once 3+ minor lines would land in the same handful of on-screen
 * pixels no matter the camera angle, drawing them adds noise, not
 * information, so they're dropped at the source instead of overlapping.
 */
const MINOR_CONTOUR_STEEP_INTERVALS = 3;
const MAX_GRID_LINES_PER_AXIS = 60;
/** Valid `flagEdges`/edge-argument values, in the fixed order UI checkboxes present them. */
const FLAG_EDGES = ['west', 'east', 'north', 'south'];
// If more than this fraction of the sampled grid comes back unresolved
// (tiles for a freshly-panned-to area haven't streamed in yet), retry once
// after a short delay instead of leaving contours sparse/missing.
const RETRY_MIN_FINITE_FRACTION = 0.6;
const RETRY_DELAY_MS = 800;
// A single retry often isn't enough right after boot or a big pan/zoom —
// tiles can take longer than 800ms to stream in, especially several in a
// row during an intro camera flight. Retrying a few times (still capped,
// never a loop) instead of giving up after one attempt is what actually
// fixes "contours show briefly then disappear": that was sparse first-pass
// data getting drawn, then immediately cleared/replaced once the single
// retry ran and still found the view mid-load.
const MAX_RECOMPUTE_RETRIES = 4;
/** Cache store name (see data/apiCache.js) for reverse-geocode results — addresses for a given point essentially never change. */
const GEOCODE_CACHE_STORE = 'geocode';
/**
 * Cache store name for the FINISHED contour map-visualization data — drawn
 * line geometry, flag spots, and ring-label positions, not raw scene
 * height samples (see `contourCacheKey` and `_recomputeContours` for the
 * freshness/safety reasoning: a hit repaints instantly, but only a
 * recent-enough hit skips the live recompute outright — an older one is
 * shown as an instant preview while a live recompute still runs
 * underneath and corrects it).
 */
const CONTOUR_GEOMETRY_CACHE_STORE = 'mapContourLines';
/** Within this long a cached contour result is treated as authoritative and the live resample is skipped entirely; past it, a hit is still painted instantly but a live recompute still follows and overwrites it. */
const CONTOUR_CACHE_FRESH_MS = 10 * 60 * 1000;
/**
 * How long the contour pipeline waits on the durable cache read before
 * going ahead with the live compute anyway. The cache is an optimization,
 * never a dependency: a read that never settles used to hang the whole
 * recompute (and, since every later recompute hit the same wall, contours
 * stopped updating entirely until the page was reloaded).
 */
const CACHE_READ_TIMEOUT_MS = 1500;
/** View-rectangle rounding (decimal degrees) for the contour cache key — coarse enough that returning to roughly the same framing still hits (~111m), fine enough that two genuinely different views don't collide. */
const CONTOUR_CACHE_PRECISION = 3;
/** The only vertical-exaggeration multipliers the UI (and this engine) accept — see `setVerticalExaggeration`. */
const EXAGGERATION_OPTIONS = [1, 1.5, 2];
/** The only minimum-drawn-height cutoffs the UI (and this engine) accept — see `setContourMinHeightM`. */
const MIN_HEIGHT_OPTIONS = [0, 100, 200];

/**
 * Cache key for the contour geometry cache: a coarsely-rounded view
 * rectangle plus every piece of engine state that affects the FINISHED
 * output (line geometry, flags, ring labels) — so a hit is only ever
 * reused when it's valid for exactly what's currently configured.
 */
function contourCacheKey(west, south, east, north, state) {
  const r = (n) => n.toFixed(CONTOUR_CACHE_PRECISION);
  const edges = [...state.flagEdges].sort().join(',');
  return [
    r(west), r(south), r(east), r(north),
    state.contourMajorSpacing,
    state.contourMinorEnabled ? 1 : 0,
    state.contourMinorSpacing,
    state.contourSmoothing,
    edges,
    state.ringLabelsEnabled ? 1 : 0,
    state.contourMinHeightM || 0,
  ].join('|');
}

export const DEFAULT_STATE = Object.freeze({
  contoursEnabled: false,
  contourMajorSpacing: 50,
  contourMinorEnabled: false,
  contourMinorSpacing: 10,
  // Widest the camera view is allowed to be for contours to compute at all
  // — see `setContourMaxViewSpanDeg` and CONTOUR_VIEW_SPAN_MIN/MAX_DEG.
  // The "Zoom-in requirement" slider in the UI.
  contourMaxViewSpanDeg: DEFAULT_CONTOUR_MAX_VIEW_SPAN_DEG,
  // Chaikin corner-cutting passes applied to every drawn contour line (see
  // data/contourMath.js's smoothPolyline) — 0 is the raw marching-squares
  // line, higher numbers round it off more. This is the "precision" slider.
  contourSmoothing: 1,
  // Minimum drawn contour height (meters) — 0 = no filter (draw every
  // level), 100/200 hide every level below that so low-lying/coastal
  // relief doesn't clutter the view when only the higher terrain matters.
  // Only ever 0, 100, or 200 — see `setContourMinHeightM`'s snapping.
  contourMinHeightM: 0,
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
  // Grid line label text size — independent of the flag/ring-label sizes,
  // and of LINE_LABEL_FONT's old hardcoded 20px (now just this state's
  // default). See `setGridLabelFontSize`.
  gridLabelFontSize: 20,
  // Big "flag" call-outs (pole + numbered plaque) on every major contour
  // line currently on screen — a separate toggle from `lineLabelsEnabled`
  // (grid) and from `contoursEnabled` (the lines themselves): the flags can
  // be shown/hidden independently of both. See `data/contourFlags.js`.
  contourFlagsEnabled: false,
  // Flag label text size — independent of the contour LINE colors (which
  // cycle through data/contourColors.js's palette). The plaque background
  // is gone (flags are transparent, drop-shadow text — see
  // data/contourFlags.js) so there's no color/opacity to persist any more.
  flagFontSize: DEFAULT_FLAG_FONT_SIZE,
  // Which edge(s) of the current view each major level gets a flag placed
  // toward — 'west' alone was the original behavior; adding 'east' first
  // "doubled their occurrence" so a line spanning the whole screen reads a
  // value near whichever side is actually in view. Now defaults to all
  // four edges for more on-screen labels overall — safe to turn up because
  // `contourFlags.js`'s installFlagAvoidance now also nudges labels apart
  // from EACH OTHER (not just away from control panels) and hides one
  // outright if it truly can't find a clear spot, so more candidate flags
  // converges on better screen coverage rather than more overlap. See
  // data/contourMath.js's extremeSegmentPoint.
  flagEdges: ['west', 'east', 'north', 'south'],
  // "Label every contour / every other / every 3rd…" — 1 = every major
  // contour line gets a flag (today's behavior), 2 = every other, etc.
  flagLabelStep: 1,
  // Small "which ring is this" label on every fully-closed contour line
  // (an isolated hilltop/basin) — see data/contourFlags.js's
  // buildRingLabels. On by default since it's a direct legibility win with
  // no clutter cost when there's nothing closed in view.
  ringLabelsEnabled: true,
  // "Chart datum" in marine-chart terms, colloquially sea level: a
  // translucent reference plane at ellipsoid height 0 spanning the current
  // view, so a viewer can see at a glance how much of what's on screen
  // sits above or below it. Unlike the contour lines above, it's pure
  // geometry off the current view rectangle — no scene-height sampling —
  // so it's cheap enough to leave on by default; see
  // `_recomputeChartDatum`.
  chartDatumEnabled: true,
});

/**
 * Resolves to `promise`'s value, or to `undefined` if it rejects or hasn't
 * settled within `ms` — for awaits that must never be able to stall their
 * caller (see `CACHE_READ_TIMEOUT_MS`).
 */
function withTimeout(promise, ms) {
  return Promise.race([
    Promise.resolve(promise).catch(() => undefined),
    new Promise((resolve) => { setTimeout(() => resolve(undefined), ms); }),
  ]);
}

/** The status sentence shown when the view is too wide to contour — the one place that wording and its numbers are produced. */
export function tooWideStatusText(spanDeg, maxSpanDeg) {
  return `Zoom in to compute contours (view is ${spanDeg.toFixed(1)}° wide, need < ${maxSpanDeg.toFixed(1)}°).`;
}

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
    this._chartDatumEntity = null;
    this._recomputeTimer = null;
    this._contourStatus = ''; // status line shown in the UI
    this._contourPhase = 'offline'; // traffic-light state for the status line — see `_setStatus`'s doc comment
    this._lastViewSpanDeg = null; // most recent camera-view span, in degrees — see `onViewSpanChange`/`_recomputeContours`
    this._computeToken = 0;
    // Shared durable cache — reverse-geocode results (see `_reverseGeocode`)
    // and, now, the finished contour map-visualization data (see
    // CONTOUR_GEOMETRY_CACHE_STORE / `_recomputeContours`).
    this._cache = getSharedCache();
    /** How many sparse-height retries have fired for the in-flight recompute cycle — bounds it to MAX_RECOMPUTE_RETRIES, never a loop. */
    this._retryCountThisCycle = 0;

    // Elevation-flag entities (see data/contourFlags.js) — a separate
    // CustomDataSource from the plain contour lines (which are raw
    // PolylineCollection primitives) since flags toggle independently.
    this._contourFlagDataSource = new Cesium.CustomDataSource('mapOverlaysContourFlags');
    this.viewer.dataSources.add(this._contourFlagDataSource);
    this._contourFlagEntities = [];
    // Small closed-ring labels — their own data source (toggles
    // independently of the big edge flags above) but share the same
    // panel-avoidance pass, see the combined getEntities() below.
    this._contourRingLabelDataSource = new Cesium.CustomDataSource('mapOverlaysRingLabels');
    this.viewer.dataSources.add(this._contourRingLabelDataSource);
    this._ringLabelEntities = [];
    this._removeFlagAvoidance = installFlagAvoidance(
      this.viewer,
      () => [...this._contourFlagEntities, ...this._ringLabelEntities],
    );
    // Grid line labels (see _recomputeGrid) are a plain Cesium.LabelCollection,
    // not entities — same panel/mutual-overlap avoidance, different Label API
    // underneath (see installLabelCollectionAvoidance's own doc for why).
    this._removeGridLabelAvoidance = installLabelCollectionAvoidance(
      this.viewer,
      () => {
        const coll = this._gridLabelPrimitive;
        if (!coll) return [];
        const out = [];
        for (let i = 0; i < coll.length; i += 1) out.push(coll.get(i));
        return out;
      },
    );

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
    if (this.state.chartDatumEnabled) this._recomputeChartDatum();
  }

  // ── persistence ──────────────────────────────────────────────────────
  _persist() {
    saveState(this.state);
  }

  /**
   * @param {string} text - Human-readable status sentence.
   * @param {'offline'|'loading'|'computing'|'done'} [phase] - The
   *   traffic-light state for `mapOverlayControls.js`'s status light:
   *   'offline' (red) = not rendering any contours right now (toggled
   *   off, view too wide, no renderable surface); 'loading' (orange) =
   *   blocked waiting on something external (terrain tiles streaming in);
   *   'computing' (purple) = actively sampling/marching-squares-ing right
   *   now; 'done' (green) = the current view's contours are finished and
   *   on screen (including the "flat here, nothing to draw" case — that's
   *   still a successfully finished render, just an empty one). Omitted
   *   only by `_clearContours`'s bare reset, which every real caller
   *   immediately follows with a phase-carrying call of its own.
   */
  _setStatus(text, phase) {
    this._contourStatus = text;
    if (phase) this._contourPhase = phase;
    this.onStatusChange?.(text, this._contourPhase);
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

  /**
   * "Zoom-in requirement" slider — the widest the camera view is allowed
   * to be for contours to compute at all (see the span check near the top
   * of `_recomputeContours`). Widening it lets contours draw at a coarser
   * zoom (at the cost of a coarser sample grid spread over more ground);
   * narrowing it forces a closer zoom for a sharper result. Re-evaluates
   * immediately so dragging the slider while zoomed out past the OLD limit
   * but within the NEW one turns contours back on right away, without
   * waiting for the next camera move.
   */
  setContourMaxViewSpanDeg(deg) {
    const clamped = Cesium.Math.clamp(
      Number(deg) || DEFAULT_CONTOUR_MAX_VIEW_SPAN_DEG,
      CONTOUR_VIEW_SPAN_MIN_DEG,
      CONTOUR_VIEW_SPAN_MAX_DEG,
    );
    this.state.contourMaxViewSpanDeg = clamped;
    this._persist();
    // The readout carries the limit as well as the span, so it has to be
    // republished here — the recompute below is debounced, and doesn't run
    // at all with contours off.
    this._publishViewSpan(this._lastViewSpanDeg ?? this._currentViewSpanDeg());
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

  /**
   * "Precision" slider: how many Chaikin corner-cutting passes
   * (`data/contourMath.js`'s `smoothPolyline`) each contour line gets
   * before it's drawn. 0 = raw marching-squares line; higher rounds it off
   * more. Needs a full recompute (not just a redraw) since it changes the
   * actual line geometry, not just a label's style.
   */
  setContourSmoothing(level) {
    this.state.contourSmoothing = Cesium.Math.clamp(Math.round(Number(level)) || 0, 0, 4);
    this._persist();
    if (this.state.contoursEnabled) this._scheduleRecompute();
  }

  /**
   * Minimum drawn contour height — hides every level below the cutoff so
   * low-lying/coastal relief doesn't clutter the view when only the
   * higher terrain matters. Only 0 (off)/100/200 are valid — snapped to
   * the nearest option same as `setVerticalExaggeration`, so a stale
   * restored value can never drift out of what the UI offers. Changes the
   * actual set of drawn levels, so it needs a full recompute.
   */
  setContourMinHeightM(meters) {
    const num = Number(meters);
    const target = Number.isFinite(num) ? num : 0;
    let snapped = MIN_HEIGHT_OPTIONS[0];
    let bestDelta = Infinity;
    for (const option of MIN_HEIGHT_OPTIONS) {
      const delta = Math.abs(option - target);
      if (delta < bestDelta) { bestDelta = delta; snapped = option; }
    }
    this.state.contourMinHeightM = snapped;
    this._persist();
    if (this.state.contoursEnabled) this._scheduleRecompute();
  }

  // ── chart datum (sea level) plane ───────────────────────────────────
  /**
   * Toggle the translucent chart-datum reference plane — see
   * `DEFAULT_STATE.chartDatumEnabled`'s comment for what it's for.
   * Independent of `contoursEnabled`: it draws (or doesn't) regardless of
   * whether the elevation contour lines are on.
   */
  setChartDatumEnabled(enabled) {
    this.state.chartDatumEnabled = Boolean(enabled);
    this._persist();
    if (this.state.chartDatumEnabled) this._recomputeChartDatum();
    else this._clearChartDatum();
  }

  _clearChartDatum() {
    if (this._chartDatumEntity) {
      this.viewer.entities.remove(this._chartDatumEntity);
      this._chartDatumEntity = null;
    }
  }

  /**
   * Redraw the chart-datum plane to cover exactly the current view
   * rectangle. Purely geometric — four corners off
   * `camera.computeViewRectangle()` — so unlike `_recomputeContours` this
   * never samples the scene and never needs debouncing; it's cheap enough
   * to run directly on every camera settle (see `_onCameraMoveEnd`).
   */
  _recomputeChartDatum() {
    if (!this.state.chartDatumEnabled) return;
    const rect = this.viewer.camera.computeViewRectangle();
    if (!rect) return;
    if (!this._chartDatumEntity) {
      this._chartDatumEntity = this.viewer.entities.add({
        id: 'map-overlays-chart-datum',
        rectangle: {
          coordinates: rect,
          height: 0,
          material: Cesium.Color.fromCssColorString('#1e90ff').withAlpha(0.14),
          outline: true,
          outlineColor: Cesium.Color.fromCssColorString('#66c8ff').withAlpha(0.6),
        },
      });
    } else {
      this._chartDatumEntity.rectangle.coordinates = rect;
    }
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

  /** Text size (px) for grid line value labels — the "Text size" slider next to "Show grid value labels". */
  setGridLabelFontSize(px) {
    this.state.gridLabelFontSize = Cesium.Math.clamp(Number(px) || DEFAULT_STATE.gridLabelFontSize, 12, 48);
    this._persist();
    if (this.state.gridEnabled && this.state.lineLabelsEnabled) this._recomputeGrid();
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

  /** Ring labels toggle independently of the big edge flags above (`ringLabelsEnabled` vs. `contourFlagsEnabled`), so this is deliberately separate from `_clearContourFlags` — `_clearContours()` (everything off) calls both. */
  _clearRingLabels() {
    this._contourRingLabelDataSource.entities.removeAll();
    this._ringLabelEntities = [];
    this._lastRingSpots = null;
  }

  // ── contour flag label style ────────────────────────────────────────
  setFlagFontSize(px) {
    this.state.flagFontSize = Cesium.Math.clamp(Number(px) || DEFAULT_FLAG_FONT_SIZE, 12, 48);
    this._persist();
    if (this.state.contourFlagsEnabled) this._rebuildContourFlagsOnly();
  }

  /**
   * Which edge(s) of the current view get a flag for each (thinned) major
   * level — any non-empty subset of `['west','east','north','south']`.
   * Changes the actual spot geometry (computed per-edge in
   * `_recomputeContours`), so — unlike the style-only setters above — this
   * needs a full recompute, not just a redraw.
   */
  setFlagEdges(edges) {
    const next = Array.isArray(edges) ? edges.filter((e) => FLAG_EDGES.includes(e)) : [];
    this.state.flagEdges = next.length ? next : ['west'];
    this._persist();
    if (this.state.contourFlagsEnabled && this.state.contoursEnabled) this._scheduleRecompute();
  }

  setFlagLabelStep(step) {
    this.state.flagLabelStep = Math.max(1, Math.round(Number(step)) || 1);
    this._persist();
    if (this.state.contourFlagsEnabled) this._rebuildContourFlagsOnly();
  }

  /** Re-draws just the flag layer from the last-computed contour spots, without a full re-sample of scene heights — used when only a label-style control (font/step) changes. */
  _rebuildContourFlagsOnly() {
    if (!this._lastFlagSpotByLevel) return;
    this._applyContourFlags(this._lastFlagSpotByLevel);
  }

  // ── closed-ring labels ──────────────────────────────────────────────
  /** Small "which ring is this" label on every fully-closed contour line — see data/contourFlags.js's buildRingLabels. Purely a display toggle over already-computed ring spots, so (unlike setFlagEdges) this never needs a recompute, only a redraw. */
  setRingLabelsEnabled(enabled) {
    this.state.ringLabelsEnabled = Boolean(enabled);
    this._persist();
    this._rebuildRingLabelsOnly();
  }

  /** Re-draws just the ring-label layer from the last-computed ring spots, without a full re-sample of scene heights. */
  _rebuildRingLabelsOnly() {
    this._applyRingLabels(this._lastRingSpots || []);
  }

  /** Builds (or clears) the ring-label layer from a full ring-spot list. */
  _applyRingLabels(rings) {
    this._lastRingSpots = rings;
    if (!this.state.ringLabelsEnabled || !rings.length) {
      this._contourRingLabelDataSource.entities.removeAll();
      this._ringLabelEntities = [];
      return;
    }
    this._ringLabelEntities = buildRingLabels({
      dataSource: this._contourRingLabelDataSource,
      rings,
      formatValue: formatHeight,
    });
  }

  /** Builds (or clears) the flag layer from a full `Map<level, Array<spot>>` — applies the frequency thinning and current label style. `levelPaletteIndex` maps each level to the palette index its contour LINE was drawn with, so a flag's pole always matches its line even after thinning changes iteration order. */
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
    this._clearRingLabels();
    // Default phase 'offline': every caller that clears contours for a
    // reason OTHER than "nothing is rendering right now" (toggling off,
    // view too wide, no renderable surface) immediately follows this with
    // its own phase-carrying `_setStatus` call in the same synchronous
    // pass, so this default is only ever the last word when contours were
    // genuinely just turned off.
    this._setStatus('', 'offline');
  }

  _scheduleRecompute() {
    if (this._recomputeTimer) clearTimeout(this._recomputeTimer);
    this._retryCountThisCycle = 0;
    this._recomputeTimer = setTimeout(() => this._recomputeContours(), RECOMPUTE_DEBOUNCE_MS);
  }

  /**
   * Manual "Refresh contours" button: an immediate, live recompute for the
   * current view — skips the recompute debounce (a click should feel
   * instant, not wait out the same delay a camera pan does) and passes
   * `forceLive` through to `_recomputeContours` so it doesn't just repaint
   * whatever's cached and call it done. A no-op while contours are off.
   */
  refreshContours() {
    if (!this.state.contoursEnabled) return;
    if (this._recomputeTimer) { clearTimeout(this._recomputeTimer); this._recomputeTimer = null; }
    this._retryCountThisCycle = 0;
    this._recomputeContours({ forceLive: true });
  }

  /**
   * True if at least one of `positions` projects anywhere near the actual
   * visible canvas — see `CONTOUR_SCREEN_MARGIN_PX`'s comment for why this
   * exists on top of the view-rectangle sampling bounds. A projection
   * failure (behind the camera, degenerate) counts as off-screen, not a
   * false positive.
   */
  _anyPositionOnScreen(positions) {
    const scene = this.viewer.scene;
    const canvas = scene?.canvas;
    if (!canvas) return true; // no canvas to check against (e.g. a test double) — don't cull blind
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    for (const pos of positions) {
      const screen = Cesium.SceneTransforms.worldToWindowCoordinates(scene, pos);
      if (
        screen
        && screen.x >= -CONTOUR_SCREEN_MARGIN_PX && screen.x <= width + CONTOUR_SCREEN_MARGIN_PX
        && screen.y >= -CONTOUR_SCREEN_MARGIN_PX && screen.y <= height + CONTOUR_SCREEN_MARGIN_PX
      ) return true;
    }
    return false;
  }

  /**
   * Rebuild a `Cesium.PolylineCollection` plus the flag/ring-label Maps
   * straight from a cached payload (see `CONTOUR_GEOMETRY_CACHE_STORE`) —
   * no scene-height sampling, no marching squares, no stitching/smoothing:
   * every point in `payload.lines` is already the final drawn shape.
   */
  _renderCachedContours(payload, token) {
    const levelPaletteIndex = new Map(payload.levelPaletteIndex);
    const newPrimitive = new Cesium.PolylineCollection();
    for (const line of payload.lines) {
      const color = Cesium.Color
        .fromCssColorString(paletteColorHex(LAND_CONTOUR_PALETTE, levelPaletteIndex.get(line.height) ?? 0))
        .withAlpha(line.isMajor ? 0.85 : 0.35);
      const positions = line.positions.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat, line.height));
      newPrimitive.add({ positions, width: line.isMajor ? 2 : 1, material: Cesium.Material.fromType('Color', { color }) });
    }
    this._finishContourRender({
      token,
      newPrimitive,
      segmentCount: payload.segmentCount,
      levelCount: payload.levelCount,
      minH: payload.minH,
      maxH: payload.maxH,
      flagSpotByLevel: new Map(payload.flagSpotByLevel),
      levelPaletteIndex,
      rings: payload.rings,
    });
  }

  /**
   * Shared tail for both a live compute and a cache-hit repaint: swap in
   * the new primitive (or drop it if there was nothing to draw), set the
   * status line, and (re)apply flags/ring labels. Bails without touching
   * anything currently on screen if `token` was superseded while this
   * result was being built/read.
   */
  _finishContourRender({ token, newPrimitive, segmentCount, levelCount, minH, maxH, flagSpotByLevel, levelPaletteIndex, rings }) {
    if (token !== this._computeToken) { newPrimitive.destroy(); return; }
    this._clearContours();
    if (segmentCount > 0) {
      this._contourPrimitive = this.viewer.scene.primitives.add(newPrimitive);
      this._setStatus(`${levelCount} level${levelCount === 1 ? '' : 's'}, ${segmentCount} segments (${Math.round(minH)}–${Math.round(maxH)} m relief).`, 'done');
    } else {
      newPrimitive.destroy();
      this._setStatus(`Flat here — ${Math.round(minH)}–${Math.round(maxH)} m relief, no contour crossing.`, 'done');
    }
    this._applyContourFlags(flagSpotByLevel, levelPaletteIndex);
    this._applyRingLabels(rings);
  }

  /**
   * @param {Object} [opts]
   * @param {boolean} [opts.forceLive=false] - Skip the cache-freshness
   *   fast path and always run a real resample, even if a recent cache
   *   entry exists for this exact view+settings. Set by the manual
   *   "Refresh contours" button (`refreshContours`) — the whole point of
   *   asking for a refresh is to not trust whatever's cached.
   */
  async _recomputeContours(opts = {}) {
    try {
      await this._runRecompute(opts);
    } catch (err) {
      // Nothing awaits this method (it's driven from timers and camera
      // events), so an exception here would otherwise be an unhandled
      // rejection: the status light frozen mid-cycle on whatever the last
      // phase was, and no indication that contours have stopped.
      this._setStatus('Contour recompute failed — try Refresh contours.', 'offline');
      console.warn('[MapOverlays] contour recompute failed:', err);
    }
  }

  async _runRecompute({ forceLive = false } = {}) {
    if (!this.state.contoursEnabled) return;
    const token = ++this._computeToken;
    const rect = this.viewer.camera.computeViewRectangle();
    if (!rect) { this._setStatus('Camera view unavailable.', 'offline'); return; }

    const spanDeg = Cesium.Math.toDegrees(Math.max(rect.width, rect.height));
    this._publishViewSpan(spanDeg);
    const maxSpanDeg = this.state.contourMaxViewSpanDeg;
    if (spanDeg > maxSpanDeg) {
      this._clearContours();
      this._setStatus(tooWideStatusText(spanDeg, maxSpanDeg), 'offline');
      return;
    }
    // Claim the status line for THIS view before the first await below.
    // Every early return past this point (superseded token, an empty or
    // failed sample) otherwise leaves whatever the previous cycle wrote —
    // most visibly the "zoom in, view is N° wide" sentence from a wider
    // view, still on screen next to a span readout that has already
    // updated to the new, narrower span.
    this._setStatus('Sampling scene heights…', 'computing');

    const west = Cesium.Math.toDegrees(rect.west);
    const south = Cesium.Math.toDegrees(rect.south);
    const east = Cesium.Math.toDegrees(rect.east);
    const north = Cesium.Math.toDegrees(rect.north);

    // Durable cache of the FINISHED map-visualization data — see
    // CONTOUR_GEOMETRY_CACHE_STORE's comment. A hit repaints instantly; a
    // RECENT hit is treated as authoritative and skips the live resample
    // below entirely, an OLDER one is shown as an instant preview while
    // the live resample still runs underneath and overwrites both the
    // screen and this cache entry once it finishes — so a hit is never a
    // permanently-stale substitute for the live result, only ever a
    // faster repaint of it. `forceLive` (the manual refresh button) skips
    // straight past this: still paints the cached shape instantly so
    // there's no blank flash, but always keeps going into a real resample
    // regardless of how fresh the cache entry is.
    const cacheKey = contourCacheKey(west, south, east, north, this.state);
    const cached = await withTimeout(
      this._cache.get(CONTOUR_GEOMETRY_CACHE_STORE, cacheKey),
      CACHE_READ_TIMEOUT_MS,
    );
    if (token !== this._computeToken) return; // superseded while the cache read was in flight
    if (cached) {
      this._renderCachedContours(cached, token); // sets phase 'done' via _finishContourRender
      if (!forceLive && Date.now() - (cached.cachedAt || 0) < CONTOUR_CACHE_FRESH_MS) return;
      // Fresh enough to preview instantly but not skip the live resample
      // (or a forced refresh) — flip back to 'computing' so the light
      // reflects that a real recompute is still running underneath the
      // cached preview just painted.
      this._setStatus(this._contourStatus, 'computing');
    }

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

    // Yield one frame here before the actual (synchronous, sometimes tens
    // of ms) sampling/marching-squares/stitching work below runs. Without
    // this, the 'computing' status set above and the 'done' status set at
    // the end of this method landed in the same synchronous JS task, and
    // the browser coalesces every DOM mutation within one task into a
    // single paint of the FINAL state — so the traffic light's purple
    // "Computing…" phase was applied in the DOM for a moment but never
    // actually painted, on every recompute that didn't need the
    // tile-loading retry loop below (which already yields via its own
    // setTimeout). That made "Refresh contours" look unresponsive: the
    // light would just sit on whatever it already was and jump straight
    // to green, with nothing to show a click had done anything.
    await new Promise((resolve) => requestAnimationFrame(resolve));
    if (token !== this._computeToken) return; // camera/settings may have changed during the yield
    const heights = sampleSceneHeights(this.viewer.scene, lonLatPairs);
    if (token !== this._computeToken) return; // superseded by a newer request

    const finite = heights.filter(Number.isFinite);
    const sparse = finite.length / heights.length < RETRY_MIN_FINITE_FRACTION;
    if (sparse && this._retryCountThisCycle < MAX_RECOMPUTE_RETRIES) {
      // Likely a freshly-panned-to (or freshly-booted) area whose tiles
      // haven't streamed in yet. Wait for a retry rather than drawing
      // contours from this partial sample and immediately replacing (or
      // clearing) them a moment later once better data arrives — that
      // flash-then-change/flash-then-empty is what "contours show at boot
      // but disappear" was.
      this._retryCountThisCycle += 1;
      this._setStatus('Sampling scene heights… (waiting for tiles to finish loading)', 'loading');
      setTimeout(() => { if (token === this._computeToken) this._recomputeContours({ forceLive }); }, RETRY_DELAY_MS);
      return;
    }
    if (!finite.length) {
      this._clearContours();
      this._setStatus('No renderable surface here yet — move the view or wait for tiles to load.', 'offline');
      return;
    }
    const minH = Math.min(...finite);
    const maxH = Math.max(...finite);

    const levels = [];
    const major = this.state.contourMajorSpacing;
    const minor = this.state.contourMinorSpacing;
    const firstMajor = Math.ceil(minH / major) * major;
    for (let lvl = firstMajor; lvl <= maxH && levels.length < MAX_CONTOUR_LEVELS; lvl += major) {
      levels.push({ height: lvl, major: true });
    }
    if (this.state.contourMinorEnabled) {
      const firstMinor = Math.ceil(minH / minor) * minor;
      for (let lvl = firstMinor; lvl <= maxH && levels.length < MAX_CONTOUR_LEVELS; lvl += minor) {
        if (Math.abs(lvl % major) < 1e-6) continue; // already a major level
        levels.push({ height: lvl, major: false });
      }
    }

    // Minimum-height cutoff (see `setContourMinHeightM`): drop every level
    // below it BEFORE anything downstream (palette index, drawing, flags,
    // ring labels, the cache payload, the status line's level count) so a
    // hidden level costs nothing beyond the arithmetic above that found
    // it — `minH`/`maxH` themselves stay the true sampled relief range,
    // only which levels actually get drawn changes.
    const minHeightFilter = this.state.contourMinHeightM || 0;
    const drawnLevels = minHeightFilter > 0 ? levels.filter((lvl) => lvl.height >= minHeightFilter) : levels;

    // Sorted by height (not push order — majors and minors are pushed in
    // two separate passes above) so that a level's index reflects its
    // actual neighbors on screen: consecutive palette colors then land on
    // lines that are genuinely next to each other, giving real
    // "contrast between neighbours" rather than an arbitrary one.
    const sortedLevels = [...drawnLevels].sort((a, b) => a.height - b.height);
    const levelPaletteIndex = new Map(sortedLevels.map((lvl, i) => [lvl.height, i]));
    const colorForLevel = (height) => Cesium.Color.fromCssColorString(paletteColorHex(LAND_CONTOUR_PALETTE, levelPaletteIndex.get(height) ?? 0));

    // For each major level, remember one segment endpoint per requested
    // edge (see data/contourFlags.js) — one entry per edge rather than one
    // per segment so a level with many crossings doesn't spam the screen
    // with repeated flags. Biased toward fixed view edges rather than the
    // view center so a returning viewer always finds a level's flag in the
    // same relative spot(s).
    const flagSpotByLevel = new Map();
    // One entry per fully-closed contour ring (an isolated hilltop/basin
    // wholly inside the sampled view) at a MAJOR level — see
    // data/contourFlags.js's buildRingLabels. Multiple concentric rings at
    // the same height (e.g. two separate hills) each get their own entry.
    const rings = [];
    const smoothing = this.state.contourSmoothing;

    // Per-cell relief, computed once for the whole grid (not per level) —
    // see `computeCellHeightRange` and `MINOR_CONTOUR_STEEP_INTERVALS`.
    // Only needed when minors are even on; a cell whose corners already
    // span this many minor intervals gets its minor-level segments
    // suppressed below, which is what stops cliff-steep ground from
    // rendering as a solid smear of overlapping parallel lines.
    const cellHeightRange = this.state.contourMinorEnabled ? computeCellHeightRange(heights, rows, cols) : null;
    const minorSteepCutoff = minor * MINOR_CONTOUR_STEEP_INTERVALS;
    const minorCellFilter = cellHeightRange
      ? (r, c) => cellHeightRange[r * (cols - 1) + c] <= minorSteepCutoff
      : undefined;

    // Mirror of `newPrimitive`'s lines as plain, JSON-serializable data
    // (lon/lat pairs, not Cartesian3) — this is exactly what gets written
    // to CONTOUR_GEOMETRY_CACHE_STORE below, and exactly what
    // `_renderCachedContours` rebuilds a primitive from on a hit.
    const linesForCache = [];

    const newPrimitive = new Cesium.PolylineCollection();
    let segmentCount = 0;
    for (const { height, major: isMajor } of sortedLevels) {
      const segs = marchingSquaresSegments(heights, rows, cols, height, isMajor ? undefined : minorCellFilter);
      segmentCount += segs.length;
      const lineColor = colorForLevel(height).withAlpha(isMajor ? 0.85 : 0.35);

      // Stitch raw 2-point marching-squares segments into continuous
      // chains so (a) a level draws as a handful of real polylines instead
      // of a scatter of disconnected 2-point pieces, (b) smoothing has an
      // actual line to round off rather than isolated segments, and (c) a
      // chain whose ends meet is detectably a closed ring.
      for (const chain of stitchSegmentsIntoPolylines(segs)) {
        let drawPts;
        if (chain.closed) {
          // The stitched ring repeats its first point as its last; drop
          // that duplicate before smoothing (smoothPolyline's own
          // `closed` handling wraps the array itself), then close the
          // SMOOTHED ring back up for rendering.
          const openPts = chain.points.slice(0, -1);
          const smoothed = smoothPolyline(openPts, smoothing, true);
          drawPts = smoothed.length ? [...smoothed, smoothed[0]] : smoothed;
        } else {
          drawPts = smoothPolyline(chain.points, smoothing, false);
        }
        if (drawPts.length < 2) continue;
        const llPoints = drawPts.map((pt) => gridToLonLat(pt.x, pt.y, rows, cols, west, south, east, north));
        const positions = llPoints.map((ll) => Cesium.Cartesian3.fromDegrees(ll.lon, ll.lat, height));
        // Inside the sampled view RECTANGLE doesn't mean inside what's
        // actually on screen for a tilted/rotated camera — see
        // CONTOUR_SCREEN_MARGIN_PX's comment. Drop it here rather than
        // spend a primitive (and cache bytes) on a line nobody sees.
        if (!this._anyPositionOnScreen(positions)) continue;
        newPrimitive.add({
          positions,
          width: isMajor ? 2 : 1,
          material: Cesium.Material.fromType('Color', { color: lineColor }),
        });
        linesForCache.push({ height, isMajor, positions: llPoints.map((ll) => [ll.lon, ll.lat]) });

        if (isMajor && chain.closed && this.state.ringLabelsEnabled) {
          // Northmost point of the RAW (unsmoothed) ring — cheap, stable,
          // and doesn't need smoothing since it's just a label anchor, not
          // a rendered line.
          let top = chain.points[0];
          for (const p of chain.points) if (p.y < top.y) top = p;
          const topLL = gridToLonLat(top.x, top.y, rows, cols, west, south, east, north);
          rings.push({ level: height, lon: topLL.lon, lat: topLL.lat });
        }

        // Flag anchors, restricted to THIS chain (a single continuous
        // on-screen contour) rather than the level's raw, unfiltered
        // segment list. This is deliberately the fix for flags landing on
        // (or being anchored toward) a piece of a level's line that isn't
        // actually rendered: the old code ran extremeSegmentPoint once per
        // level over EVERY segment at that height, on/off-screen alike, so
        // a level with an off-screen chain and a tiny on-screen one could
        // still get its flag pulled toward the invisible chain. Deriving
        // flag spots exclusively from chains that already passed the same
        // `_anyPositionOnScreen` cull as the line itself means a flag can
        // never be placed on — or biased toward — geometry that isn't on
        // screen in the first place, and a chain with no on-screen portion
        // simply never contributes a flag at all. Since flags are rebuilt
        // fresh every recompute (camera moveEnd), this tracks the viewport
        // continuously rather than needing a separate per-frame patrol.
        if (isMajor && this.state.flagEdges.length) {
          // "No more than 2 labels per continuous contour" — and only 1 (or
          // 0, if nothing matches) for a level whose height isn't a clean
          // multiple of 50, per a direct ask: round-number elevations get
          // the fuller treatment, in-between ones stay quieter.
          const maxFlagsThisChain = (Math.round(height) % 50 === 0) ? MAX_FLAGS_PER_CHAIN : 1;
          const chainSegs = [];
          for (let i = 0; i < chain.points.length - 1; i += 1) chainSegs.push([chain.points[i], chain.points[i + 1]]);
          const chainSpots = [];
          for (const edge of this.state.flagEdges) {
            if (chainSpots.length >= maxFlagsThisChain) break;
            const spot = extremeSegmentPoint(chainSegs, rows, cols, west, south, east, north, edge);
            if (spot && !chainSpots.some((s) => s.lon === spot.lon && s.lat === spot.lat)) chainSpots.push(spot);
          }
          if (chainSpots.length) {
            const existing = flagSpotByLevel.get(height);
            if (existing) existing.push(...chainSpots);
            else flagSpotByLevel.set(height, chainSpots);
          }
        }
      }
    }

    // Cache the finished result before rendering it — a live compute that
    // gets superseded mid-flight still leaves a valid entry behind for the
    // NEXT visit to this same view+settings, even though `_finishContourRender`
    // below will decline to touch the screen for it.
    this._cache.put(CONTOUR_GEOMETRY_CACHE_STORE, cacheKey, {
      minH,
      maxH,
      levelCount: drawnLevels.length,
      segmentCount,
      lines: linesForCache,
      flagSpotByLevel: [...flagSpotByLevel.entries()],
      levelPaletteIndex: [...levelPaletteIndex.entries()],
      rings,
      cachedAt: Date.now(),
    });

    this._finishContourRender({
      token,
      newPrimitive,
      segmentCount,
      levelCount: drawnLevels.length,
      minH,
      maxH,
      flagSpotByLevel,
      levelPaletteIndex,
      rings,
    });
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

    // Same screen-space cull the contour lines already use (see
    // `_anyPositionOnScreen`'s own comment on why `computeViewRectangle()`'s
    // axis-aligned bbox over-samples a tilted/rotated camera's true visible
    // footprint): a meridian/parallel spans the FULL bbox edge to edge, so
    // for an oblique view a fair number of them never actually cross the
    // visible quadrilateral at all. Sampled at 5 points along each line
    // (not just its 2 endpoints) since a line that bows across a tilted
    // projection can have both endpoints off-screen while its middle still
    // crosses the visible area. Filtered BEFORE label placement too, so an
    // invisible line never gets an orphan label either.
    const meridianSamples = (lon) => [0, 0.25, 0.5, 0.75, 1].map(
      (t) => Cesium.Cartesian3.fromDegrees(lon, south + (north - south) * t, 0),
    );
    const parallelSamples = (lat) => [0, 0.25, 0.5, 0.75, 1].map(
      (t) => Cesium.Cartesian3.fromDegrees(west + (east - west) * t, lat, 0),
    );
    const visibleMeridians = thinnedMeridians.filter((lon) => this._anyPositionOnScreen(meridianSamples(lon)));
    const visibleParallels = thinnedParallels.filter((lat) => this._anyPositionOnScreen(parallelSamples(lat)));

    const color = Cesium.Color.fromCssColorString(this.state.gridColor).withAlpha(0.55);
    const newPrimitive = new Cesium.PolylineCollection();
    for (const lon of visibleMeridians) {
      newPrimitive.add({
        positions: [
          Cesium.Cartesian3.fromDegrees(lon, south, 0),
          Cesium.Cartesian3.fromDegrees(lon, north, 0),
        ],
        width: 1,
        material: Cesium.Material.fromType('Color', { color }),
      });
    }
    for (const lat of visibleParallels) {
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
      const fontSize = this.state.gridLabelFontSize || DEFAULT_STATE.gridLabelFontSize;
      const font = `700 ${fontSize}px sans-serif`;
      const labelPrimitive = new Cesium.LabelCollection();
      for (const lon of visibleMeridians) {
        const label = labelPrimitive.add({
          position: Cesium.Cartesian3.fromDegrees(lon, midLat, 0),
          text: toDMS(lon, false),
          font,
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 4,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
        });
        // Tagged for installLabelCollectionAvoidance (see contourFlags.js) —
        // a plain Cesium.Label has no equivalent of an Entity's data-only
        // custom fields, but plain property assignment works the same way.
        label._gevFontSize = fontSize;
        label._gevBaseOffset = Cesium.Cartesian2.ZERO;
      }
      for (const lat of visibleParallels) {
        const label = labelPrimitive.add({
          position: Cesium.Cartesian3.fromDegrees(midLon, lat, 0),
          text: toDMS(lat, true),
          font,
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 4,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
        });
        label._gevFontSize = fontSize;
        label._gevBaseOffset = Cesium.Cartesian2.ZERO;
      }
      this._gridLabelPrimitive = this.viewer.scene.primitives.add(labelPrimitive);
    }
  }

  /**
   * Records the current view span and pushes it at the UI readout. Kept
   * separate from `_recomputeContours` so the readout can also be updated
   * straight off a camera move — the recompute is debounced by
   * RECOMPUTE_DEBOUNCE_MS and skipped entirely while contours are off, and
   * a readout that only moved on that schedule sat visibly behind the
   * viewport it claims to describe.
   */
  _publishViewSpan(spanDeg) {
    if (!Number.isFinite(spanDeg)) return;
    this._lastViewSpanDeg = spanDeg;
    this.onViewSpanChange?.(spanDeg, this.state.contourMaxViewSpanDeg);
  }

  /**
   * Brings the status line into line with a just-observed view span,
   * without waiting out the recompute debounce: past the limit, say so
   * now; back inside it, drop the "zoom in" sentence rather than leave it
   * contradicting a span readout that already shows a legal span.
   */
  _syncSpanGateStatus(spanDeg) {
    if (!this.state.contoursEnabled || !Number.isFinite(spanDeg)) return;
    const maxSpanDeg = this.state.contourMaxViewSpanDeg;
    if (spanDeg > maxSpanDeg) {
      this._setStatus(tooWideStatusText(spanDeg, maxSpanDeg), 'offline');
    } else if (this._contourStatus.startsWith('Zoom in to compute contours')) {
      this._setStatus('Sampling scene heights…', 'computing');
    }
  }

  /** Current camera view span in degrees (the wider of the view rectangle's two sides), or null if the camera isn't looking at the globe. */
  _currentViewSpanDeg() {
    const rect = this.viewer.camera?.computeViewRectangle?.();
    if (!rect) return null;
    return Cesium.Math.toDegrees(Math.max(rect.width, rect.height));
  }

  _onCameraMoveEnd() {
    const spanDeg = this._currentViewSpanDeg();
    this._publishViewSpan(spanDeg);
    this._syncSpanGateStatus(spanDeg);
    if (this.state.contoursEnabled) this._scheduleRecompute();
    if (this.state.gridEnabled) this._recomputeGrid();
    if (this.state.chartDatumEnabled) this._recomputeChartDatum();
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
    this._clearChartDatum();
    if (this.state.chartDatumEnabled) this._recomputeChartDatum();
    this.clearCursor();
    this.setCursorActive(false);
  }

  destroy() {
    this.viewer.camera.moveEnd.removeEventListener(this._onCameraMoveEnd);
    if (this._recomputeTimer) clearTimeout(this._recomputeTimer);
    this._removeFlagAvoidance?.();
    this._removeGridLabelAvoidance?.();
    this._clearContours();
    this.viewer.dataSources.remove(this._contourFlagDataSource, true);
    this.viewer.dataSources.remove(this._contourRingLabelDataSource, true);
    this._clearGrid();
    this._clearChartDatum();
    this._uninstallCursorHandler();
    this.clearCursor();
  }
}

export function initMapOverlays(viewer) {
  return new MapOverlaysEngine(viewer);
}
