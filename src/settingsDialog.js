import { API_KEY_DEFS, getApiKeyOverride, setApiKeyOverride } from './apiKeys.js';
import { FIRST_RUN_MISSIONS, environmentalLabel, runFirstRunChoice } from './firstRunExperience.js';
import { SERVER_API_KEY_DEFS } from './data/sessionSettings.js';
import { saveSessionSettings } from './sessionSettingsClient.js';
import { showAllPanels } from './panelVisibility.js';
import { TIERS, TIER_LABELS, loadStoredTier, saveTier, applyTier } from './renderQuality.js';

/** Panels reset to their as-shipped collapsed state by "Reset panel layout" — every id
 * that participates in the generic `.panel-collapse-btn[data-collapse-target]` mechanism. */
const RESETTABLE_COLLAPSE_PANEL_IDS = [
  'pp-toggles', 'param-slider-panel', 'location-bar', 'data-panel',
  'cctv-panel', 'scene-panel', 'global-context-panel', 'radio-panel',
];

/**
 * @file Settings dialog: gear icon (top-left) opening a small panel with —
 * a global "panel transparency" slider (drives `--gev-panel-bg-alpha`, the
 * one CSS variable every panel/box/chip's background reads through — see
 * style.css's `:root`), client API key inputs (browser-local overrides,
 * since a page can't write the build's `.env` — see src/apiKeys.js) with a
 * Save & Reload button, server-side API key inputs (FIRMS/TomTom/AISStream/
 * OpenAI/OpenSky — the ones `.env.example` documents as SERVER-SIDE ONLY,
 * previously missing from this dialog entirely — persisted through
 * `/api/settings` into the transportable `gev.settings.json` file, see
 * src/data/sessionSettings.js and src/sessionSettingsClient.js), a Mission
 * section that runs the same starting scenarios the old auto-popping
 * first-run launcher offered (see src/firstRunExperience.js — this dialog
 * reuses its mission table and runner, just triggered on demand instead of
 * automatically on load), and a Reset panel layout action for
 * src/panelDrag.js's draggable panels.
 *
 * Deliberately independent of the main Cesium bootstrap in main.js
 * (initialized at module load, not inside main.js's async init()/try
 * block) so a person who's missing an API key entirely — the one case
 * where the app itself fails to boot — can still open this dialog and add
 * one, rather than being stuck on an error screen with no way to recover
 * without editing `.env` on disk. The Mission section's buttons stay
 * disabled until `attachMissionRunner()` is called with a live
 * styleManager/dataManager — which never happens on a failed boot, so they
 * correctly stay inert rather than throwing against objects that don't
 * exist yet.
 *
 * @module settingsDialog
 */

/** Build-time values for the two CLIENT-EXPOSED keys (see apiKeys.js) — read
 * once via literal `import.meta.env.<ID>` accesses (Vite's `define` only
 * rewrites static property access, not a dynamic lookup) so the Settings
 * placeholder can say "using your .env value" instead of a vague "if any". */
const BUILD_TIME_CLIENT_KEYS = {
  CESIUM_ION_TOKEN: import.meta.env.CESIUM_ION_TOKEN,
  GOOGLE_MAPS_API_KEY: import.meta.env.GOOGLE_MAPS_API_KEY,
};

/** Exported so main.js's session-settings restore/autosave (src/sessionSettingsClient.js)
 * can read/write the same localStorage entry without a private hook into this module. */
export const OPACITY_STORAGE_KEY = 'godsEyeView.settings.panelBgAlpha';
const MIN_ALPHA = 0.2;
const MAX_ALPHA = 0.95;
const DEFAULT_ALPHA = 0.72;

function clampAlpha(value) {
  return Math.max(MIN_ALPHA, Math.min(MAX_ALPHA, value));
}

function applyAlpha(alpha) {
  document.documentElement.style.setProperty('--gev-panel-bg-alpha', String(alpha));
}

function loadStoredAlpha() {
  let raw;
  try { raw = localStorage.getItem(OPACITY_STORAGE_KEY); } catch { raw = null; }
  const value = Number(raw);
  return Number.isFinite(value) ? clampAlpha(value) : DEFAULT_ALPHA;
}

function saveAlpha(alpha) {
  try { localStorage.setItem(OPACITY_STORAGE_KEY, String(alpha)); } catch { /* storage unavailable */ }
}

/** Applies the last-saved transparency immediately, before the dialog UI itself exists. */
function restoreAlphaEarly() {
  applyAlpha(loadStoredAlpha());
}

/** Missions offered from Settings — every FIRST_RUN_MISSIONS entry except
 * the no-op 'explore' choice, which has nothing to run from a dialog. */
const SETTINGS_MISSION_CHOICES = ['contacts', 'space-missions', 'environmental'];

export class SettingsDialog {
  constructor() {
    restoreAlphaEarly();
    /** Set by attachRenderTargets() once the viewer/tileset/sharpen stage exist — see that method. */
    this._renderTargets = null;
    this._renderQualityTier = loadStoredTier();
    /** Set by attachMissionRunner() once styleManager/dataManager exist. */
    this._missionDeps = null;
    this._missionBusy = false;
    /** @type {?Array<{id:string,label:string,help:string,configured:boolean,source:string}>} */
    this._serverKeyStatus = null;
    this._build();
    void this._loadServerKeyStatus();
  }

  _build() {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.id = 'gev-settings-toggle';
    toggle.className = 'gev-settings-toggle';
    toggle.title = 'Settings';
    toggle.setAttribute('aria-label', 'Open settings');
    toggle.setAttribute('aria-pressed', 'false');
    toggle.textContent = '⚙';
    document.body.appendChild(toggle);
    this._toggle = toggle;

    const backdrop = document.createElement('div');
    backdrop.id = 'gev-settings-backdrop';
    backdrop.className = 'gev-settings-backdrop';
    backdrop.hidden = true;

    const dialog = document.createElement('div');
    dialog.className = 'gev-settings-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'gev-settings-title');

    const apiKeyRows = API_KEY_DEFS.map((def) => {
      let placeholder;
      if (getApiKeyOverride(def.id)) placeholder = '•••••••• (saved here — leave blank to keep)';
      else if (BUILD_TIME_CLIENT_KEYS[def.id]) placeholder = 'using your .env value — leave blank to keep';
      else placeholder = 'not set — add a key or the app can\'t start';
      return `
      <label class="gev-settings-field" for="gev-key-${def.id}">
        <span class="gev-settings-field-label">${def.label}</span>
        <input type="password" id="gev-key-${def.id}" class="gev-settings-input"
          data-key-id="${def.id}" autocomplete="off" spellcheck="false"
          placeholder="${placeholder}">
        <span class="gev-settings-field-help">${def.help}</span>
      </label>
    `;
    }).join('');

    const serverKeyRows = SERVER_API_KEY_DEFS.map((def) => `
      <label class="gev-settings-field" for="gev-server-key-${def.id}">
        <span class="gev-settings-field-label">${def.label}</span>
        <input type="password" id="gev-server-key-${def.id}" class="gev-settings-input"
          data-server-key-id="${def.id}" autocomplete="off" spellcheck="false"
          placeholder="checking…">
        <span class="gev-settings-field-help">${def.help}</span>
      </label>
    `).join('');

    dialog.innerHTML = `
      <div class="gev-settings-header">
        <span id="gev-settings-title">SETTINGS</span>
        <button type="button" class="gev-settings-close" aria-label="Close settings">×</button>
      </div>

      <section class="gev-settings-section">
        <h3 class="gev-settings-section-title">Panel transparency</h3>
        <p class="gev-settings-section-help">One slider controls every panel, box, and chip's background — including the text-backing boxes behind HUD readouts.</p>
        <div class="gev-settings-slider-row">
          <span aria-hidden="true">◐</span>
          <input type="range" id="gev-opacity-slider" min="${MIN_ALPHA}" max="${MAX_ALPHA}" step="0.01">
          <span aria-hidden="true">◑</span>
        </div>
      </section>

      <section class="gev-settings-section">
        <h3 class="gev-settings-section-title">Render quality</h3>
        <p class="gev-settings-section-help">Trades streamed tile detail, antialiasing, and the sharpen effect for GPU/battery cost. "Balanced" is how the app has always looked — pick "Performance" on an integrated GPU or laptop battery.</p>
        <div class="mapovl-row" id="gev-settings-quality-row">
          ${TIERS.map((tier) => `<button type="button" class="mapovl-btn" data-quality-tier="${tier}" title="${TIER_LABELS[tier].hint}">${TIER_LABELS[tier].label}</button>`).join('')}
        </div>
      </section>

      <section class="gev-settings-section">
        <h3 class="gev-settings-section-title">Mission</h3>
        <p class="gev-settings-section-help">
          Jump straight into a starting scenario — each one enables its layers/context exactly like
          clicking them yourself. This replaces the picker that used to pop up automatically on load.
        </p>
        <div class="gev-settings-mission-grid">
          <button type="button" class="gev-settings-mission-btn" data-mission="contacts" disabled title="Loading…">
            <strong>Live Contacts</strong>
            <small>Aircraft, vessels and nearby intelligence</small>
          </button>
          <button type="button" class="gev-settings-mission-btn" data-mission="space-missions" disabled title="Loading…">
            <strong>Space Missions</strong>
            <small>Launches, spacecraft and orbital context</small>
          </button>
          <button type="button" class="gev-settings-mission-btn" data-mission="environmental" disabled title="Loading…">
            <strong data-mission-environmental-title>${environmentalLabel().title}</strong>
            <small>Live earthquakes and active fires, from USGS and NASA</small>
          </button>
        </div>
      </section>

      <section class="gev-settings-section">
        <h3 class="gev-settings-section-title">API keys — client</h3>
        <p class="gev-settings-section-help">
          Cesium and Google Maps run in the browser, so these two keys ship inside the page itself —
          a key saved here is stored only in this browser and takes priority over the build's own key.
          Saving reloads the page so every module picks it up cleanly.
        </p>
        ${apiKeyRows}
        <div class="gev-settings-actions">
          <button type="button" id="gev-settings-save-keys" class="gev-settings-btn gev-settings-btn-primary">Save &amp; Reload</button>
          <button type="button" id="gev-settings-clear-keys" class="gev-settings-btn">Clear saved keys</button>
        </div>
      </section>

      <section class="gev-settings-section">
        <h3 class="gev-settings-section-title">API keys — server</h3>
        <p class="gev-settings-section-help">
          These live data feeds (fires, traffic, AIS, voice, aircraft) run their key server-side and
          never send it to the browser. A key saved here is written to <code>gev.settings.json</code>
          at the project root — git-ignored, same as <code>.env</code>, and carried along if you copy
          that file into a new clone — and takes effect immediately, no reload needed.
        </p>
        ${serverKeyRows}
        <div class="gev-settings-actions">
          <button type="button" id="gev-settings-save-server-keys" class="gev-settings-btn gev-settings-btn-primary">Save server keys</button>
          <button type="button" id="gev-settings-clear-server-keys" class="gev-settings-btn">Clear saved server keys</button>
        </div>
      </section>

      <section class="gev-settings-section">
        <h3 class="gev-settings-section-title">Panel layout</h3>
        <p class="gev-settings-section-help">Data Layers / CCTV / Scenes / Display / Context can be dragged free by their grip handle (⠿) and resized from their right edge. Every panel can also be collapsed to a strip or fully hidden with its own "×" — hidden panels list in the "Hidden panels" tray for one-click restore.</p>
        <div class="gev-settings-actions">
          <button type="button" id="gev-settings-reset-layout" class="gev-settings-btn">Reset all panels</button>
        </div>
      </section>
    `;
    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);
    this._backdrop = backdrop;
    this._dialog = dialog;

    toggle.addEventListener('click', () => this.setOpen(backdrop.hidden));
    dialog.querySelector('.gev-settings-close').addEventListener('click', () => this.setOpen(false));
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) this.setOpen(false);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !backdrop.hidden) this.setOpen(false);
    });

    const slider = dialog.querySelector('#gev-opacity-slider');
    slider.value = String(loadStoredAlpha());
    slider.addEventListener('input', () => {
      const alpha = clampAlpha(Number(slider.value));
      applyAlpha(alpha);
      saveAlpha(alpha);
    });

    this._qualityButtons = [...dialog.querySelectorAll('[data-quality-tier]')];
    this._markActiveQualityTier();
    for (const button of this._qualityButtons) {
      button.addEventListener('click', () => {
        this._renderQualityTier = button.dataset.qualityTier;
        saveTier(this._renderQualityTier);
        this._markActiveQualityTier();
        if (this._renderTargets) applyTier(this._renderQualityTier, this._renderTargets);
      });
    }

    for (const button of dialog.querySelectorAll('[data-mission]')) {
      button.addEventListener('click', () => this._runMission(button.dataset.mission));
    }

    dialog.querySelector('#gev-settings-save-keys').addEventListener('click', () => {
      let changed = false;
      for (const def of API_KEY_DEFS) {
        const input = dialog.querySelector(`#gev-key-${def.id}`);
        const value = input.value.trim();
        if (!value) continue; // blank = keep whatever's already saved
        setApiKeyOverride(def.id, value);
        changed = true;
      }
      if (changed) {
        window.location.reload();
      } else {
        this._flashStatus(dialog, 'Nothing to save — enter a key first, or it\'s already saved.');
      }
    });

    dialog.querySelector('#gev-settings-clear-keys').addEventListener('click', () => {
      for (const def of API_KEY_DEFS) setApiKeyOverride(def.id, '');
      window.location.reload();
    });

    dialog.querySelector('#gev-settings-save-server-keys').addEventListener('click', () => {
      void this._saveServerKeys(dialog);
    });

    dialog.querySelector('#gev-settings-clear-server-keys').addEventListener('click', () => {
      void this._saveServerKeys(dialog, { clearAll: true });
    });

    dialog.querySelector('#gev-settings-reset-layout').addEventListener('click', () => {
      // Position/width (the panels panelDrag.js manages), collapsed state
      // (every panel that participates in the generic collapse mechanism),
      // and fully-hidden state (panelVisibility.js) are three independent
      // pieces of per-panel state — a full reset clears all three together.
      window.__godsEyeView?.panelDrag?.resetAll?.();
      const setCollapsed = window.__godsEyeView?.styleManager?.setPanelCollapsed?.bind(
        window.__godsEyeView.styleManager,
      );
      if (setCollapsed) {
        for (const id of RESETTABLE_COLLAPSE_PANEL_IDS) setCollapsed(id, true);
      }
      showAllPanels();
      this._flashStatus(dialog, 'Panel layout, collapsed state, and hidden panels reset.');
    });
  }

  /**
   * Fetch server-side key configured/source status from `/api/settings` and
   * update each row's placeholder to reflect it. Never shows a secret value
   * (the endpoint doesn't return one) — only whether one is set and whether
   * it came from the transportable file or `.env`/shell.
   */
  async _loadServerKeyStatus() {
    try {
      const response = await fetch('/api/settings', { headers: { Accept: 'application/json' } });
      if (!response.ok) return;
      const data = await response.json();
      this._serverKeyStatus = Array.isArray(data?.apiKeyStatus) ? data.apiKeyStatus : null;
    } catch {
      this._serverKeyStatus = null;
    }
    if (!this._serverKeyStatus) return;
    for (const status of this._serverKeyStatus) {
      const input = this._dialog?.querySelector(`[data-server-key-id="${status.id}"]`);
      if (!input) continue;
      if (status.source === 'file') input.placeholder = '•••••••• (saved here — leave blank to keep)';
      else if (status.source === 'env') input.placeholder = 'using your .env value — leave blank to keep';
      else input.placeholder = 'not set';
    }
  }

  /**
   * Save (or clear) server-side API keys via `PUT /api/settings`, then
   * refresh each row's status from the response instead of re-fetching.
   * @param {HTMLElement} dialog
   * @param {{clearAll?: boolean}} [opts]
   */
  async _saveServerKeys(dialog, { clearAll = false } = {}) {
    const patchApiKeys = {};
    let changed = false;
    for (const def of SERVER_API_KEY_DEFS) {
      if (clearAll) {
        patchApiKeys[def.id] = '';
        changed = true;
        continue;
      }
      const input = dialog.querySelector(`[data-server-key-id="${def.id}"]`);
      const value = input?.value.trim() || '';
      if (!value) continue; // blank = keep whatever's already saved
      patchApiKeys[def.id] = value;
      changed = true;
    }
    if (!changed) {
      this._flashStatus(dialog, 'Nothing to save — enter a key first, or it\'s already saved.');
      return;
    }
    const result = await saveSessionSettings({ apiKeys: patchApiKeys });
    if (!result?.ok) {
      this._flashStatus(dialog, 'Could not save server keys — is the dev server running?');
      return;
    }
    this._serverKeyStatus = Array.isArray(result.apiKeyStatus) ? result.apiKeyStatus : null;
    for (const def of SERVER_API_KEY_DEFS) {
      const input = dialog.querySelector(`[data-server-key-id="${def.id}"]`);
      if (input) input.value = '';
    }
    for (const status of this._serverKeyStatus || []) {
      const input = dialog.querySelector(`[data-server-key-id="${status.id}"]`);
      if (!input) continue;
      if (status.source === 'file') input.placeholder = '•••••••• (saved here — leave blank to keep)';
      else if (status.source === 'env') input.placeholder = 'using your .env value — leave blank to keep';
      else input.placeholder = 'not set';
    }
    this._flashStatus(dialog, clearAll ? 'Server keys cleared.' : 'Server keys saved — takes effect immediately.');
  }

  _markActiveQualityTier() {
    for (const button of this._qualityButtons || []) {
      button.classList.toggle('is-active', button.dataset.qualityTier === this._renderQualityTier);
    }
  }

  /**
   * Wires the "Render quality" control up to the live Cesium objects it
   * actually controls, and immediately applies whichever tier was last
   * saved (or the default) to them. Called from main.js once the viewer,
   * the Google 3D Tileset (may be null — the app falls back to the plain
   * Cesium globe when Google 3D Tiles fail to load, in which case the
   * tileset-detail knob is simply inert until a stack switch adds one),
   * and the sharpen post-process stage all exist — this dialog is built
   * at module load time, well before any of those, so it can't reach them
   * on its own.
   * @param {{viewer: import('cesium').Viewer, tileset: import('cesium').Cesium3DTileset|null, sharpenStage: import('cesium').PostProcessStage|null}} targets
   */
  attachRenderTargets(targets) {
    this._renderTargets = targets;
    applyTier(this._renderQualityTier, targets);
  }

  _flashStatus(dialog, text) {
    clearTimeout(this._statusTimer);
    let status = dialog.querySelector('.gev-settings-status');
    if (!status) {
      status = document.createElement('div');
      status.className = 'gev-settings-status';
      dialog.appendChild(status);
    }
    status.textContent = text;
    status.classList.add('visible');
    this._statusTimer = window.setTimeout(() => status.classList.remove('visible'), 2400);
  }

  /**
   * Apply a panel transparency value restored from the transportable session
   * file (see main.js's boot sequence / src/data/sessionSettings.js). Unlike
   * the slider's own `input` handler this may fire AFTER `_build()` already
   * rendered the slider from whatever `localStorage` held at module-load
   * time (the file fetch is async, `_build()` is not) — so this also
   * corrects the live slider element, not just the stored/applied value.
   * @param {number} alpha
   */
  applyPanelAlpha(alpha) {
    const value = Number(alpha);
    if (!Number.isFinite(value)) return;
    const clamped = clampAlpha(value);
    applyAlpha(clamped);
    saveAlpha(clamped);
    const slider = this._dialog?.querySelector('#gev-opacity-slider');
    if (slider) slider.value = String(clamped);
  }

  setOpen(open) {
    this._backdrop.hidden = !open;
    this._toggle.classList.toggle('is-active', open);
    this._toggle.setAttribute('aria-pressed', String(open));
    if (open) this._dialog.querySelector('.gev-settings-close')?.focus();
  }

  /**
   * Enable the Mission section once the app has actually booted. Called from
   * main.js after styleManager/dataManager exist — never on a failed boot
   * (missing API key), so the buttons correctly stay disabled there instead
   * of running a mission against objects that don't exist.
   * @param {{styleManager: object, dataManager: object}} deps
   */
  attachMissionRunner({ styleManager, dataManager }) {
    this._missionDeps = { styleManager, dataManager };
    const title = this._dialog.querySelector('[data-mission-environmental-title]');
    if (title) title.textContent = environmentalLabel().title;
    for (const button of this._dialog.querySelectorAll('[data-mission]')) {
      button.disabled = false;
      button.title = '';
    }
  }

  /**
   * Run one mission choice through the same table/runner the old auto-
   * popping launcher used (src/firstRunExperience.js) — a mission tile here
   * is a real person choosing it, so layers persist exactly as clicking
   * those rows would (`origin: 'user'`).
   * @param {string} choice - One of SETTINGS_MISSION_CHOICES.
   */
  async _runMission(choice) {
    if (!this._missionDeps || this._missionBusy || !SETTINGS_MISSION_CHOICES.includes(choice)) return;
    const { styleManager, dataManager } = this._missionDeps;
    const mission = FIRST_RUN_MISSIONS[choice];
    this._missionBusy = true;
    this._flashStatus(this._dialog, mission?.busyText || 'Working…');
    let outcome = null;
    try {
      outcome = await runFirstRunChoice(choice, {
        setContextMode: async (mode) => {
          const result = await styleManager.setContextMode(mode);
          if (result?.ok) {
            styleManager.setPanelCollapsed?.('global-context-panel', false, { explicit: true });
          }
          return result;
        },
        setLayerEnabled: (layerId) => dataManager.setEnabled(layerId, true, { origin: 'user' }),
        flyToGlobe: () => styleManager.resetToGlobeView(),
      });
    } catch (error) {
      console.warn('[Settings] Mission launch failed:', error);
    }
    this._missionBusy = false;
    if (outcome?.ok) {
      this._flashStatus(this._dialog, 'Mission started.');
      this.setOpen(false);
      return;
    }
    const failed = outcome?.failedLayerIds?.length ? outcome.failedLayerIds : outcome?.result?.failedLayerIds;
    const detail = Array.isArray(failed) && failed.length ? ` (${failed.join(', ')})` : '';
    this._flashStatus(this._dialog, `Could not start that mission${detail}.`);
  }
}

/** @returns {SettingsDialog} */
export function initSettingsDialog() {
  return new SettingsDialog();
}
