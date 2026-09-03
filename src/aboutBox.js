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
      'Chart datum (sea level) is a translucent plane at 0m elevation spanning the current view — on by default — so how much of what\'s on screen sits above or below sea level reads at a glance, no numbers needed.',
      'Height relief exaggeration makes hills/valleys more obvious — 1.0× is true scale.',
      'Line smoothing rounds off the raw computed contour line in steps — 0 is the exact line, higher numbers trade a little precision for a visibly smoother curve.',
      'Contour flags need "Show contour lines" on to have anything to flag; each level gets one flag per edge toggled on (W/E/N/S), nudged clear of any control panel in the way.',
      'A fully closed contour ring — an isolated hilltop or basin entirely inside the current view — gets its own small value label right on the ring, so a stack of rings up a hillside reads at a glance.',
      'Grid value labels show large lat/long labels on whichever grid lines are currently on screen.',
    ]));

    body.appendChild(section('CONTOUR STATUS LINE', [
      'Reads as "N level(s), N segments (min–max m relief)" — N levels/segments is how many contour lines were drawn in the current view; the m relief range is the lowest and highest sampled height in view, not the whole planet.',
      '"Flat here" means no contour line crosses the current view at all — the terrain in view is entirely within one band.',
    ]));

    body.appendChild(section('GPS TRACKS', [
      'Accepts .gpx, .txt, .log, and .nmea files — either already-converted GPX tracks or raw NMEA logger dumps, parsed entirely in the browser (nothing is uploaded anywhere).',
    ]));

    body.appendChild(section('DATA CACHE', [
      'Reverse-geocoded addresses and bathymetry depth samples are cached durably (IndexedDB, 5GB budget) so revisiting the same spot doesn\'t re-fetch it. The Data Cache box shows total usage and lets you flush one type or everything.',
    ]));

    body.appendChild(section('CONTOUR LINE COLORS', [
      'Land elevation and ocean depth contours each cycle through their own fixed color palette, so neighboring lines are easy to tell apart. A flag\'s marker always matches its own line\'s color; flags are always transparent with heavy-shadow white text — only text size is set separately, with each box\'s own label controls.',
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
