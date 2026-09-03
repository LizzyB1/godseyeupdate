/**
 * @file Durable, cross-session client cache for slow-changing API results —
 * reverse-geocoded addresses (`data/mapOverlays.js`) and bathymetry depth
 * lookups (`data/bathymetry.js`) so far — backed by IndexedDB
 * (`localStorage`'s ~5-10MB cap is far too small for a useful geographic
 * cache). Hard-capped at `MAX_CACHE_BYTES` (5 GB) with FIFO eviction: once
 * the budget is exceeded, the oldest-WRITTEN entry goes first, tracked via
 * a monotonic write sequence number rather than last-access time — a true
 * first-in-first-out policy, not LRU, per the operator's explicit request.
 *
 * Deliberately NOT a place for this app's scene-derived heights or the
 * contour lines computed from them (`data/sceneHeight.js`,
 * `data/mapOverlays.js`): those exist specifically to read "what the scene
 * is rendering right now," which changes as 3D tiles stream in at
 * different levels of detail — durably caching them would reintroduce the
 * exact off-the-rendered-ground mismatch bug `sceneHeight.js`'s own
 * file-level comment documents fixing. Only genuinely slow-changing,
 * network-fetched results belong here.
 *
 * `listStores()`/`clearStore()` give a cache-controller UI
 * (`cacheControllerBox.js`) a per-logical-store breakdown and per-type
 * flush, on top of the whole-cache `stats()`/`clear()` every consumer
 * already had.
 *
 * The IndexedDB plumbing itself isn't unit-testable outside a browser, so
 * it's kept to thin get/put/evict methods around two pure, exported,
 * Cesium/IndexedDB-free helpers — `estimateBytes` and `planEviction` — that
 * carry the actual size/eviction accounting and are covered by
 * `apiCache.test.mjs`, mirroring this codebase's split between
 * browser-touching render/data modules and their pure-logic siblings
 * (`contourMath.js`, `gpsTrackParse.js`, `heightInterp.js`).
 *
 * Every public method is best-effort: a missing/broken IndexedDB (older
 * browser, private-mode quota refusal, disabled storage) degrades to a
 * silent no-op cache — every `get()` misses, every `put()` is dropped —
 * rather than throwing into a caller's render/fetch path.
 *
 * @module data/apiCache
 */

/** Hard cap on total cached bytes across every logical store. */
export const MAX_CACHE_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB

const DB_NAME = 'godsEyeView.apiCache';
const DB_VERSION = 1;
const ENTRIES_STORE = 'entries';
const META_STORE = 'meta';
const META_KEY = 'totals';

/** Namespaced entry key so different logical caches ('overpassTiles', 'geocode', ...) can't collide. */
export function namespacedKey(storeName, key) {
  return `${storeName}::${key}`;
}

/** Approximate on-disk size (bytes) of a JSON-serializable value; 0 for anything that can't be serialized. */
export function estimateBytes(value) {
  try {
    return new Blob([JSON.stringify(value)]).size;
  } catch {
    return 0;
  }
}

/**
 * Pure FIFO eviction planner: given the cache's other entries oldest-write-
 * first (`[{seq, bytes}]`, EXCLUDING whatever's being overwritten, if
 * anything) plus the size of the entry about to be written, how many of the
 * oldest entries need to go so the total fits within `maxBytes`.
 * @param {Array<{seq:number, bytes:number}>} orderedEntries - oldest write first.
 * @param {number} incomingBytes - size of the entry about to be written.
 * @param {number} maxBytes
 * @returns {{toEvictSeqs:number[], totalBytesAfter:number}}
 */
export function planEviction(orderedEntries, incomingBytes, maxBytes) {
  let total = orderedEntries.reduce((sum, e) => sum + e.bytes, 0) + Math.max(0, incomingBytes);
  const toEvictSeqs = [];
  let i = 0;
  while (total > maxBytes && i < orderedEntries.length) {
    total -= orderedEntries[i].bytes;
    toEvictSeqs.push(orderedEntries[i].seq);
    i += 1;
  }
  return { toEvictSeqs, totalBytesAfter: Math.max(0, total) };
}

/**
 * Human-readable size string for a byte count — B/KB/MB/GB, one decimal
 * place above B. Pure/exported so the cache-controller UI's formatting is
 * unit-testable the same way `estimateBytes`/`planEviction` are.
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  const n = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function hasIndexedDb() {
  return typeof indexedDB !== 'undefined';
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB request failed'));
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}

function openDb() {
  return new Promise((resolve, reject) => {
    if (!hasIndexedDb()) { reject(new Error('IndexedDB unavailable')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ENTRIES_STORE)) {
        const store = db.createObjectStore(ENTRIES_STORE, { keyPath: 'key' });
        store.createIndex('bySeq', 'seq', { unique: false });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Could not open apiCache IndexedDB'));
  });
}

/** IndexedDB-backed generic key/value cache, namespaced by logical store name, 5GB-capped with FIFO eviction. */
export class ApiCache {
  constructor({ maxBytes = MAX_CACHE_BYTES } = {}) {
    this.maxBytes = maxBytes;
    this._dbPromise = null;
  }

  _db() {
    if (!this._dbPromise) this._dbPromise = openDb();
    return this._dbPromise;
  }

  /**
   * @param {string} storeName - logical cache name, e.g. 'overpassTiles'.
   * @param {string} key
   * @returns {Promise<any|undefined>} the cached value, or undefined on a miss/error.
   */
  async get(storeName, key) {
    try {
      const db = await this._db();
      const tx = db.transaction(ENTRIES_STORE, 'readonly');
      const row = await reqToPromise(tx.objectStore(ENTRIES_STORE).get(namespacedKey(storeName, key)));
      return row?.value;
    } catch {
      return undefined;
    }
  }

  /**
   * Write (or overwrite) an entry, evicting the oldest entries FIFO-style
   * across the WHOLE cache if this pushes it over budget. Best-effort —
   * never throws; returns false if the write couldn't be completed.
   * @param {string} storeName
   * @param {string} key
   * @param {any} value - JSON-serializable.
   * @returns {Promise<boolean>}
   */
  async put(storeName, key, value) {
    try {
      const db = await this._db();
      const nsKey = namespacedKey(storeName, key);
      const bytes = estimateBytes(value);

      const tx = db.transaction([ENTRIES_STORE, META_STORE], 'readwrite');
      const entries = tx.objectStore(ENTRIES_STORE);
      const meta = tx.objectStore(META_STORE);

      const metaRow = (await reqToPromise(meta.get(META_KEY))) || { id: META_KEY, seq: 0 };
      const nextSeq = metaRow.seq + 1;

      // Oldest-write-first list of every OTHER entry (the one being
      // overwritten, if any, is excluded — it's about to be replaced wholesale).
      const others = await new Promise((resolve, reject) => {
        const found = [];
        const cursorReq = entries.index('bySeq').openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) { resolve(found); return; }
          if (cursor.value.key !== nsKey) found.push(cursor.value);
          cursor.continue();
        };
        cursorReq.onerror = () => reject(cursorReq.error);
      });

      const { toEvictSeqs } = planEviction(
        others.map((e) => ({ seq: e.seq, bytes: e.bytes })),
        bytes,
        this.maxBytes,
      );
      const evictSet = new Set(toEvictSeqs);
      let keptBytes = 0;
      for (const e of others) {
        if (evictSet.has(e.seq)) entries.delete(e.key);
        else keptBytes += e.bytes;
      }

      entries.put({ key: nsKey, store: storeName, value, bytes, seq: nextSeq, insertedAt: Date.now() });
      meta.put({ id: META_KEY, seq: nextSeq, totalBytes: keptBytes + bytes });

      await txDone(tx);
      return true;
    } catch {
      return false;
    }
  }

  /** @returns {Promise<{totalBytes:number, maxBytes:number}>} */
  async stats() {
    try {
      const db = await this._db();
      const tx = db.transaction(META_STORE, 'readonly');
      const metaRow = await reqToPromise(tx.objectStore(META_STORE).get(META_KEY));
      return { totalBytes: metaRow?.totalBytes ?? 0, maxBytes: this.maxBytes };
    } catch {
      return { totalBytes: 0, maxBytes: this.maxBytes };
    }
  }

  /** Wipe every cached entry. Best-effort. */
  async clear() {
    try {
      const db = await this._db();
      const tx = db.transaction([ENTRIES_STORE, META_STORE], 'readwrite');
      tx.objectStore(ENTRIES_STORE).clear();
      tx.objectStore(META_STORE).clear();
      await txDone(tx);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Per-logical-store breakdown of what's currently cached — item count and
   * total bytes for every `storeName` that has at least one entry, largest
   * first. Walks every entry once via a cursor: fine for the "how much, of
   * what" summary a cache-controller UI needs on open/refresh, not meant
   * for a hot path. Best-effort — returns `[]` on any failure.
   * @returns {Promise<Array<{store:string, count:number, bytes:number}>>}
   */
  async listStores() {
    try {
      const db = await this._db();
      const tx = db.transaction(ENTRIES_STORE, 'readonly');
      const totals = new Map(); // storeName -> {count, bytes}
      await new Promise((resolve, reject) => {
        const cursorReq = tx.objectStore(ENTRIES_STORE).openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) { resolve(); return; }
          const row = cursor.value;
          const entry = totals.get(row.store) || { count: 0, bytes: 0 };
          entry.count += 1;
          entry.bytes += row.bytes || 0;
          totals.set(row.store, entry);
          cursor.continue();
        };
        cursorReq.onerror = () => reject(cursorReq.error);
      });
      return [...totals.entries()]
        .map(([store, { count, bytes }]) => ({ store, count, bytes }))
        .sort((a, b) => b.bytes - a.bytes);
    } catch {
      return [];
    }
  }

  /**
   * Wipe every entry belonging to ONE logical store, leaving every other
   * store's entries untouched — the per-type flush a cache-controller UI
   * needs, as opposed to `clear()`'s wipe-everything. Best-effort.
   * @param {string} storeName
   * @returns {Promise<boolean>}
   */
  async clearStore(storeName) {
    try {
      const db = await this._db();
      const tx = db.transaction([ENTRIES_STORE, META_STORE], 'readwrite');
      const entries = tx.objectStore(ENTRIES_STORE);
      const meta = tx.objectStore(META_STORE);
      let removedBytes = 0;
      await new Promise((resolve, reject) => {
        const cursorReq = entries.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) { resolve(); return; }
          if (cursor.value.store === storeName) {
            removedBytes += cursor.value.bytes || 0;
            cursor.delete();
          }
          cursor.continue();
        };
        cursorReq.onerror = () => reject(cursorReq.error);
      });
      if (removedBytes > 0) {
        const metaRow = (await reqToPromise(meta.get(META_KEY))) || { id: META_KEY, seq: 0, totalBytes: 0 };
        meta.put({ ...metaRow, totalBytes: Math.max(0, (metaRow.totalBytes || 0) - removedBytes) });
      }
      await txDone(tx);
      return true;
    } catch {
      return false;
    }
  }
}

let sharedCache = null;
/** The one cache instance the app's data modules share. */
export function getSharedCache() {
  if (!sharedCache) sharedCache = new ApiCache();
  return sharedCache;
}
