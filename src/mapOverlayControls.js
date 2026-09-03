import { buildMiniBox } from './miniBox.js';

/**
 * @file "Map Overlays" mini control box: elevation contours, vertical
 * (height-relief) exaggeration, a lat/lon graticule, and a combined toggle
 * for large on-screen value labels on both — everything driven by
 * `src/data/mapOverlays.js`'s `MapOverlaysEngine`. Also carries the
 * "share viewport" screenshot button in its header, since it doesn't
 * warrant a whole panel of its own.
 *
 * The coordinate cursor/pin tool used to live in this same box; it's now
 * its own standalone, independently movable/resizable/hidable box — see
 * `coordinatesBox.js` — so it can be positioned and collapsed separately
 * from the rest of Map Overlays.
 *
 * Same movable/resizable/persisted-position/collapsible box mechanics as
 * `cameraControls.js`, both built on the shared `miniBox.js` helper so
 * neither reimplements that plumbing.
 *
 * @module mapOverlayControls
 */

const MAJOR_SPACING_OPTIONS = [10, 25, 50, 100, 200, 500];
/** The only vertical-exaggeration multipliers offered — kept in sync with `data/mapOverlays.js`'s `EXAGGERATION_OPTIONS`. */
const EXAGGERATION_OPTIONS = [1, 1.5, 2];
const GRID_SPACING_OPTIONS = [
  { label: '10°', value: 10 },
  { label: '5°', value: 5 },
  { label: '1°', value: 1 },
  { label: '30\'', value: 0.5 },
  { label: '10\'', value: 1 / 6 },
  { label: '5\'', value: 1 / 12 },
  { label: '1\'', value: 1 / 60 },
];

function el(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html != null) node.innerHTML = html;
  return node;
}

export class MapOverlayControls {
  constructor(engine) {
    this.engine = engine;
    this._build();
    this.engine.onStatusChange = (text) => this._setContourStatus(text);
  }

  _build() {
    const box = buildMiniBox({
      idPrefix: 'mapovl',
      storagePrefix: 'godsEyeView.mapOverlayBox.',
      title: 'MAP OVERLAYS',
      ariaLabel: 'Map overlay controls: contours, height exaggeration, and coordinate grid',
      defaultWidth: 268,
      defaultHeight: 460,
      minWidth: 220,
      maxWidth: 440,
      minHeight: 260,
      maxHeight: 760,
      anchor: { right: '16px', top: '16px' },
      onHeaderBuilt: (header) => {
        const shareBtn = document.createElement('button');
        shareBtn.type = 'button';
        shareBtn.className = 'mapovl-share-btn';
        shareBtn.title = 'Share viewport — download a screenshot of the display as-is';
        shareBtn.setAttribute('aria-label', 'Capture a screenshot of the current view');
        shareBtn.textContent = '📷';
        shareBtn.addEventListener('click', (event) => {
          event.stopPropagation();
          this.engine.captureScreenshot().catch(() => this._setContourStatus('Screenshot failed.'));
        });
        header.appendChild(shareBtn);
      },
    });
    this._box = box;
    const body = box.body;

    // ── Contours ──────────────────────────────────────────────────────
    const contourSection = el('div', 'mapovl-section');
    contourSection.appendChild(el('div', 'mapovl-section-title', 'ELEVATION CONTOURS'));

    const contourRow = el('label', 'mapovl-row');
    const contourEnable = document.createElement('input');
    contourEnable.type = 'checkbox';
    contourEnable.checked = this.engine.state.contoursEnabled;
    contourRow.appendChild(contourEnable);
    contourRow.appendChild(document.createTextNode('Show contour lines'));
    contourSection.appendChild(contourRow);

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

    const contourStatus = el('div', 'mapovl-status', '');
    contourSection.appendChild(contourStatus);
    this._contourStatus = contourStatus;
    body.appendChild(contourSection);

    contourEnable.addEventListener('change', () => this.engine.setContoursEnabled(contourEnable.checked));
    intervalSelect.addEventListener('change', () => this.engine.setContourMajorSpacing(Number(intervalSelect.value)));
    minorEnable.addEventListener('change', () => this.engine.setContourMinorEnabled(minorEnable.checked));

    // ── Vertical exaggeration ────────────────────────────────────────
    // A fixed 3-option button group, not a slider — only 1.0×/1.5×/2.0× are
    // valid, kept in lockstep with `data/mapOverlays.js`'s own snapping.
    const exagSection = el('div', 'mapovl-section');
    exagSection.appendChild(el('div', 'mapovl-section-title', 'HEIGHT RELIEF EXAGGERATION'));
    const exagRow = el('div', 'mapovl-row');
    const exagButtons = [];
    const markActiveExaggeration = (v) => {
      for (const btn of exagButtons) btn.classList.toggle('is-active', Number(btn.dataset.value) === v);
    };
    for (const v of EXAGGERATION_OPTIONS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mapovl-btn';
      btn.dataset.value = String(v);
      btn.textContent = `${v.toFixed(1)}×`;
      btn.addEventListener('click', () => {
        this.engine.setVerticalExaggeration(v);
        markActiveExaggeration(this.engine.state.verticalExaggeration);
      });
      exagButtons.push(btn);
      exagRow.appendChild(btn);
    }
    markActiveExaggeration(this.engine.state.verticalExaggeration);
    exagSection.appendChild(exagRow);
    body.appendChild(exagSection);

    // ── Lat/lon grid ──────────────────────────────────────────────────
    const gridSection = el('div', 'mapovl-section');
    gridSection.appendChild(el('div', 'mapovl-section-title', 'LAT / LONG GRID'));

    const gridRow = el('label', 'mapovl-row');
    const gridEnable = document.createElement('input');
    gridEnable.type = 'checkbox';
    gridEnable.checked = this.engine.state.gridEnabled;
    gridRow.appendChild(gridEnable);
    gridRow.appendChild(document.createTextNode('Show grid lines'));
    gridSection.appendChild(gridRow);

    const gridSpacingRow = el('label', 'mapovl-row');
    gridSpacingRow.appendChild(document.createTextNode('Spacing'));
    const gridSpacingSelect = document.createElement('select');
    gridSpacingSelect.className = 'mapovl-select';
    for (const { label, value } of GRID_SPACING_OPTIONS) {
      const opt = document.createElement('option');
      opt.value = String(value);
      opt.textContent = label;
      if (Math.abs(value - this.engine.state.gridSpacingDeg) < 1e-9) opt.selected = true;
      gridSpacingSelect.appendChild(opt);
    }
    gridSpacingRow.appendChild(gridSpacingSelect);
    gridSection.appendChild(gridSpacingRow);

    const gridColorRow = el('label', 'mapovl-row');
    gridColorRow.appendChild(document.createTextNode('Color'));
    const gridColorInput = document.createElement('input');
    gridColorInput.type = 'color';
    gridColorInput.className = 'mapovl-color';
    gridColorInput.value = this.engine.state.gridColor;
    gridColorRow.appendChild(gridColorInput);
    gridSection.appendChild(gridColorRow);
    body.appendChild(gridSection);

    gridEnable.addEventListener('change', () => this.engine.setGridEnabled(gridEnable.checked));
    gridSpacingSelect.addEventListener('change', () => this.engine.setGridSpacingDeg(Number(gridSpacingSelect.value)));
    gridColorInput.addEventListener('input', () => this.engine.setGridColor(gridColorInput.value));

    // ── Grid line labels ─────────────────────────────────────────────
    // Only for lines already computed for the current viewport, so this
    // never needs its own visible-viewport filtering (see mapOverlays.js).
    const labelSection = el('div', 'mapovl-section');
    labelSection.appendChild(el('div', 'mapovl-section-title', 'GRID LINE LABELS'));
    const labelRow = el('label', 'mapovl-row');
    const labelEnable = document.createElement('input');
    labelEnable.type = 'checkbox';
    labelEnable.checked = this.engine.state.lineLabelsEnabled;
    labelRow.appendChild(labelEnable);
    labelRow.appendChild(document.createTextNode('Show grid value labels'));
    labelSection.appendChild(labelRow);
    body.appendChild(labelSection);

    labelEnable.addEventListener('change', () => this.engine.setLineLabelsEnabled(labelEnable.checked));

    // ── Contour elevation flags ─────────────────────────────────────────
    // Independent of both "Show contour lines" and the grid labels above —
    // a big pole+plaque flag on every major contour line currently on
    // screen, biased toward the view's west edge (see data/contourFlags.js).
    const flagSection = el('div', 'mapovl-section');
    flagSection.appendChild(el('div', 'mapovl-section-title', 'CONTOUR FLAGS'));
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

    const flagSizeRow = el('label', 'mapovl-row');
    flagSizeRow.appendChild(document.createTextNode('Text size'));
    const flagSizeInput = document.createElement('input');
    flagSizeInput.type = 'range';
    flagSizeInput.min = '12';
    flagSizeInput.max = '48';
    flagSizeInput.step = '1';
    flagSizeInput.value = String(this.engine.state.flagFontSize);
    flagSizeRow.appendChild(flagSizeInput);
    flagSection.appendChild(flagSizeRow);
    flagSizeInput.addEventListener('input', () => this.engine.setFlagFontSize(Number(flagSizeInput.value)));

    const flagBgColorRow = el('label', 'mapovl-row');
    flagBgColorRow.appendChild(document.createTextNode('Background color'));
    const flagBgColorInput = document.createElement('input');
    flagBgColorInput.type = 'color';
    flagBgColorInput.className = 'mapovl-color';
    flagBgColorInput.value = this.engine.state.flagBgColor;
    flagBgColorRow.appendChild(flagBgColorInput);
    flagSection.appendChild(flagBgColorRow);
    flagBgColorInput.addEventListener('input', () => this.engine.setFlagBgColor(flagBgColorInput.value));

    const flagBgAlphaRow = el('label', 'mapovl-row');
    flagBgAlphaRow.appendChild(document.createTextNode('Background transparency'));
    const flagBgAlphaInput = document.createElement('input');
    flagBgAlphaInput.type = 'range';
    flagBgAlphaInput.min = '0';
    flagBgAlphaInput.max = '1';
    flagBgAlphaInput.step = '0.05';
    flagBgAlphaInput.value = String(this.engine.state.flagBgAlpha);
    flagBgAlphaRow.appendChild(flagBgAlphaInput);
    flagSection.appendChild(flagBgAlphaRow);
    flagBgAlphaInput.addEventListener('input', () => this.engine.setFlagBgAlpha(Number(flagBgAlphaInput.value)));

    body.appendChild(flagSection);

    flagEnable.addEventListener('change', () => this.engine.setContourFlagsEnabled(flagEnable.checked));

    // ── Reset ─────────────────────────────────────────────────────────
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'mapovl-btn mapovl-reset-btn';
    resetBtn.textContent = 'Reset all overlay controls';
    resetBtn.addEventListener('click', () => {
      this.engine.reset();
      contourEnable.checked = false;
      intervalSelect.value = String(this.engine.state.contourMajorSpacing);
      minorEnable.checked = false;
      markActiveExaggeration(this.engine.state.verticalExaggeration);
      gridEnable.checked = false;
      gridSpacingSelect.value = String(this.engine.state.gridSpacingDeg);
      gridColorInput.value = this.engine.state.gridColor;
      labelEnable.checked = false;
      flagEnable.checked = false;
      flagStepSelect.value = String(this.engine.state.flagLabelStep);
      flagSizeInput.value = String(this.engine.state.flagFontSize);
      flagBgColorInput.value = this.engine.state.flagBgColor;
      flagBgAlphaInput.value = String(this.engine.state.flagBgAlpha);
      this._setContourStatus('');
    });
    body.appendChild(resetBtn);
  }

  _setContourStatus(text) {
    if (this._contourStatus) this._contourStatus.textContent = text || '';
  }

  destroy() {
    this._box.destroy();
  }
}

/**
 * @param {import('./data/mapOverlays.js').MapOverlaysEngine} engine
 * @returns {MapOverlayControls}
 */
export function initMapOverlayControls(engine) {
  return new MapOverlayControls(engine);
}
