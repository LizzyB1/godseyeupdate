import { API_KEY_DEFS, getApiKeyOverride, setApiKeyOverride } from './apiKeys.js';

/**
 * @file Settings dialog: gear icon (top-left) opening a small panel with —
 * a global "panel transparency" slider (drives `--gev-panel-bg-alpha`, the
 * one CSS variable every panel/box/chip's background reads through — see
 * style.css's `:root`), API key inputs (browser-local overrides, since a
 * page can't write the build's `.env` — see src/apiKeys.js) with a
 * Save & Reload button, and a Reset panel layout action for
 * src/panelDrag.js's draggable panels.
 *
 * Deliberately independent of the main Cesium bootstrap in main.js
 * (initialized at module load, not inside main.js's async init()/try
 * block) so a person who's missing an API key entirely — the one case
 * where the app itself fails to boot — can still open this dialog and add
 * one, rather than being stuck on an error screen with no way to recover
 * without editing `.env` on disk.
 *
 * @module settingsDialog
 */

const OPACITY_STORAGE_KEY = 'godsEyeView.settings.panelBgAlpha';
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

export class SettingsDialog {
  constructor() {
    restoreAlphaEarly();
    this._build();
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

    const apiKeyRows = API_KEY_DEFS.map((def) => `
      <label class="gev-settings-field" for="gev-key-${def.id}">
        <span class="gev-settings-field-label">${def.label}</span>
        <input type="password" id="gev-key-${def.id}" class="gev-settings-input"
          data-key-id="${def.id}" autocomplete="off" spellcheck="false"
          placeholder="${getApiKeyOverride(def.id) ? '•••••••• (saved — leave blank to keep)' : 'not set — using build default, if any'}">
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
        <h3 class="gev-settings-section-title">API keys</h3>
        <p class="gev-settings-section-help">
          A running page can't edit this project's <code>.env</code> file directly — a key saved here
          is stored only in this browser and takes priority over the build's own key. Saving reloads
          the page so every module picks it up cleanly.
        </p>
        ${apiKeyRows}
        <div class="gev-settings-actions">
          <button type="button" id="gev-settings-save-keys" class="gev-settings-btn gev-settings-btn-primary">Save &amp; Reload</button>
          <button type="button" id="gev-settings-clear-keys" class="gev-settings-btn">Clear saved keys</button>
        </div>
      </section>

      <section class="gev-settings-section">
        <h3 class="gev-settings-section-title">Panel layout</h3>
        <p class="gev-settings-section-help">Data Layers / CCTV / Scenes / Display can be dragged free by their grip handle (⠿) and resized from their right edge.</p>
        <div class="gev-settings-actions">
          <button type="button" id="gev-settings-reset-layout" class="gev-settings-btn">Reset panel positions</button>
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

    dialog.querySelector('#gev-settings-reset-layout').addEventListener('click', () => {
      window.__godsEyeView?.panelDrag?.resetAll?.();
      this._flashStatus(dialog, 'Panel positions reset.');
    });
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

  setOpen(open) {
    this._backdrop.hidden = !open;
    this._toggle.classList.toggle('is-active', open);
    this._toggle.setAttribute('aria-pressed', String(open));
    if (open) this._dialog.querySelector('.gev-settings-close')?.focus();
  }
}

/** @returns {SettingsDialog} */
export function initSettingsDialog() {
  return new SettingsDialog();
}
