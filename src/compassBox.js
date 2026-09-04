import * as Cesium from 'cesium';
import { buildMiniBox } from './miniBox.js';
import { getMagneticDeclination } from './data/magneticDeclination.js';

/**
 * @file Standalone "Compass" mini control box: a live true-north reference
 * ring plus a magnetic-north needle offset by the local magnetic
 * declination (variation) at wherever the camera currently is — see
 * `data/magneticDeclination.js` (a pure-JS World Magnetic Model
 * evaluation). Independent of `cameraControls.js`'s own orientation
 * compass, which shows where the CAMERA is looking; this one is a
 * navigation instrument showing how a magnetic compass held at the
 * current location would disagree with true north, updating as the view
 * moves around the globe.
 *
 * The ring/ticks/true-north needle counter-rotate against the camera's
 * current heading (`_applyHeadingRotation`, run every rendered frame —
 * same `scene.postRender` pattern as `cameraControls.js`'s own needle,
 * so it tracks smoothly while dragging to rotate the view rather than
 * lagging behind) so "N" always points to the actual screen-space
 * direction of true north. Earlier versions drew the ring hard-fixed
 * pointing straight up regardless of camera heading, which only looked
 * correct when the camera happened to be facing due north — any other
 * heading made the compass visibly disagree with real north.
 *
 * Same movable/resizable/persisted-position/collapsible/hideable box
 * mechanics as the app's other mini-boxes, built on `miniBox.js`.
 *
 * @module compassBox
 */

/** Recompute declination this long after the camera stops moving, not on every frame — matches `data/mapOverlays.js`'s RECOMPUTE_DEBOUNCE_MS pattern; declination changes smoothly over hundreds of km, so per-frame precision buys nothing. */
const RECOMPUTE_DEBOUNCE_MS = 400;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function svgEl(tag) {
  return document.createElementNS('http://www.w3.org/2000/svg', tag);
}

function fmtDeclination(deg) {
  if (!Number.isFinite(deg)) return '—';
  if (Math.abs(deg) < 0.05) return '0.0°';
  return `${Math.abs(deg).toFixed(1)}° ${deg > 0 ? 'E' : 'W'}`;
}

export class CompassBox {
  constructor(viewer) {
    this.viewer = viewer;
    this._recomputeTimer = null;
    // Last-fetched declination, applied on every heading-rotation tick
    // below rather than only right after a (debounced) declination
    // recompute — otherwise the magnetic needle would sit at the wrong
    // angle for up to 400ms after every rotation.
    this._lastDeclinationDeg = 0;
    this._onCameraMoveEnd = () => this._scheduleRecompute();
    this._onPostRender = () => this._applyHeadingRotation();
    this._build();
    this.viewer.camera.moveEnd.addEventListener(this._onCameraMoveEnd);
    this.viewer.scene?.postRender.addEventListener(this._onPostRender);
    this._recompute();
    this._applyHeadingRotation();
  }

  _build() {
    const box = buildMiniBox({
      idPrefix: 'compassbox',
      storagePrefix: 'godsEyeView.compassBox.',
      title: 'COMPASS',
      ariaLabel: 'Compass: true north reference and local magnetic variation',
      defaultWidth: 190,
      defaultHeight: 220,
      minWidth: 130,
      maxWidth: 360,
      minHeight: 150,
      maxHeight: 460,
      anchor: { left: '292px', top: '894px' },
    });
    this._box = box;
    const body = box.body;

    const ringWrap = el('div', 'compassbox-ring-wrap');
    const svg = svgEl('svg');
    svg.setAttribute('viewBox', '0 0 40 40');
    svg.setAttribute('class', 'compassbox-svg');
    svg.setAttribute('focusable', 'false');

    const ring = svgEl('circle');
    ring.setAttribute('class', 'compassbox-ring');
    ring.setAttribute('cx', '20');
    ring.setAttribute('cy', '20');
    ring.setAttribute('r', '17.5');
    svg.appendChild(ring);

    // True-north-referenced cardinal ticks + the true-north needle, both
    // grouped so `_applyHeadingRotation` can spin them together against
    // the camera's current heading — N always means true geographic
    // north, but which way that is ON SCREEN depends on which way the
    // camera is currently facing, so the group itself isn't fixed.
    const ringGroup = svgEl('g');
    ringGroup.setAttribute('class', 'compassbox-ring-group');
    const CARDINAL_TICKS = [
      { label: 'N', x: 20, y: 7, primary: true },
      { label: 'E', x: 33, y: 20, primary: false },
      { label: 'S', x: 20, y: 33, primary: false },
      { label: 'W', x: 7, y: 20, primary: false },
    ];
    for (const { label, x, y, primary } of CARDINAL_TICKS) {
      const tick = svgEl('text');
      tick.setAttribute('class', primary ? 'compassbox-n' : 'compassbox-ew');
      tick.setAttribute('x', String(x));
      tick.setAttribute('y', String(y));
      tick.setAttribute('text-anchor', 'middle');
      if (!primary) tick.setAttribute('dominant-baseline', 'central');
      tick.textContent = label;
      ringGroup.appendChild(tick);
    }

    // True-north needle: part of the same rotating group above — this is
    // the reference every other reading (the magnetic needle) is
    // measured against.
    const trueNeedle = svgEl('path');
    trueNeedle.setAttribute('class', 'compassbox-true-needle');
    trueNeedle.setAttribute('d', 'M20 20 L17.6 11 L20 7 L22.4 11 Z');
    ringGroup.appendChild(trueNeedle);
    svg.appendChild(ringGroup);
    this._ringGroup = ringGroup;

    const hub = svgEl('circle');
    hub.setAttribute('class', 'compassbox-hub');
    hub.setAttribute('cx', '20');
    hub.setAttribute('cy', '20');
    hub.setAttribute('r', '1.8');
    svg.appendChild(hub);

    // Magnetic-north needle: rotates by (declination − camera heading) —
    // both the "dynamic" declination value (recomputed on camera
    // moveEnd, see _recompute) and the live heading (recomputed every
    // frame, see _applyHeadingRotation) feed into its angle.
    // Appended last so it draws on top of the (shorter) true-north
    // needle and the hub when the two nearly overlap at low declination.
    const magNeedle = svgEl('g');
    magNeedle.setAttribute('class', 'compassbox-mag-needle-group');
    const magNeedlePath = svgEl('path');
    magNeedlePath.setAttribute('class', 'compassbox-mag-needle');
    magNeedlePath.setAttribute('d', 'M20 20 L18.2 12.5 L20 9.5 L21.8 12.5 Z');
    magNeedle.appendChild(magNeedlePath);
    svg.appendChild(magNeedle);

    // Heading pointer: the direction the camera itself is facing, read the
    // same way as the two north needles — an arrow from the hub — rather
    // than as a number somewhere else on screen. It is deliberately OUTSIDE
    // the rotating ring group: the ring counter-rotates by the camera
    // heading so N tracks true north, which leaves screen-up meaning
    // "where the camera is pointing", so this arrow is fixed there and the
    // ring turns underneath it.
    const headingNeedle = svgEl('path');
    headingNeedle.setAttribute('class', 'compassbox-heading-needle');
    headingNeedle.setAttribute('d', 'M20 20 L18.8 5.2 L20 2.6 L21.2 5.2 Z');
    svg.appendChild(headingNeedle);

    ringWrap.appendChild(svg);
    body.appendChild(ringWrap);
    this._magNeedle = magNeedle;

    // One line, under the compass, on the box's own transparency — the
    // variation and nothing else. The needles say which north is which;
    // the earlier legend, bearing-correction sentence, camera lat/lon and
    // model name said it again in prose.
    const outVariation = el('div', 'compassbox-readout');
    body.appendChild(outVariation);
    this._outVariation = outVariation;
  }

  _scheduleRecompute() {
    if (this._recomputeTimer) clearTimeout(this._recomputeTimer);
    this._recomputeTimer = setTimeout(() => this._recompute(), RECOMPUTE_DEBOUNCE_MS);
  }

  _recompute() {
    const carto = this.viewer.camera?.positionCartographic;
    if (!carto) return;
    const lat = Cesium.Math.toDegrees(carto.latitude);
    const lon = Cesium.Math.toDegrees(carto.longitude);
    const result = getMagneticDeclination(lat, lon);

    if (!result) {
      this._lastDeclinationDeg = 0;
      this._applyHeadingRotation();
      this._outVariation.textContent = 'Variation —';
      return;
    }

    const { declinationDeg } = result;
    // WMM convention: positive declination = magnetic north lies EAST of
    // true north, which on this ring (clockwise = east, once oriented to
    // true north by _applyHeadingRotation) is a clockwise SVG rotation
    // by that many degrees, on top of whatever the current heading
    // needs — see _applyHeadingRotation for the combined angle.
    this._lastDeclinationDeg = declinationDeg;
    this._applyHeadingRotation();
    this._outVariation.textContent = `Variation ${fmtDeclination(declinationDeg)}`;
  }

  /**
   * Runs every rendered frame (`scene.postRender`) so the ring tracks
   * smoothly while the camera is actively being rotated, rather than
   * jumping into place up to 400ms later on the debounced declination
   * recompute above. Cheap: two SVG transform-attribute writes, no
   * layout/geometry work.
   */
  _applyHeadingRotation() {
    const camera = this.viewer.camera;
    if (!camera) return;
    const headingDeg = Cesium.Math.toDegrees(camera.heading);
    // Counter-rotate the ring/ticks/true-needle by the camera's current
    // heading so "N" keeps pointing to the actual screen-space direction
    // of true north, whatever way the view is currently facing.
    this._ringGroup.setAttribute('transform', `rotate(${-headingDeg} 20 20)`);
    this._magNeedle.setAttribute('transform', `rotate(${this._lastDeclinationDeg - headingDeg} 20 20)`);
  }

  destroy() {
    this.viewer.camera.moveEnd.removeEventListener(this._onCameraMoveEnd);
    this.viewer.scene?.postRender.removeEventListener(this._onPostRender);
    if (this._recomputeTimer) clearTimeout(this._recomputeTimer);
    this._box.destroy();
  }
}

/**
 * @param {import('cesium').Viewer} viewer
 * @returns {CompassBox}
 */
export function initCompassBox(viewer) {
  return new CompassBox(viewer);
}
