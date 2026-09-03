import * as Cesium from 'cesium';
import { PANEL_LABELS } from '../panelVisibility.js';

/**
 * @file Shared "flag" rendering for contour-line value call-outs: a small
 * marker sitting directly ON the contour line itself, right next to its
 * own big, high-contrast numbered label — used by both the land-elevation
 * contours (`data/mapOverlays.js`) and the bathymetry depth contours
 * (`data/bathymetry.js`), which otherwise render their contour LINES very
 * differently (raw primitive collections vs. entities) but want visually
 * identical, equally "obvious" flags for the numbers.
 *
 * SIMPLIFIED (previously): flags used to sit atop a vertical pole and get
 * pulled toward a circle centered on the viewport, spread apart by angle
 * along that circle to avoid overlapping each other. That was meant to
 * keep them out of the (often panel-crowded) edges of the view, but a
 * single degenerate contour level's flag — e.g. from the scene-height
 * sampling bug `data/sceneHeight.js` now guards against — landed all its
 * neighbors on nearly the same bearing from center, piling every flag
 * directly on top of each other regardless of the ring-spread. Simpler
 * and more legible now: a flag renders exactly where its line is, full
 * stop.
 *
 * STYLE: the plaque background is gone — flags are transparent now, with
 * white text carrying a heavy black outline (Cesium's `FILL_AND_OUTLINE`
 * label style) standing in for a drop shadow, since Cesium labels have no
 * literal CSS-style shadow. That's a fixed look (not a per-engine color
 * picker like the old plaque was) because it's what reads clearly over
 * both bright land tiles and dark ocean alike.
 *
 * PLACEMENT: a level can now get more than one flag — one per edge the
 * caller asks for (`data/contourMath.js`'s `extremeSegmentPoint`, called
 * once per edge by `data/mapOverlays.js`), e.g. both the view's west AND
 * east edges so a long line crossing the whole screen is always labeled
 * near whichever side is actually on screen. `spots` is therefore
 * `Map<level, Array<{lon,lat}>>`, not one spot per level.
 *
 * Three responsibilities remain here:
 *  1. `buildContourFlags` — turn `spots` into marker+label entities in a
 *     `CustomDataSource`, one entity per `{lon,lat}` anchor. The marker
 *     always uses the per-level contour color passed in via
 *     `poleColorForLevel` (see `data/contourColors.js`), so a flag always
 *     matches the line it's planted on.
 *  2. `buildRingLabels` — a small, marker-less companion label for every
 *     CLOSED contour ring (a hill or basin fully inside the sampled view —
 *     see `data/contourMath.js`'s `stitchSegmentsIntoPolylines`), so
 *     stacked rings on a hillside can be told apart at a glance without
 *     waiting for the big west/east flags. Same drop-shadow text, smaller.
 *  3. `installFlagAvoidance` — the one remaining per-frame nudge
 *     (`scene.postRender` — the same "recompute every rendered frame"
 *     pattern `cameraControls.js`'s live orientation readout already
 *     uses): a label sitting under a visible control panel gets nudged
 *     right, clear of that panel's edge. This nudge applies only to the
 *     label's `pixelOffset`; the underlying world position (and the
 *     marker drawn from it) never moves, so panning the true spot back
 *     into the clear snaps the label right back to it. Works the same for
 *     both flag entities and ring-label entities — pass both arrays
 *     (concatenated) as `getEntities()`'s result.
 *
 * @module data/contourFlags
 */

/** Label's resting offset above its own world anchor — small and fixed, just enough to clear the marker dot, not a pole's worth of lift. */
const BASE_LABEL_OFFSET = new Cesium.Cartesian2(0, -10);
/** Ring labels have no marker dot to clear, so they can sit closer to their own anchor point. */
const RING_LABEL_OFFSET = new Cesium.Cartesian2(0, -4);
/** Extra clearance kept past an obstructing panel's edge once a flag is nudged clear of it. */
const AVOIDANCE_MARGIN_PX = 14;
/** Default plaque text size if a caller doesn't supply its own — matches the flags' original look. */
export const DEFAULT_FLAG_FONT_SIZE = 22;
/** Default ring-label text size — smaller than a flag's, since a ring label is a quiet "which line is this" cue, not a big call-out. */
export const DEFAULT_RING_LABEL_FONT_SIZE = 13;
/** No longer used by `buildContourFlags` (the plaque background it sized is gone — see the module doc), kept exported only so `data/bathymetry.js`'s still-benched (`BATHYMETRY_DISABLED`) flag-style state keeps importing a real value rather than needing its own edit for a dead feature. */
export const DEFAULT_FLAG_BG_ALPHA = 0.92;

/** Every mini-box / hideable-panel root id known to the app — the full set `installFlagAvoidance` checks flags against. Sourced from `panelVisibility.js`'s registry (the hideable panels) plus every `buildMiniBox` instance (not all of which are hideable), so a flag is nudged clear of ANY visible control box, not just the ones with a "×" hide button. */
const MINIBOX_PANEL_IDS = ['restoretray-pad', 'mapovl-pad', 'coordbox-pad', 'hudread-pad', 'bathy-pad', 'camctl-pad', 'gpstrack-pad', 'about-pad', 'statusbox-pad'];
const AVOIDANCE_PANEL_IDS = [...new Set([...Object.keys(PANEL_LABELS), ...MINIBOX_PANEL_IDS])];

/** Shared drop-shadow label look: heavy black outline behind solid white fill, no background plaque. `weight` is the outline width in px — flags use a heavier one than the smaller ring labels so the shadow stays proportional to the text. */
function dropShadowLabelProps(text, fontPx, weight) {
  return {
    text,
    font: `700 ${Math.round(fontPx)}px sans-serif`,
    fillColor: Cesium.Color.WHITE,
    outlineColor: Cesium.Color.BLACK,
    outlineWidth: weight,
    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
    showBackground: false,
    horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
    verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
    disableDepthTestDistance: Number.POSITIVE_INFINITY,
  };
}

/**
 * (Re)build flag entities into `dataSource`: one marker+label per
 * `{lon,lat}` anchor in every level's spot array. Clears whatever was
 * there before.
 * @param {Object} opts
 * @param {Cesium.Viewer} opts.viewer
 * @param {Cesium.CustomDataSource} opts.dataSource - dedicated to flags; cleared and repopulated each call.
 * @param {Map<number, Array<{lon:number, lat:number}>>} opts.spots - per-level flag anchors (one per requested edge), in the contour's own coordinate space (level = height above ellipsoid the line is drawn at — negative for depth).
 * @param {(level:number)=>string} opts.formatValue - e.g. `formatHeight`/`formatDepth`.
 * @param {(level:number, index:number)=>Cesium.Color} opts.poleColorForLevel - the marker/line color for a given level and its position (index) in the spot iteration order — normally the same per-level palette color the contour line itself was drawn with, so the flag visually matches its line.
 * @param {number} [opts.fontSize] - label text size in px. Defaults to {@link DEFAULT_FLAG_FONT_SIZE}.
 * @returns {Array<Cesium.Entity>} the new flag entities (for `installFlagAvoidance`'s `getEntities`).
 */
export function buildContourFlags({ viewer, dataSource, spots, formatValue, poleColorForLevel, fontSize = DEFAULT_FLAG_FONT_SIZE }) {
  dataSource.entities.removeAll();
  if (!spots.size) return [];
  const entities = [];
  let index = 0;
  for (const [level, spotList] of spots) {
    const markerColor = poleColorForLevel(level, index);
    index += 1;
    for (const spot of (Array.isArray(spotList) ? spotList : [spotList])) {
      if (!spot) continue;
      const position = Cesium.Cartesian3.fromDegrees(spot.lon, spot.lat, level);
      const entity = dataSource.entities.add({
        position,
        point: {
          pixelSize: 7,
          color: markerColor,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 1.5,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          ...dropShadowLabelProps(formatValue(level), fontSize, 6),
          pixelOffset: BASE_LABEL_OFFSET,
        },
      });
      // Tag with its own resting offset so `installFlagAvoidance` — shared
      // with `buildRingLabels`'s smaller-offset entities — nudges each
      // entity out from its OWN base position, not a hardcoded one.
      entity._gevBaseOffset = BASE_LABEL_OFFSET;
      entities.push(entity);
    }
  }
  return entities;
}

/**
 * (Re)build one small label per closed contour ring — no marker dot, just
 * text sitting on the line — so a stack of rings up a hillside (or down a
 * basin) can be read apart without following each one back to its big
 * west/east flag. Clears whatever was there before.
 * @param {Object} opts
 * @param {Cesium.CustomDataSource} opts.dataSource - dedicated to ring labels; cleared and repopulated each call.
 * @param {Array<{level:number, lon:number, lat:number}>} opts.rings - one entry per closed ring found this recompute (multiple rings can share a level — concentric hills at the same height each get their own label).
 * @param {(level:number)=>string} opts.formatValue
 * @param {number} [opts.fontSize] - Defaults to {@link DEFAULT_RING_LABEL_FONT_SIZE}.
 * @returns {Array<Cesium.Entity>}
 */
export function buildRingLabels({ dataSource, rings, formatValue, fontSize = DEFAULT_RING_LABEL_FONT_SIZE }) {
  dataSource.entities.removeAll();
  if (!rings.length) return [];
  const entities = [];
  for (const ring of rings) {
    const entity = dataSource.entities.add({
      position: Cesium.Cartesian3.fromDegrees(ring.lon, ring.lat, ring.level),
      label: {
        ...dropShadowLabelProps(formatValue(ring.level), fontSize, 3.5),
        pixelOffset: RING_LABEL_OFFSET,
      },
    });
    entity._gevBaseOffset = RING_LABEL_OFFSET;
    entities.push(entity);
  }
  return entities;
}

/**
 * Selects every Nth entry from an ordered `Map`, preserving insertion order
 * — the "label every contour / every other contour / every 3rd…" frequency
 * control. `step` of 1 keeps everything (today's behavior). Values are
 * opaque to this function (a single spot, an array of spots, anything) —
 * only the `Map`'s keys (levels) drive the thinning.
 * @param {Map<number, *>} spots
 * @param {number} step - 1-based; only every `step`th entry (by iteration order) is kept.
 * @returns {Map<number, *>}
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
 * shifts right, past the widest obstructing panel's right edge: most of
 * the app's control boxes anchor along the left/top edges by default, so a
 * panel obstructing a flag is more often than not anchored to its left,
 * and shifting right moves the flag toward open canvas rather than
 * off-screen. A flag placed on the view's own east edge (see
 * `data/mapOverlays.js`'s `flagEdges`) is the one case this can push
 * slightly further right than ideal, but simple beats another axis of
 * per-edge special-casing for a rare, self-correcting overlap.
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
      const base = entity._gevBaseOffset || BASE_LABEL_OFFSET;
      entity.label.pixelOffset = new Cesium.Cartesian2(
        base.x + avoid.x,
        base.y + avoid.y,
      );
    }
  };
  const remove = viewer.scene.postRender.addEventListener(handler);
  return remove;
}
