import { buildMiniBox } from './miniBox.js';
import { OVERLAY_STYLE_PREFIX, el, section } from './overlayControlsKit.js';

/**
 * @file "TERRAIN" box: the two overlay controls that shape the globe
 * itself rather than a line drawn on it — the chart-datum (sea level)
 * plane and height-relief exaggeration — plus the "share viewport"
 * screenshot button in its header and the reset for every overlay setting.
 *
 * The last of the three boxes that replaced the single "MAP OVERLAYS"
 * panel (with `contoursBox.js` and `gridBox.js`).
 *
 * @module terrainBox
 */

/** The only vertical-exaggeration multipliers offered — kept in sync with `data/mapOverlays.js`'s `EXAGGERATION_OPTIONS`. */
const EXAGGERATION_OPTIONS = [1, 1.5, 2];

export class TerrainBox {
  /**
   * @param {import('./data/mapOverlays.js').MapOverlaysEngine} engine
   * @param {{onReset?: () => void}} [hooks] - `onReset` runs after the engine's own reset, for the sibling boxes (and the contour/grid layer rows) to re-read it.
   */
  constructor(engine, { onReset } = {}) {
    this.engine = engine;
    this._onReset = onReset;
    this._build();
  }

  _build() {
    const box = buildMiniBox({
      idPrefix: 'terrainbox',
      stylePrefix: OVERLAY_STYLE_PREFIX,
      storagePrefix: 'godsEyeView.terrainBox.',
      title: 'TERRAIN',
      ariaLabel: 'Terrain overlay controls: sea level plane and height relief exaggeration',
      defaultWidth: 250,
      defaultHeight: 210,
      minWidth: 210,
      maxWidth: 420,
      minHeight: 150,
      maxHeight: 480,
      anchor: { right: '16px', bottom: '292px' },
      onHeaderBuilt: (header) => {
        const shareBtn = document.createElement('button');
        shareBtn.type = 'button';
        shareBtn.className = 'mapovl-share-btn';
        shareBtn.title = 'Share viewport — download a screenshot of the display as-is';
        shareBtn.setAttribute('aria-label', 'Capture a screenshot of the current view');
        shareBtn.textContent = '📷';
        shareBtn.addEventListener('click', (event) => {
          event.stopPropagation();
          this.engine.captureScreenshot().catch(() => { /* nothing to say here; the box has no status line */ });
        });
        header.appendChild(shareBtn);
      },
    });
    this._box = box;
    const body = box.body;

    // ── Chart datum (sea level) ─────────────────────────────────────────
    // A translucent reference plane at height 0, not a contour level, so it
    // draws (or doesn't) regardless of whether contours are on. On by
    // default; see data/mapOverlays.js's DEFAULT_STATE.chartDatumEnabled.
    const chartDatumSection = section('CHART DATUM (SEA LEVEL)');
    const chartDatumRow = el('label', 'mapovl-row');
    const chartDatumEnable = document.createElement('input');
    chartDatumEnable.type = 'checkbox';
    chartDatumEnable.checked = this.engine.state.chartDatumEnabled;
    chartDatumRow.appendChild(chartDatumEnable);
    chartDatumRow.appendChild(document.createTextNode('Show sea level plane'));
    chartDatumSection.appendChild(chartDatumRow);
    body.appendChild(chartDatumSection);
    chartDatumEnable.addEventListener('change', () => this.engine.setChartDatumEnabled(chartDatumEnable.checked));

    // ── Vertical exaggeration ────────────────────────────────────────
    // A fixed 3-option button group, not a slider — only 1.0×/1.5×/2.0× are
    // valid, kept in lockstep with `data/mapOverlays.js`'s own snapping.
    const exagSection = section('HEIGHT RELIEF EXAGGERATION');
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

    // ── Reset ─────────────────────────────────────────────────────────
    // Still one button for every overlay setting (the engine's reset is
    // whole-state), so it tells the sibling boxes to re-read the engine
    // afterwards rather than leaving their widgets showing old values.
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'mapovl-btn mapovl-reset-btn';
    resetBtn.textContent = 'Reset all overlay controls';
    resetBtn.addEventListener('click', () => {
      this.engine.reset();
      chartDatumEnable.checked = this.engine.state.chartDatumEnabled;
      markActiveExaggeration(this.engine.state.verticalExaggeration);
      this._onReset?.();
    });
    body.appendChild(resetBtn);
  }

  destroy() {
    this._box.destroy();
  }
}

/**
 * @param {import('./data/mapOverlays.js').MapOverlaysEngine} engine
 * @param {{onReset?: () => void}} [hooks]
 * @returns {TerrainBox}
 */
export function initTerrainBox(engine, hooks) {
  return new TerrainBox(engine, hooks);
}
