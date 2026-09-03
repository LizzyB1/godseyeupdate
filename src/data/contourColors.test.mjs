import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LAND_CONTOUR_PALETTE, DEPTH_CONTOUR_PALETTE, paletteColorHex } from './contourColors.js';

const HEX_RE = /^#[0-9a-f]{6}$/i;

/** Hue in degrees [0, 360) — channel-max/min comparisons alone misclassify
 * purple/magenta (which have blue as their largest channel, e.g. #8e24aa)
 * as "blue", so this goes through actual HSL hue instead. */
function hexToHue(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return 0; // grey
  let hue;
  if (max === r) hue = 60 * (((g - b) / delta) % 6);
  else if (max === g) hue = 60 * ((b - r) / delta + 2);
  else hue = 60 * ((r - g) / delta + 4);
  return hue < 0 ? hue + 360 : hue;
}

function isWhiteish(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return r > 230 && g > 230 && b > 230;
}

/** Green spans roughly 75-165°, cyan 165-195°, blue 195-255° — this bans
 * that whole 75-255° arc while allowing red/orange/yellow (<75°) and
 * purple/magenta/pink (255-345°) through. */
function isGreenCyanOrBlue(hex) {
  const hue = hexToHue(hex);
  return hue >= 75 && hue < 255;
}

test('both palettes are non-empty lists of valid hex colors', () => {
  for (const palette of [LAND_CONTOUR_PALETTE, DEPTH_CONTOUR_PALETTE]) {
    assert.ok(palette.length >= 2);
    for (const hex of palette) assert.match(hex, HEX_RE);
  }
});

test('no palette color reads as blue, green/cyan, or white', () => {
  for (const palette of [LAND_CONTOUR_PALETTE, DEPTH_CONTOUR_PALETTE]) {
    for (const hex of palette) {
      assert.equal(isWhiteish(hex), false, `${hex} reads as white`);
      assert.equal(isGreenCyanOrBlue(hex), false, `${hex} reads as green/cyan/blue (hue ${hexToHue(hex).toFixed(1)}°)`);
    }
  }
});

test('the land and depth palettes are distinct color sets (different scheme)', () => {
  const landSet = new Set(LAND_CONTOUR_PALETTE.map((c) => c.toLowerCase()));
  for (const hex of DEPTH_CONTOUR_PALETTE) assert.ok(!landSet.has(hex.toLowerCase()));
});

test('paletteColorHex cycles through the palette in order', () => {
  const palette = ['#111111', '#222222', '#333333'];
  assert.equal(paletteColorHex(palette, 0), '#111111');
  assert.equal(paletteColorHex(palette, 1), '#222222');
  assert.equal(paletteColorHex(palette, 2), '#333333');
  assert.equal(paletteColorHex(palette, 3), '#111111'); // wraps
  assert.equal(paletteColorHex(palette, 4), '#222222');
});

test('paletteColorHex handles negative indices by wrapping, never throwing', () => {
  const palette = ['#111111', '#222222', '#333333'];
  assert.equal(paletteColorHex(palette, -1), '#333333');
  assert.equal(paletteColorHex(palette, -3), '#111111');
});
