// src/data/aircraftPhotos.js
/**
 * A photo of the actual airframe being tracked, from the free Planespotters
 * photo API (https://www.planespotters.net/photo/api), keyed by the ICAO 24-bit
 * hex the ADS-B feed already gives us, or by registration when that is all we
 * have.
 *
 * Their terms shape this module, so the constraints are structural, not stylistic:
 *   - The photographer's name must be visible beside the image and the thumbnail
 *     must link to the returned photo page — so both come back with the URL and
 *     callers have no valid rendering without them.
 *   - The image itself must be loaded from their URL and must NOT be stored:
 *     no proxying, no rewriting, no writing the bytes to disk or IndexedDB. Only
 *     the JSON is persisted here, which they allow for up to 24 hours.
 *   - Not to be used to build datasets, so nothing accumulates: the cache is
 *     keyed one entry per airframe and expires.
 *
 * Negative results are cached too (an airframe with no photo today has none in
 * an hour either), which is what keeps a busy sky from re-asking constantly.
 */

const API_BASE = 'https://api.planespotters.net/pub/photos';
/** Their published ceiling for retaining the JSON response. */
export const PHOTO_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const STORAGE_KEY = 'godsEyeView.aircraftPhotos.v1';
/** Airframes retained across a reload; oldest are dropped first. */
const STORAGE_MAX_ENTRIES = 400;
const REQUEST_TIMEOUT_MS = 6000;

/** @type {Map<string, {at: number, photo: object|null}>} */
const _memory = new Map();
/** @type {Map<string, Promise<object|null>>} In-flight requests, deduped. */
const _inflight = new Map();
let _restored = false;

/**
 * The credited, linkable photo fields, or null when the response has no usable
 * photo. Anything missing credit or a link is treated as unusable rather than
 * shown bare.
 * @param {object} payload Parsed API response.
 * @returns {{thumbnail: string, large: string, link: string, photographer: string}|null}
 */
export function selectPhoto(payload) {
  const photo = Array.isArray(payload?.photos) ? payload.photos[0] : null;
  const thumbnail = photo?.thumbnail_large?.src || photo?.thumbnail?.src || '';
  const link = photo?.link || '';
  const photographer = photo?.photographer || '';
  if (!thumbnail || !link || !photographer) return null;
  return {
    thumbnail,
    large: photo?.thumbnail_large?.src || thumbnail,
    link,
    photographer,
  };
}

/** Cache key for an airframe: hex where known, else registration. */
export function photoKey({ icao24, registration } = {}) {
  const hex = String(icao24 || '').trim().toLowerCase();
  if (hex) return `hex:${hex}`;
  const reg = String(registration || '').trim().toUpperCase();
  return reg ? `reg:${reg}` : '';
}

function requestUrl(key) {
  const [kind, value] = key.split(':');
  return kind === 'hex'
    ? `${API_BASE}/hex/${encodeURIComponent(value)}`
    : `${API_BASE}/reg/${encodeURIComponent(value)}`;
}

function storage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null; // Private mode / blocked storage: memory cache still works.
  }
}

function restore(now) {
  if (_restored) return;
  _restored = true;
  const store = storage();
  if (!store) return;
  try {
    const parsed = JSON.parse(store.getItem(STORAGE_KEY) || '{}');
    for (const [key, entry] of Object.entries(parsed)) {
      if (!entry || now - entry.at >= PHOTO_CACHE_TTL_MS) continue;
      _memory.set(key, { at: entry.at, photo: entry.photo || null });
    }
  } catch {
    store.removeItem(STORAGE_KEY);
  }
}

function persist(now) {
  const store = storage();
  if (!store) return;
  const fresh = [...
    _memory.entries()]
    .filter(([, entry]) => now - entry.at < PHOTO_CACHE_TTL_MS)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, STORAGE_MAX_ENTRIES);
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(fresh)));
  } catch {
    // Quota or blocked storage: the memory cache is enough for this session.
  }
}

/**
 * The cached photo for an airframe, if one was fetched within the TTL.
 * @param {{icao24?: string, registration?: string}} aircraft Identity.
 * @param {number} [now] Clock override for tests.
 * @returns {{photo: object|null}|null} Null when nothing is cached (as opposed
 *   to `{photo: null}`, which means "asked, and there is no photo").
 */
export function cachedPhoto(aircraft, now = Date.now()) {
  const key = photoKey(aircraft);
  if (!key) return null;
  restore(now);
  const entry = _memory.get(key);
  if (!entry) return null;
  if (now - entry.at >= PHOTO_CACHE_TTL_MS) {
    _memory.delete(key);
    return null;
  }
  return { photo: entry.photo };
}

/**
 * Fetch (or return cached) photo metadata for an airframe. Never throws; a
 * failed lookup resolves to null and is not cached, so it retries later.
 * @param {{icao24?: string, registration?: string}} aircraft Identity.
 * @param {{fetchImpl?: Function, now?: Function}} [deps] Test seams.
 * @returns {Promise<{thumbnail: string, large: string, link: string, photographer: string}|null>}
 */
export async function fetchAircraftPhoto(aircraft, deps = {}) {
  const now = deps.now || Date.now;
  const key = photoKey(aircraft);
  if (!key) return null;
  const cached = cachedPhoto(aircraft, now());
  if (cached) return cached.photo;
  if (_inflight.has(key)) return _inflight.get(key);

  const fetchImpl = deps.fetchImpl || globalThis.fetch?.bind(globalThis);
  if (!fetchImpl) return null;

  const request = (async () => {
    try {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
      let payload = null;
      try {
        const res = await fetchImpl(requestUrl(key), {
          signal: controller?.signal,
          headers: { Accept: 'application/json' },
        });
        if (!res?.ok) return null;
        payload = await res.json();
      } finally {
        if (timer) clearTimeout(timer);
      }
      const photo = selectPhoto(payload);
      const at = now();
      // A miss is cached as well: airframes without a photo are the common case
      // and asking again on every reselect is exactly the load they ask us not
      // to generate.
      _memory.set(key, { at, photo });
      persist(at);
      return photo;
    } catch {
      return null;
    } finally {
      _inflight.delete(key);
    }
  })();

  _inflight.set(key, request);
  return request;
}

/** Drop every cached entry (test/reset seam). */
export function resetAircraftPhotoCache() {
  _memory.clear();
  _inflight.clear();
  _restored = false;
  storage()?.removeItem(STORAGE_KEY);
}
