/**
 * @file Single "render quality" lever tying together the handful of GPU-cost
 * knobs that were previously either hardcoded or untouched entirely (see the
 * 2026-09-03 perf scope pass): WebGL MSAA sample count, the Google
 * Photorealistic 3D Tileset's streaming detail (`maximumScreenSpaceError`/
 * `dynamicScreenSpaceError`), and the always-on unsharp-mask post-process
 * stage's enabled/intensity state.
 *
 * `balanced` is deliberately defined to equal exactly what the app already
 * shipped before this module existed (msaaSamples 4, Cesium's own stock
 * tileset SSE default of 16, sharpen on at its old hardcoded 2.1) — so a
 * fresh browser with nothing in localStorage yet renders IDENTICALLY to
 * before this was added; only a person who explicitly picks Performance or
 * Quality in Settings sees any change.
 *
 * Scope note: this does NOT touch per-layer entity/model caps (e.g.
 * flights.js's MODEL_MAX/MODEL_MAX_ALL) — those are baked into each data
 * layer's own module-level constants, and turning them into a live-tunable
 * setting would be a much larger refactor across every layer. The three
 * knobs here are the ones that are both genuinely GPU-cost-significant and
 * cheap to wire up as a single global lever.
 *
 * @module renderQuality
 */

const STORAGE_KEY = 'godsEyeView.renderQuality.tier';

/** Valid tier ids, in the fixed order the Settings UI presents them. */
export const TIERS = ['performance', 'balanced', 'quality'];

export const DEFAULT_TIER = 'balanced';

/** Human-readable label + one-line hint per tier, for the Settings UI. */
export const TIER_LABELS = {
  performance: { label: 'Performance', hint: 'Lowest GPU/battery cost — coarser tile detail, no MSAA, sharpen off.' },
  balanced: { label: 'Balanced', hint: 'The app\'s default look — unchanged from before this setting existed.' },
  quality: { label: 'Quality', hint: 'Sharper streamed tile detail, same MSAA/sharpen as Balanced.' },
};

/**
 * Per-tier values for every knob this module owns.
 *  - `msaaSamples`: WebGL multisample count (`scene.msaaSamples`) — 1 is
 *    effectively "off" (Cesium clamps to the nearest supported count; 1 is
 *    always supported and means no multisampling).
 *  - `tilesetSSE` / `tilesetDynamicSSE`: `Cesium3DTileset.maximumScreenSpaceError`
 *    (lower = sharper streamed detail = more tile downloads + GPU) and
 *    `dynamicScreenSpaceError` (lets Cesium relax detail further out
 *    automatically). 16/false are Cesium's own stock tileset defaults.
 *  - `sharpenAmount`: the unsharp-mask stage's `amount` uniform — `null`
 *    disables the stage outright rather than running it at zero effect.
 */
const TIER_SETTINGS = {
  performance: { msaaSamples: 1, tilesetSSE: 32, tilesetDynamicSSE: true, sharpenAmount: null },
  balanced: { msaaSamples: 4, tilesetSSE: 16, tilesetDynamicSSE: false, sharpenAmount: 2.1 },
  quality: { msaaSamples: 4, tilesetSSE: 8, tilesetDynamicSSE: false, sharpenAmount: 2.1 },
};

/** @param {string} tier @returns {boolean} */
export function isValidTier(tier) {
  return TIERS.includes(tier);
}

/** @returns {string} the last-saved tier, or {@link DEFAULT_TIER} if none/invalid is stored. */
export function loadStoredTier() {
  let raw;
  try { raw = localStorage.getItem(STORAGE_KEY); } catch { raw = null; }
  return isValidTier(raw) ? raw : DEFAULT_TIER;
}

/** @param {string} tier */
export function saveTier(tier) {
  if (!isValidTier(tier)) return;
  try { localStorage.setItem(STORAGE_KEY, tier); } catch { /* storage unavailable */ }
}

/**
 * Applies one tier's settings to whichever live targets are currently
 * available. Every target is optional and independently guarded — this is
 * safe to call before the tileset/sharpen stage exist yet (e.g. Google 3D
 * Tiles failed to load, or Settings applies the stored tier before main.js
 * has finished booting), in which case that target's knob is simply
 * skipped until a later call (main.js re-applies once everything is ready).
 * @param {string} tier
 * @param {{viewer?: import('cesium').Viewer, tileset?: import('cesium').Cesium3DTileset|null, sharpenStage?: import('cesium').PostProcessStage|null}} targets
 */
export function applyTier(tier, { viewer, tileset, sharpenStage } = {}) {
  const settings = TIER_SETTINGS[tier] || TIER_SETTINGS[DEFAULT_TIER];
  if (viewer?.scene) {
    viewer.scene.msaaSamples = settings.msaaSamples;
  }
  if (tileset) {
    tileset.maximumScreenSpaceError = settings.tilesetSSE;
    tileset.dynamicScreenSpaceError = settings.tilesetDynamicSSE;
  }
  if (sharpenStage) {
    if (settings.sharpenAmount == null) {
      sharpenStage.enabled = false;
    } else {
      sharpenStage.enabled = true;
      sharpenStage.uniforms.amount = settings.sharpenAmount;
    }
  }
}
