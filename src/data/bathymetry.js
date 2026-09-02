import * as Cesium from 'cesium';
import { getSharedCache } from './apiCache.js';
import { registerDynamicCredit, NOAA_BATHYMETRY_CREDIT, GEBCO_DEPTH_CREDIT } from './dataCredits.js';

/**
 * @file Cesium-facing engine behind the "Bathymetry" control box: undersea
 * depth contour lines (isobaths) and a grid of point depth-marker readouts,
 * both drawn over the currently-visible ocean area and refreshed as the
 * camera moves. See `src/bathymetryBox.js` for the control box.
 *
 * Two free, no-API-key data sources:
 *  - Contour lines: NOAA's public "OceanReports/BathymetricContours" ArcGIS
 *    REST layer — pre-drawn global isobath polylines (standard nautical
 *    depth bands, -10 m to -10,500 m), queried by the current view's
 *    bounding box and returned as GeoJSON. No key, no registration.
 *  - Depth markers: Open Topo Data's public REST API
 *    (api.opentopodata.org), querying the GEBCO2020 global bathymetry/
 *    elevation grid at a handful of points across the view. No key either,
 *    but it IS rate-limited (1 request/second, 100 locations/request,
 *    1000 requests/day on the free public instance) — every lookup is
 *    cached durably (see `data/apiCache.js`) so re-visiting an area never
 *    re-queries it, and each recompute cycle costs exactly one request.
 *
 * Both are drawn flat at sea level (height 0) with depth-test disabled,
 * like a chart overlay laid on top of the water rather than literal 3D
 * geometry buried under the rendered ocean surface — the Google
 * Photorealistic 3D Tileset's water surface would otherwise occlude
 * anything placed at its true (negative) depth.
 *
 * @module data/bathymetry
 */

const STORAGE_KEY = 'godsEyeView.bathymetry.state';
const RECOMPUTE_DEBOUNCE_MS = 900; // gentler than the land-contour engine's — these hit real network APIs, one of them rate-limited.
const MAX_CONTOUR_VIEW_SPAN_DEG = 25; // above this the bbox query would return a very large/slow feature set for little visual payoff.
const MAX_CONTOUR_FEATURES = 2500; // hard safety cap on rendered segments.
const MARKER_GRID_COLS = 5;
const MARKER_GRID_ROWS = 4;
const MARKER_CACHE_STORE = 'bathyDepth';
const MARKER_CACHE_PRECISION = 2; // decimal degrees (~1.1km) — cache key rounding.
const NOAA_CONTOUR_URL = 'https://coast.noaa.gov/arcgis/rest/services/OceanReports/BathymetricContours/MapServer/0/query';
const OPENTOPODATA_URL = 'https://api.opentopodata.org/v1/gebco2020';

const CONTOUR_COLOR = Cesium.Color.fromCssColorString('#3fa9ff');
const MARKER_TEXT_COLOR = Cesium.Color.fromCssColorString('#bfe6ff');

export const DEFAULT_STATE = Object.freeze({
  contoursEnabled: false,
  markersEnabled: false,
});

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_STATE };
    return { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function saveState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch { /* storage unavailable */ }
}

function markerCacheKey(lon, lat) {
  return `${lat.toFixed(MARKER_CACHE_PRECISION)},${lon.toFixed(MARKER_CACHE_PRECISION)}`;
}

function formatDepth(meters) {
  const rounded = Math.round(Math.abs(meters));
  return `${rounded.toLocaleString('en-US')} m`;
}

export class BathymetryEngine {
  constructor(viewer) {
    this.viewer = viewer;
    this.state = loadState();

    this._contourDataSource = new Cesium.CustomDataSource('bathymetryContours');
    this._markerDataSource = new Cesium.CustomDataSource('bathymetryMarkers');
    this.viewer.dataSources.add(this._contourDataSource);
    this.viewer.dataSources.add(this._markerDataSource);

    this._recomputeTimer = null;
    this._contourToken = 0;
    this._markerToken = 0;
    this._lastMarkerFetchAt = 0;
    this._cache = getSharedCache();

    // Contours and markers fetch independently (and often concurrently, when
    // both toggles are on) — each keeps its own status line so one doesn't
    // clobber the other; the UI callback receives them already joined.
    this._contourStatusText = '';
    this._markerStatusText = '';
    /** @type {?Function} UI callback: (statusText) => void */
    this.onStatusChange = null;

    this._onCameraMoveEnd = this._onCameraMoveEnd.bind(this);
    this.viewer.camera.moveEnd.addEventListener(this._onCameraMoveEnd);

    // A prior session may have left either toggle on (state is persisted) —
    // register their credits now rather than only from the setters, which
    // this restore path bypasses.
    if (this.state.contoursEnabled) registerDynamicCredit(this.viewer, NOAA_BATHYMETRY_CREDIT);
    if (this.state.markersEnabled) registerDynamicCredit(this.viewer, GEBCO_DEPTH_CREDIT);
    if (this.state.contoursEnabled || this.state.markersEnabled) this._scheduleRecompute();
  }

  _persist() {
    saveState(this.state);
  }

  _setContourStatus(text) {
    this._contourStatusText = text;
    this._emitStatus();
  }

  _setMarkerStatus(text) {
    this._markerStatusText = text;
    this._emitStatus();
  }

  _emitStatus() {
    const parts = [this._contourStatusText, this._markerStatusText].filter(Boolean);
    this._status = parts.join(' · ');
    this.onStatusChange?.(this._status);
  }

  getStatus() {
    return this._status;
  }

  // ── toggles ──────────────────────────────────────────────────────────
  setContoursEnabled(enabled) {
    this.state.contoursEnabled = Boolean(enabled);
    this._persist();
    if (this.state.contoursEnabled) {
      registerDynamicCredit(this.viewer, NOAA_BATHYMETRY_CREDIT);
      this._scheduleRecompute();
    } else {
      this._contourToken += 1;
      this._contourDataSource.entities.removeAll();
      this._setContourStatus('');
    }
  }

  setMarkersEnabled(enabled) {
    this.state.markersEnabled = Boolean(enabled);
    this._persist();
    if (this.state.markersEnabled) {
      registerDynamicCredit(this.viewer, GEBCO_DEPTH_CREDIT);
      this._scheduleRecompute();
    } else {
      this._markerToken += 1;
      this._markerDataSource.entities.removeAll();
      this._setMarkerStatus('');
    }
  }

  _onCameraMoveEnd() {
    if (this.state.contoursEnabled || this.state.markersEnabled) this._scheduleRecompute();
  }

  _scheduleRecompute() {
    if (this._recomputeTimer) clearTimeout(this._recomputeTimer);
    this._recomputeTimer = setTimeout(() => {
      if (this.state.contoursEnabled) this._recomputeContours();
      if (this.state.markersEnabled) this._recomputeMarkers();
    }, RECOMPUTE_DEBOUNCE_MS);
  }

  // ── contour lines (NOAA isobaths) ───────────────────────────────────
  async _recomputeContours() {
    const token = ++this._contourToken;
    const rect = this.viewer.camera.computeViewRectangle();
    if (!rect) { this._setContourStatus('Camera view unavailable.'); return; }

    const spanDeg = Cesium.Math.toDegrees(Math.max(rect.width, rect.height));
    if (spanDeg > MAX_CONTOUR_VIEW_SPAN_DEG) {
      this._contourDataSource.entities.removeAll();
      this._setContourStatus(`Zoom in for depth contours (view is ${spanDeg.toFixed(1)}° wide, need < ${MAX_CONTOUR_VIEW_SPAN_DEG}°).`);
      return;
    }

    const west = Cesium.Math.toDegrees(rect.west);
    const south = Cesium.Math.toDegrees(rect.south);
    const east = Cesium.Math.toDegrees(rect.east);
    const north = Cesium.Math.toDegrees(rect.north);

    const params = new URLSearchParams({
      f: 'geojson',
      geometry: `${west},${south},${east},${north}`,
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326',
      outSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: 'Contour',
      returnGeometry: 'true',
    });

    this._setContourStatus('Loading depth contours…');
    let data;
    try {
      const res = await fetch(`${NOAA_CONTOUR_URL}?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
    } catch (err) {
      if (token !== this._contourToken) return;
      this._setContourStatus(`Depth contours unavailable (${err.message || 'network error'}).`);
      return;
    }
    if (token !== this._contourToken) return; // superseded by a newer view

    const features = Array.isArray(data?.features) ? data.features : [];
    this._contourDataSource.entities.removeAll();
    let segmentCount = 0;
    for (const feature of features) {
      if (segmentCount >= MAX_CONTOUR_FEATURES) break;
      const depth = Number(feature?.properties?.Contour);
      if (!Number.isFinite(depth)) continue;
      const geom = feature?.geometry;
      if (!geom) continue;
      const lines = geom.type === 'MultiLineString' ? geom.coordinates
        : geom.type === 'LineString' ? [geom.coordinates]
        : [];
      const isMajor = Math.abs(depth) % 1000 === 0;
      for (const line of lines) {
        if (!Array.isArray(line) || line.length < 2) continue;
        // Take only [lon, lat] per vertex — a defensive normalize in case a
        // vertex carries a third (Z) coordinate, which would otherwise
        // misalign a raw `.flat()` against `fromDegreesArray`'s expected
        // flat lon/lat pairing.
        const flatLonLat = line.flatMap((pt) => (Array.isArray(pt) && pt.length >= 2 ? [pt[0], pt[1]] : []));
        if (flatLonLat.length < 4) continue;
        const positions = Cesium.Cartesian3.fromDegreesArray(flatLonLat);
        this._contourDataSource.entities.add({
          polyline: {
            positions,
            width: isMajor ? 2.5 : 1.25,
            material: CONTOUR_COLOR.withAlpha(isMajor ? 0.9 : 0.55),
            clampToGround: false,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
        segmentCount += 1;
        if (segmentCount >= MAX_CONTOUR_FEATURES) break;
      }
    }

    if (token !== this._contourToken) return;
    this._setContourStatus(segmentCount > 0
      ? `${segmentCount} isobath segment${segmentCount === 1 ? '' : 's'} · NOAA`
      : 'No charted depth contours in this view (likely over land).');
  }

  // ── depth markers (GEBCO via Open Topo Data) ────────────────────────
  async _recomputeMarkers() {
    const token = ++this._markerToken;
    const rect = this.viewer.camera.computeViewRectangle();
    if (!rect) return;

    const west = Cesium.Math.toDegrees(rect.west);
    const south = Cesium.Math.toDegrees(rect.south);
    const east = Cesium.Math.toDegrees(rect.east);
    const north = Cesium.Math.toDegrees(rect.north);

    const points = [];
    for (let r = 0; r < MARKER_GRID_ROWS; r += 1) {
      const lat = south + ((r + 0.5) / MARKER_GRID_ROWS) * (north - south);
      for (let c = 0; c < MARKER_GRID_COLS; c += 1) {
        const lon = west + ((c + 0.5) / MARKER_GRID_COLS) * (east - west);
        points.push({ lon, lat });
      }
    }

    // Serve whatever's already cached immediately; only network-fetch the misses.
    const resolved = new Map(); // key -> {lon, lat, depth|null}
    const misses = [];
    for (const p of points) {
      const key = markerCacheKey(p.lon, p.lat);
      const cached = await this._cache.get(MARKER_CACHE_STORE, key);
      if (token !== this._markerToken) return;
      if (cached !== undefined) resolved.set(key, { ...p, depth: cached });
      else misses.push({ ...p, key });
    }

    if (misses.length) {
      // Respect the free tier's 1 request/second ceiling — wait out
      // whatever's left of the last call's 1.1s cooldown before firing.
      const waitMs = Math.max(0, 1100 - (Date.now() - this._lastMarkerFetchAt));
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      if (token !== this._markerToken) return;
      this._lastMarkerFetchAt = Date.now();

      const locations = misses.map((p) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`).join('|');
      try {
        const res = await fetch(`${OPENTOPODATA_URL}?locations=${encodeURIComponent(locations)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const results = Array.isArray(data?.results) ? data.results : [];
        results.forEach((r, i) => {
          const miss = misses[i];
          if (!miss) return;
          const depth = Number.isFinite(r?.elevation) ? r.elevation : null;
          resolved.set(miss.key, { ...miss, depth });
          this._cache.put(MARKER_CACHE_STORE, miss.key, depth);
        });
      } catch (err) {
        if (token !== this._markerToken) return;
        this._setMarkerStatus(`Depth markers unavailable (${err.message || 'network error'}).`);
        // Still render whatever we already had cached, below.
      }
    }

    if (token !== this._markerToken) return;
    this._markerDataSource.entities.removeAll();
    let shown = 0;
    for (const { lon, lat, depth } of resolved.values()) {
      if (depth == null || depth >= 0) continue; // land, or lookup failed
      this._markerDataSource.entities.add({
        position: Cesium.Cartesian3.fromDegrees(lon, lat, 0),
        point: {
          pixelSize: 4,
          color: MARKER_TEXT_COLOR,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: formatDepth(depth),
          font: '600 12px monospace',
          fillColor: MARKER_TEXT_COLOR,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -12),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      shown += 1;
    }
    this._setMarkerStatus(shown > 0
      ? `${shown} depth marker${shown === 1 ? '' : 's'} · GEBCO/opentopodata.org`
      : 'No ocean depth points in this view (likely over land).');
  }

  destroy() {
    this.viewer.camera.moveEnd.removeEventListener(this._onCameraMoveEnd);
    if (this._recomputeTimer) clearTimeout(this._recomputeTimer);
    this.viewer.dataSources.remove(this._contourDataSource, true);
    this.viewer.dataSources.remove(this._markerDataSource, true);
  }
}

/** @param {Cesium.Viewer} viewer @returns {BathymetryEngine} */
export function initBathymetry(viewer) {
  return new BathymetryEngine(viewer);
}
