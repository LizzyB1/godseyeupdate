import * as Cesium from 'cesium';
import { buildMiniBox } from './miniBox.js';
import { getMagneticDeclination } from './data/magneticDeclination.js';
import { compassTapeMarks } from './cameraMath.js';
import { magneticHeadingDegrees } from './magneticVariation.js';

/**
 * @file Standalone "Compass" mini control box: a live true-north reference
 * ring plus a magnetic-north needle offset by the local magnetic
 * declination (variation) at wherever the camera currently is — see
 * `data/magneticDeclination.js` (a pure-JS World Magnetic Model
 * evaluation) — and, underneath the ring, the numeric bearing tape (moved
 * here from the Controls box, formerly Camera, per a direct user ask: all
 * heading/orientation info lives in one box now instead of being split
 * across two). The ring shows where the CAMERA is looking as a
 * true-north-referenced needle; the tape underneath shows the same
 * heading as a scrolling numeric readout, magnetic where local variation
 * is known (°M), true otherwise (°T) — same pairing `cameraControls.js`
 * used to draw on its own.
 *
 * The ring/ticks/true-north needle counter-rotate against the camera's
 * current heading (`_applyHeadingRotation`, run every rendered frame —
 * same `scene.postRender` pattern `cameraControls.js`'s own tape used) so
 * "N" always points to the actual screen-space direction of true north.
 * Earlier versions drew the ring hard-fixed pointing straight up
 * regardless of camera heading, which only looked correct when the
 * camera happened to be facing due north — any other heading made the
 * compass visibly disagree with real north. The tape is driven by the
 * same per-frame heading value, converted to magnetic using whatever
 * declination `_recompute`'s debounced World Magnetic Model sample last
 * found (see that method) — no separate lookup of its own.
 *
 * Same movable/resizable/persisted-position/collapsible/hideable box
 * mechanics as the app's other mini-boxes, built on `miniBox.js`.
 *
 * @module compassBox
 */

/** Degrees of compass tape visible either side of the center index — same span `cameraControls.js`'s tape used. */
const TAPE_HALF_SPAN_DEG = 60;
/** Spacing between compass tape marks, in degrees. */
const TAPE_STEP_DEG = 15;

/** Radians → unsigned compass degrees in [0, 360). */
function toCompassDeg(rad) {
  let deg = Cesium.Math.toDegrees(rad) % 360;
  if (deg < 0) deg += 360;
  return deg;
}

/** Compass degrees → a zero-padded three-digit label, `360` folded to `000`. */
function fmtCompassDeg(deg) {
  return (Math.round(deg) % 360).toString().padStart(3, '0');
}

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
    this._lastDeclinationSampleOk = false;
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
      ariaLabel: 'Compass: true north reference, local magnetic variation, and bearing tape',
      // Grown from 190×220 to make room for the bearing tape/heading
      // readout moved in from the Controls box (formerly Camera).
      defaultWidth: 190,
      defaultHeight: 272,
      minWidth: 150,
      maxWidth: 360,
      minHeight: 200,
      maxHeight: 500,
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

    // Bearing tape: a flat compass tape whose cardinal marks slide under a
    // fixed center index as the camera turns, with the numeric heading
    // underneath — moved here from the Controls box (formerly Camera).
    const orient = el('div', 'compassbox-orient');
    orient.setAttribute('aria-hidden', 'true');

    const tape = el('div', 'compassbox-tape');
    tape.title = 'Bearing tape — cardinal marks slide under the center index as the camera turns';

    const tapeMarks = [];
    const markCount = Math.ceil((2 * TAPE_HALF_SPAN_DEG) / TAPE_STEP_DEG) + 1;
    for (let i = 0; i < markCount; i += 1) {
      const mark = document.createElement('span');
      mark.className = 'compassbox-tape-mark';
      const tick = document.createElement('i');
      const label = document.createElement('b');
      mark.append(tick, label);
      tape.appendChild(mark);
      tapeMarks.push({ el: mark, labelEl: label });
    }
    this._tapeMarks = tapeMarks;

    const tapeIndex = el('span', 'compassbox-tape-index');
    tape.appendChild(tapeIndex);
    orient.appendChild(tape);

    const heading = el('div', 'compassbox-heading');
    const headingValue = el('b', null, '000');
    const headingRef = el('small', null, '°M');
    heading.append(headingValue, headingRef);
    orient.appendChild(heading);
    this._headingEl = heading;
    this._headingValue = headingValue;
    this._headingRef = headingRef;

    body.appendChild(orient);
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
      this._lastDeclinationSampleOk = false;
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
    this._lastDeclinationSampleOk = true;
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
    this._updateBearingTape(headingDeg);
  }

  /**
   * Bearing tape + numeric heading readout — same per-frame cadence as the
   * ring above, so both stay in lockstep. Magnetic where a declination
   * sample is available (this box's own debounced `_recompute`, not a
   * fresh lookup here), true otherwise — mirrors what `cameraControls.js`'s
   * tape used to do before it moved here.
   */
  _updateBearingTape(trueHeadingDeg) {
    const hasDeclination = this._lastDeclinationSampleOk;
    const magneticDeg = hasDeclination
      ? magneticHeadingDegrees(trueHeadingDeg, this._lastDeclinationDeg)
      : null;
    const displayHeadingDeg = magneticDeg ?? trueHeadingDeg;

    const marks = compassTapeMarks(displayHeadingDeg, {
      halfSpanDeg: TAPE_HALF_SPAN_DEG,
      stepDeg: TAPE_STEP_DEG,
    });
    this._tapeMarks.forEach((slot, index) => {
      const mark = marks[index];
      if (!mark) {
        slot.el.hidden = true;
        return;
      }
      slot.el.hidden = false;
      slot.el.style.transform = `translateX(${(mark.offsetRatio * 50).toFixed(3)}%)`;
      slot.el.style.opacity = (1 - (Math.abs(mark.offsetRatio) ** 2) * 0.8).toFixed(3);
      slot.el.classList.toggle('is-cardinal', mark.cardinal);
      if (slot.labelEl.textContent !== mark.label) slot.labelEl.textContent = mark.label;
    });

    const headingText = fmtCompassDeg(displayHeadingDeg);
    const refText = magneticDeg === null ? '°T' : '°M';
    if (this._headingValue.textContent !== headingText) {
      this._headingValue.textContent = headingText;
      this._headingEl.title = magneticDeg === null
        ? 'Heading relative to true north — local magnetic variation is unavailable here'
        : `Magnetic heading — ${fmtCompassDeg(trueHeadingDeg)}° true, variation ${this._outVariation.textContent}`;
    }
    if (this._headingRef.textContent !== refText) this._headingRef.textContent = refText;
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
