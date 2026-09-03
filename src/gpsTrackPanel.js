import { buildMiniBox } from './miniBox.js';
import { hidePanel, isPanelHidden } from './panelVisibility.js';
import { parseTrackFile } from './data/gpsTrackParse.js';

/**
 * @file "GPS Tracks" mini control box: lets an operator load raw NMEA
 * `.txt/.log/.nmea` logger dumps (as produced by the uploaded
 * nmea_to_gpx.py / convert_logs.py scripts) or already-converted `.gpx`
 * files straight into the browser — parsed client-side by
 * `data/gpsTrackParse.js` — and view the resulting track(s) as an extra
 * overlay on the live globe via `data/gpsTracks.js`. No Python, no server
 * round-trip.
 *
 * Same movable/resizable/persisted-position/collapsible/hideable box
 * mechanics as the app's other mini-boxes (`miniBox.js` +
 * `panelVisibility.js`) — see `bathymetryBox.js` for the pattern this
 * mirrors. Reuses the shared `.mapovl-*`-style dark-chip content look
 * where it fits, but keeps its own `.gps-track-panel__*` content classes
 * for the drop zone / row list, which are specific to this box.
 *
 * @module gpsTrackPanel
 */

const ACCEPT = '.gpx,.txt,.log,.nmea';

function el(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html != null) node.innerHTML = html;
  return node;
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error || new Error(`Could not read ${file.name}`));
    reader.readAsText(file);
  });
}

/**
 * Builds and wires the GPS track loader mini-box.
 * @param {import('./data/gpsTracks.js').GpsTrackOverlay} overlay
 */
export class GpsTrackPanel {
  constructor(overlay) {
    this.overlay = overlay;
    this._rows = new Map(); // track id -> row element
    this._build();
  }

  _build() {
    const box = buildMiniBox({
      idPrefix: 'gpstrack',
      storagePrefix: 'godsEyeView.gpsTrackBox.',
      title: 'GPS TRACKS',
      ariaLabel: 'GPS track loader: load NMEA/GPX logs as an overlay',
      defaultWidth: 260,
      defaultHeight: 320,
      minWidth: 220,
      maxWidth: 440,
      minHeight: 200,
      maxHeight: 560,
      anchor: { right: '16px', top: '440px' },
      onHeaderBuilt: (header) => {
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'gpstrack-close-btn';
        closeBtn.title = 'Hide panel — restore it from the Hidden Panels tray';
        closeBtn.setAttribute('aria-label', 'Hide GPS Tracks panel');
        closeBtn.textContent = '×';
        closeBtn.addEventListener('click', (event) => {
          event.stopPropagation();
          hidePanel('gpstrack-pad');
        });
        header.appendChild(closeBtn);
      },
    });
    this._box = box;
    // The box is built well after ui.js's one-time `applyStoredHiddenState()`
    // pass (it doesn't exist yet at that point), so a previously-hidden
    // state has to be re-applied here instead of relying on that pass.
    box.root.classList.toggle('panel-fully-hidden', isPanelHidden('gpstrack-pad'));
    const body = box.body;

    const drop = el(
      'div',
      'gps-track-panel__drop',
      `
        <div class="gps-track-panel__drop-label">Drop .gpx / .txt / .log / .nmea files here</div>
        <div class="gps-track-panel__drop-sub">or click to browse — raw NMEA logger dumps or converted GPX tracks</div>
        <input type="file" class="gps-track-panel__input" accept="${ACCEPT}" multiple hidden>
      `,
    );
    drop.tabIndex = 0;
    drop.setAttribute('role', 'button');
    drop.setAttribute('aria-label', 'Load GPS log files: click to browse or drag files here');
    body.appendChild(drop);

    const status = el('div', 'gps-track-panel__status');
    status.setAttribute('aria-live', 'polite');
    body.appendChild(status);
    this._status = status;

    const list = el('div', 'gps-track-panel__list');
    body.appendChild(list);
    this._list = list;

    this._input = drop.querySelector('.gps-track-panel__input');

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
      <input type="color" class="gps-track-row__color" value="${result.color}"
             title="Track color" aria-label="Track color for ${result.name}">
      <div class="gps-track-row__meta">
        <div class="gps-track-row__name" title="${result.name}">${result.name}</div>
        <div class="gps-track-row__sub">${result.pointCount} pts · ${result.segmentCount} seg</div>
      </div>
      <button type="button" class="gps-track-row__btn" data-action="fly" title="Fly to track">Fly</button>
      <button type="button" class="gps-track-row__btn is-active" data-action="flags" title="Show/hide start/end/interval flags">Flags</button>
      <button type="button" class="gps-track-row__btn" data-action="toggle" title="Show/hide track">Hide</button>
      <button type="button" class="gps-track-row__btn gps-track-row__btn--danger" data-action="remove" title="Remove track">✕</button>
    `;
    row.querySelector('.gps-track-row__color').addEventListener('input', (e) => {
      this.overlay.setColor(result.id, e.target.value);
    });
    row.addEventListener('click', (e) => {
      const action = e.target?.dataset?.action;
      if (!action) return;
      if (action === 'fly') this.overlay.flyTo(result.id);
      else if (action === 'flags') {
        this.overlay.toggleFlagsVisible(result.id);
        const nowVisible = this.overlay.tracks.get(result.id)?.flagsVisible;
        e.target.classList.toggle('is-active', nowVisible);
      } else if (action === 'toggle') {
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
    this._box.destroy();
  }
}

/**
 * @param {import('./data/gpsTracks.js').GpsTrackOverlay} overlay
 * @returns {GpsTrackPanel}
 */
export function initGpsTrackPanel(overlay) {
  return new GpsTrackPanel(overlay);
}
