import * as Cesium from 'cesium';
import { sampleSceneHeights, DEFAULT_HEIGHT_OFFSET } from './sceneHeight.js';
import { getSharedCache } from './apiCache.js';
import { tilesForRect, dedupeElements } from './overpassTiling.js';

/**
 * @file "Signpost" labels — mountain/peak names and the OSM place-name
 * hierarchy (city down to isolated dwelling), rendered as small billboard
 * signposts with a text label, at a density controlled by a single
 * "detail level" the operator can raise or lower.
 *
 * There's no place-name/peak dataset anywhere in this app to draw from, so
 * this queries OpenStreetMap's Overpass API for named `natural=peak` nodes
 * and `place=*` nodes — through the app's own `/api/overpass` proxy (see
 * vite.config.js), the same endpoint `data/traffic.js` and the
 * annotation/geocoding code already use for road and boundary lookups.
 * Queries are snapped to a coarse fixed tile grid (`data/overpassTiling.js`)
 * and each tile's result is cached durably (`data/apiCache.js`) — place and
 * peak names are "broadly unchangeable content", so a viewport that's been
 * queried before (even under a differently-panned/zoomed camera) reuses the
 * cached tile instead of re-hitting Overpass. A view needing more tiles
 * than is worth fetching individually falls back to one direct, uncached
 * query spanning the whole viewport. Overpass is a public, best-effort
 * service: a slow mirror or a timeout just leaves the last-known labels on
 * screen and shows a status line — it never throws into the render loop.
 *
 * Labels used to rely on `Cesium.HeightReference.CLAMP_TO_GROUND`, which
 * isn't reliable in a scene with `globe.show = false` and no terrain
 * provider (see main.js / data/sceneHeight.js's module doc comment) —
 * billboards/labels could silently resolve to height≈0 and end up hidden
 * beneath the rendered 3D Tileset surface, which is what "signposts not
 * showing up" actually was. Positions are now computed explicitly via
 * `data/sceneHeight.js`, sampling the same scene the operator sees.
 *
 * Fetching (network, debounced on camera moveEnd) and rendering (pure
 * filter + billboard/label rebuild from the last fetched elements) are
 * deliberately separate: nudging the detail-level slider re-renders
 * instantly from the cached viewport data instead of re-querying Overpass.
 *
 * @module data/signpostLabels
 */

const OVERPASS_URL = '/api/overpass';
const STORAGE_KEY = 'godsEyeView.signposts.state';
const FETCH_DEBOUNCE_MS = 500;
const MAX_VIEW_SPAN_DEG = 6; // above this, the viewport is too big for a meaningful place-name query
/** Cache store name (see data/apiCache.js) for per-tile Overpass results. */
const OVERPASS_CACHE_STORE = 'overpassTiles';
/** Billboards/labels sit a bit further off the surface than a track dot so they clear the mesh even at a grazing view angle. */
const SIGNPOST_HEIGHT_OFFSET = DEFAULT_HEIGHT_OFFSET + 0.5;
// If more than this fraction of a render pass's candidates fell back to an
// unresolved (default) height, retry the render once shortly — likely means
// tiles for a freshly-panned-to area hadn't streamed in yet.
const RETRY_MIN_RESOLVED_FRACTION = 0.6;
const RETRY_DELAY_MS = 800;

/**
 * Detail levels 0 (sparsest) .. 6 (densest) — each widens which OSM
 * `place=*` tag values are shown and lowers the minimum peak elevation
 * (meters) that qualifies, with a rendered-label budget that grows
 * alongside it so raising the level doesn't quietly do nothing at a
 * wide-open view.
 */
export const DETAIL_LEVELS = [
  { label: 'Major cities only', placeTiers: ['city'], minPeakEle: 4000, budget: 15 },
  { label: 'Cities + towns', placeTiers: ['city', 'town'], minPeakEle: 2500, budget: 25 },
  { label: '+ villages', placeTiers: ['city', 'town', 'village'], minPeakEle: 1500, budget: 40 },
  { label: '+ hamlets', placeTiers: ['city', 'town', 'village', 'hamlet'], minPeakEle: 800, budget: 65 },
  { label: '+ suburbs', placeTiers: ['city', 'town', 'village', 'hamlet', 'suburb'], minPeakEle: 400, budget: 95 },
  { label: '+ neighbourhoods', placeTiers: ['city', 'town', 'village', 'hamlet', 'suburb', 'neighbourhood'], minPeakEle: 150, budget: 135 },
  { label: 'All the way to small features', placeTiers: ['city', 'town', 'village', 'hamlet', 'suburb', 'neighbourhood', 'locality', 'isolated_dwelling'], minPeakEle: 0, budget: 200 },
];

const ALL_PLACE_TIERS = DETAIL_LEVELS[DETAIL_LEVELS.length - 1].placeTiers;
/** Lower index = more important; used to sort places within a render pass. */
const TIER_RANK = Object.fromEntries(ALL_PLACE_TIERS.map((t, i) => [t, i]));

export const DEFAULT_STATE = Object.freeze({
  enabled: false,
  detailLevel: 2,
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
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* storage unavailable */ }
}

function svgDataUri(svg) {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const PEAK_ICON = svgDataUri(
  '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26">'
  + '<path d="M3 21 L11 7 L14 12 L17 5 L23 21 Z" fill="#a9865a" stroke="#241a0e" stroke-width="1.2"/>'
  + '<path d="M17 5 L19.3 9.2 L14.8 9.2 Z" fill="#f4f8fb"/>'
  + '</svg>',
);
const PLACE_ICON = svgDataUri(
  '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="28" viewBox="0 0 18 28">'
  + '<rect x="8" y="5" width="2" height="21" fill="#5b4126"/>'
  + '<rect x="1" y="1" width="15" height="9" rx="1.5" fill="#00d4ff" stroke="#052027" stroke-width="1"/>'
  + '</svg>',
);

/** Extract a leading numeric elevation out of an OSM `ele` tag ("1500", "1500 m", "1500;1502"). */
function parseEle(value) {
  if (value == null) return NaN;
  const match = String(value).match(/-?\d+(\.\d+)?/);
  return match ? Number(match[0]) : NaN;
}

function buildOverpassQuery(south, west, north, east) {
  const placeRegex = `^(${ALL_PLACE_TIERS.join('|')})$`;
  return `[out:json][timeout:20];(`
    + `node["natural"="peak"]["name"](${south},${west},${north},${east});`
    + `node["place"~"${placeRegex}"]["name"](${south},${west},${north},${east});`
    + `);out body;`;
}

export class SignpostLabels {
  constructor(viewer) {
    this.viewer = viewer;
    this.state = loadState();

    /** @type {Array<{kind:'peak'|'place', name:string, lat:number, lon:number, ele:number, tier:?string}>} */
    this._elements = [];
    this._entities = [];
    this._fetchTimer = null;
    this._fetchToken = 0;
    this._status = '';
    /** Whether an unresolved-heights retry render has already fired for the in-flight fetch/render cycle — bounds it to one retry, never a loop. */
    this._retriedThisCycle = false;

    /** @type {?Function} UI callback: (statusText) => void */
    this.onStatusChange = null;

    this._onCameraMoveEnd = this._onCameraMoveEnd.bind(this);
    this.viewer.camera.moveEnd.addEventListener(this._onCameraMoveEnd);

    if (this.state.enabled) this._scheduleFetch();
  }

  _setStatus(text) {
    this._status = text;
    this.onStatusChange?.(text);
  }

  _persist() {
    saveState(this.state);
  }

  setEnabled(enabled) {
    this.state.enabled = Boolean(enabled);
    this._persist();
    if (this.state.enabled) this._scheduleFetch();
    else this._clearEntities();
  }

  setDetailLevel(level) {
    const clamped = Cesium.Math.clamp(Math.round(Number(level)), 0, DETAIL_LEVELS.length - 1);
    this.state.detailLevel = clamped;
    this._persist();
    if (this.state.enabled) this._render();
  }

  levelLabel(level = this.state.detailLevel) {
    return DETAIL_LEVELS[level]?.label ?? '';
  }

  _onCameraMoveEnd() {
    if (this.state.enabled) this._scheduleFetch();
  }

  _scheduleFetch() {
    if (this._fetchTimer) clearTimeout(this._fetchTimer);
    this._retriedThisCycle = false;
    this._fetchTimer = setTimeout(() => this._fetch(), FETCH_DEBOUNCE_MS);
  }

  async _fetch() {
    if (!this.state.enabled) return;
    const rect = this.viewer.camera.computeViewRectangle();
    if (!rect) return;
    const spanDeg = Cesium.Math.toDegrees(Math.max(rect.width, rect.height));
    if (spanDeg > MAX_VIEW_SPAN_DEG) {
      this._setStatus(`Zoom in for place/peak labels (view is ${spanDeg.toFixed(1)}° wide, need < ${MAX_VIEW_SPAN_DEG}°).`);
      return;
    }

    const south = Cesium.Math.toDegrees(rect.south);
    const west = Cesium.Math.toDegrees(rect.west);
    const north = Cesium.Math.toDegrees(rect.north);
    const east = Cesium.Math.toDegrees(rect.east);

    const token = ++this._fetchToken;
    this._setStatus('Loading labels…');
    let elements;
    try {
      elements = await this._fetchElementsForRect(south, west, north, east);
    } catch {
      if (token !== this._fetchToken) return;
      this._setStatus('Label lookup failed — will retry when the view moves.');
      return;
    }
    if (token !== this._fetchToken) return;

    this._elements = elements;
    this._render();
  }

  /**
   * Elements covering a view rectangle, tile-cached where the view fits
   * within `overpassTiling.js`'s tile budget, or one direct uncached query
   * for a view too wide to tile sensibly.
   */
  async _fetchElementsForRect(south, west, north, east) {
    const tiles = tilesForRect(south, west, north, east);
    if (!tiles) return this._queryOverpass(south, west, north, east);

    const cache = getSharedCache();
    const perTile = await Promise.all(tiles.map(async (tile) => {
      try {
        const cached = await cache.get(OVERPASS_CACHE_STORE, tile.key);
        if (cached) return cached;
      } catch { /* cache unavailable — fall through to a live query */ }
      const tileElements = await this._queryOverpass(tile.south, tile.west, tile.north, tile.east);
      try { await cache.put(OVERPASS_CACHE_STORE, tile.key, tileElements); } catch { /* best-effort */ }
      return tileElements;
    }));
    return dedupeElements(perTile.flat());
  }

  /** One direct, uncached Overpass query for the given bounding box. */
  async _queryOverpass(south, west, north, east) {
    const query = buildOverpassQuery(south, west, north, east);
    const response = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
    });
    if (!response.ok) throw new Error(`Overpass returned ${response.status}`);
    const data = await response.json();

    const elements = [];
    for (const item of data?.elements || []) {
      if (item.type !== 'node' || !item.tags?.name) continue;
      if (item.tags.natural === 'peak') {
        elements.push({ kind: 'peak', name: item.tags.name, lat: item.lat, lon: item.lon, ele: parseEle(item.tags.ele), tier: null });
      } else if (item.tags.place && ALL_PLACE_TIERS.includes(item.tags.place)) {
        elements.push({ kind: 'place', name: item.tags.name, lat: item.lat, lon: item.lon, ele: NaN, tier: item.tags.place });
      }
    }
    return elements;
  }

  _clearEntities() {
    for (const entity of this._entities) this.viewer.entities.remove(entity);
    this._entities = [];
    this._setStatus('');
  }

  _render() {
    this._clearEntities();
    if (!this.state.enabled) return;
    const level = DETAIL_LEVELS[this.state.detailLevel];

    const candidates = this._elements
      .filter((item) => (item.kind === 'peak' ? item.ele >= level.minPeakEle : level.placeTiers.includes(item.tier)))
      .sort((a, b) => {
        const rankA = a.kind === 'peak' ? -1 : TIER_RANK[a.tier] ?? 99;
        const rankB = b.kind === 'peak' ? -1 : TIER_RANK[b.tier] ?? 99;
        if (rankA !== rankB) return rankA - rankB;
        if (a.kind === 'peak' && b.kind === 'peak') return (b.ele || 0) - (a.ele || 0);
        return 0;
      })
      .slice(0, level.budget);

    // Explicit scene-sampled positions instead of CLAMP_TO_GROUND — see the
    // module doc comment. A candidate the scene can't yet resolve falls
    // back to its own OSM `ele` (peaks only) or 0.
    const sampledHeights = sampleSceneHeights(this.viewer.scene, candidates.map((item) => ({ lon: item.lon, lat: item.lat })));
    let unresolvedCount = 0;

    candidates.forEach((item, i) => {
      const resolved = Number.isFinite(sampledHeights[i]);
      if (!resolved) unresolvedCount += 1;
      const baseHeight = resolved ? sampledHeights[i] : (Number.isFinite(item.ele) ? item.ele : 0);
      const position = Cesium.Cartesian3.fromDegrees(item.lon, item.lat, baseHeight + SIGNPOST_HEIGHT_OFFSET);
      const isPeak = item.kind === 'peak';
      const entity = this.viewer.entities.add({
        position,
        billboard: {
          image: isPeak ? PEAK_ICON : PLACE_ICON,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          scale: isPeak ? 0.9 : 0.85,
          disableDepthTestDistance: 0,
        },
        label: {
          text: isPeak && Number.isFinite(item.ele) ? `${item.name} (${Math.round(item.ele)} m)` : item.name,
          font: isPeak ? 'bold 13px sans-serif' : '12px sans-serif',
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
          pixelOffset: new Cesium.Cartesian2(10, isPeak ? -14 : -22),
          scaleByDistance: new Cesium.NearFarScalar(1000, 1.0, 400000, 0.4),
          translucencyByDistance: new Cesium.NearFarScalar(1000, 1.0, 900000, 0.0),
        },
      });
      this._entities.push(entity);
    });

    if (candidates.length && unresolvedCount / candidates.length > (1 - RETRY_MIN_RESOLVED_FRACTION) && !this._retriedThisCycle) {
      // Likely a freshly-panned-to area whose tiles haven't streamed in yet
      // — retry the render once shortly rather than leaving labels stuck at
      // a fallback height.
      this._retriedThisCycle = true;
      setTimeout(() => { if (this.state.enabled) this._render(); }, RETRY_DELAY_MS);
    }

    this._setStatus(`${candidates.length} signpost${candidates.length === 1 ? '' : 's'} — ${level.label}.`);
  }

  reset() {
    this.state = { ...DEFAULT_STATE };
    this._persist();
    this._clearEntities();
  }

  destroy() {
    this.viewer.camera.moveEnd.removeEventListener(this._onCameraMoveEnd);
    if (this._fetchTimer) clearTimeout(this._fetchTimer);
    this._clearEntities();
  }
}

export function initSignpostLabels(viewer) {
  return new SignpostLabels(viewer);
}
