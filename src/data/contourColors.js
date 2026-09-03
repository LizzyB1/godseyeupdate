/**
 * @file Fixed, hand-picked color palettes for contour-line rendering — two
 * distinct schemes, one for land elevation contours and one for ocean depth
 * contours, so the two layers read as visually different from each other at
 * a glance. Within each palette, entries are ordered so that consecutive
 * levels — drawn right next to each other on screen — get contrasting
 * colors rather than blending into a gradient. Deliberately excludes blue,
 * white, and green: blue/cyan is reserved for the lat/lon grid, white for
 * HUD text, and green is used elsewhere in the app for status/traffic
 * colors — a contour line in any of those would get lost among them.
 *
 * `paletteColorHex` is the only lookup this module exposes: callers pick a
 * palette (land or depth) and an index (typically a level's position in its
 * sorted level list) and get back a cycling color, wrapping around once the
 * level count exceeds the palette size.
 *
 * @module data/contourColors
 */

/** Land elevation contours: a "fire/earth" scheme — reds, oranges, ambers, browns. */
export const LAND_CONTOUR_PALETTE = Object.freeze([
  '#e53935', // red
  '#ffb300', // amber
  '#5d4037', // dark brown
  '#fb8c00', // orange
  '#c62828', // deep red / maroon
  '#d4a017', // goldenrod
]);

/** Ocean depth contours: a "berry/sunset" scheme — purples, magentas, corals — visually distinct from the land palette's fire/earth tones, still excluding blue/white/green. */
export const DEPTH_CONTOUR_PALETTE = Object.freeze([
  '#8e24aa', // purple
  '#e64a19', // burnt orange
  '#ad1457', // deep magenta
  '#ff7043', // coral
  '#6a1b9a', // deep violet
  '#c2185b', // rose / crimson
]);

/**
 * @param {readonly string[]} palette
 * @param {number} index
 * @returns {string} hex color, cycling through `palette` by `index` (wraps for any integer, including negative).
 */
export function paletteColorHex(palette, index) {
  const n = palette.length;
  const i = ((index % n) + n) % n;
  return palette[i];
}
