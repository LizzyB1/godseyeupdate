import { buildMiniBox } from './miniBox.js';

/**
 * @file "Map Overlays" mini control box: elevation contours, vertical
 * (height-relief) exaggeration, a lat/lon graticule, and the coordinate
 * cursor/pin tool with its copyable output box — everything driven by
 * `src/data/mapOverlays.js`'s `MapOverlaysEngine`. Also carries the
 * "share viewport" screenshot button in its header, since it doesn't
 * warrant a whole panel of its own.
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
    this.engine.onCursorChange = () => this._refreshCoordBox();
    this._refreshCoordBox();
  }

  _build() {
    const box = buildMiniBox({
      idPrefix: 'mapovl',
      storagePrefix: 'godsEyeView.mapOverlayBox.',
      title: 'MAP OVERLAYS',
      ariaLabel: 'Map overlay controls: contours, height exaggeration, coordinate grid, and cursor tool',
      defaultWidth: 268,
      defaultHeight: 560,
      minWidth: 220,
      maxWidth: 440,
      minHeight: 260,
      maxHeight: 820,
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
    exagSection.appendChild(el('div', 'mapovl-hint', 'Makes hills/valleys more obvious — 1.0× is true scale.'));
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

    // ── Coordinates / cursor tool ───────────────────────────────────────
    const coordSection = el('div', 'mapovl-section');
    coordSection.appendChild(el('div', 'mapovl-section-title', 'COORDINATES'));

    const cursorRow = el('div', 'mapovl-row');
    const cursorToggle = document.createElement('button');
    cursorToggle.type = 'button';
    cursorToggle.className = 'mapovl-btn';
    cursorToggle.textContent = '📍 Place cursor';
    cursorToggle.title = 'Click the map to drop/move a coordinate cursor';
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'mapovl-btn';
    clearBtn.textContent = 'Clear pin';
    cursorRow.appendChild(cursorToggle);
    cursorRow.appendChild(clearBtn);
    coordSection.appendChild(cursorRow);

    const output = el('div', 'mapovl-output');
    const outLat = el('div', 'mapovl-output-row');
    const outHeight = el('div', 'mapovl-output-row');
    const outAddr = el('div', 'mapovl-output-row');
    const outLink = el('div', 'mapovl-output-row');
    output.appendChild(outLat);
    output.appendChild(outHeight);
    output.appendChild(outAddr);
    output.appendChild(outLink);
    coordSection.appendChild(output);
    this._outLat = outLat;
    this._outHeight = outHeight;
    this._outAddr = outAddr;
    this._outLink = outLink;

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'mapovl-btn mapovl-copy-btn';
    copyBtn.textContent = 'Copy coordinates';
    coordSection.appendChild(copyBtn);
    this._copyBtn = copyBtn;
    body.appendChild(coordSection);

    cursorToggle.addEventListener('click', () => {
      const nowActive = !this.engine.isCursorActive();
      this.engine.setCursorActive(nowActive);
      cursorToggle.classList.toggle('is-active', nowActive);
      cursorToggle.textContent = nowActive ? '📍 Cursor active — click map' : '📍 Place cursor';
    });
    clearBtn.addEventListener('click', () => {
      this.engine.clearCursor();
      this._refreshCoordBox();
    });
    copyBtn.addEventListener('click', () => this._copyCoordinates());

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
      cursorToggle.classList.remove('is-active');
      cursorToggle.textContent = '📍 Place cursor';
      this._setContourStatus('');
      this._refreshCoordBox();
    });
    body.appendChild(resetBtn);
  }

  _setContourStatus(text) {
    if (this._contourStatus) this._contourStatus.textContent = text || '';
  }

  _refreshCoordBox() {
    const out = this.engine.getCursorOutput() || this.engine.getCameraOutput();
    if (!out) {
      this._outLat.textContent = 'No position yet.';
      this._outHeight.textContent = '';
      this._outAddr.textContent = '';
      this._outLink.textContent = '';
      return;
    }
    this._outLat.textContent = `${out.dms}  (${out.decimal})`;
    this._outHeight.textContent = out.height ? `Height: ${out.height}` : '';
    this._outAddr.textContent = out.address ? `Address: ${out.address}` : '';
    if (out.mapsLink) {
      this._outLink.innerHTML = '';
      const a = document.createElement('a');
      a.href = out.mapsLink;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = 'Open in Google Maps ↗';
      this._outLink.appendChild(a);
    } else {
      this._outLink.textContent = '';
    }
  }

  async _copyCoordinates() {
    const out = this.engine.getCursorOutput() || this.engine.getCameraOutput();
    if (!out) return;
    const lines = [out.dms, out.decimal];
    if (out.height) lines.push(out.height);
    if (out.address) lines.push(out.address);
    if (out.mapsLink) lines.push(out.mapsLink);
    const text = lines.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      const original = this._copyBtn.textContent;
      this._copyBtn.textContent = 'Copied!';
      setTimeout(() => { this._copyBtn.textContent = original; }, 1200);
    } catch {
      this._setContourStatus('Clipboard unavailable — select and copy manually.');
    }
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
