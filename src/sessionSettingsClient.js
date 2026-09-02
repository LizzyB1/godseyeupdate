/**
 * @file Browser-side half of the transportable session-settings feature —
 * talks to the dev server's `/api/settings` endpoint (see
 * `sessionSettingsProxy()` in `vite.config.js`) so the file-backed state in
 * `src/data/sessionSettings.js` can actually be fetched/saved from a
 * running page. Kept separate from that pure module so the shared
 * normalize/merge logic stays `fetch`-free and importable from Node
 * (`vite.config.js`) without pulling in any browser-only API.
 *
 * @module sessionSettingsClient
 */

const SAVE_DEBOUNCE_MS = 2000;

/**
 * Fetch the current transportable session settings. Never throws — a
 * missing/unreachable endpoint (e.g. a production static build with no dev
 * server) just means "nothing to restore", same as a fresh clone.
 * @returns {Promise<?{camera:?object, mapStack:?string, panelAlpha:?number, layerState:?string}>}
 */
export async function fetchSessionSettings() {
  try {
    // Bounded: this is awaited early in main.js's boot sequence, before the
    // globe or any layer exists — a production static host with no dev
    // server (so no /api/settings at all) must never stall boot waiting on
    // a request nothing will ever answer.
    const res = await fetch('/api/settings', {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.settings || null;
  } catch {
    return null;
  }
}

/**
 * PUT a partial settings patch. Fire-and-forget from the caller's
 * perspective (used for best-effort autosave) — failures are logged, not
 * thrown, so a flaky/offline dev server never interrupts the app itself.
 * @param {object} patch - See `mergeSessionSettings` in sessionSettings.js
 *   for exact per-field merge semantics.
 */
export async function saveSessionSettings(patch) {
  try {
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch || {}),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (error) {
    console.warn('[SessionSettings] save failed:', error?.message || error);
    return null;
  }
}

/**
 * Debounced autosave: coalesces bursts of change events (camera move,
 * layer toggle, map-stack switch, transparency drag) into one PUT after
 * things settle, and merges consecutive patches so an early field isn't
 * lost if a later call fires before the timer does.
 * @returns {(patch: object) => void} call with a partial patch any time
 *   something worth persisting changes.
 */
export function createSessionSettingsAutosave() {
  let pending = null;
  let timer = null;
  return function scheduleSave(patch) {
    pending = { ...pending, ...patch };
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const toSave = pending;
      pending = null;
      timer = null;
      void saveSessionSettings(toSave);
    }, SAVE_DEBOUNCE_MS);
  };
}
