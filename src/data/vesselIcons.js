// src/data/vesselIcons.js
/**
 * Bow-up plan-view vessel silhouettes, one per AIS type family, as SVG bodies
 * for the billboard icons in aisLiveVessels.js.
 *
 * Every vessel used to be the same chevron in a different colour, so a tug and
 * a VLCC read identically at a glance. These are drawn from above in a 32-unit
 * box (centre 16,16, bow toward -Y so billboard rotation still maps straight to
 * heading) and differ by PLANFORM — hull length-to-beam, superstructure
 * position, deck furniture — so the type is readable at ~24px without relying
 * on the colour, which stays owned by vesselLabels.js.
 *
 * Drawn here rather than sourced: the published silhouette sets are either
 * unlicensed or non-commercial, and a dozen deck plans are cheaper to draw than
 * to license.
 */

import { normalizeVesselType } from './vesselLabels.js';

/** Type family → silhouette id. First match wins, so specifics precede families. */
const SHAPE_PATTERNS = [
  { pattern: /tanker/i, shape: 'tanker' },
  { pattern: /container/i, shape: 'container' },
  { pattern: /cargo|bulk|carrier|dredg/i, shape: 'cargo' },
  { pattern: /passenger|cruise|ferry/i, shape: 'passenger' },
  { pattern: /high-speed|hsc/i, shape: 'highSpeed' },
  { pattern: /fishing|trawl/i, shape: 'fishing' },
  { pattern: /tug|tow|pilot|tender|supply|service|sar|anti-pollution/i, shape: 'tug' },
  { pattern: /military|law|patrol|naval|warship/i, shape: 'military' },
  { pattern: /sailing|yacht/i, shape: 'sailing' },
  { pattern: /pleasure|craft/i, shape: 'pleasure' },
];
const DEFAULT_SHAPE = 'cargo';

/**
 * Which silhouette an AIS type gets.
 * @param {string} type Raw AIS type (numeric code or text).
 * @returns {string} Shape id, always one of SHAPES.
 */
export function vesselShapeId(type) {
  const text = normalizeVesselType(type);
  const found = SHAPE_PATTERNS.find((entry) => entry.pattern.test(text));
  return found ? found.shape : DEFAULT_SHAPE;
}

/**
 * Hull outlines in a centred frame (0,0 = icon centre, bow toward -Y). `hull`
 * is the filled body; `deck` is drawn over it in the stroke colour to carry
 * superstructure and deck detail.
 */
const SHAPES = {
  // Long, full-bodied hull; bridge right aft, pipework down the centreline.
  tanker: {
    hull: 'M0,-14 C 3.4,-11 4.6,-6 4.6,0 L 4.6,11 L 3.4,13 L -3.4,13 L -4.6,11 L -4.6,0 C -4.6,-6 -3.4,-11 0,-14 Z',
    deck: '<rect x="-3.6" y="7.4" width="7.2" height="4.4" rx="0.8"/><rect x="-0.9" y="-7" width="1.8" height="12"/>',
  },
  // Same long hull, bridge aft, but a stacked box grid forward — the giveaway.
  container: {
    hull: 'M0,-14 C 3.6,-11 4.8,-6 4.8,0 L 4.8,11 L 3.6,13 L -3.6,13 L -4.8,11 L -4.8,0 C -4.8,-6 -3.6,-11 0,-14 Z',
    deck: '<rect x="-3.8" y="8" width="7.6" height="4" rx="0.7"/>'
      + '<rect x="-3.4" y="-8" width="6.8" height="14.4" rx="0.5" fill="none" stroke-width="0.9"/>'
      + '<line x1="0" y1="-8" x2="0" y2="6.4"/><line x1="-3.4" y1="-3.2" x2="3.4" y2="-3.2"/>'
      + '<line x1="-3.4" y1="1.6" x2="3.4" y2="1.6"/>',
  },
  // General cargo: hatches amidships, kingposts, bridge aft.
  cargo: {
    hull: 'M0,-13.5 C 3.4,-10.5 4.4,-6 4.4,0 L 4.4,10.5 L 3.2,12.5 L -3.2,12.5 L -4.4,10.5 L -4.4,0 C -4.4,-6 -3.4,-10.5 0,-13.5 Z',
    deck: '<rect x="-3.4" y="7.6" width="6.8" height="4" rx="0.7"/>'
      + '<rect x="-2.6" y="-7" width="5.2" height="4" rx="0.6"/><rect x="-2.6" y="-1" width="5.2" height="4" rx="0.6"/>',
  },
  // Cruise/ferry: broad hull almost fully covered by superstructure.
  passenger: {
    hull: 'M0,-13 C 4.4,-10 5.6,-5 5.6,1 L 5.6,10.5 L 4.2,12.5 L -4.2,12.5 L -5.6,10.5 L -5.6,1 C -5.6,-5 -4.4,-10 0,-13 Z',
    deck: '<rect x="-3.8" y="-6.5" width="7.6" height="16.5" rx="2.2"/>'
      + '<line x1="-3.8" y1="-1" x2="3.8" y2="-1" stroke-width="0.8"/>'
      + '<line x1="-3.8" y1="4.5" x2="3.8" y2="4.5" stroke-width="0.8"/>',
  },
  // Catamaran wave-piercer: two slim hulls under one bridging deck.
  highSpeed: {
    hull: 'M-5.4,-9 C -3.4,-11.5 -2.4,-8 -2.4,-3 L -2.4,11 L -5.4,11 Z '
      + 'M5.4,-9 C 3.4,-11.5 2.4,-8 2.4,-3 L 2.4,11 L 5.4,11 Z '
      + 'M-5.4,-1 L 5.4,-1 L 5.4,8 L -5.4,8 Z',
    deck: '<rect x="-2.6" y="0.5" width="5.2" height="5" rx="1"/>',
  },
  // Trawler: short chunky hull, wheelhouse forward, gantry over the stern.
  fishing: {
    hull: 'M0,-9 C 3.2,-6.5 4,-3 4,1 L 4,7.5 L 2.6,9.5 L -2.6,9.5 L -4,7.5 L -4,1 C -4,-3 -3.2,-6.5 0,-9 Z',
    deck: '<rect x="-2.4" y="-5" width="4.8" height="4.4" rx="0.8"/>'
      + '<line x1="-3.4" y1="6.4" x2="3.4" y2="6.4" stroke-width="1.1"/>'
      + '<line x1="0" y1="-0.6" x2="0" y2="6.4" stroke-width="0.8"/>',
  },
  // Tug: stubby, beamy, wheelhouse forward and a towing deck aft.
  tug: {
    hull: 'M0,-7.5 C 3.4,-5.5 4.2,-2.5 4.2,1 L 4.2,6.5 L 2.8,8.5 L -2.8,8.5 L -4.2,6.5 L -4.2,1 C -4.2,-2.5 -3.4,-5.5 0,-7.5 Z',
    deck: '<rect x="-2.6" y="-4.2" width="5.2" height="5" rx="1"/>'
      + '<circle cx="0" cy="4.6" r="1.5" fill="none" stroke-width="0.9"/>',
  },
  // Warship: fine bow, slab sides, mast amidships, flight deck aft.
  military: {
    hull: 'M0,-14.5 C 2.2,-11 3.4,-7 3.6,-2 L 3.6,10 L 2.4,12 L -2.4,12 L -3.6,10 L -3.6,-2 C -3.4,-7 -2.2,-11 0,-14.5 Z',
    deck: '<rect x="-2.4" y="-6" width="4.8" height="6" rx="0.6"/>'
      + '<path d="M0,-6.5 L 1.6,-2 L -1.6,-2 Z"/>'
      + '<rect x="-2.6" y="5.5" width="5.2" height="5.4" rx="0.8" fill="none" stroke-width="0.9"/>',
  },
  // Sailing yacht: narrow pointed hull with mast and boom on the centreline.
  sailing: {
    hull: 'M0,-11 C 2.2,-7 2.8,-3 2.8,1 L 2.8,8 L 1.8,9.5 L -1.8,9.5 L -2.8,8 L -2.8,1 C -2.8,-3 -2.2,-7 0,-11 Z',
    deck: '<circle cx="0" cy="-1.5" r="1.2"/><line x1="0" y1="-1.5" x2="0" y2="7.5" stroke-width="0.9"/>',
  },
  // Motor yacht/small craft: rounded planing hull, cabin forward of centre.
  pleasure: {
    hull: 'M0,-8.5 C 2.6,-6 3.2,-3 3.2,0.5 L 3.2,7 L 2,8.8 L -2,8.8 L -3.2,7 L -3.2,0.5 C -3.2,-3 -2.6,-6 0,-8.5 Z',
    deck: '<rect x="-1.9" y="-4.4" width="3.8" height="5.4" rx="1.4"/>',
  },
};

/**
 * The SVG for one vessel silhouette.
 * @param {string} type Raw AIS type.
 * @param {string} fill Hull fill colour (the type hue, or white when selected).
 * @param {{stroke: string, strokeWidth: number}} edge Outline colour/width.
 * @returns {string} Complete 32×32 SVG source, bow up.
 */
export function vesselIconSvg(type, fill, edge) {
  const shape = SHAPES[vesselShapeId(type)] || SHAPES[DEFAULT_SHAPE];
  const stroke = edge?.stroke || 'rgba(4,18,24,0.9)';
  const strokeWidth = Number(edge?.strokeWidth) || 0.7;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
    <g transform="translate(16,16)">
      <path d="${shape.hull}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linejoin="round"/>
      <g fill="${stroke}" stroke="${stroke}" stroke-width="0.6" stroke-linejoin="round">${shape.deck}</g>
    </g>
  </svg>`;
}
