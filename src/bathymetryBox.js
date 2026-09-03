import { buildMiniBox } from './miniBox.js';
import { BATHYMETRY_DISABLED } from './data/bathymetry.js';

/**
 * @file "Bathymetry" mini control box: toggles for undersea depth contour
 * lines and depth markers, driven by `src/data/bathymetry.js`'s
 * `BathymetryEngine`. Same movable/resizable/persisted-position/collapsible
 * box mechanics as the app's other mini-boxes (`miniBox.js`), and reuses
 * the shared `.mapovl-*` content classes verbatim (section/row/status) —
 * see `coordinatesBox.js` for why that's safe: those classes aren't
 * scoped to a particular box's `idPrefix`, only the chrome classes are.
 *
 * The header "×" hide button, and its entry in the Hidden Panels restore
 * tray, come for free from `buildMiniBox` — see `miniBox.js`.
 *
 * @module bathymetryBox
 */

function el(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html != null) node.innerHTML = html;
  return node;
}

/**
 * A small min/interim/max scale rendered under a `type="range"` slider —
 * see `mapOverlayControls.js`'s identical helper for why plain evenly-
 * spaced labels (no JS pixel-sync to the thumb) are enough here.
 * @param {string[]} labels - Evenly-spaced values from min to max, as display text.
 */
function sliderScale(labels) {
  const row = el('div', 'mapovl-slider-scale');
  for (const label of labels) row.appendChild(el('span', 'mapovl-slider-scale-tick', label));
  return row;
}

export class BathymetryBox {
  constructor(engine) {
    this.engine = engine;
    this._build();
    this.engine.onStatusChange = (text) => this._setStatus(text);
    this._setStatus(this.engine.getStatus());
  }

  _build() {
    const box = buildMiniBox({
      idPrefix: 'bathy',
      storagePrefix: 'godsEyeView.bathymetryBox.',
      title: 'BATHYMETRY',
      ariaLabel: 'Bathymetry controls: undersea depth contours and depth markers',
      defaultWidth: 250,
      defaultHeight: 270,
      minWidth: 200,
      maxWidth: 400,
      minHeight: 180,
      maxHeight: 460,
      anchor: { right: '16px', top: '160px' },
      // Hide (×) button, initial hidden-state restore, and the Hidden
      // Panels tray label are all handled centrally by `buildMiniBox` now
      // — see `miniBox.js`.
    });
    this._box = box;
    const body = box.body;

    const section = el('div', 'mapovl-section');
    section.appendChild(el('div', 'mapovl-section-title', 'UNDERSEA DATA'));

    const contourRow = el('label', 'mapovl-row');
    const contourEnable = document.createElement('input');
    contourEnable.type = 'checkbox';
    contourEnable.checked = this.engine.state.contoursEnabled;
    contourRow.appendChild(contourEnable);
    contourRow.appendChild(document.createTextNode('Show depth contours'));
    section.appendChild(contourRow);
    contourEnable.addEventListener('change', () => this.engine.setContoursEnabled(contourEnable.checked));

    const markerRow = el('label', 'mapovl-row');
    const markerEnable = document.createElement('input');
    markerEnable.type = 'checkbox';
    markerEnable.checked = this.engine.state.markersEnabled;
    markerRow.appendChild(markerEnable);
    markerRow.appendChild(document.createTextNode('Show depth markers'));
    section.appendChild(markerRow);
    markerEnable.addEventListener('change', () => this.engine.setMarkersEnabled(markerEnable.checked));

    const flagRow = el('label', 'mapovl-row');
    const flagEnable = document.createElement('input');
    flagEnable.type = 'checkbox';
    flagEnable.checked = this.engine.state.depthFlagsEnabled;
    flagRow.appendChild(flagEnable);
    flagRow.appendChild(document.createTextNode('Show depth flags'));
    section.appendChild(flagRow);
    flagEnable.addEventListener('change', () => this.engine.setDepthFlagsEnabled(flagEnable.checked));

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
    section.appendChild(flagStepRow);
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
    section.appendChild(flagSizeRow);
    flagSizeInput.addEventListener('input', () => this.engine.setFlagFontSize(Number(flagSizeInput.value)));

    const flagBgColorRow = el('label', 'mapovl-row');
    flagBgColorRow.appendChild(document.createTextNode('Background color'));
    const flagBgColorInput = document.createElement('input');
    flagBgColorInput.type = 'color';
    flagBgColorInput.className = 'mapovl-color';
    flagBgColorInput.value = this.engine.state.flagBgColor;
    flagBgColorRow.appendChild(flagBgColorInput);
    section.appendChild(flagBgColorRow);
    flagBgColorInput.addEventListener('input', () => this.engine.setFlagBgColor(flagBgColorInput.value));

    const flagBgAlphaRow = el('div', 'mapovl-slider-row');
    flagBgAlphaRow.appendChild(el('div', 'mapovl-slider-row-label', 'Background transparency'));
    const flagBgAlphaInput = document.createElement('input');
    flagBgAlphaInput.type = 'range';
    flagBgAlphaInput.min = '0';
    flagBgAlphaInput.max = '1';
    flagBgAlphaInput.step = '0.05';
    flagBgAlphaInput.value = String(this.engine.state.flagBgAlpha);
    flagBgAlphaRow.appendChild(flagBgAlphaInput);
    flagBgAlphaRow.appendChild(sliderScale(['0', '0.25', '0.5', '0.75', '1']));
    section.appendChild(flagBgAlphaRow);
    flagBgAlphaInput.addEventListener('input', () => this.engine.setFlagBgAlpha(Number(flagBgAlphaInput.value)));

    section.appendChild(el(
      'div',
      'mapovl-hint',
      'Isobaths and depth readouts: GEBCO grid via opentopodata.org (public, no key, rate-limited — cached once looked up). Depth flags need "Show depth contours" on, sit right on their contour line, and nudge clear of any control panel in the way.',
    ));

    if (BATHYMETRY_DISABLED) {
      // Benched, not hidden: the controls stay visible (so the feature
      // isn't erased from the UI) but greyed out and unusable via the
      // native `disabled` attribute, backed by BATHYMETRY_DISABLED
      // guarding every engine setter too (see data/bathymetry.js).
      for (const input of [contourEnable, markerEnable, flagEnable, flagStepSelect, flagSizeInput, flagBgColorInput, flagBgAlphaInput]) {
        input.disabled = true;
      }
      section.insertBefore(
        el('div', 'mapovl-hint', 'Bathymetry is temporarily disabled — contours were rendering unreliably (showing then vanishing) with poorly-placed labels. Controls are shown but inactive until this is fixed.'),
        section.firstChild.nextSibling, // right after the section title
      );
    }

    body.appendChild(section);

    const status = el('div', 'mapovl-status', '');
    body.appendChild(status);
    this._status = status;
  }

  _setStatus(text) {
    if (BATHYMETRY_DISABLED) { this._status.textContent = 'Disabled.'; return; }
    this._status.textContent = text || '';
  }

  destroy() {
    this._box.destroy();
  }
}

/**
 * @param {import('./data/bathymetry.js').BathymetryEngine} engine
 * @returns {BathymetryBox}
 */
export function initBathymetryBox(engine) {
  return new BathymetryBox(engine);
}
