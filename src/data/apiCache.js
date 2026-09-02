/**
 * @file Durable, cross-session client cache for slow-changing API results —
 * reverse-geocoded addresses (`data/mapOverlays.js`) so far — backed by
 * IndexedDB (`localStorage`'s ~5-10MB cap is far too small for a useful
 * geographic cache). Hard-capped at `MAX_CACHE_BYTES` (5 GB) with FIFO
 * eviction: once the budget is exceeded, the oldest-WRITTEN entry goes
 * first, tracked via a monotonic write sequence number rather than
 * last-access time — a true first-in-first-out policy, not LRU, per the
 * operator's explicit request.
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
}

let sharedCache = null;
/** The one cache instance the app's data modules share. */
export function getSharedCache() {
  if (!sharedCache) sharedCache = new ApiCache();
  return sharedCache;
}
