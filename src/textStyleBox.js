import { buildMiniBox } from './miniBox.js';

/**
 * @file "Text Style" mini control box: a single place to globally scale the
 * size of every box's text (headers, body copy, buttons, Data Layer names)
 * and set the color every box's header title renders in. Per a direct user
 * ask ("create a Text size and colour mini box to control ALL text").
 *
 * How the two controls actually reach "ALL text":
 * - Color drives `--gev-text-color`, which the shared box-header-title rule
 *   (style.css, `[class$="-title"]` consolidation) reads for every box's
 *   title — headers everywhere update together.
 * - Size drives `--gev-text-scale` as a CSS `zoom` on every box's own outer
 *   container (`.panel-inner`/`.data-panel-inner`/.../`[class$="-pad"]`/
 *   `#gev-voice-control`, see style.css) rather than rewriting every one of
 *   the file's hundreds of hardcoded `font-size` declarations one at a time
 *   (which is what "in-box text, button text, data layer names" are made
 *   of, and don't share one common rule the way titles do). `zoom` scales
 *   an element's entire rendered box — text, buttons, row spacing, layer
 *   list — uniformly and (unlike `transform: scale()`) keeps mouse/click
 *   coordinates correct, without touching the Cesium globe canvas at all
 *   (that's a sibling element outside every box's container).
 *
 * Same movable/resizable/persisted-position/collapsible box mechanics as
 * the app's other mini-boxes (`miniBox.js`).
 *
 * @module textStyleBox
 */

const SCALE_KEY = 'godsEyeView.settings.textScale';
const COLOR_KEY = 'godsEyeView.settings.textColor';
const MIN_SCALE = 0.8;
const MAX_SCALE = 1.6;
const DEFAULT_SCALE = 1;
const DEFAULT_COLOR = '#ffffff';
const PRESET_COLORS = ['#ffffff', '#e8f0f4', '#7ec8ff', '#ffd27e', '#8effb0'];

function el(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html != null) node.innerHTML = html;
  return node;
}

function clampScale(value) {
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, value));
}

function loadStoredScale() {
  let raw;
  try { raw = localStorage.getItem(SCALE_KEY); } catch { raw = null; }
  const value = Number(raw);
  return Number.isFinite(value) ? clampScale(value) : DEFAULT_SCALE;
}

function loadStoredColor() {
  let raw;
  try { raw = localStorage.getItem(COLOR_KEY); } catch { raw = null; }
  return /^#[0-9a-fA-F]{6}$/.test(raw || '') ? raw : DEFAULT_COLOR;
}

function applyScale(scale) {
  document.documentElement.style.setProperty('--gev-text-scale', String(scale));
}

function applyColor(color) {
  document.documentElement.style.setProperty('--gev-text-color', color);
}

/** Applies whatever was last saved immediately, before this box's own UI
 * exists — same early-apply pattern as settingsDialog.js's panel-transparency
 * slider, so there's no flash of default size/color on load. Safe to call
 * at module load time, before any panel is in the DOM. */
export function restoreTextStyleEarly() {
  applyScale(loadStoredScale());
  applyColor(loadStoredColor());
}

export class TextStyleBox {
  constructor() {
    this._scale = loadStoredScale();
    this._color = loadStoredColor();
    this._build();
  }

  _build() {
    const box = buildMiniBox({
      idPrefix: 'textstyle',
      storagePrefix: 'godsEyeView.textStyleBox.',
      title: 'TEXT STYLE',
      ariaLabel: 'Text style controls: global text size and header color for every box',
      defaultWidth: 240,
      defaultHeight: 230,
      minWidth: 210,
      maxWidth: 360,
      minHeight: 190,
      maxHeight: 320,
      anchor: { left: '16px', bottom: 'calc(2vh + 4.5rem)' },
    });
    this._box = box;
    const body = box.body;

    const section = el('div', 'mapovl-section');
    section.appendChild(el('div', 'mapovl-section-title', 'ALL BOXES'));

    const sizeRow = el('div', 'mapovl-slider-row');
    sizeRow.appendChild(el('div', 'mapovl-slider-row-label', 'Text size'));
    const sizeInput = document.createElement('input');
    sizeInput.type = 'range';
    sizeInput.min = String(MIN_SCALE);
    sizeInput.max = String(MAX_SCALE);
    sizeInput.step = '0.05';
    sizeInput.value = String(this._scale);
    sizeInput.setAttribute('aria-label', 'Global text size');
    sizeRow.appendChild(sizeInput);
    const sizeScale = el('div', 'mapovl-slider-scale');
    sizeScale.appendChild(el('span', 'mapovl-slider-scale-tick', 'S'));
    sizeScale.appendChild(el('span', 'mapovl-slider-scale-tick', 'NORMAL'));
    sizeScale.appendChild(el('span', 'mapovl-slider-scale-tick', 'L'));
    sizeRow.appendChild(sizeScale);
    section.appendChild(sizeRow);
    sizeInput.addEventListener('input', () => {
      this._scale = clampScale(Number(sizeInput.value));
      applyScale(this._scale);
      try { localStorage.setItem(SCALE_KEY, String(this._scale)); } catch { /* storage unavailable */ }
    });

    const colorRow = el('label', 'mapovl-row');
    colorRow.appendChild(document.createTextNode('Header text color'));
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.className = 'mapovl-color';
    colorInput.value = this._color;
    colorRow.appendChild(colorInput);
    section.appendChild(colorRow);

    const swatchRow = el('div', 'textstyle-swatch-row');
    swatchRow.setAttribute('role', 'group');
    swatchRow.setAttribute('aria-label', 'Preset header text colors');
    const swatchButtons = PRESET_COLORS.map((hex) => {
      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = 'textstyle-swatch';
      swatch.style.setProperty('--swatch-color', hex);
      swatch.title = hex;
      swatch.setAttribute('aria-label', `Set header text color to ${hex}`);
      swatch.addEventListener('click', () => setColor(hex));
      swatchRow.appendChild(swatch);
      return swatch;
    });
    section.appendChild(swatchRow);

    const setColor = (hex) => {
      this._color = hex;
      colorInput.value = hex;
      applyColor(hex);
      try { localStorage.setItem(COLOR_KEY, hex); } catch { /* storage unavailable */ }
      for (const swatch of swatchButtons) {
        swatch.classList.toggle('is-active', swatch.style.getPropertyValue('--swatch-color') === hex);
      }
    };
    colorInput.addEventListener('input', () => setColor(colorInput.value));
    setColor(this._color);

    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'scene-btn';
    resetBtn.textContent = 'Reset to defaults';
    resetBtn.addEventListener('click', () => {
      sizeInput.value = String(DEFAULT_SCALE);
      this._scale = DEFAULT_SCALE;
      applyScale(DEFAULT_SCALE);
      try { localStorage.setItem(SCALE_KEY, String(DEFAULT_SCALE)); } catch { /* storage unavailable */ }
      setColor(DEFAULT_COLOR);
    });
    section.appendChild(resetBtn);

    body.appendChild(section);
  }

  destroy() {
    this._box.destroy();
  }
}

/** @returns {TextStyleBox} */
export function initTextStyleBox() {
  return new TextStyleBox();
}
