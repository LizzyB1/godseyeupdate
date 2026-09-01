import { parseTrackFile } from './data/gpsTrackParse.js';

/**
 * @file "Module loader" panel for the GPS toolkit: lets an operator load raw
 * NMEA `.txt/.log/.nmea` logger dumps (as produced by the uploaded
 * nmea_to_gpx.py / convert_logs.py scripts) or already-converted `.gpx`
 * files straight into the browser — parsed client-side by
 * `data/gpsTrackParse.js` — and view the resulting track(s) as an extra
 * overlay on the live globe via `data/gpsTracks.js`. No Python, no server
 * round-trip.
 *
 * Self-contained by design (own floating panel, own toggle button), the
 * same pattern as `cameraControls.js`'s on-screen pad — it is not wired
 * into the app's DataLayerManager/share-link layer system, so it can't
 * destabilize that registry.
 *
 * @module gpsTrackPanel
 */

const ACCEPT = '.gpx,.txt,.log,.nmea';

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error || new Error(`Could not read ${file.name}`));
    reader.readAsText(file);
  });
}

/**
 * Builds and wires the GPS track loader panel + its toggle tab.
 * @param {import('./data/gpsTracks.js').GpsTrackOverlay} overlay
 */
export class GpsTrackPanel {
  constructor(overlay) {
    this.overlay = overlay;
    this._rows = new Map(); // track id -> row element
    this._build();
  }

  _build() {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.id = 'gps-track-toggle';
    toggle.className = 'gps-track-toggle';
    toggle.title = 'GPS tracks — load NMEA/GPX logs as an overlay';
    toggle.setAttribute('aria-label', 'Toggle GPS track loader panel');
    toggle.setAttribute('aria-pressed', 'false');
    toggle.textContent = '⛳ Tracks';
    document.body.appendChild(toggle);
    this._toggle = toggle;

    const panel = document.createElement('div');
    panel.id = 'gps-track-panel';
    panel.className = 'gps-track-panel';
    panel.hidden = true;
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', 'GPS track loader');

    panel.innerHTML = `
      <div class="gps-track-panel__header">
        <span>GPS TRACK LOADER</span>
        <button type="button" class="gps-track-panel__close" aria-label="Close">×</button>
      </div>
      <div class="gps-track-panel__drop" tabindex="0" role="button"
           aria-label="Load GPS log files: click to browse or drag files here">
        <div class="gps-track-panel__drop-label">Drop .gpx / .txt / .log / .nmea files here</div>
        <div class="gps-track-panel__drop-sub">or click to browse — raw NMEA logger dumps or converted GPX tracks</div>
        <input type="file" class="gps-track-panel__input" accept="${ACCEPT}" multiple hidden>
      </div>
      <div class="gps-track-panel__status" aria-live="polite"></div>
      <div class="gps-track-panel__list"></div>
    `;
    document.body.appendChild(panel);
    this._panel = panel;
    this._status = panel.querySelector('.gps-track-panel__status');
    this._list = panel.querySelector('.gps-track-panel__list');
    this._input = panel.querySelector('.gps-track-panel__input');
    const drop = panel.querySelector('.gps-track-panel__drop');

    toggle.addEventListener('click', () => this.setOpen(panel.hidden));
    panel.querySelector('.gps-track-panel__close').addEventListener('click', () => this.setOpen(false));

    drop.addEventListener('click', () => this._input.click());
    drop.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this._input.click(); }
    });
    this._input.addEventListener('change', () => {
      this._handleFiles(this._input.files);
      this._input.value = '';
    });

    let dragDepth = 0;
    drop.addEventListener('dragenter', (e) => {
      e.preventDefault();
      dragDepth += 1;
      drop.classList.add('is-dragover');
    });
    drop.addEventListener('dragover', (e) => e.preventDefault());
    drop.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) drop.classList.remove('is-dragover');
    });
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      dragDepth = 0;
      drop.classList.remove('is-dragover');
      this._handleFiles(e.dataTransfer?.files);
    });
  }

  setOpen(open) {
    this._panel.hidden = !open;
    this._toggle.classList.toggle('is-active', open);
    this._toggle.setAttribute('aria-pressed', String(open));
  }

  _setStatus(text, isError = false) {
    this._status.textContent = text;
    this._status.classList.toggle('is-error', isError);
  }

  async _handleFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    let loaded = 0;
    const errors = [];

    for (const file of files) {
      try {
        const text = await readFileAsText(file);
        const parsed = parseTrackFile(file.name, text);
        const result = this.overlay.addTrack(parsed, { sourceLabel: file.name });
        this._addRow(result);
        loaded += 1;
      } catch (err) {
        errors.push(`${file.name}: ${err?.message || err}`);
      }
    }

    if (errors.length) {
      this._setStatus(`Loaded ${loaded}/${files.length}. ${errors.join(' · ')}`, true);
    } else {
      this._setStatus(`Loaded ${loaded} track${loaded === 1 ? '' : 's'}.`, false);
    }
  }

  _addRow(result) {
    const row = document.createElement('div');
    row.className = 'gps-track-row';
    row.dataset.trackId = result.id;
    row.innerHTML = `
      <span class="gps-track-row__swatch" style="background:${result.color}"></span>
      <div class="gps-track-row__meta">
        <div class="gps-track-row__name" title="${result.name}">${result.name}</div>
        <div class="gps-track-row__sub">${result.pointCount} pts · ${result.segmentCount} seg</div>
      </div>
      <button type="button" class="gps-track-row__btn" data-action="fly" title="Fly to track">Fly</button>
      <button type="button" class="gps-track-row__btn" data-action="toggle" title="Show/hide track">Hide</button>
      <button type="button" class="gps-track-row__btn gps-track-row__btn--danger" data-action="remove" title="Remove track">✕</button>
    `;
    row.addEventListener('click', (e) => {
      const action = e.target?.dataset?.action;
      if (!action) return;
      if (action === 'fly') this.overlay.flyTo(result.id);
      else if (action === 'toggle') {
        this.overlay.toggleVisible(result.id);
        const nowVisible = this.overlay.tracks.get(result.id)?.visible;
        e.target.textContent = nowVisible ? 'Hide' : 'Show';
        row.classList.toggle('is-hidden', !nowVisible);
      } else if (action === 'remove') {
        this.overlay.removeTrack(result.id);
        row.remove();
        this._rows.delete(result.id);
      }
    });
    this._list.appendChild(row);
    this._rows.set(result.id, row);
  }

  destroy() {
    this._toggle.remove();
    this._panel.remove();
  }
}

/**
 * @param {import('./data/gpsTracks.js').GpsTrackOverlay} overlay
 * @returns {GpsTrackPanel}
 */
export function initGpsTrackPanel(overlay) {
  return new GpsTrackPanel(overlay);
}
