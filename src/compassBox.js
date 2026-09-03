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
  const rounded = Math.abs(deg).toFixed(1);
  if (Math.abs(deg) < 0.05) return '0.0° (true ≈ magnetic)';
  return `${rounded}° ${deg > 0 ? 'E' : 'W'}`;
}

export class CompassBox {
  constructor(viewer) {
    this.viewer = viewer;
    this._recomputeTimer = null;
    this._onCameraMoveEnd = () => this._scheduleRecompute();
    this._build();
    this.viewer.camera.moveEnd.addEventListener(this._onCameraMoveEnd);
    this._recompute();
  }

  _build() {
    const box = buildMiniBox({
      idPrefix: 'compassbox',
      storagePrefix: 'godsEyeView.compassBox.',
      title: 'COMPASS',
      ariaLabel: 'Compass: true north reference and local magnetic variation',
      defaultWidth: 220,
      defaultHeight: 300,
      minWidth: 190,
      maxWidth: 360,
      minHeight: 240,
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

    // True-north-referenced cardinal ticks — fixed in place. Unlike
    // cameraControls.js's orientation compass (whose ring is also fixed
    // but represents "wherever the camera is pointed"), N here always
    // means true geographic north.
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
      svg.appendChild(tick);
    }

    // True-north needle: fixed, always pointing straight up — the
    // reference every other reading is measured against.
    const trueNeedle = svgEl('path');
    trueNeedle.setAttribute('class', 'compassbox-true-needle');
    trueNeedle.setAttribute('d', 'M20 20 L17.6 11 L20 7 L22.4 11 Z');
    svg.appendChild(trueNeedle);

    const hub = svgEl('circle');
    hub.setAttribute('class', 'compassbox-hub');
    hub.setAttribute('cx', '20');
    hub.setAttribute('cy', '20');
    hub.setAttribute('r', '1.8');
    svg.appendChild(hub);

    // Magnetic-north needle: rotates by the local declination — this is
    // the "dynamic" part, recomputed as the view moves (see _recompute).
    // Appended last so it draws on top of the (shorter, fixed) true-north
    // needle and the hub when the two nearly overlap at low declination.
    const magNeedle = svgEl('g');
    magNeedle.setAttribute('class', 'compassbox-mag-needle-group');
    const magNeedlePath = svgEl('path');
    magNeedlePath.setAttribute('class', 'compassbox-mag-needle');
    magNeedlePath.setAttribute('d', 'M20 20 L18.2 12.5 L20 9.5 L21.8 12.5 Z');
    magNeedle.appendChild(magNeedlePath);
    svg.appendChild(magNeedle);

    ringWrap.appendChild(svg);
    body.appendChild(ringWrap);
    this._magNeedle = magNeedle;

    const legend = el('div', 'compassbox-legend');
    const trueRow = el('div', 'compassbox-legend-row');
    trueRow.appendChild(el('span', 'compassbox-swatch compassbox-swatch-true'));
    trueRow.appendChild(el('span', null, 'True north'));
    const magRow = el('div', 'compassbox-legend-row');
    magRow.appendChild(el('span', 'compassbox-swatch compassbox-swatch-mag'));
    magRow.appendChild(el('span', null, 'Magnetic north'));
    legend.appendChild(trueRow);
    legend.appendChild(magRow);
    body.appendChild(legend);

    const output = el('div', 'mapovl-output');
    const outDecl = el('div', 'mapovl-output-row');
    const outAdvice = el('div', 'mapovl-output-row');
    const outLoc = el('div', 'mapovl-output-row');
    const outModel = el('div', 'mapovl-hint');
    output.appendChild(outDecl);
    output.appendChild(outAdvice);
    output.appendChild(outLoc);
    output.appendChild(outModel);
    body.appendChild(output);
    this._outDecl = outDecl;
    this._outAdvice = outAdvice;
    this._outLoc = outLoc;
    this._outModel = outModel;
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
      this._magNeedle.setAttribute('transform', 'rotate(0 20 20)');
      this._outDecl.textContent = 'Magnetic variation: unavailable here.';
      this._outAdvice.textContent = '';
      this._outLoc.textContent = '';
      this._outModel.textContent = '';
      return;
    }

    const { declinationDeg, modelName } = result;
    // WMM convention: positive declination = magnetic north lies EAST of
    // true north, which on this ring (N fixed at top, clockwise = east)
    // is exactly a clockwise SVG rotation by that many degrees.
    this._magNeedle.setAttribute('transform', `rotate(${declinationDeg} 20 20)`);

    this._outDecl.textContent = `Magnetic variation: ${fmtDeclination(declinationDeg)}`;
    if (Math.abs(declinationDeg) >= 0.05) {
      const towardTrue = declinationDeg > 0 ? 'subtract' : 'add';
      this._outAdvice.textContent = `${towardTrue} ${Math.abs(declinationDeg).toFixed(1)}° from a magnetic bearing to get true.`;
    } else {
      this._outAdvice.textContent = '';
    }
    this._outLoc.textContent = `At ${lat.toFixed(2)}°, ${lon.toFixed(2)}°`;
    this._outModel.textContent = `${modelName} geomagnetic model`;
  }

  destroy() {
    this.viewer.camera.moveEnd.removeEventListener(this._onCameraMoveEnd);
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
