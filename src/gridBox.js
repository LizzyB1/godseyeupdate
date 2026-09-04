import { buildMiniBox } from './miniBox.js';
import { OVERLAY_STYLE_PREFIX, el, section, sliderScale } from './overlayControlsKit.js';

/**
 * @file "GRID LINES" box: spacing, color and value labels for the lat/lon
 * graticule drawn by `data/mapOverlays.js`.
 *
 * One of the three boxes that replaced the single "MAP OVERLAYS" panel
 * (with `contoursBox.js` and `terrainBox.js`). As with contours, the
 * feature's on/off lives in the layers list (`data/overlayLayers.js`), so
 * there is no enable checkbox here.
 *
 * @module gridBox
 */

const GRID_SPACING_OPTIONS = [
  { label: '10°', value: 10 },
  { label: '5°', value: 5 },
  { label: '1°', value: 1 },
  { label: '30\'', value: 0.5 },
  { label: '10\'', value: 1 / 6 },
  { label: '5\'', value: 1 / 12 },
  { label: '1\'', value: 1 / 60 },
];

export class GridBox {
  constructor(engine) {
    this.engine = engine;
    this._build();
  }

  _build() {
    const box = buildMiniBox({
      idPrefix: 'gridbox',
      stylePrefix: OVERLAY_STYLE_PREFIX,
      storagePrefix: 'godsEyeView.gridBox.',
      title: 'GRID LINES',
      ariaLabel: 'Coordinate grid controls: spacing, color and value labels',
      defaultWidth: 250,
      defaultHeight: 250,
      minWidth: 210,
      maxWidth: 420,
      minHeight: 170,
      maxHeight: 520,
      anchor: { right: '16px', top: '452px' },
    });
    this._box = box;
    const body = box.body;

    const gridSection = section('LAT / LONG GRID');

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

    gridSpacingSelect.addEventListener('change', () => this.engine.setGridSpacingDeg(Number(gridSpacingSelect.value)));
    gridColorInput.addEventListener('input', () => this.engine.setGridColor(gridColorInput.value));

    // ── Grid line labels ─────────────────────────────────────────────
    // Only for lines already computed for the current viewport, so this
    // never needs its own visible-viewport filtering (see mapOverlays.js).
    const labelSection = section('GRID LINE LABELS');
    const labelRow = el('label', 'mapovl-row');
    const labelEnable = document.createElement('input');
    labelEnable.type = 'checkbox';
    labelEnable.checked = this.engine.state.lineLabelsEnabled;
    labelRow.appendChild(labelEnable);
    labelRow.appendChild(document.createTextNode('Show grid value labels'));
    labelSection.appendChild(labelRow);

    const gridLabelSizeRow = el('div', 'mapovl-slider-row');
    gridLabelSizeRow.appendChild(el('div', 'mapovl-slider-row-label', 'Text size'));
    const gridLabelSizeInput = document.createElement('input');
    gridLabelSizeInput.type = 'range';
    gridLabelSizeInput.min = '12';
    gridLabelSizeInput.max = '48';
    gridLabelSizeInput.step = '1';
    gridLabelSizeInput.value = String(this.engine.state.gridLabelFontSize);
    gridLabelSizeRow.appendChild(gridLabelSizeInput);
    gridLabelSizeRow.appendChild(sliderScale(['12', '21', '30', '39', '48']));
    labelSection.appendChild(gridLabelSizeRow);
    body.appendChild(labelSection);

    labelEnable.addEventListener('change', () => this.engine.setLineLabelsEnabled(labelEnable.checked));
    gridLabelSizeInput.addEventListener('input', () => this.engine.setGridLabelFontSize(Number(gridLabelSizeInput.value)));

    this._controls = { gridSpacingSelect, gridColorInput, labelEnable, gridLabelSizeInput };
  }

  /** Re-reads every widget from the engine — used after a global reset elsewhere. */
  sync() {
    const c = this._controls;
    const state = this.engine.state;
    c.gridSpacingSelect.value = String(state.gridSpacingDeg);
    c.gridColorInput.value = state.gridColor;
    c.labelEnable.checked = state.lineLabelsEnabled;
    c.gridLabelSizeInput.value = String(state.gridLabelFontSize);
  }

  destroy() {
    this._box.destroy();
  }
}

/**
 * @param {import('./data/mapOverlays.js').MapOverlaysEngine} engine
 * @returns {GridBox}
 */
export function initGridBox(engine) {
  return new GridBox(engine);
}
