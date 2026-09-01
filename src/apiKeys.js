/**
 * @file API key overrides, entered through the settings dialog.
 *
 * `import.meta.env.*` values are inlined by Vite at BUILD time — a running
 * page in the browser cannot read or rewrite the `.env` file that produced
 * them (no filesystem access from a browser tab). So "editing .env with a
 * refresh button" becomes: store a browser-local override that takes
 * priority over the build-time value, and have "refresh" reload the page
 * so every module that reads the key (Cesium ion, Google Maps tiles/
 * geocoding) picks up the new one from a clean boot — hot-swapping Cesium's
 * ion token or every in-flight Google Maps consumer live is not something
 * this can safely attempt without breaking whatever is mid-fetch.
 *
 * The override is per-browser (localStorage), never sent anywhere but back
 * into `Cesium.Ion.defaultAccessToken` / `Cesium.GoogleMaps.defaultApiKey` /
 * `window.__GOOGLE_MAPS_API_KEY__` the same way the build-time value is.
 *
 * @module apiKeys
 */

const PREFIX = 'godsEyeView.apiKeyOverride.';

/** Keys the settings dialog offers an input for. */
export const API_KEY_DEFS = [
  {
    id: 'CESIUM_ION_TOKEN',
    label: 'Cesium Ion Token',
    help: 'Used for Cesium World Terrain. Get one at ion.cesium.com.',
  },
  {
    id: 'GOOGLE_MAPS_API_KEY',
    label: 'Google Maps API Key',
    help: 'Used for Photorealistic 3D Tiles and geocoding. Required for the globe to load at all.',
  },
];

export function getApiKeyOverride(id) {
  try {
    return localStorage.getItem(`${PREFIX}${id}`) || '';
  } catch {
    return '';
  }
}

export function setApiKeyOverride(id, value) {
  const trimmed = String(value ?? '').trim();
  try {
    if (trimmed) localStorage.setItem(`${PREFIX}${id}`, trimmed);
    else localStorage.removeItem(`${PREFIX}${id}`);
  } catch {
    // storage unavailable — override just won't persist across reloads
  }
}

/**
 * Resolve a key for use: a saved browser override wins over the build-time
 * `.env` value.
 * @param {string} id - One of API_KEY_DEFS' ids.
 * @param {string|undefined} buildTimeValue - `import.meta.env.<id>`.
 * @returns {string}
 */
export function resolveApiKey(id, buildTimeValue) {
  return getApiKeyOverride(id) || buildTimeValue || '';
}

/** True if any key currently in effect came from a browser override rather than the build. */
export function hasAnyOverride() {
  return API_KEY_DEFS.some((def) => Boolean(getApiKeyOverride(def.id)));
}
