/**
 * @file Transportable session settings — the shape and pure logic behind
 * `gev.settings.json`, a git-ignored file at the project root that persists
 * "everything for the next session": the active map stack, camera pose,
 * layer on/off state (the same opaque string `src/data/layerState.js`
 * already keeps in `localStorage`), panel transparency, and server-side API
 * keys entered through Settings.
 *
 * Why a file instead of only `localStorage`: `localStorage` is per-browser
 * profile and never leaves the machine it was written on. The user asked
 * for state that survives "for the next session... transportable to new
 * clones" — i.e. carried by `git clone`/copying the checkout itself, which
 * only a file inside the repo can do. `gev.settings.json` is listed in
 * `.gitignore` (same as `.env`) so it never actually gets committed/pushed —
 * "transportable" here means copy-the-file-alongside-the-checkout, not
 * "checked into git" (that would leak API keys).
 *
 * This module is imported from BOTH sides:
 *  - `vite.config.js` (Node, dev-server `/api/settings` proxy) — reads/
 *    writes the file, decides which server-side API key is "configured"
 *    and from where.
 *  - the browser bundle (`src/sessionSettingsClient.js`) — normalizes what
 *    a `GET /api/settings` response hands back before applying it.
 *
 * Kept dependency-free (no `fs`, no `fetch`, no Cesium) so it works
 * identically in both, and so it's plain-Node unit-testable.
 *
 * @module data/sessionSettings
 */

export const SETTINGS_FILE_NAME = 'gev.settings.json';
export const SESSION_SETTINGS_VERSION = 1;

/**
 * Server-side-only API keys (never reach the browser bundle — see
 * `.env.example`'s CLIENT-EXPOSED vs SERVER-SIDE ONLY split, and
 * `src/apiKeys.js` for the two keys that ARE client-exposed and already
 * have their own browser-local-override mechanism, which this module does
 * not duplicate).
 *
 * `envVar` is always equal to `id` today (kept as a separate field in case
 * that ever needs to diverge, e.g. one UI row backed by more than one
 * env var).
 */
export const SERVER_API_KEY_DEFS = [
  {
    id: 'FIRMS_MAP_KEY',
    envVar: 'FIRMS_MAP_KEY',
    label: 'NASA FIRMS Map Key',
    help: 'Live active-fires layer. Free key: firms.modaps.eosdis.nasa.gov/api/map_key',
  },
  {
    id: 'TOMTOM_API_KEY',
    envVar: 'TOMTOM_API_KEY',
    label: 'TomTom API Key',
    help: 'Live traffic flow tiles. Without a key the layer runs a built-in simulation instead.',
  },
  {
    id: 'AISSTREAM_API_KEY',
    envVar: 'AISSTREAM_API_KEY',
    label: 'AISStream API Key',
    help: 'Live AIS vessel positions, streamed server-side.',
  },
  {
    id: 'OPENAI_API_KEY',
    envVar: 'OPENAI_API_KEY',
    label: 'OpenAI API Key',
    help: 'Realtime voice control (MIC panel).',
  },
  {
    id: 'OPENSKY_CLIENT_ID',
    envVar: 'OPENSKY_CLIENT_ID',
    label: 'OpenSky Client ID',
    help: 'OAuth credential for the live aircraft feed. Leave blank to use anonymous/rate-limited access.',
  },
  {
    id: 'OPENSKY_CLIENT_SECRET',
    envVar: 'OPENSKY_CLIENT_SECRET',
    label: 'OpenSky Client Secret',
    help: 'Paired with the OpenSky Client ID above.',
  },
];

const SERVER_API_KEY_IDS = new Set(SERVER_API_KEY_DEFS.map((def) => def.id));

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function trimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** A fresh, empty settings object — what a clone with no saved file starts from. */
export function createDefaultSessionSettings() {
  return {
    version: SESSION_SETTINGS_VERSION,
    apiKeys: {},
    camera: null,
    mapStack: null,
    panelAlpha: null,
    layerState: null,
    updatedAt: null,
  };
}

/**
 * Validate/coerce a camera pose. Any missing or non-finite field invalidates
 * the whole pose (a partial camera restore is worse than none — Cesium's
 * `setView` needs all six values).
 * @returns {?{lon:number, lat:number, height:number, heading:number, pitch:number, roll:number}}
 */
function normalizeCamera(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const lon = Number(raw.lon);
  const lat = Number(raw.lat);
  const height = Number(raw.height);
  const heading = Number(raw.heading);
  const pitch = Number(raw.pitch);
  const roll = Number(raw.roll);
  if (![lon, lat, height, heading, pitch, roll].every(isFiniteNumber)) return null;
  if (lat < -90 || lat > 90 || height < -1000) return null;
  return { lon, lat, height, heading, pitch, roll };
}

function normalizeApiKeys(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, value] of Object.entries(raw)) {
    if (!SERVER_API_KEY_IDS.has(id)) continue;
    const trimmed = trimmedString(value);
    if (trimmed) out[id] = trimmed;
  }
  return out;
}

/**
 * Sanitize an arbitrary (e.g. parsed-from-disk or posted-from-a-client)
 * object into a well-shaped settings record. Unknown fields are dropped;
 * malformed known fields fall back to "unset" rather than throwing, so one
 * bad field never loses the rest of a person's saved state.
 */
export function normalizeSessionSettings(raw) {
  const defaults = createDefaultSessionSettings();
  if (!raw || typeof raw !== 'object') return defaults;
  return {
    version: SESSION_SETTINGS_VERSION,
    apiKeys: normalizeApiKeys(raw.apiKeys),
    camera: normalizeCamera(raw.camera),
    mapStack: typeof raw.mapStack === 'string' && raw.mapStack.trim() ? raw.mapStack.trim() : null,
    panelAlpha: isFiniteNumber(Number(raw.panelAlpha)) && raw.panelAlpha !== null && raw.panelAlpha !== ''
      ? Math.max(0.2, Math.min(0.95, Number(raw.panelAlpha)))
      : null,
    layerState: typeof raw.layerState === 'string' && raw.layerState ? raw.layerState : null,
    // `Number(null) === 0` and `Number('') === 0` are both finite — guard
    // explicitly, or re-normalizing an already-normalized (still-unset)
    // record would turn a real `null` into a spurious `0` (caught by
    // sessionSettings.test.mjs's merge-with-no-patch round-trip case).
    updatedAt: raw.updatedAt !== null && raw.updatedAt !== '' && isFiniteNumber(Number(raw.updatedAt))
      ? Number(raw.updatedAt)
      : null,
  };
}

/**
 * Merge a partial PUT body (`patch`) onto an existing normalized settings
 * record, producing a new normalized record. Semantics per field:
 *  - `apiKeys`: merged key-by-key. A non-empty string sets/replaces that
 *    key; an explicit `''` clears it; a key simply absent from the patch is
 *    left untouched (so saving one key never wipes the others).
 *  - every other field: present in the patch (including explicit `null`)
 *    replaces the base value; absent leaves the base value untouched.
 * @param {object} base - Already-normalized settings.
 * @param {object} patch - Raw (not yet normalized) partial update.
 */
export function mergeSessionSettings(base, patch) {
  const current = normalizeSessionSettings(base);
  if (!patch || typeof patch !== 'object') return current;

  const mergedApiKeys = { ...current.apiKeys };
  if (patch.apiKeys && typeof patch.apiKeys === 'object') {
    for (const [id, value] of Object.entries(patch.apiKeys)) {
      if (!SERVER_API_KEY_IDS.has(id)) continue;
      const trimmed = trimmedString(value);
      if (trimmed) mergedApiKeys[id] = trimmed;
      else delete mergedApiKeys[id];
    }
  }

  const next = {
    version: SESSION_SETTINGS_VERSION,
    apiKeys: mergedApiKeys,
    camera: 'camera' in patch ? normalizeCamera(patch.camera) : current.camera,
    mapStack: 'mapStack' in patch
      ? (typeof patch.mapStack === 'string' && patch.mapStack.trim() ? patch.mapStack.trim() : null)
      : current.mapStack,
    panelAlpha: 'panelAlpha' in patch
      ? normalizeSessionSettings({ panelAlpha: patch.panelAlpha }).panelAlpha
      : current.panelAlpha,
    layerState: 'layerState' in patch
      ? (typeof patch.layerState === 'string' && patch.layerState ? patch.layerState : null)
      : current.layerState,
    updatedAt: Date.now(),
  };
  return next;
}

/**
 * Per-key configured/source status for the Settings UI — deliberately never
 * includes the actual secret value (not even to the same-origin dev
 * server's own client), only whether one is set and whether it came from
 * the transportable file or the `.env`/shell environment.
 * @param {object} settings - Normalized settings (its `apiKeys` are checked).
 * @param {Record<string,string|undefined>} envSnapshot - e.g. `process.env`
 *   captured BEFORE any file-based override was applied to it.
 */
export function describeServerKeyStatus(settings, envSnapshot) {
  const apiKeys = (settings && typeof settings === 'object' && settings.apiKeys) || {};
  const env = envSnapshot || {};
  return SERVER_API_KEY_DEFS.map((def) => {
    const fromFile = Boolean(trimmedString(apiKeys[def.id]));
    const fromEnv = !fromFile && Boolean(trimmedString(env[def.envVar]));
    return {
      id: def.id,
      label: def.label,
      help: def.help,
      configured: fromFile || fromEnv,
      source: fromFile ? 'file' : fromEnv ? 'env' : 'none',
    };
  });
}

/** Redacted view of a settings record safe to send to a browser client — never includes `apiKeys` values. */
export function toClientSettings(settings) {
  const normalized = normalizeSessionSettings(settings);
  return {
    version: normalized.version,
    camera: normalized.camera,
    mapStack: normalized.mapStack,
    panelAlpha: normalized.panelAlpha,
    layerState: normalized.layerState,
    updatedAt: normalized.updatedAt,
  };
}
