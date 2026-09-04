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
/** Extra clearance kept past an obstructing panel's edge once a flag is nudged clear of it — i.e. how far a flag "stands off" a panel, not just whether it clears it. Widened from the original 14px per a direct ask for a bigger, more obvious buffer around control boxes. */
const AVOIDANCE_MARGIN_PX = 26;
/** Default plaque text size if a caller doesn't supply its own — matches the flags' original look. */
export const DEFAULT_FLAG_FONT_SIZE = 22;
/** Default ring-label text size — smaller than a flag's, since a ring label is a quiet "which line is this" cue, not a big call-out. */
export const DEFAULT_RING_LABEL_FONT_SIZE = 13;
/** No longer used by `buildContourFlags` (the plaque background it sized is gone — see the module doc), kept exported only so `data/bathymetry.js`'s still-benched (`BATHYMETRY_DISABLED`) flag-style state keeps importing a real value rather than needing its own edit for a dead feature. */
export const DEFAULT_FLAG_BG_ALPHA = 0.92;

/** Every mini-box / hideable-panel root id known to the app — the full set `installFlagAvoidance` checks flags against. Sourced from `panelVisibility.js`'s registry (the hideable panels) plus every `buildMiniBox` instance (not all of which are hideable), so a flag is nudged clear of ANY visible control box, not just the ones with a "×" hide button. */
const MINIBOX_PANEL_IDS = ['restoretray-pad', 'contourbox-pad', 'gridbox-pad', 'terrainbox-pad', 'coordbox-pad', 'hudread-pad', 'bathy-pad', 'camctl-pad', 'gpstrack-pad', 'about-pad', 'telemetry-pad', 'summarybox-pad', 'cachectl-pad'];
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
      // entity out from its OWN base position, not a hardcoded one. Also
      // tag its font size directly (rather than parsing it back out of the
      // CSS font shorthand string) so the same handler's mutual-overlap
      // check can estimate this label's on-screen footprint.
      entity._gevBaseOffset = BASE_LABEL_OFFSET;
      entity._gevFontSize = fontSize;
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
    entity._gevFontSize = fontSize;
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
 * Given a flag's natural (unshifted) screen position and an already-fetched
 * list of panel rects, return the extra pixel offset — `{x: 0, y: 0}` if
 * nothing obstructs it — needed to clear every one of them. Always shifts
 * right, past the widest obstructing panel's right edge: most of the app's
 * control boxes anchor along the left/top edges by default, so a panel
 * obstructing a flag is more often than not anchored to its left, and
 * shifting right moves the flag toward open canvas rather than off-screen.
 * A flag placed on the view's own east edge (see `data/mapOverlays.js`'s
 * `flagEdges`) is the one case this can push slightly further right than
 * ideal, but simple beats another axis of per-edge special-casing for a
 * rare, self-correcting overlap.
 *
 * Split out from {@link computePanelAvoidanceOffset} so `installFlagAvoidance`
 * can fetch `visiblePanelRects()` ONCE per rendered frame and reuse it
 * across every entity, instead of every entity independently re-walking
 * the panel list and forcing a fresh `getBoundingClientRect()` layout read
 * for each one.
 * @param {number} screenX @param {number} screenY
 * @param {Array<DOMRect>} rects
 * @returns {{x:number, y:number}}
 */
function panelAvoidanceOffsetFromRects(screenX, screenY, rects) {
  let shiftRight = 0;
  for (const rect of rects) {
    if (screenX >= rect.left && screenX <= rect.right && screenY >= rect.top && screenY <= rect.bottom) {
      shiftRight = Math.max(shiftRight, rect.right - screenX + AVOIDANCE_MARGIN_PX);
    }
  }
  return { x: shiftRight, y: 0 };
}

/**
 * Given a flag's natural (unshifted) screen position, return the extra
 * pixel offset needed to clear every currently-visible panel it would
 * otherwise land under — see {@link panelAvoidanceOffsetFromRects}, which
 * this just calls with a fresh `visiblePanelRects()`. Kept as its own
 * export for any one-off caller that isn't iterating a whole entity list
 * per frame (`installFlagAvoidance` calls the rects-based version directly
 * instead, to fetch panel rects only once per frame).
 * @param {number} screenX @param {number} screenY
 * @returns {{x:number, y:number}}
 */
export function computePanelAvoidanceOffset(screenX, screenY) {
  return panelAvoidanceOffsetFromRects(screenX, screenY, visiblePanelRects());
}

/** Fraction of the canvas, centered on it, that flag/ring labels are biased to stay within — see `computeCenterBiasOffset`. 0.75 means a 12.5%-wide margin is kept clear on every side. */
const CENTER_BIAS_FRACTION = 0.75;

/**
 * Given a flag's screen position (after any panel-avoidance shift already
 * applied) and the current canvas size, return the extra pixel offset
 * needed to pull it back inside the central `CENTER_BIAS_FRACTION` of the
 * canvas — `{x: 0, y: 0}` if it's already inside that central band. Like
 * `computePanelAvoidanceOffset`, this only ever feeds into the label's
 * `pixelOffset`, never the world anchor: panning the true contour spot back
 * into the central band snaps the label right back to it, and a contour
 * that's mostly off-screen just keeps its label pinned to the nearest edge
 * of the band rather than being hidden.
 * @param {number} screenX @param {number} screenY
 * @param {number} width @param {number} height
 * @returns {{x:number, y:number}}
 */
export function computeCenterBiasOffset(screenX, screenY, width, height) {
  const marginX = (width * (1 - CENTER_BIAS_FRACTION)) / 2;
  const marginY = (height * (1 - CENTER_BIAS_FRACTION)) / 2;
  let x = 0;
  let y = 0;
  if (screenX < marginX) x = marginX - screenX;
  else if (screenX > width - marginX) x = (width - marginX) - screenX;
  if (screenY < marginY) y = marginY - screenY;
  else if (screenY > height - marginY) y = (height - marginY) - screenY;
  return { x, y };
}

/** Rough average glyph width, as a fraction of font-size-in-px, for the bold sans-serif label font `dropShadowLabelProps` uses — enough to estimate a label's on-screen footprint without an actual canvas text-measure call (too expensive to do per label per frame). */
const GLYPH_WIDTH_FRACTION = 0.62;
/** Extra clearance kept between two labels' estimated boxes before they're considered to be overlapping. */
const LABEL_OVERLAP_PAD_PX = 3;
/** Vertical step size tried when nudging a label clear of another one already placed this frame. */
const LABEL_DECLUTTER_STEP_PX = 16;
/** How many nudge attempts (alternating up/down, growing each time) before giving up and hiding a label rather than leaving it piled on another. */
const LABEL_DECLUTTER_MAX_STEPS = 3;

/**
 * Estimates a label's on-screen bounding box from its final anchor point,
 * text, and font size — text width isn't actually measured (a real
 * `CanvasRenderingContext2D.measureText` call per label per frame would
 * defeat the point of keeping this cheap), just approximated from
 * character count. `dropShadowLabelProps` anchors every flag/ring label
 * horizontally CENTERED and vertically at its BOTTOM (`verticalAnchor`
 * default `'bottom'`), so by default the box sits centered above
 * `(anchorX, anchorY)`; pass `'center'` for a label anchored at
 * `VerticalOrigin.CENTER` instead (e.g. `data/mapOverlays.js`'s grid line
 * labels), which centers the box on `anchorY` instead.
 * @param {number} anchorX @param {number} anchorY
 * @param {string} text @param {number} fontSizePx
 * @param {'bottom'|'center'} [verticalAnchor]
 * @returns {{left:number, right:number, top:number, bottom:number}}
 */
export function estimateLabelBox(anchorX, anchorY, text, fontSizePx, verticalAnchor = 'bottom') {
  const charWidth = fontSizePx * GLYPH_WIDTH_FRACTION;
  const width = Math.max(charWidth * 2, (text?.length || 1) * charWidth);
  const height = fontSizePx * 1.15;
  if (verticalAnchor === 'center') {
    return {
      left: anchorX - width / 2,
      right: anchorX + width / 2,
      top: anchorY - height / 2,
      bottom: anchorY + height / 2,
    };
  }
  return {
    left: anchorX - width / 2,
    right: anchorX + width / 2,
    top: anchorY - height,
    bottom: anchorY,
  };
}

function boxesOverlap(a, b) {
  return a.left < b.right + LABEL_OVERLAP_PAD_PX
    && a.right > b.left - LABEL_OVERLAP_PAD_PX
    && a.top < b.bottom + LABEL_OVERLAP_PAD_PX
    && a.bottom > b.top - LABEL_OVERLAP_PAD_PX;
}

/**
 * Given a label's estimated box and every OTHER label already placed this
 * frame, finds a small vertical nudge that clears all of them, or reports
 * that this label should be hidden instead. Tries the unshifted position
 * first, then alternates up/down in growing steps
 * (`LABEL_DECLUTTER_STEP_PX` × 1, 1, 2, 2, 3, 3…) up to
 * `LABEL_DECLUTTER_MAX_STEPS` each way — cheap since the per-frame label
 * count is small (tens, not thousands), so an O(placed) scan per candidate
 * is negligible. A label that still can't fit anywhere is hidden rather
 * than left stacked illegibly on top of another — the "or get rid of them"
 * half of the ask, applied only when avoidance alone can't do the job.
 * @param {{left:number,right:number,top:number,bottom:number}} box
 * @param {Array<{left:number,right:number,top:number,bottom:number}>} placed
 * @returns {{visible:boolean, extraY:number}}
 */
export function resolveLabelOverlap(box, placed) {
  const candidates = [0];
  for (let i = 1; i <= LABEL_DECLUTTER_MAX_STEPS; i += 1) {
    candidates.push(-LABEL_DECLUTTER_STEP_PX * i, LABEL_DECLUTTER_STEP_PX * i);
  }
  for (const extraY of candidates) {
    const shifted = { left: box.left, right: box.right, top: box.top + extraY, bottom: box.bottom + extraY };
    if (!placed.some((p) => boxesOverlap(shifted, p))) return { visible: true, extraY };
  }
  return { visible: false, extraY: 0 };
}

/**
 * Install a `scene.postRender` listener that keeps every entity returned by
 * `getEntities()` clear of the app's currently-visible panels, biased
 * toward the central 3/4 of the screen, AND clear of every other label in
 * the same set — nudging one vertically when it would otherwise land on
 * top of a label already placed this frame, and hiding it outright if even
 * that can't find it a clear spot. All of this only ever adjusts each
 * entity's `label.pixelOffset` (and, for the declutter case,
 * `label.show`) — the underlying world position never moves, so panning
 * the true spot into the clear snaps everything back automatically.
 * Cheap and idempotent per call; returns a remover.
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
    const width = canvas?.clientWidth || 0;
    const height = canvas?.clientHeight || 0;
    // Fetched ONCE per frame (each rect a forced-layout getBoundingClientRect
    // read) and reused for every entity below, rather than every entity
    // independently re-walking the panel list.
    const panelRects = visiblePanelRects();
    const placedBoxes = [];
    for (const entity of entities) {
      if (!entity.label || entity.isDestroyed?.()) continue;
      const pos = entity.position?.getValue(now);
      if (!pos) continue;
      const screen = Cesium.SceneTransforms.worldToWindowCoordinates(viewer.scene, pos);
      if (!screen) continue;
      const avoidPanel = panelAvoidanceOffsetFromRects(screen.x, screen.y, panelRects);
      // Center-bias runs against the post-panel-avoidance position, since
      // that's where the label would actually land — no point pulling
      // toward center from a spot it's about to be shifted away from.
      const avoidCenter = (width > 0 && height > 0)
        ? computeCenterBiasOffset(screen.x + avoidPanel.x, screen.y + avoidPanel.y, width, height)
        : { x: 0, y: 0 };
      const base = entity._gevBaseOffset || BASE_LABEL_OFFSET;
      const offsetX = base.x + avoidPanel.x + avoidCenter.x;
      const offsetY = base.y + avoidPanel.y + avoidCenter.y;

      const fontSize = entity._gevFontSize || DEFAULT_FLAG_FONT_SIZE;
      // `label.text` is a Cesium Property (constant here, but still a
      // Property, not a raw string) — same pattern as `entity.position`
      // above, resolved through `.getValue(now)` rather than read directly.
      const labelText = entity.label.text?.getValue ? entity.label.text.getValue(now) : entity.label.text;
      const box = estimateLabelBox(screen.x + offsetX, screen.y + offsetY, labelText, fontSize);
      const resolved = resolveLabelOverlap(box, placedBoxes);
      entity.label.show = resolved.visible;
      if (!resolved.visible) continue;
      placedBoxes.push({ left: box.left, right: box.right, top: box.top + resolved.extraY, bottom: box.bottom + resolved.extraY });
      entity.label.pixelOffset = new Cesium.Cartesian2(offsetX, offsetY + resolved.extraY);
    }
  };
  const remove = viewer.scene.postRender.addEventListener(handler);
  return remove;
}

/**
 * Same per-frame panel-avoidance + mutual-overlap-avoidance as
 * `installFlagAvoidance`, but for a plain `Cesium.LabelCollection`'s
 * `Label` objects rather than `Entity`-wrapped flags/ring labels — used by
 * `data/mapOverlays.js`'s lat/long grid line labels. Those are placed at a
 * fixed position along each line (a meridian's label sits at the view's
 * vertical center, a parallel's at the horizontal center) with no
 * collision awareness of its own; in a tilted 3D view, several grid
 * lines' projected paths can converge close together on screen (nowhere
 * near a straight top-down graticule), stacking their labels into
 * unreadable overlapping text. This keeps them apart the same way flags
 * are kept apart from each other and from control panels, hiding one
 * outright only if it truly can't find a clear spot.
 *
 * No center-bias pass here (unlike `installFlagAvoidance`): the grid
 * labels' own midpoint placement already deliberately spreads them across
 * the middle of the screen, so pulling them toward center too would fight
 * that spread rather than help it.
 *
 * A `Cesium.Label`'s properties (`position`, `text`, `pixelOffset`,
 * `show`) are plain values, not time-dynamic Cesium `Property` objects
 * like an `Entity.label`'s — so, unlike `installFlagAvoidance`, no
 * `JulianDate`/`.getValue()` is needed to read them.
 * @param {Cesium.Viewer} viewer
 * @param {() => Array<Cesium.Label>} getLabels - called fresh each frame, so a rebuilt label set is picked up automatically.
 * @returns {() => void} call to uninstall.
 */
export function installLabelCollectionAvoidance(viewer, getLabels) {
  const handler = () => {
    const labels = getLabels();
    if (!labels || !labels.length) return;
    const panelRects = visiblePanelRects();
    const placedBoxes = [];
    for (const label of labels) {
      if (!label || label.isDestroyed?.()) continue;
      const pos = label.position;
      if (!pos) continue;
      const screen = Cesium.SceneTransforms.worldToWindowCoordinates(viewer.scene, pos);
      if (!screen) continue;
      const avoidPanel = panelAvoidanceOffsetFromRects(screen.x, screen.y, panelRects);
      const base = label._gevBaseOffset || Cesium.Cartesian2.ZERO;
      const offsetX = base.x + avoidPanel.x;
      const offsetY = base.y + avoidPanel.y;
      const fontSize = label._gevFontSize || 20;
      const box = estimateLabelBox(screen.x + offsetX, screen.y + offsetY, label.text, fontSize, 'center');
      const resolved = resolveLabelOverlap(box, placedBoxes);
      label.show = resolved.visible;
      if (!resolved.visible) continue;
      placedBoxes.push({ left: box.left, right: box.right, top: box.top + resolved.extraY, bottom: box.bottom + resolved.extraY });
      label.pixelOffset = new Cesium.Cartesian2(offsetX, offsetY + resolved.extraY);
    }
  };
  const remove = viewer.scene.postRender.addEventListener(handler);
  return remove;
}
