import { buildMiniBox } from './miniBox.js';
import { CONTOUR_VIEW_SPAN_MIN_DEG, CONTOUR_VIEW_SPAN_MAX_DEG } from './data/mapOverlays.js';
import { OVERLAY_STYLE_PREFIX, el, section, sliderScale } from './overlayControlsKit.js';

/**
 * @file "CONTOURS" box: everything that shapes the elevation contours —
 * interval, minor lines, smoothing, minimum height, ring labels, the
 * zoom-in requirement with its live view-span readout, the render-phase
 * light and status line, the manual refresh, and the edge elevation flags.
 *
 * One of the three boxes that replaced the single "MAP OVERLAYS" panel
 * (with `gridBox.js` and `terrainBox.js`), so each feature is moved,
 * resized, collapsed and hidden on its own. There is deliberately no
 * "show contours" checkbox here: contours are a row in the layers list
 * (`data/overlayLayers.js`), the single switch for the feature.
 *
 * Refreshing is still manual only — nothing in this box computes contours;
 * every control just restyles what is already drawn and marks it stale
 * until ⟳ Refresh contours is pressed.
 *
 * @module contoursBox
 */

const MAJOR_SPACING_OPTIONS = [10, 25, 50, 100, 200, 500];

/**
 * Traffic-light meta for `data/mapOverlays.js`'s `_contourPhase` — see
 * `_setStatus`'s doc comment there for what each phase means. Keyed the
 * same way so a new phase value there is a compile-time-obvious miss here
 * (falls through to the `PHASE_META.offline` default in `_setPhase`)
 * rather than a silently-blank light.
 */
const PHASE_META = {
  done: { label: 'Rendering', className: 'is-done' },
  computing: { label: 'Computing…', className: 'is-computing' },
  loading: { label: 'Loading tiles…', className: 'is-loading' },
  offline: { label: 'Not rendering', className: 'is-offline' },
};

export class ContoursBox {
  constructor(engine) {
    this.engine = engine;
    this._build();
    this.engine.onStatusChange = (text, phase) => this._setContourStatus(text, phase);
    this.engine.onViewSpanChange = (spanDeg, maxSpanDeg) => this._setViewSpanReadout(spanDeg, maxSpanDeg);
    // Initialize the light/readout from whatever the engine already knows
    // — it may have run a cycle or more before this UI subscribed above.
    this._setContourStatus(this.engine._contourStatus, this.engine._contourPhase);
    if (this.engine._lastViewSpanDeg != null) {
      this._setViewSpanReadout(this.engine._lastViewSpanDeg, this.engine.state.contourMaxViewSpanDeg);
    }
  }

  _build() {
    const box = buildMiniBox({
      idPrefix: 'contourbox',
      stylePrefix: OVERLAY_STYLE_PREFIX,
      storagePrefix: 'godsEyeView.contoursBox.',
      title: 'CONTOURS',
      ariaLabel: 'Elevation contour controls: interval, smoothing, labels and manual refresh',
      defaultWidth: 268,
      defaultHeight: 420,
      minWidth: 220,
      maxWidth: 440,
      minHeight: 220,
      maxHeight: 760,
      anchor: { right: '16px', top: '16px' },
    });
    this._box = box;
    const body = box.body;

    const contourSection = section('ELEVATION CONTOURS');

    const intervalRow = el('label', 'mapovl-row');
    intervalRow.appendChild(document.createTextNode('Interval'));
    const intervalSelect = document.createElement('select');
    intervalSelect.className = 'mapovl-select';
    for (const m of MAJOR_SPACING_OPTIONS) {
      const opt = document.createElement('option');
      opt.value = String(m);
      opt.textContent = `${m} m`;
      if (m === this.engine.state.contourMajorSpacing) opt.selected = true;
      intervalSelect.appendChild(opt);
    }
    intervalRow.appendChild(intervalSelect);
    contourSection.appendChild(intervalRow);

    const minorRow = el('label', 'mapovl-row');
    const minorEnable = document.createElement('input');
    minorEnable.type = 'checkbox';
    minorEnable.checked = this.engine.state.contourMinorEnabled;
    minorRow.appendChild(minorEnable);
    minorRow.appendChild(document.createTextNode('+ minor contours every 10 m'));
    contourSection.appendChild(minorRow);

    // A stacked (label-above) row, not the inline label+control rows used
    // elsewhere in this box: the slider needs its full row width to itself
    // so the min/interim/max scale directly under it lines up with the
    // track (see sliderScale's own comment).
    const precisionRow = el('div', 'mapovl-slider-row');
    precisionRow.appendChild(el('div', 'mapovl-slider-row-label', 'Line smoothing'));
    const precisionInput = document.createElement('input');
    precisionInput.type = 'range';
    precisionInput.min = '0';
    precisionInput.max = '4';
    precisionInput.step = '1';
    precisionInput.value = String(this.engine.state.contourSmoothing);
    precisionInput.title = '0 = raw line, higher = smoother/more precise';
    precisionRow.appendChild(precisionInput);
    precisionRow.appendChild(sliderScale(['0', '1', '2', '3', '4']));
    contourSection.appendChild(precisionRow);
    precisionInput.addEventListener('change', () => this.engine.setContourSmoothing(Number(precisionInput.value)));

    // Minimum-height cutoff — same fixed button-group pattern as height
    // relief exaggeration in the terrain box: hides every level below the
    // pick, so low-lying/coastal relief doesn't clutter the view when only
    // the higher terrain matters.
    const minHeightRow = el('div', 'mapovl-row');
    minHeightRow.appendChild(document.createTextNode('Hide contours below'));
    const minHeightButtons = [];
    const markActiveMinHeight = (v) => {
      for (const btn of minHeightButtons) btn.classList.toggle('is-active', Number(btn.dataset.value) === v);
    };
    for (const { label, value } of [
      { label: 'Off', value: 0 },
      { label: '100m', value: 100 },
      { label: '200m', value: 200 },
    ]) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mapovl-btn';
      btn.dataset.value = String(value);
      btn.textContent = label;
      btn.addEventListener('click', () => {
        this.engine.setContourMinHeightM(value);
        markActiveMinHeight(this.engine.state.contourMinHeightM);
      });
      minHeightButtons.push(btn);
      minHeightRow.appendChild(btn);
    }
    markActiveMinHeight(this.engine.state.contourMinHeightM);
    contourSection.appendChild(minHeightRow);

    const ringLabelsRow = el('label', 'mapovl-row');
    const ringLabelsEnable = document.createElement('input');
    ringLabelsEnable.type = 'checkbox';
    ringLabelsEnable.checked = this.engine.state.ringLabelsEnabled;
    ringLabelsRow.appendChild(ringLabelsEnable);
    ringLabelsRow.appendChild(document.createTextNode('Label closed contour rings'));
    contourSection.appendChild(ringLabelsRow);
    ringLabelsEnable.addEventListener('change', () => this.engine.setRingLabelsEnabled(ringLabelsEnable.checked));

    // Zoom-in requirement: the widest the camera view is allowed to be for
    // contours to compute at all (data/mapOverlays.js's
    // setContourMaxViewSpanDeg), with the current view's own span shown
    // right next to it — per a direct user report that the requirement
    // wasn't obvious.
    const viewSpanRow = el('div', 'mapovl-slider-row');
    viewSpanRow.appendChild(el('div', 'mapovl-slider-row-label', 'Zoom-in requirement'));
    const viewSpanInput = document.createElement('input');
    viewSpanInput.type = 'range';
    viewSpanInput.min = String(CONTOUR_VIEW_SPAN_MIN_DEG);
    viewSpanInput.max = String(CONTOUR_VIEW_SPAN_MAX_DEG);
    viewSpanInput.step = '0.1';
    viewSpanInput.value = String(this.engine.state.contourMaxViewSpanDeg);
    viewSpanInput.title = 'Widest the camera view may be for contours to compute — wider views are too coarse to be meaningful';
    viewSpanRow.appendChild(viewSpanInput);
    viewSpanRow.appendChild(sliderScale(['0.5°', '1.0°', '1.5°', '2.0°', '2.5°']));
    contourSection.appendChild(viewSpanRow);
    viewSpanInput.addEventListener('input', () => this.engine.setContourMaxViewSpanDeg(Number(viewSpanInput.value)));

    const viewSpanReadout = el('div', 'mapovl-view-span-readout', 'View span: —');
    contourSection.appendChild(viewSpanReadout);
    this._viewSpanReadout = viewSpanReadout;

    // Traffic light: at-a-glance render phase, independent of the text
    // status sentence below (which stays a human-readable detail; the
    // light is the fast glance) — green = finished, orange = waiting on
    // tiles, purple = actively computing, red = not rendering right now
    // (off, view too wide, no surface). See data/mapOverlays.js's
    // `_setStatus` doc comment for the exact phase semantics.
    const phaseRow = el('div', 'mapovl-phase-row');
    const phaseLight = el('span', 'mapovl-phase-light');
    const phaseLabel = el('span', 'mapovl-phase-label', 'Not rendering');
    phaseRow.appendChild(phaseLight);
    phaseRow.appendChild(phaseLabel);
    contourSection.appendChild(phaseRow);
    this._phaseLight = phaseLight;
    this._phaseLabel = phaseLabel;

    // Manual refresh: the only thing in the app that computes contours.
    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'mapovl-btn mapovl-refresh-contours-btn';
    refreshBtn.textContent = '⟳ Refresh contours';
    refreshBtn.title = 'Recompute contours for the current view right now, ignoring any cached result';
    refreshBtn.addEventListener('click', () => this.engine.refreshContours());
    contourSection.appendChild(refreshBtn);

    const contourStatus = el('div', 'mapovl-status', '');
    contourSection.appendChild(contourStatus);
    this._contourStatus = contourStatus;
    body.appendChild(contourSection);

    intervalSelect.addEventListener('change', () => this.engine.setContourMajorSpacing(Number(intervalSelect.value)));
    minorEnable.addEventListener('change', () => this.engine.setContourMinorEnabled(minorEnable.checked));

    // ── Contour elevation flags ─────────────────────────────────────────
    // A marker+numbered label on every major contour line currently on
    // screen, placed toward the view edges (see data/contourFlags.js).
    const flagSection = section('CONTOUR FLAGS');
    const flagRow = el('label', 'mapovl-row');
    const flagEnable = document.createElement('input');
    flagEnable.type = 'checkbox';
    flagEnable.checked = this.engine.state.contourFlagsEnabled;
    flagRow.appendChild(flagEnable);
    flagRow.appendChild(document.createTextNode('Show elevation flags'));
    flagSection.appendChild(flagRow);

    const flagStepRow = el('label', 'mapovl-row');
    flagStepRow.appendChild(document.createTextNode('Label frequency'));
    const flagStepSelect = document.createElement('select');
    flagStepSelect.className = 'mapovl-select';
    for (const { label, value } of [
      { label: 'Every contour', value: 1 },
      { label: 'Every other', value: 2 },
      { label: 'Every 3rd', value: 3 },
      { label: 'Every 4th', value: 4 },
    ]) {
      const opt = document.createElement('option');
      opt.value = String(value);
      opt.textContent = label;
      if (value === this.engine.state.flagLabelStep) opt.selected = true;
      flagStepSelect.appendChild(opt);
    }
    flagStepRow.appendChild(flagStepSelect);
    flagSection.appendChild(flagStepRow);
    flagStepSelect.addEventListener('change', () => this.engine.setFlagLabelStep(Number(flagStepSelect.value)));

    const flagSizeRow = el('div', 'mapovl-slider-row');
    flagSizeRow.appendChild(el('div', 'mapovl-slider-row-label', 'Text size'));
    const flagSizeInput = document.createElement('input');
    flagSizeInput.type = 'range';
    flagSizeInput.min = '12';
    flagSizeInput.max = '48';
    flagSizeInput.step = '1';
    flagSizeInput.value = String(this.engine.state.flagFontSize);
    flagSizeRow.appendChild(flagSizeInput);
    flagSizeRow.appendChild(sliderScale(['12', '21', '30', '39', '48']));
    flagSection.appendChild(flagSizeRow);
    flagSizeInput.addEventListener('input', () => this.engine.setFlagFontSize(Number(flagSizeInput.value)));

    body.appendChild(flagSection);
    flagEnable.addEventListener('change', () => this.engine.setContourFlagsEnabled(flagEnable.checked));

    this._controls = {
      intervalSelect,
      minorEnable,
      precisionInput,
      markActiveMinHeight,
      ringLabelsEnable,
      viewSpanInput,
      flagEnable,
      flagStepSelect,
      flagSizeInput,
    };
  }

  /** Re-reads every widget from the engine — used after a global reset elsewhere. */
  sync() {
    const c = this._controls;
    const state = this.engine.state;
    c.intervalSelect.value = String(state.contourMajorSpacing);
    c.minorEnable.checked = state.contourMinorEnabled;
    c.precisionInput.value = String(state.contourSmoothing);
    c.markActiveMinHeight(state.contourMinHeightM);
    c.ringLabelsEnable.checked = state.ringLabelsEnabled;
    c.viewSpanInput.value = String(state.contourMaxViewSpanDeg);
    c.flagEnable.checked = state.contourFlagsEnabled;
    c.flagStepSelect.value = String(state.flagLabelStep);
    c.flagSizeInput.value = String(state.flagFontSize);
    this._setContourStatus('');
  }

  _setContourStatus(text, phase) {
    if (this._contourStatus) this._contourStatus.textContent = text || '';
    if (phase) this._setPhase(phase);
  }

  /** Applies one of PHASE_META's four states to the traffic-light dot + its label. */
  _setPhase(phase) {
    const meta = PHASE_META[phase] || PHASE_META.offline;
    if (this._phaseLight) {
      for (const { className } of Object.values(PHASE_META)) this._phaseLight.classList.remove(className);
      this._phaseLight.classList.add(meta.className);
    }
    if (this._phaseLabel) this._phaseLabel.textContent = meta.label;
  }

  /** Keeps the "View span: X.X° (limit Y.Y°)" readout in sync with every recompute cycle, including ones that never touch the status light (e.g. contours disabled). */
  _setViewSpanReadout(spanDeg, maxSpanDeg) {
    if (!this._viewSpanReadout) return;
    if (!Number.isFinite(spanDeg)) { this._viewSpanReadout.textContent = 'View span: —'; return; }
    const overLimit = spanDeg > maxSpanDeg;
    this._viewSpanReadout.textContent = `View span: ${spanDeg.toFixed(1)}° (limit ${maxSpanDeg.toFixed(1)}°)`;
    this._viewSpanReadout.classList.toggle('is-over-limit', overLimit);
  }

  destroy() {
    this._box.destroy();
  }
}

/**
 * @param {import('./data/mapOverlays.js').MapOverlaysEngine} engine
 * @returns {ContoursBox}
 */
export function initContoursBox(engine) {
  return new ContoursBox(engine);
}
