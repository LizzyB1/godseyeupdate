/**
 * @file The bits the three overlay control boxes — `contoursBox.js`,
 * `gridBox.js`, `terrainBox.js` — all need, kept in one place now that the
 * single "MAP OVERLAYS" box they replaced no longer holds them.
 *
 * They also share that box's `mapovl-*` content styling (via `buildMiniBox`'s
 * `stylePrefix`), so the CSS did not have to be tripled either.
 *
 * @module overlayControlsKit
 */

/** Class prefix every overlay box wears, so one set of `mapovl-*` rules dresses all three. */
export const OVERLAY_STYLE_PREFIX = 'mapovl';

export function el(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html != null) node.innerHTML = html;
  return node;
}

/**
 * A small min/interim/max scale rendered under a `type="range"` slider —
 * plain evenly-spaced labels with a tick mark above each, not pixel-synced
 * to the actual thumb position via JS. That's fine here: every slider this
 * is used with has its labeled values evenly spaced across its own min-max
 * range, and a native range input's track is linear, so each label already
 * lines up with its value's real position on the track for free.
 * @param {string[]} labels - Evenly-spaced values from min to max, as display text.
 */
export function sliderScale(labels) {
  const row = el('div', 'mapovl-slider-scale');
  for (const label of labels) row.appendChild(el('span', 'mapovl-slider-scale-tick', label));
  return row;
}

/** A titled section container, matching the old box's section markup. */
export function section(title) {
  const node = el('div', 'mapovl-section');
  node.appendChild(el('div', 'mapovl-section-title', title));
  return node;
}
