import { buildMiniBox } from './miniBox.js';

/**
 * @file "About" mini control box: a place for reference/explainer text that
 * doesn't change from moment to moment — data-source credits, what a
 * status-line format means, how a toggle's side effects work — the kind of
 * detail that used to live as long paragraphs inside each control box's own
 * hint text, taking up space next to controls someone is actively using.
 * Nothing in here is wired to any engine; it's static content only.
 *
 * Same movable/resizable/persisted-position/collapsible/hideable box
 * mechanics as the app's other mini-boxes (`miniBox.js` +
 * `panelVisibility.js`).
 *
 * @module aboutBox
 */

function el(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html != null) node.innerHTML = html;
  return node;
}

function section(title, paragraphs) {
  const wrap = el('div', 'mapovl-section');
  wrap.appendChild(el('div', 'mapovl-section-title', title));
  for (const p of paragraphs) wrap.appendChild(el('div', 'mapovl-hint', p));
  return wrap;
}

export class AboutBox {
  constructor() {
    this._build();
  }

  _build() {
    const box = buildMiniBox({
      idPrefix: 'about',
      storagePrefix: 'godsEyeView.aboutBox.',
      title: 'ABOUT',
      ariaLabel: 'About — reference information for the other control boxes',
      defaultWidth: 260,
      defaultHeight: 300,
      minWidth: 220,
      maxWidth: 440,
      minHeight: 160,
      maxHeight: 560,
      // Every corner/edge slot is already taken by another box (HUD
      // Readouts top-left, Map Overlays top-right, Coordinates
      // bottom-right, Hidden Panels bottom-left, Bathymetry/GPS Tracks
      // stacked down the right edge) — this sits along the top edge, just
      // right of HUD Readouts (which is 260px wide starting at left:16px),
      // the one clear stretch of room left by default. Like every mini-box
      // this is only a starting position; dragging it is remembered.
      anchor: { left: '292px', top: '16px' },
      // Hide (×) button, initial hidden-state restore, and the Hidden
      // Panels tray label are all handled centrally by `buildMiniBox` now
      // — see `miniBox.js`.
    });
    this._box = box;
    const body = box.body;

    body.appendChild(section('BATHYMETRY', [
      'Isobaths and depth readouts: GEBCO grid via opentopodata.org (public, no key, rate-limited — cached once looked up).',
      'Depth flags need "Show depth contours" on, sit right on their contour line, and nudge clear of any control panel in the way.',
    ]));

    body.appendChild(section('MAP OVERLAYS', [
      'Height relief exaggeration makes hills/valleys more obvious — 1.0× is true scale.',
      'Contour flags need "Show contour lines" on to have anything to flag; each one sits right on its line and nudges clear of any control panel in the way.',
      'Grid value labels show large lat/long labels on whichever grid lines are currently on screen.',
    ]));

    body.appendChild(section('CONTOUR STATUS LINE', [
      'Reads as "N level(s), N segments (min–max m relief)" — N levels/segments is how many contour lines were drawn in the current view; the m relief range is the lowest and highest sampled height in view, not the whole planet.',
      '"Flat here" means no contour line crosses the current view at all — the terrain in view is entirely within one band.',
    ]));

    body.appendChild(section('GPS TRACKS', [
      'Accepts .gpx, .txt, .log, and .nmea files — either already-converted GPX tracks or raw NMEA logger dumps, parsed entirely in the browser (nothing is uploaded anywhere).',
    ]));

    body.appendChild(section('CONTOUR LINE COLORS', [
      'Land elevation and ocean depth contours each cycle through their own fixed color palette, so neighboring lines are easy to tell apart. A flag\'s pole always matches its own line\'s color; the flag\'s background/text-size are set separately with each box\'s own label controls.',
    ]));
  }

  destroy() {
    this._box.destroy();
  }
}

/** @returns {AboutBox} */
export function initAboutBox() {
  return new AboutBox();
}
