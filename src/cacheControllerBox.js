import { buildMiniBox } from './miniBox.js';
import { getSharedCache, formatBytes } from './data/apiCache.js';

/**
 * @file "Data Cache" mini control box: an admin view onto the durable,
 * cross-session IndexedDB cache `data/apiCache.js`'s `ApiCache` keeps for
 * slow-changing API results — reverse-geocoded addresses
 * (`data/mapOverlays.js`) and bathymetry depth samples
 * (`data/bathymetry.js`) today. Shows total usage against the 5 GB budget,
 * a per-logical-store breakdown (how many items, how many bytes, each),
 * and lets an operator flush one store at a time or everything at once —
 * `ApiCache#listStores`/`#clearStore`, on top of the whole-cache
 * `#stats`/`#clear` every consumer already had.
 *
 * Purely a viewer onto the shared cache singleton (`getSharedCache()`) —
 * doesn't own or duplicate any cached data itself, and reads are cheap
 * enough (a single cursor walk) to poll on a slow cadence rather than
 * needing the cache to push change events.
 *
 * Same movable/resizable/persisted-position/collapsible/hideable box
 * mechanics as the app's other mini-boxes, built on `miniBox.js`.
 *
 * @module cacheControllerBox
 */

/** How often to re-poll IndexedDB for fresh stats while the box exists. */
const POLL_MS = 5000;

/** Friendlier names for the logical store names `apiCache.js` consumers use internally. */
const STORE_LABELS = {
  geocode: 'Reverse-geocoded addresses',
  bathyDepth: 'Bathymetry depth samples',
  mapContourLines: 'Contour line geometry',
  trafficRoadData: 'Traffic road geometry (Overpass)',
  terrainHeights: 'Terrain point heights',
};

function labelFor(storeName) {
  return STORE_LABELS[storeName] || storeName;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export class CacheControllerBox {
  constructor() {
    this._cache = getSharedCache();
    this._build();
    this._pollTimer = window.setInterval(() => this._refresh(), POLL_MS);
    this._refresh();
  }

  _build() {
    const box = buildMiniBox({
      idPrefix: 'cachectl',
      storagePrefix: 'godsEyeView.cacheControllerBox.',
      title: 'DATA CACHE',
      ariaLabel: 'Data cache: total usage and a per-type breakdown of the durable cache, with per-type and whole-cache flush',
      defaultWidth: 264,
      defaultHeight: 280,
      minWidth: 220,
      maxWidth: 440,
      minHeight: 160,
      maxHeight: 640,
      // Below Status (same left-of-center column: About top:16px, Status
      // top:332px/defaultHeight 250 → bottom ~582), the next open stretch.
      anchor: { left: '292px', top: '598px' },
      onHeaderBuilt: (header) => {
        const refreshBtn = document.createElement('button');
        refreshBtn.type = 'button';
        refreshBtn.className = 'mapovl-share-btn';
        refreshBtn.title = 'Refresh cache statistics';
        refreshBtn.setAttribute('aria-label', 'Refresh cache statistics');
        refreshBtn.textContent = '⟳';
        refreshBtn.addEventListener('click', (event) => {
          event.stopPropagation();
          this._refresh();
        });
        header.appendChild(refreshBtn);
      },
    });
    this._box = box;
    const body = box.body;

    const totalSection = el('div', 'mapovl-section');
    totalSection.appendChild(el('div', 'mapovl-section-title', 'TOTAL USAGE'));
    this._totalBarFill = el('div', 'cachectl-bar-fill');
    const totalBar = el('div', 'cachectl-bar');
    totalBar.appendChild(this._totalBarFill);
    totalSection.appendChild(totalBar);
    this._totalText = el('div', 'cachectl-total-text', '—');
    totalSection.appendChild(this._totalText);
    body.appendChild(totalSection);

    const typesSection = el('div', 'mapovl-section');
    typesSection.appendChild(el('div', 'mapovl-section-title', 'BY TYPE'));
    this._typeList = el('div', 'cachectl-list');
    typesSection.appendChild(this._typeList);
    body.appendChild(typesSection);

    const clearAllBtn = document.createElement('button');
    clearAllBtn.type = 'button';
    clearAllBtn.className = 'mapovl-btn cachectl-clear-all-btn';
    clearAllBtn.textContent = 'Clear all cached data';
    clearAllBtn.addEventListener('click', () => this._clearAll(clearAllBtn));
    body.appendChild(clearAllBtn);

    this._statusEl = el('div', 'mapovl-status', '');
    body.appendChild(this._statusEl);
  }

  async _refresh() {
    const [stats, stores] = await Promise.all([this._cache.stats(), this._cache.listStores()]);
    const pct = stats.maxBytes > 0 ? Math.min(100, (stats.totalBytes / stats.maxBytes) * 100) : 0;
    this._totalBarFill.style.width = `${pct.toFixed(1)}%`;
    this._totalText.textContent = `${formatBytes(stats.totalBytes)} / ${formatBytes(stats.maxBytes)} (${pct.toFixed(1)}%)`;

    this._typeList.textContent = '';
    if (!stores.length) {
      this._typeList.appendChild(el('div', 'cachectl-empty', 'Nothing cached yet.'));
      return;
    }
    for (const { store, count, bytes } of stores) {
      const row = el('div', 'cachectl-row');
      const info = el('div', 'cachectl-row-info');
      info.appendChild(el('div', 'cachectl-row-label', labelFor(store)));
      info.appendChild(el('div', 'cachectl-row-detail', `${count} item${count === 1 ? '' : 's'} · ${formatBytes(bytes)}`));
      row.appendChild(info);

      const flushBtn = document.createElement('button');
      flushBtn.type = 'button';
      flushBtn.className = 'cachectl-flush-btn';
      flushBtn.textContent = 'Flush';
      flushBtn.title = `Clear only the cached ${labelFor(store).toLowerCase()}`;
      flushBtn.addEventListener('click', () => this._clearStore(store));
      row.appendChild(flushBtn);

      this._typeList.appendChild(row);
    }
  }

  async _clearStore(storeName) {
    const ok = await this._cache.clearStore(storeName);
    this._statusEl.textContent = ok
      ? `Cleared ${labelFor(storeName).toLowerCase()}.`
      : 'Could not clear that cache — try again.';
    await this._refresh();
  }

  async _clearAll(btn) {
    btn.disabled = true;
    const ok = await this._cache.clear();
    btn.disabled = false;
    this._statusEl.textContent = ok ? 'Cleared all cached data.' : 'Could not clear the cache — try again.';
    await this._refresh();
  }

  destroy() {
    if (this._pollTimer) window.clearInterval(this._pollTimer);
    this._box.destroy();
  }
}

/** @returns {CacheControllerBox} */
export function initCacheControllerBox() {
  return new CacheControllerBox();
}
