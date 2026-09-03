import { buildMiniBox } from './miniBox.js';
import { layerFeedState } from './data/manager.js';
import { aggregateLayerLoading } from './loadingFeedback.js';

/**
 * @file "Status" mini control box: a verbose, always-on-screen answer to
 * "what's loading or fetching right now" — pulled from REAL state, not a
 * decorative spinner. Two sources, both already built for other purposes:
 *
 * 1. `DataLayerManager` (`src/data/manager.js`) already tracks a rich
 *    lifecycle (enabling/enabled/disabling/disabled) plus each of its 16
 *    registered layers' own `getStats()` (count, lastUpdate, loading,
 *    error, stale, degraded, fallback, unavailable, ...) — the exact same
 *    data that already drives the top-center "LOADING LIVE DATA" banner
 *    (`src/loadingFeedback.js`'s `aggregateLayerLoading`) and each layer's
 *    control-chip color (`layerFeedState`). This box reuses both functions
 *    directly rather than re-deriving loading/error state a third way.
 * 2. Bathymetry and Map Overlays (contours) aren't DataLayerManager
 *    layers, but both already push free-text status through a single
 *    `engine.onStatusChange` callback slot, each already claimed by their
 *    own box (`bathymetryBox.js`/`mapOverlayControls.js`). This box wraps
 *    (not replaces) whatever's already assigned there, so both listeners
 *    keep firing — safe as long as this box is constructed AFTER those
 *    two in `main.js`, which it is.
 *
 * GPS track loading (user-selected files, not a network fetch) and the
 * one-time geoid grid download aren't surfaced here — neither exposes
 * observable state today, and both are minor/rare next to the 16 live
 * layers and two engines above.
 *
 * Same movable/resizable/persisted-position/collapsible/hideable box
 * mechanics as the app's other mini-boxes, built on `miniBox.js`.
 *
 * @module statusBox
 */

const FEED_LABELS = {
  nominal: 'OK',
  loading: 'LOADING',
  degraded: 'DEGRADED',
  stale: 'STALE',
  fallback: 'FALLBACK',
  unavailable: 'UNAVAILABLE',
  off: 'OFF',
};

// Re-render on this cadence too, not just on manager events — `stats.count`/
// `lastUpdate`/relative-age text can move between the manager's own
// visibility/refresh transition events, and this is cheap (DOM text only).
const POLL_MS = 1000;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function relativeAge(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  const deltaS = Math.max(0, (Date.now() - n) / 1000);
  if (deltaS < 1) return 'just now';
  if (deltaS < 60) return `${Math.round(deltaS)}s ago`;
  if (deltaS < 3600) return `${Math.round(deltaS / 60)}m ago`;
  return `${Math.round(deltaS / 3600)}h ago`;
}

function errorText(err) {
  if (!err) return '';
  const text = typeof err === 'string' ? err : (err.message || String(err));
  return text.length > 64 ? `${text.slice(0, 61)}...` : text;
}

export class StatusBox {
  /**
   * @param {Object} deps
   * @param {import('./data/manager.js').DataLayerManager} [deps.dataManager]
   * @param {import('./data/bathymetry.js').BathymetryEngine} [deps.bathymetry]
   * @param {import('./data/mapOverlays.js').MapOverlaysEngine} [deps.mapOverlays]
   */
  constructor({ dataManager, bathymetry, mapOverlays } = {}) {
    this._dataManager = dataManager || null;
    this._bathymetry = bathymetry || null;
    this._mapOverlays = mapOverlays || null;
    this._bathyStatus = '';
    this._contourStatus = '';
    this._build();
    this._wireEngineStatus();
    this._unsubscribe = this._dataManager
      ? this._dataManager.subscribe(() => this._render())
      : null;
    this._pollTimer = window.setInterval(() => this._render(), POLL_MS);
    this._render();
  }

  /**
   * Chains onto whatever's already listening on each engine's single
   * `onStatusChange` slot, instead of reassigning it — reassigning would
   * silently break bathymetryBox.js's / mapOverlayControls.js's own status
   * line, since it's one callback reference, not a subscriber list.
   */
  _wireEngineStatus() {
    if (this._bathymetry) {
      const prev = this._bathymetry.onStatusChange;
      this._bathymetry.onStatusChange = (text) => {
        prev?.(text);
        this._bathyStatus = text || '';
        this._render();
      };
      this._bathyStatus = this._bathymetry.getStatus?.() || '';
    }
    if (this._mapOverlays) {
      const prev = this._mapOverlays.onStatusChange;
      this._mapOverlays.onStatusChange = (text) => {
        prev?.(text);
        this._contourStatus = text || '';
        this._render();
      };
    }
  }

  _build() {
    const box = buildMiniBox({
      idPrefix: 'statusbox',
      storagePrefix: 'godsEyeView.statusBox.',
      title: 'STATUS',
      ariaLabel: 'Status: which layers and engines are currently loading, fetching, or in error',
      defaultWidth: 264,
      defaultHeight: 340,
      minWidth: 220,
      maxWidth: 440,
      minHeight: 160,
      maxHeight: 640,
      // Below About (top edge, left:292px/top:16px, ~300px tall) — the
      // next open stretch of the same left-of-center column.
      anchor: { left: '292px', top: '332px' },
    });
    this._box = box;
    const body = box.body;

    // Section chrome reuses the shared `.mapovl-section`/`-section-title`
    // classes verbatim (same reasoning as aboutBox.js/bathymetryBox.js —
    // they're not scoped to a particular box's idPrefix); the row list
    // below is new, since nothing existing has this label+state-badge+
    // detail, color-coded-by-feed-state shape.
    const activeSection = el('div', 'mapovl-section');
    activeSection.appendChild(el('div', 'mapovl-section-title', 'ACTIVE NOW'));
    this._activeList = el('div', 'statusbox-list');
    activeSection.appendChild(this._activeList);
    body.appendChild(activeSection);

    const engineSection = el('div', 'mapovl-section');
    engineSection.appendChild(el('div', 'mapovl-section-title', 'ENGINES'));
    this._engineList = el('div', 'statusbox-list');
    engineSection.appendChild(this._engineList);
    body.appendChild(engineSection);

    const allSection = el('div', 'mapovl-section');
    allSection.appendChild(el('div', 'mapovl-section-title', 'ALL LAYERS'));
    this._allList = el('div', 'statusbox-list');
    allSection.appendChild(this._allList);
    body.appendChild(allSection);
  }

  _row(label, state, detail) {
    const row = el('div', `statusbox-row statusbox-row--${state}`);
    row.appendChild(el('span', 'statusbox-row-dot'));
    row.appendChild(el('span', 'statusbox-row-label', label));
    row.appendChild(el('span', 'statusbox-row-state', FEED_LABELS[state] || String(state).toUpperCase()));
    if (detail) row.appendChild(el('span', 'statusbox-row-detail', detail));
    return row;
  }

  _renderActiveAndAllLayers() {
    this._activeList.textContent = '';
    this._allList.textContent = '';
    if (!this._dataManager) {
      this._activeList.appendChild(el('div', 'statusbox-empty', 'No data manager connected.'));
      return;
    }

    const layers = this._dataManager.getAll();
    const summary = aggregateLayerLoading(layers);

    if (summary.active.length === 0) {
      this._activeList.appendChild(el('div', 'statusbox-empty', 'Nothing loading right now.'));
    } else {
      for (const record of summary.active) {
        this._activeList.appendChild(this._row(record.label, 'loading', record.disabling ? 'disabling...' : 'fetching...'));
      }
    }

    for (const layer of layers) {
      const state = layer.enabled ? layerFeedState(layer.stats) : 'off';
      const bits = [];
      const count = Number(layer.stats?.count);
      if (Number.isFinite(count) && count > 0) bits.push(`${count}`);
      const age = relativeAge(layer.stats?.lastUpdate);
      if (age) bits.push(age);
      const err = errorText(layer.stats?.error || layer.stats?.lastError);
      if (err) bits.push(err);
      this._allList.appendChild(this._row(layer.name || layer.id, state, bits.join(' · ')));
    }
  }

  _renderEngines() {
    this._engineList.textContent = '';
    if (this._bathymetry) {
      this._engineList.appendChild(el('div', 'statusbox-engine-row',
        `Bathymetry: ${this._bathyStatus || '—'}`));
    }
    if (this._mapOverlays) {
      this._engineList.appendChild(el('div', 'statusbox-engine-row',
        `Contours: ${this._contourStatus || '—'}`));
    }
    if (!this._engineList.children.length) {
      this._engineList.appendChild(el('div', 'statusbox-empty', 'No engines connected.'));
    }
  }

  _render() {
    this._renderActiveAndAllLayers();
    this._renderEngines();
  }

  destroy() {
    this._unsubscribe?.();
    if (this._pollTimer) window.clearInterval(this._pollTimer);
    this._box.destroy();
  }
}

/**
 * @param {Object} deps
 * @returns {StatusBox}
 */
export function initStatusBox(deps) {
  return new StatusBox(deps);
}
