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
};

function loadHidden() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : []);
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
  if (!id || hidden.has(id)) return;
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
