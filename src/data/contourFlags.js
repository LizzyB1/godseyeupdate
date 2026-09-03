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
 * Two responsibilities live here:
 *  1. `buildContourFlags` — turn a `Map<level, {lon,lat}>` of per-level flag
 *     spots into pole+label entities in a `CustomDataSource`.
 *  2. `installFlagAvoidance` — keep those labels from sitting hidden behind
 *     one of the app's draggable mini-box control panels. Panels move
 *     (drag), resize, collapse, and hide independently of the map and of
 *     each other, so a flag's on-screen position is checked continuously
 *     (every rendered frame, via `scene.postRender` — the same "recompute
 *     every rendered frame" pattern `cameraControls.js`'s live orientation
 *     readout already uses) rather than once at placement time. A flag
 *     whose natural position lands under a panel gets nudged right, clear
 *     of that panel's edge, via the label's `pixelOffset` — its underlying
 *     world position (and the pole drawn from it) never moves, so panning
 *     back out from under the panel snaps it right back to its true spot.
 *
 * @module data/contourFlags
 */

/** Big, bold, high-contrast — the point of a "flag" is to be unmissable, not to blend in like the rest of the HUD. */
const FLAG_FONT = '700 22px sans-serif';
/** How far above the contour line's own point the flag sits, as a fraction of current camera altitude (clamped) — purely a visual attachment device, not to scale. */
const POLE_RISE_FRACTION = 0.12;
const MIN_POLE_RISE_M = 15;
const MAX_POLE_RISE_M = 4000;
/** Label's resting offset above its world anchor (the pole tip), before any panel-avoidance nudge is added. */
const BASE_LABEL_OFFSET = new Cesium.Cartesian2(0, -4);
/** Extra clearance kept past an obstructing panel's edge once a flag is nudged clear of it. */
const AVOIDANCE_MARGIN_PX = 14;

/** Every mini-box / hideable-panel root id known to the app — the full set `installFlagAvoidance` checks flags against. Sourced from `panelVisibility.js`'s registry (the hideable panels) plus every `buildMiniBox` instance (not all of which are hideable), so a flag is nudged clear of ANY visible control box, not just the ones with a "×" hide button. */
const MINIBOX_PANEL_IDS = ['restoretray-pad', 'mapovl-pad', 'coordbox-pad', 'hudread-pad', 'bathy-pad', 'camctl-pad'];
const AVOIDANCE_PANEL_IDS = [...new Set([...Object.keys(PANEL_LABELS), ...MINIBOX_PANEL_IDS])];

/** Clamp current camera altitude into a sensible pole-rise, so the flag is always a visible "stuck into the line" affordance regardless of what value it's labeling. */
function poleRiseMeters(viewer) {
  const height = viewer.camera.positionCartographic?.height;
  const alt = Number.isFinite(height) ? height : MIN_POLE_RISE_M;
  return Cesium.Math.clamp(alt * POLE_RISE_FRACTION, MIN_POLE_RISE_M, MAX_POLE_RISE_M);
}

/**
 * (Re)build flag entities into `dataSource`, one per `[level, {lon,lat}]`
 * entry in `spots`. Clears whatever was there before.
 * @param {Object} opts
 * @param {Cesium.Viewer} opts.viewer
 * @param {Cesium.CustomDataSource} opts.dataSource - dedicated to flags; cleared and repopulated each call.
 * @param {Map<number, {lon:number, lat:number}>} opts.spots - per-level flag anchor, in the contour's own coordinate space (level = height above ellipsoid the line is drawn at — negative for depth).
 * @param {(level:number)=>string} opts.formatValue - e.g. `formatHeight`/`formatDepth`.
 * @param {Cesium.Color} opts.color - flag color (pole + background box).
 * @returns {Array<Cesium.Entity>} the new flag entities (for `installFlagAvoidance`'s `getEntities`).
 */
export function buildContourFlags({ viewer, dataSource, spots, formatValue, color }) {
  dataSource.entities.removeAll();
  if (!spots.size) return [];
  const rise = poleRiseMeters(viewer);
  const entities = [];
  for (const [level, spot] of spots) {
    const basePos = Cesium.Cartesian3.fromDegrees(spot.lon, spot.lat, level);
    const topPos = Cesium.Cartesian3.fromDegrees(spot.lon, spot.lat, level + rise);
    const entity = dataSource.entities.add({
      position: topPos,
      polyline: {
        positions: [basePos, topPos],
        width: 3,
        material: color,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: formatValue(level),
        font: FLAG_FONT,
        fillColor: Cesium.Color.BLACK,
        showBackground: true,
        backgroundColor: color.withAlpha(0.92),
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
 * Install a `scene.postRender` listener that keeps every entity returned by
 * `getEntities()` clear of the app's currently-visible panels, by adjusting
 * each entity's `label.pixelOffset` in place every frame. Cheap and
 * idempotent per call; returns a remover.
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
    for (const entity of entities) {
      if (!entity.label || entity.isDestroyed?.()) continue;
      const pos = entity.position?.getValue(now);
      if (!pos) continue;
      const screen = Cesium.SceneTransforms.worldToWindowCoordinates(viewer.scene, pos);
      if (!screen) continue;
      const avoid = computePanelAvoidanceOffset(screen.x, screen.y);
      entity.label.pixelOffset = new Cesium.Cartesian2(BASE_LABEL_OFFSET.x + avoid.x, BASE_LABEL_OFFSET.y + avoid.y);
    }
  };
  const remove = viewer.scene.postRender.addEventListener(handler);
  return remove;
}
