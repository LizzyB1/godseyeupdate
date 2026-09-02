import * as Cesium from 'cesium';
import { marchingSquaresSegments, gridToLonLat } from './contourMath.js';
import { formatLatLonDMS, formatLatLonDecimal, googleMapsLink, formatHeight } from './coordFormat.js';
import { resolveApiKey } from '../apiKeys.js';

/**
 * @file Cesium-facing engine behind the "Map Overlays" control box: elevation
 * contour lines, vertical (height-relief) exaggeration, a lat/lon graticule,
 * and a click-to-place coordinate cursor with reverse geocoding + a
 * viewport-screenshot capture. Kept as one module since all of it shares the
 * same terrain-height plumbing and the same control box.
 *
 * The globe mesh itself is hidden in this app (`viewer.scene.globe.show =
 * false` — visuals come from the Google Photorealistic 3D Tileset instead,
 * see main.js), and no terrain provider is otherwise configured, so real
 * elevation values for contours/height come from a dedicated Cesium World
 * Terrain provider created here purely for height *queries*
 * (`Cesium.sampleTerrainMostDetailed`) — it is never assigned to
 * `viewer.terrainProvider` and never rendered, so it can't affect the
 * existing visual pipeline at all.
 *
 * Contour lines don't need ground-clamping/draping tricks: each contour
 * level IS a height, so its polyline vertices are simply placed at that
 * exact height above the ellipsoid (`Cartesian3.fromDegrees(lon, lat,
 * level)`) at the (lon, lat) marching-squares found for that level — no
 * `GroundPolylinePrimitive`/3D-tile classification needed.
 *
 * @module data/mapOverlays
 */

const STORAGE_KEY = 'godsEyeView.mapOverlays.state';
const RECOMPUTE_DEBOUNCE_MS = 550;
const CONTOUR_GRID_COLS = 42;
const CONTOUR_GRID_ROWS = 30;
const MAX_CONTOUR_VIEW_SPAN_DEG = 1.5; // ~165km — above this, contours are too coarse to be meaningful
const MAX_CONTOUR_LEVELS = 60; // hard cap so pathological relief can't spawn thousands of polylines
const MAX_GRID_LINES_PER_AXIS = 60;

export const DEFAULT_STATE = Object.freeze({
  contoursEnabled: false,
  contourMajorSpacing: 50,
  contourMinorEnabled: false,
  contourMinorSpacing: 10,
  verticalExaggeration: 1,
  gridEnabled: false,
  gridSpacingDeg: 1,
  gridColor: '#00d4ff',
  gridMinorColor: '#3a5a66',
});

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_STATE };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_STATE, ...parsed };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function saveState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch { /* storage unavailable */ }
}

export class MapOverlaysEngine {
  constructor(viewer) {
    this.viewer = viewer;
    this.state = loadState();

    /** @type {?Promise<Cesium.CesiumTerrainProvider>} */
    this._terrainProviderPromise = null;
    this._terrainStatus = 'idle'; // idle | loading | ready | unavailable

    this._contourPrimitive = null;
    this._gridPrimitive = null;
    this._recomputeTimer = null;
    this._contourStatus = ''; // status line shown in the UI
    this._computeToken = 0;

    this._cursorActive = false;
    this._cursorEntity = null;
    this._cursorHandler = null;
    this._cursorData = null; // last resolved {lat, lon, height, address}
    this._geocodeToken = 0;

    /** @type {?Function} UI callback: (statusText) => void */
    this.onStatusChange = null;
    /** @type {?Function} UI callback: (cursorData) => void */
    this.onCursorChange = null;

    this._onCameraMoveEnd = this._onCameraMoveEnd.bind(this);
    this.viewer.camera.moveEnd.addEventListener(this._onCameraMoveEnd);

    this._applyVerticalExaggeration();
    if (this.state.contoursEnabled) this._scheduleRecompute();
    if (this.state.gridEnabled) this._recomputeGrid();
  }

  // ── persistence ──────────────────────────────────────────────────────
  _persist() {
    saveState(this.state);
  }

  _setStatus(text) {
    this._contourStatus = text;
    this.onStatusChange?.(text);
  }

  // ── terrain provider (height queries only, never rendered) ─────────
  async _getTerrainProvider() {
    if (this._terrainProviderPromise) return this._terrainProviderPromise;
    this._terrainStatus = 'loading';
    this._terrainProviderPromise = Cesium.createWorldTerrainAsync({ requestVertexNormals: false, requestWaterMask: false })
      .then((provider) => {
        this._terrainStatus = 'ready';
        return provider;
      })
      .catch((err) => {
        this._terrainStatus = 'unavailable';
        this._terrainProviderPromise = null;
        throw err;
      });
    return this._terrainProviderPromise;
  }

  // ── vertical exaggeration ───────────────────────────────────────────
  setVerticalExaggeration(value) {
    const clamped = Cesium.Math.clamp(Number(value) || 1, 1, 10);
    this.state.verticalExaggeration = clamped;
    this._applyVerticalExaggeration();
    this._persist();
  }

  _applyVerticalExaggeration() {
    this.viewer.scene.verticalExaggeration = this.state.verticalExaggeration;
    this.viewer.scene.verticalExaggerationRelativeHeight = 0;
  }

  // ── contours ─────────────────────────────────────────────────────────
  setContoursEnabled(enabled) {
    this.state.contoursEnabled = Boolean(enabled);
    this._persist();
    if (this.state.contoursEnabled) this._scheduleRecompute();
    else this._clearContours();
  }

  setContourMajorSpacing(meters) {
    const clamped = Cesium.Math.clamp(Number(meters) || 50, 5, 1000);
    this.state.contourMajorSpacing = clamped;
    this._persist();
    if (this.state.contoursEnabled) this._scheduleRecompute();
  }

  setContourMinorEnabled(enabled) {
    this.state.contourMinorEnabled = Boolean(enabled);
    this._persist();
    if (this.state.contoursEnabled) this._scheduleRecompute();
  }

  setContourMinorSpacing(meters) {
    const clamped = Cesium.Math.clamp(Number(meters) || 10, 1, 500);
    this.state.contourMinorSpacing = clamped;
    this._persist();
    if (this.state.contoursEnabled && this.state.contourMinorEnabled) this._scheduleRecompute();
  }

  _clearContours() {
    if (this._contourPrimitive) {
      this.viewer.scene.primitives.remove(this._contourPrimitive);
      this._contourPrimitive = null;
    }
    this._setStatus('');
  }

  _scheduleRecompute() {
    if (this._recomputeTimer) clearTimeout(this._recomputeTimer);
    this._recomputeTimer = setTimeout(() => this._recomputeContours(), RECOMPUTE_DEBOUNCE_MS);
  }

  async _recomputeContours() {
    if (!this.state.contoursEnabled) return;
    const token = ++this._computeToken;
    const rect = this.viewer.camera.computeViewRectangle();
    if (!rect) { this._setStatus('Camera view unavailable.'); return; }

    const spanDeg = Cesium.Math.toDegrees(Math.max(rect.width, rect.height));
    if (spanDeg > MAX_CONTOUR_VIEW_SPAN_DEG) {
      this._clearContours();
      this._setStatus(`Zoom in to compute contours (view is ${spanDeg.toFixed(1)}° wide, need < ${MAX_CONTOUR_VIEW_SPAN_DEG}°).`);
      return;
    }

    let terrainProvider;
    try {
      this._setStatus('Loading terrain data…');
      terrainProvider = await this._getTerrainProvider();
    } catch {
      this._setStatus('Terrain data unavailable — check the Cesium Ion Token in Settings.');
      return;
    }
    if (token !== this._computeToken) return; // superseded by a newer request

    const west = Cesium.Math.toDegrees(rect.west);
    const south = Cesium.Math.toDegrees(rect.south);
    const east = Cesium.Math.toDegrees(rect.east);
    const north = Cesium.Math.toDegrees(rect.north);

    const rows = CONTOUR_GRID_ROWS;
    const cols = CONTOUR_GRID_COLS;
    const positions = [];
    for (let r = 0; r < rows; r += 1) {
      const lat = north - (r / (rows - 1)) * (north - south);
      for (let c = 0; c < cols; c += 1) {
        const lon = west + (c / (cols - 1)) * (east - west);
        positions.push(Cesium.Cartographic.fromDegrees(lon, lat));
      }
    }

    this._setStatus('Sampling terrain heights…');
    let sampled;
    try {
      sampled = await Cesium.sampleTerrainMostDetailed(terrainProvider, positions);
    } catch {
      this._setStatus('Terrain sampling failed — try again after the view settles.');
      return;
    }
    if (token !== this._computeToken) return;

    const heights = sampled.map((c) => (Number.isFinite(c.height) ? c.height : NaN));
    const finite = heights.filter(Number.isFinite);
    if (!finite.length) {
      this._clearContours();
      this._setStatus('No terrain height data at this location.');
      return;
    }
    const minH = Math.min(...finite);
    const maxH = Math.max(...finite);

    const levels = [];
    const major = this.state.contourMajorSpacing;
    const firstMajor = Math.ceil(minH / major) * major;
    for (let lvl = firstMajor; lvl <= maxH && levels.length < MAX_CONTOUR_LEVELS; lvl += major) {
      levels.push({ height: lvl, major: true });
    }
    if (this.state.contourMinorEnabled) {
      const minor = this.state.contourMinorSpacing;
      const firstMinor = Math.ceil(minH / minor) * minor;
      for (let lvl = firstMinor; lvl <= maxH && levels.length < MAX_CONTOUR_LEVELS; lvl += minor) {
        if (Math.abs(lvl % major) < 1e-6) continue; // already a major level
        levels.push({ height: lvl, major: false });
      }
    }

    const majorColor = Cesium.Color.fromCssColorString('#ffd60a').withAlpha(0.85);
    const minorColor = Cesium.Color.fromCssColorString('#ffd60a').withAlpha(0.35);

    const newPrimitive = new Cesium.PolylineCollection();
    let segmentCount = 0;
    for (const { height, major: isMajor } of levels) {
      const segs = marchingSquaresSegments(heights, rows, cols, height);
      for (const [a, b] of segs) {
        const aLL = gridToLonLat(a.x, a.y, rows, cols, west, south, east, north);
        const bLL = gridToLonLat(b.x, b.y, rows, cols, west, south, east, north);
        newPrimitive.add({
          positions: [
            Cesium.Cartesian3.fromDegrees(aLL.lon, aLL.lat, height),
            Cesium.Cartesian3.fromDegrees(bLL.lon, bLL.lat, height),
          ],
          width: isMajor ? 2 : 1,
          material: Cesium.Material.fromType('Color', { color: isMajor ? majorColor : minorColor }),
        });
        segmentCount += 1;
      }
    }

    if (token !== this._computeToken) { newPrimitive.destroy(); return; }
    this._clearContours();
    if (segmentCount > 0) {
      this._contourPrimitive = this.viewer.scene.primitives.add(newPrimitive);
      this._setStatus(`${levels.length} level${levels.length === 1 ? '' : 's'}, ${segmentCount} segments (${Math.round(minH)}–${Math.round(maxH)} m relief).`);
    } else {
      newPrimitive.destroy();
      this._setStatus(`Flat here — ${Math.round(minH)}–${Math.round(maxH)} m relief, no contour crossing.`);
    }
  }

  // ── lat/lon grid ─────────────────────────────────────────────────────
  setGridEnabled(enabled) {
    this.state.gridEnabled = Boolean(enabled);
    this._persist();
    if (this.state.gridEnabled) this._recomputeGrid();
    else this._clearGrid();
  }

  setGridSpacingDeg(deg) {
    const clamped = Cesium.Math.clamp(Number(deg) || 1, 0.001, 45);
    this.state.gridSpacingDeg = clamped;
    this._persist();
    if (this.state.gridEnabled) this._recomputeGrid();
  }

  setGridColor(hex) {
    this.state.gridColor = hex || DEFAULT_STATE.gridColor;
    this._persist();
    if (this.state.gridEnabled) this._recomputeGrid();
  }

  _clearGrid() {
    if (this._gridPrimitive) {
      this.viewer.scene.primitives.remove(this._gridPrimitive);
      this._gridPrimitive = null;
    }
  }

  _recomputeGrid() {
    if (!this.state.gridEnabled) return;
    const rect = this.viewer.camera.computeViewRectangle();
    if (!rect) return;
    const west = Cesium.Math.toDegrees(rect.west);
    const south = Cesium.Math.clamp(Cesium.Math.toDegrees(rect.south), -89.9, 89.9);
    const east = Cesium.Math.toDegrees(rect.east);
    const north = Cesium.Math.clamp(Cesium.Math.toDegrees(rect.north), -89.9, 89.9);
    const spacing = this.state.gridSpacingDeg;

    const meridians = [];
    let start = Math.ceil(west / spacing) * spacing;
    for (let lon = start; lon <= east; lon += spacing) meridians.push(lon);
    const parallels = [];
    start = Math.ceil(south / spacing) * spacing;
    for (let lat = start; lat <= north; lat += spacing) parallels.push(lat);

    const thin = (arr, cap) => {
      if (arr.length <= cap) return arr;
      const step = Math.ceil(arr.length / cap);
      return arr.filter((_, i) => i % step === 0);
    };
    const thinnedMeridians = thin(meridians, MAX_GRID_LINES_PER_AXIS);
    const thinnedParallels = thin(parallels, MAX_GRID_LINES_PER_AXIS);

    const color = Cesium.Color.fromCssColorString(this.state.gridColor).withAlpha(0.55);
    const newPrimitive = new Cesium.PolylineCollection();
    for (const lon of thinnedMeridians) {
      newPrimitive.add({
        positions: [
          Cesium.Cartesian3.fromDegrees(lon, south, 0),
          Cesium.Cartesian3.fromDegrees(lon, north, 0),
        ],
        width: 1,
        material: Cesium.Material.fromType('Color', { color }),
      });
    }
    for (const lat of thinnedParallels) {
      newPrimitive.add({
        positions: [
          Cesium.Cartesian3.fromDegrees(west, lat, 0),
          Cesium.Cartesian3.fromDegrees(east, lat, 0),
        ],
        width: 1,
        material: Cesium.Material.fromType('Color', { color }),
      });
    }

    this._clearGrid();
    this._gridPrimitive = this.viewer.scene.primitives.add(newPrimitive);
  }

  _onCameraMoveEnd() {
    if (this.state.contoursEnabled) this._scheduleRecompute();
    if (this.state.gridEnabled) this._recomputeGrid();
  }

  // ── cursor / pin tool ────────────────────────────────────────────────
  setCursorActive(active) {
    this._cursorActive = Boolean(active);
    if (this._cursorActive) this._installCursorHandler();
    else this._uninstallCursorHandler();
  }

  isCursorActive() {
    return this._cursorActive;
  }

  _installCursorHandler() {
    if (this._cursorHandler) return;
    this._cursorHandler = new Cesium.ScreenSpaceEventHandler(this.viewer.scene.canvas);
    this._cursorHandler.setInputAction((movement) => {
      this._placeCursor(movement.position);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  _uninstallCursorHandler() {
    if (!this._cursorHandler) return;
    this._cursorHandler.destroy();
    this._cursorHandler = null;
  }

  clearCursor() {
    if (this._cursorEntity) {
      this.viewer.entities.remove(this._cursorEntity);
      this._cursorEntity = null;
    }
    this._cursorData = null;
    this.onCursorChange?.(null);
  }

  _placeCursor(windowPosition) {
    const scene = this.viewer.scene;
    let cartesian = scene.pickPositionSupported ? scene.pickPosition(windowPosition) : undefined;
    if (!Cesium.defined(cartesian)) {
      const ray = this.viewer.camera.getPickRay(windowPosition);
      cartesian = ray ? scene.globe.pick(ray, scene) : undefined;
    }
    if (!Cesium.defined(cartesian)) {
      cartesian = this.viewer.camera.pickEllipsoid(windowPosition, scene.globe.ellipsoid);
    }
    if (!Cesium.defined(cartesian)) return;

    const carto = Cesium.Cartographic.fromCartesian(cartesian);
    const lat = Cesium.Math.toDegrees(carto.latitude);
    const lon = Cesium.Math.toDegrees(carto.longitude);
    const height = carto.height;

    if (!this._cursorEntity) {
      this._cursorEntity = this.viewer.entities.add({
        id: 'map-overlays-cursor-pin',
        position: cartesian,
        point: { pixelSize: 12, color: Cesium.Color.fromCssColorString('#00d4ff'), outlineColor: Cesium.Color.BLACK, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        label: {
          text: '📍',
          font: '20px sans-serif',
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          pixelOffset: new Cesium.Cartesian2(0, -4),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          showBackground: false,
        },
      });
    } else {
      this._cursorEntity.position = cartesian;
    }

    this._cursorData = { lat, lon, height, address: null, addressStatus: 'loading' };
    this.onCursorChange?.(this._cursorData);
    this._reverseGeocode(lat, lon);
  }

  async _reverseGeocode(lat, lon) {
    const token = ++this._geocodeToken;
    const apiKey = resolveApiKey('GOOGLE_MAPS_API_KEY', import.meta.env?.GOOGLE_MAPS_API_KEY) || window.__GOOGLE_MAPS_API_KEY__;
    if (!apiKey) {
      if (this._cursorData) { this._cursorData.address = null; this._cursorData.addressStatus = 'no-key'; this.onCursorChange?.(this._cursorData); }
      return;
    }
    try {
      const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lon}&key=${apiKey}`;
      const response = await fetch(url);
      const data = await response.json();
      if (token !== this._geocodeToken) return;
      const address = (data.status === 'OK' && data.results?.length) ? data.results[0].formatted_address : null;
      if (this._cursorData) {
        this._cursorData.address = address;
        this._cursorData.addressStatus = address ? 'ok' : 'not-found';
        this.onCursorChange?.(this._cursorData);
      }
    } catch {
      if (token !== this._geocodeToken) return;
      if (this._cursorData) { this._cursorData.address = null; this._cursorData.addressStatus = 'error'; this.onCursorChange?.(this._cursorData); }
    }
  }

  /** Formatted strings for the copyable output box, or null if no cursor is placed. */
  getCursorOutput() {
    if (!this._cursorData) return null;
    const { lat, lon, height, address, addressStatus } = this._cursorData;
    return {
      dms: formatLatLonDMS(lat, lon),
      decimal: formatLatLonDecimal(lat, lon),
      height: formatHeight(height),
      address: address || (addressStatus === 'loading' ? 'Looking up address…' : addressStatus === 'no-key' ? 'No Google Maps key configured' : 'No address found'),
      mapsLink: googleMapsLink(lat, lon),
      addressStatus,
    };
  }

  /** The live camera position, formatted the same way as the cursor output — used when no pin is placed. */
  getCameraOutput() {
    const carto = this.viewer.camera.positionCartographic;
    if (!carto) return null;
    const lat = Cesium.Math.toDegrees(carto.latitude);
    const lon = Cesium.Math.toDegrees(carto.longitude);
    return {
      dms: formatLatLonDMS(lat, lon),
      decimal: formatLatLonDecimal(lat, lon),
      height: formatHeight(carto.height),
    };
  }

  // ── screenshot ───────────────────────────────────────────────────────
  captureScreenshot() {
    return new Promise((resolve, reject) => {
      try {
        this.viewer.scene.render();
        const canvas = this.viewer.scene.canvas;
        canvas.toBlob((blob) => {
          if (!blob) { reject(new Error('Could not capture the viewport.')); return; }
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `gods-eye-view-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 5000);
          resolve();
        }, 'image/png');
      } catch (err) {
        reject(err);
      }
    });
  }

  // ── reset ────────────────────────────────────────────────────────────
  reset() {
    this.state = { ...DEFAULT_STATE };
    this._persist();
    this._applyVerticalExaggeration();
    this._clearContours();
    this._clearGrid();
    this.clearCursor();
    this.setCursorActive(false);
  }

  destroy() {
    this.viewer.camera.moveEnd.removeEventListener(this._onCameraMoveEnd);
    if (this._recomputeTimer) clearTimeout(this._recomputeTimer);
    this._clearContours();
    this._clearGrid();
    this._uninstallCursorHandler();
    this.clearCursor();
  }
}

export function initMapOverlays(viewer) {
  return new MapOverlaysEngine(viewer);
}
