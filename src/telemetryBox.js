import { buildMiniBox } from './miniBox.js';
import { layerFeedState } from './data/manager.js';
import { getRenderGovernorDiagnostics } from './renderGovernor.js';

/**
 * @file "Telemetry" mini-box — the retired STATUS box's replacement.
 *
 * STATUS answered one question ("what's loading right now?") in prose. This
 * box answers "what is the machine actually doing?" with the raw numbers the
 * app already keeps, split into one internal panel per area of concern:
 *
 * - **RENDER** — the idle render governor's real mode and holds
 *   (`renderGovernor.js`), rendered frames per second counted off
 *   `scene.postRender` (so idle mode honestly reads 0), terrain tile
 *   activity, primitive/entity counts, camera pose, JS heap where the
 *   browser exposes it.
 * - **FEEDS** — every registered layer's own `getStats()` dumped as raw
 *   `key=value` scalars rather than summarised into one adjective, plus
 *   the manager's lifecycle state (which is what distinguishes a layer
 *   that is genuinely fetching from one whose stats have gone stale).
 * - **COMPUTE** — the contour engine's phase/span/settings via
 *   `getTelemetry()` and the bathymetry engine's status line.
 *
 * Sources are the same ones STATUS used (`DataLayerManager.getAll()`, the
 * engines' `onStatusChange` slots) — nothing here re-derives state a second
 * way, and the engine callbacks are still chained, not replaced, so
 * `bathymetryBox.js`/`mapOverlayControls.js` keep their own status lines.
 *
 * @module telemetryBox
 */

/** Rows are text-only, so a 1s repaint is cheap and keeps ages/counters honest between manager events. */
const POLL_MS = 1000;

/** Frame timestamps older than this drop out of the fps average. */
const FPS_WINDOW_MS = 2000;

/** Stats keys that are noise in a raw dump: either restated in the row's own label, or an object/blob. */
const SKIP_STAT_KEYS = new Set([
  'count', 'lastUpdate', 'loading', 'error', 'lastError', 'managerRefreshError',
  'loadingLabel', 'phaseLabel', 'trafficTiming', 'flowBuckets', 'jamViz',
]);

const MAX_SCALARS_PER_LAYER = 8;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * Rendered frames per second over the trailing window.
 * @param {number[]} timestamps Frame times, oldest first.
 * @param {number} nowMs
 * @param {number} [windowMs]
 * @returns {number} Frames per second, 0 when nothing rendered in the window.
 */
export function fpsFromFrameTimes(timestamps, nowMs, windowMs = FPS_WINDOW_MS) {
  const recent = timestamps.filter((t) => nowMs - t <= windowMs);
  if (recent.length < 2) return 0;
  const span = nowMs - recent[0];
  if (span <= 0) return 0;
  return Math.round(((recent.length - 1) / span) * 1000);
}

/** Compact age string for a millisecond epoch, '' when there is no timestamp. */
export function relativeAge(ms, nowMs = Date.now()) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  const deltaS = Math.max(0, (nowMs - n) / 1000);
  if (deltaS < 1) return 'now';
  if (deltaS < 60) return `${Math.round(deltaS)}s`;
  if (deltaS < 3600) return `${Math.round(deltaS / 60)}m`;
  return `${Math.round(deltaS / 3600)}h`;
}

function formatValue(value) {
  if (value === true) return 'y';
  if (value === false) return 'n';
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
  const text = String(value);
  return text.length > 18 ? `${text.slice(0, 17)}…` : text;
}

/**
 * Flatten a layer's `getStats()` into raw `key=value` telemetry, dropping
 * anything already carried by the row's own label plus every non-scalar.
 * @param {Object} stats
 * @param {number} [limit]
 * @returns {string[]}
 */
export function statScalars(stats = {}, limit = MAX_SCALARS_PER_LAYER) {
  const out = [];
  for (const [key, value] of Object.entries(stats || {})) {
    if (SKIP_STAT_KEYS.has(key)) continue;
    if (value == null || value === '') continue;
    if (typeof value === 'object') continue;
    out.push(`${key}=${formatValue(value)}`);
    if (out.length >= limit) break;
  }
  return out;
}

function errorText(err) {
  if (!err) return '';
  const text = typeof err === 'string' ? err : (err.message || String(err));
  return text.length > 48 ? `${text.slice(0, 45)}…` : text;
}

export class TelemetryBox {
  /**
   * @param {Object} deps
   * @param {Object} [deps.viewer] Cesium viewer, for render/camera telemetry.
   * @param {import('./data/manager.js').DataLayerManager} [deps.dataManager]
   * @param {import('./data/bathymetry.js').BathymetryEngine} [deps.bathymetry]
   * @param {import('./data/mapOverlays.js').MapOverlaysEngine} [deps.mapOverlays]
   */
  constructor({ viewer, dataManager, bathymetry, mapOverlays } = {}) {
    this._viewer = viewer || null;
    this._dataManager = dataManager || null;
    this._bathymetry = bathymetry || null;
    this._mapOverlays = mapOverlays || null;
    this._bathyStatus = '';
    this._contourStatus = '';
    this._frameTimes = [];
    this._build();
    this._wireEngineStatus();
    this._wireFrameCounter();
    this._unsubscribe = this._dataManager
      ? this._dataManager.subscribe(() => this._render())
      : null;
    this._pollTimer = window.setInterval(() => this._render(), POLL_MS);
    this._render();
  }

  /**
   * Chains onto whatever already owns each engine's single `onStatusChange`
   * slot instead of reassigning it — one callback reference, not a
   * subscriber list, so replacing it would silently kill the engine's own
   * box. Both arguments are forwarded: `mapOverlays` carries `(text, phase)`
   * and `mapOverlayControls.js`'s traffic light depends on the second.
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
      this._mapOverlays.onStatusChange = (text, phase) => {
        prev?.(text, phase);
        this._contourStatus = text || '';
        this._render();
      };
    }
  }

  /**
   * Counts frames Cesium actually renders — the only honest fps under the
   * idle render governor, where requestAnimationFrame keeps ticking at
   * 60Hz while the scene draws nothing.
   */
  _wireFrameCounter() {
    const scene = this._viewer?.scene;
    if (!scene?.postRender?.addEventListener) return;
    this._onPostRender = () => {
      const now = Date.now();
      this._frameTimes.push(now);
      while (this._frameTimes.length && now - this._frameTimes[0] > FPS_WINDOW_MS) {
        this._frameTimes.shift();
      }
    };
    scene.postRender.addEventListener(this._onPostRender);
  }

  _build() {
    const box = buildMiniBox({
      idPrefix: 'telemetry',
      storagePrefix: 'godsEyeView.telemetryBox.',
      title: 'TELEMETRY',
      ariaLabel: 'Telemetry: raw render, feed and compute counters',
      defaultWidth: 288,
      defaultHeight: 300,
      minWidth: 220,
      maxWidth: 480,
      minHeight: 140,
      maxHeight: 720,
      anchor: { left: '292px', top: '332px' },
    });
    this._box = box;

    this._renderList = this._area('RENDER / HUD');
    this._feedList = this._area('LAYER FEEDS');
    this._computeList = this._area('COMPUTE');
  }

  /** One internal status box: its own framed area with a title and a row list. */
  _area(title) {
    const area = el('div', 'telemetry-area');
    area.appendChild(el('div', 'telemetry-area-title', title));
    const list = el('div', 'telemetry-list');
    area.appendChild(list);
    this._box.body.appendChild(area);
    return list;
  }

  _row(label, value, state) {
    const row = el('div', state ? `telemetry-row telemetry-row--${state}` : 'telemetry-row');
    row.appendChild(el('span', 'telemetry-row-label', label));
    row.appendChild(el('span', 'telemetry-row-value', value));
    return row;
  }

  _renderRenderArea() {
    const list = this._renderList;
    list.textContent = '';
    const gov = getRenderGovernorDiagnostics();
    const fps = fpsFromFrameTimes(this._frameTimes, Date.now());
    list.appendChild(this._row('fps', `${fps}`, fps === 0 ? 'off' : null));
    list.appendChild(this._row('render', gov.mode, gov.mode === 'continuous' ? 'busy' : null));
    list.appendChild(this._row('holds', gov.holds.length ? gov.holds.join(' ') : '—'));
    const lastRequest = gov.recentRequests[gov.recentRequests.length - 1];
    list.appendChild(this._row(
      'last req',
      lastRequest ? `${lastRequest.reason} ${relativeAge(lastRequest.at)}` : '—',
    ));

    const scene = this._viewer?.scene;
    if (!scene) {
      list.appendChild(this._row('scene', 'not connected', 'off'));
      return;
    }
    const tilesLoaded = scene.globe?.tilesLoaded;
    if (typeof tilesLoaded === 'boolean') {
      list.appendChild(this._row('terrain', tilesLoaded ? 'loaded' : 'streaming', tilesLoaded ? null : 'busy'));
    }
    if (Number.isFinite(scene.primitives?.length)) {
      list.appendChild(this._row('primitives', `${scene.primitives.length}`));
    }
    const entities = this._viewer?.entities?.values?.length;
    const dataSources = this._viewer?.dataSources?.length;
    if (Number.isFinite(entities)) {
      list.appendChild(this._row('entities', Number.isFinite(dataSources)
        ? `${entities} · ${dataSources} src`
        : `${entities}`));
    }

    const camera = this._viewer?.camera;
    const carto = camera?.positionCartographic;
    if (carto) {
      const deg = (rad) => ((rad * 180) / Math.PI).toFixed(3);
      list.appendChild(this._row('cam pos', `${deg(carto.latitude)} ${deg(carto.longitude)}`));
      list.appendChild(this._row('cam alt', `${Math.round(carto.height)} m`));
    }
    if (Number.isFinite(camera?.heading)) {
      const deg = (rad) => Math.round((rad * 180) / Math.PI);
      list.appendChild(this._row('cam hdg/pit', `${deg(camera.heading)}° / ${deg(camera.pitch)}°`));
    }

    const heap = performance?.memory?.usedJSHeapSize;
    if (Number.isFinite(heap)) {
      list.appendChild(this._row('js heap', `${Math.round(heap / 1048576)} MB`));
    }
  }

  _renderFeedArea() {
    const list = this._feedList;
    list.textContent = '';
    if (!this._dataManager) {
      list.appendChild(this._row('manager', 'not connected', 'off'));
      return;
    }
    const layers = this._dataManager.getAll();
    const off = [];
    for (const layer of layers) {
      if (!layer.enabled && layer.lifecycleState !== 'enabling') {
        off.push(layer.id);
        continue;
      }
      const stats = layer.stats || {};
      const state = layerFeedState(stats);
      const bits = [`${Number(stats.count) || 0}`];
      const age = relativeAge(stats.lastUpdate);
      if (age) bits.push(age);
      bits.push(state);
      if (layer.lifecycleState !== 'enabled') bits.push(layer.lifecycleState);
      const err = errorText(stats.error || stats.lastError || stats.managerRefreshError);
      if (err) bits.push(err);
      bits.push(...statScalars(stats));
      list.appendChild(this._row(layer.name || layer.id, bits.join(' '), state));
    }
    list.appendChild(this._row('off', off.length ? `${off.length} layers` : 'none', 'off'));
  }

  _renderComputeArea() {
    const list = this._computeList;
    list.textContent = '';
    const contours = this._mapOverlays?.getTelemetry?.();
    if (contours) {
      list.appendChild(this._row('contours', contours.contoursEnabled ? contours.phase : 'off',
        contours.contoursEnabled ? null : 'off'));
      const span = Number.isFinite(contours.viewSpanDeg) ? contours.viewSpanDeg.toFixed(2) : '—';
      list.appendChild(this._row('view span', `${span}° / ${contours.maxViewSpanDeg}° max`));
      list.appendChild(this._row('drawn', contours.stale ? 'stale' : 'current', contours.stale ? 'busy' : null));
      list.appendChild(this._row('spacing', `${contours.majorSpacingM} m${contours.minorEnabled ? ` · ${contours.minorSpacingM} m minor` : ''}`));
      list.appendChild(this._row('status', this._contourStatus || '—'));
    }
    if (this._bathymetry) {
      list.appendChild(this._row('bathymetry', this._bathyStatus || '—'));
    }
    if (!list.children.length) {
      list.appendChild(this._row('engines', 'not connected', 'off'));
    }
  }

  _render() {
    this._renderRenderArea();
    this._renderFeedArea();
    this._renderComputeArea();
  }

  destroy() {
    this._unsubscribe?.();
    if (this._pollTimer) window.clearInterval(this._pollTimer);
    if (this._onPostRender) {
      this._viewer?.scene?.postRender?.removeEventListener?.(this._onPostRender);
      this._onPostRender = null;
    }
    this._box.destroy();
  }
}

/**
 * @param {Object} deps
 * @returns {TelemetryBox}
 */
export function initTelemetryBox(deps) {
  return new TelemetryBox(deps);
}
