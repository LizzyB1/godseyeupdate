import * as Cesium from 'cesium';
import { PANEL_LABELS } from '../panelVisibility.js';

/**
 * @file Shared "flag" rendering for contour-line value call-outs: a short
 * pole rising from the contour line itself, topped by a big, high-contrast
 * numbered label — used by both the land-elevation contours
 * (`data/mapOverlays.js`) and the bathymetry depth contours
 * (`data/bathymetry.js`), which otherwise render their contour LINES very
 * differently (raw primitive collections vs. entities) but want visually
 * identical, equally "obvious" flags for the numbers.
 *
 * Three responsibilities live here:
 *  1. `buildContourFlags` — turn a `Map<level, {lon,lat}>` of per-level flag
 *     spots into pole+label entities in a `CustomDataSource`. Text size and
 *     plaque background color/transparency are caller-supplied (each engine
 *     persists its own — see its box's "label style" controls) rather than
 *     fixed, so the two layers can be tuned independently; the pole itself
 *     always uses the per-level contour color passed in via `poleColorForLevel`
 *     (see `data/contourColors.js`), so a flag's pole always matches the line
 *     it's planted on.
 *  2. `installFlagAvoidance` — keep those labels readable and clear of the
 *     app's draggable mini-box control panels, via two per-frame nudges
 *     (`scene.postRender` — the same "recompute every rendered frame"
 *     pattern `cameraControls.js`'s live orientation readout already uses):
 *      a. Center-circle clamp — a flag whose true screen position drifts
 *         out past a circle centered on the viewport gets its LABEL (not
 *         its pole/line, which stay at the real position) pulled back onto
 *         that circle's edge, so labels always stay clustered in the
 *         readable middle of the view instead of piling up at the edges.
 *      b. Panel avoidance — from that (possibly already-clamped) position,
 *         a label still sitting under a visible control panel gets nudged
 *         right, clear of that panel's edge.
 *     Both nudges apply only to the label's `pixelOffset`; the underlying
 *     world position (and the pole drawn from it) never moves, so panning
 *     the true spot back into the clear snaps the label right back to it.
 *
 * @module data/contourFlags
 */

/** How far above the contour line's own point the flag sits, as a fraction of current camera altitude (clamped) — purely a visual attachment device, not to scale. */
const POLE_RISE_FRACTION = 0.12;
const MIN_POLE_RISE_M = 15;
const MAX_POLE_RISE_M = 4000;
/** Label's resting offset above its world anchor (the pole tip), before any center-circle/panel-avoidance nudge is added. */
const BASE_LABEL_OFFSET = new Cesium.Cartesian2(0, -4);
/** Extra clearance kept past an obstructing panel's edge once a flag is nudged clear of it. */
const AVOIDANCE_MARGIN_PX = 14;
/** Default plaque text size/background if a caller doesn't supply its own — matches the flags' original look. */
export const DEFAULT_FLAG_FONT_SIZE = 22;
export const DEFAULT_FLAG_BG_ALPHA = 0.92;
/** Radius of the "stay near the middle" circle, as a fraction of the shorter canvas dimension — a comfortable central cluster with margin left for edge-docked panels/HUD chrome. */
const CENTER_CIRCLE_RADIUS_FRACTION = 0.38;

/** Every mini-box / hideable-panel root id known to the app — the full set `installFlagAvoidance` checks flags against. Sourced from `panelVisibility.js`'s registry (the hideable panels) plus every `buildMiniBox` instance (not all of which are hideable), so a flag is nudged clear of ANY visible control box, not just the ones with a "×" hide button. */
const MINIBOX_PANEL_IDS = ['restoretray-pad', 'mapovl-pad', 'coordbox-pad', 'hudread-pad', 'bathy-pad', 'camctl-pad', 'gpstrack-pad'];
const AVOIDANCE_PANEL_IDS = [...new Set([...Object.keys(PANEL_LABELS), ...MINIBOX_PANEL_IDS])];

/** Clamp current camera altitude into a sensible pole-rise, so the flag is always a visible "stuck into the line" affordance regardless of what value it's labeling. */
function poleRiseMeters(viewer) {
  const height = viewer.camera.positionCartographic?.height;
  const alt = Number.isFinite(height) ? height : MIN_POLE_RISE_M;
  return Cesium.Math.clamp(alt * POLE_RISE_FRACTION, MIN_POLE_RISE_M, MAX_POLE_RISE_M);
}

/** True if `color` is light enough that black plaque text reads better than white on it (simple relative-luminance threshold). */
function isLightColor(color) {
  const luminance = 0.299 * color.red + 0.587 * color.green + 0.114 * color.blue;
  return luminance > 0.5;
}

/**
 * (Re)build flag entities into `dataSource`, one per `[level, {lon,lat}]`
 * entry in `spots`. Clears whatever was there before.
 * @param {Object} opts
 * @param {Cesium.Viewer} opts.viewer
 * @param {Cesium.CustomDataSource} opts.dataSource - dedicated to flags; cleared and repopulated each call.
 * @param {Map<number, {lon:number, lat:number}>} opts.spots - per-level flag anchor, in the contour's own coordinate space (level = height above ellipsoid the line is drawn at — negative for depth).
 * @param {(level:number)=>string} opts.formatValue - e.g. `formatHeight`/`formatDepth`.
 * @param {(level:number, index:number)=>Cesium.Color} opts.poleColorForLevel - the pole/line color for a given level and its position (index) in the spot iteration order — normally the same per-level palette color the contour line itself was drawn with, so the flag visually matches its line.
 * @param {Cesium.Color} opts.bgColor - plaque background color (RGB only — alpha comes from `bgAlpha`).
 * @param {number} [opts.bgAlpha] - plaque background opacity, 0-1. Defaults to {@link DEFAULT_FLAG_BG_ALPHA}.
 * @param {number} [opts.fontSize] - plaque text size in px. Defaults to {@link DEFAULT_FLAG_FONT_SIZE}.
 * @returns {Array<Cesium.Entity>} the new flag entities (for `installFlagAvoidance`'s `getEntities`).
 */
export function buildContourFlags({ viewer, dataSource, spots, formatValue, poleColorForLevel, bgColor, bgAlpha = DEFAULT_FLAG_BG_ALPHA, fontSize = DEFAULT_FLAG_FONT_SIZE }) {
  dataSource.entities.removeAll();
  if (!spots.size) return [];
  const rise = poleRiseMeters(viewer);
  const font = `700 ${Math.round(fontSize)}px sans-serif`;
  const background = bgColor.withAlpha(Cesium.Math.clamp(bgAlpha, 0, 1));
  const textColor = isLightColor(background) ? Cesium.Color.BLACK : Cesium.Color.WHITE;
  const entities = [];
  let index = 0;
  for (const [level, spot] of spots) {
    const poleColor = poleColorForLevel(level, index);
    index += 1;
    const basePos = Cesium.Cartesian3.fromDegrees(spot.lon, spot.lat, level);
    const topPos = Cesium.Cartesian3.fromDegrees(spot.lon, spot.lat, level + rise);
    const entity = dataSource.entities.add({
      position: topPos,
      polyline: {
        positions: [basePos, topPos],
        width: 3,
        material: poleColor,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: formatValue(level),
        font,
        fillColor: textColor,
        showBackground: true,
        backgroundColor: background,
        backgroundPadding: new Cesium.Cartesian2(10, 6),
        style: Cesium.LabelStyle.FILL,
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        pixelOffset: BASE_LABEL_OFFSET,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    entities.push(entity);
  }
  return entities;
}

/**
 * Selects every Nth entry from an ordered `Map`, preserving insertion order
 * — the "label every contour / every other contour / every 3rd…" frequency
 * control. `step` of 1 keeps everything (today's behavior).
 * @param {Map<number, {lon:number, lat:number}>} spots
 * @param {number} step - 1-based; only every `step`th entry (by iteration order) is kept.
 * @returns {Map<number, {lon:number, lat:number}>}
 */
export function thinSpotsByStep(spots, step) {
  const n = Math.max(1, Math.round(step) || 1);
  if (n <= 1) return spots;
  const out = new Map();
  let i = 0;
  for (const [level, spot] of spots) {
    if (i % n === 0) out.set(level, spot);
    i += 1;
  }
  return out;
}

/** Every currently-visible avoidance-relevant panel's bounding rect (viewport coords). Elements resolve once each and are cached by id — the app's mini-box/panel roots are created once at startup and never recreated, only shown/hidden — but a lookup is retried on every call for any id not yet resolved, in case this runs before every panel exists (construction order between engines and their control boxes isn't guaranteed), so nothing is permanently missed. */
const _panelElCache = new Map();
function visiblePanelRects() {
  const rects = [];
  for (const id of AVOIDANCE_PANEL_IDS) {
    let el = _panelElCache.get(id);
    if (!el) {
      el = document.getElementById(id);
      if (el) _panelElCache.set(id, el);
      else continue;
    }
    if (el.classList.contains('panel-fully-hidden')) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) rects.push(rect);
  }
  return rects;
}

/**
 * Given a flag's natural (unshifted) screen position, return the extra
 * pixel offset — `{x: 0, y: 0}` if nothing obstructs it — needed to clear
 * every currently-visible panel it would otherwise land under. Always
 * shifts right, past the widest obstructing panel's right edge: flags
 * already cluster toward the view's west/left side (see
 * `westmostSegmentPoint`), so a panel obstructing one is overwhelmingly
 * likely to be anchored at that same left edge, and shifting right moves
 * the flag toward the open canvas rather than off-screen.
 * @param {number} screenX @param {number} screenY
 * @returns {{x:number, y:number}}
 */
export function computePanelAvoidanceOffset(screenX, screenY) {
  let shiftRight = 0;
  for (const rect of visiblePanelRects()) {
    if (screenX >= rect.left && screenX <= rect.right && screenY >= rect.top && screenY <= rect.bottom) {
      shiftRight = Math.max(shiftRight, rect.right - screenX + AVOIDANCE_MARGIN_PX);
    }
  }
  return { x: shiftRight, y: 0 };
}

/**
 * Given a flag's natural (unshifted) screen position and the current
 * viewport size, return the point on screen it should actually render at:
 * unchanged if it's already within {@link CENTER_CIRCLE_RADIUS_FRACTION} of
 * the viewport's center, otherwise pulled straight in along the same
 * center→point line until it lands exactly on that circle's edge. This is
 * what keeps flags clustered in the readable middle of the view rather than
 * drifting out toward the (often panel-crowded) edges as the camera pans —
 * "the labels stay in a circle in mid viewport."
 * @param {number} screenX @param {number} screenY
 * @param {number} canvasWidth @param {number} canvasHeight
 * @returns {{x:number, y:number}} the (possibly clamped) target screen position.
 */
export function clampToCenterCircle(screenX, screenY, canvasWidth, canvasHeight) {
  const centerX = canvasWidth / 2;
  const centerY = canvasHeight / 2;
  const radius = Math.min(canvasWidth, canvasHeight) * CENTER_CIRCLE_RADIUS_FRACTION;
  const dx = screenX - centerX;
  const dy = screenY - centerY;
  const dist = Math.hypot(dx, dy);
  if (dist <= radius || dist === 0) return { x: screenX, y: screenY };
  const scale = radius / dist;
  return { x: centerX + dx * scale, y: centerY + dy * scale };
}

/**
 * Install a `scene.postRender` listener that keeps every entity returned by
 * `getEntities()` clustered near the viewport's center (see
 * {@link clampToCenterCircle}) and clear of the app's currently-visible
 * panels, by adjusting each entity's `label.pixelOffset` in place every
 * frame. Cheap and idempotent per call; returns a remover.
 * @param {Cesium.Viewer} viewer
 * @param {() => Array<Cesium.Entity>} getEntities - called fresh each frame, so a rebuilt flag set is picked up automatically.
 * @returns {() => void} call to uninstall.
 */
export function installFlagAvoidance(viewer, getEntities) {
  const now = new Cesium.JulianDate();
  const handler = () => {
    const entities = getEntities();
    if (!entities || !entities.length) return;
    Cesium.JulianDate.now(now);
    const canvas = viewer.scene.canvas;
    for (const entity of entities) {
      if (!entity.label || entity.isDestroyed?.()) continue;
      const pos = entity.position?.getValue(now);
      if (!pos) continue;
      const screen = Cesium.SceneTransforms.worldToWindowCoordinates(viewer.scene, pos);
      if (!screen) continue;
      const clamped = clampToCenterCircle(screen.x, screen.y, canvas.clientWidth, canvas.clientHeight);
      const avoid = computePanelAvoidanceOffset(clamped.x, clamped.y);
      const targetX = clamped.x + avoid.x;
      const targetY = clamped.y + avoid.y;
      entity.label.pixelOffset = new Cesium.Cartesian2(
        BASE_LABEL_OFFSET.x + (targetX - screen.x),
        BASE_LABEL_OFFSET.y + (targetY - screen.y),
      );
    }
  };
  const remove = viewer.scene.postRender.addEventListener(handler);
  return remove;
}
