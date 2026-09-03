/**
 * @file Shared "fully hidden panel" registry — the full-hide half of the
 * GUI-cleanup panel mechanics (drag/resize come from `panelDrag.js`,
 * collapse-to-strip from `ui.js`'s `.panel-collapsible` machinery). A
 * panel's "Hide panel" (×) button calls `hidePanel(id)` here; the restore
 * tray (`panelRestoreTray.js`) subscribes to this module to list every
 * currently-hidden panel with a one-click restore, satisfying the request
 * for "a gui element that takes note of fully hidden/closed options with
 * the option to reshow them."
 *
 * Hidden state is orthogonal to collapsed state: a panel can be expanded-
 * but-hidden or collapsed-but-hidden: hiding just adds `.panel-fully-hidden`
 * (a `display: none !important` in style.css) on top of whatever collapse
 * state it already had, and un-hiding restores exactly that prior state
 * with no other side effect.
 *
 * @module panelVisibility
 */

const STORAGE_KEY = 'godsEyeView.hiddenPanels.v1';

/** Panel ids that can never be added to the hidden set — the Hidden Panels
 * tray itself, since hiding it would remove the only way to un-hide
 * anything else. `hidePanel` refuses these outright (it doesn't even carry
 * a "×" button per bathymetryBox.js's pattern, but this guard makes it
 * impossible to hide by any other route too — e.g. a future "hide all"
 * helper, or a stray call passing the wrong id). */
const NEVER_HIDDEN_IDS = new Set(['restoretray-pad']);

/** Human labels for the restore tray — kept separate from live DOM text
 * since a hidden panel's own title may itself be hard to read/derive
 * reliably (e.g. control-panel's header is a whole `<button>`). */
export const PANEL_LABELS = {
  'pp-toggles': 'Display',
  'cctv-panel': 'CCTV',
  'global-context-panel': 'Context',
  'data-panel': 'Data Layers',
  'control-panel': 'Visual Presets',
  'location-bar': 'Location',
  'scene-panel': 'Scenes',
  // Every `buildMiniBox`-based box (camera controls, map overlays,
  // coordinates, HUD readouts, bathymetry, GPS tracks, about, ...)
  // self-registers its own label here via `registerPanelLabel` the moment
  // it's built, instead of needing an entry hardcoded in this list — see
  // `miniBox.js`. The handful of legacy `.panel-collapsible`-system panels
  // above (whose ids/titles live in `index.html`, not a shared factory)
  // are the only ones still listed by hand.
};

/**
 * Registers a hideable panel's human label for the restore tray, so a
 * box built via `buildMiniBox` doesn't also need a hand-maintained entry
 * in the static `PANEL_LABELS` map above. Safe to call more than once for
 * the same id (e.g. hot-reload) — later calls simply overwrite the label.
 * @param {string} id
 * @param {string} label
 */
export function registerPanelLabel(id, label) {
  if (!id || !label) return;
  PANEL_LABELS[id] = label;
}

function loadHidden() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    const ids = Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string' && !NEVER_HIDDEN_IDS.has(id)) : [];
    return new Set(ids);
  } catch {
    return new Set();
  }
}

function saveHidden(set) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...set]));
  } catch { /* storage unavailable */ }
}

const hidden = loadHidden();
const listeners = new Set();

function notify() {
  for (const fn of listeners) fn(getHiddenPanelIds());
}

function applyDom(id) {
  const el = document.getElementById(id);
  if (el) el.classList.toggle('panel-fully-hidden', hidden.has(id));
}

/** @param {string} id @returns {boolean} */
export function isPanelHidden(id) {
  return hidden.has(id);
}

/** @returns {string[]} ids of every currently-hidden panel, insertion order. */
export function getHiddenPanelIds() {
  return [...hidden];
}

/** @param {string} id */
export function hidePanel(id) {
  if (!id || hidden.has(id) || NEVER_HIDDEN_IDS.has(id)) return;
  hidden.add(id);
  saveHidden(hidden);
  applyDom(id);
  notify();
}

/** @param {string} id */
export function showPanel(id) {
  if (!id || !hidden.has(id)) return;
  hidden.delete(id);
  saveHidden(hidden);
  applyDom(id);
  notify();
}

/** Un-hides every currently-hidden panel — the "reset" half of panel state. */
export function showAllPanels() {
  if (!hidden.size) return;
  const ids = [...hidden];
  hidden.clear();
  saveHidden(hidden);
  for (const id of ids) applyDom(id);
  notify();
}

/**
 * Subscribe to hidden-set changes. Returns an unsubscribe function.
 * @param {(ids: string[]) => void} fn
 * @returns {() => void}
 */
export function subscribeHiddenPanels(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Applies whatever hidden-set was loaded from storage to the live DOM.
 * Call once at startup, after all 6 panel elements exist.
 */
export function applyStoredHiddenState() {
  for (const id of hidden) applyDom(id);
}
