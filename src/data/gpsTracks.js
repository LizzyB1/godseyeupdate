import * as Cesium from 'cesium';
import { trackBounds, trackFlags } from './gpsTrackParse.js';
import { sampleSceneHeights } from './sceneHeight.js';
import { pickSampleIndices, interpolateHeights } from './heightInterp.js';

/**
 * @file Cesium rendering layer for parsed GPS tracks — turns the plain
 * `{ name, segments }` shape produced by `gpsTrackParse.js` into glowing
 * polyline entities on the live globe.
 *
 * Track height used to come straight from the file's own recorded `ele`
 * field, trusted as-is. That can (and, per field testing, does) disagree
 * with the app's actual rendered ground — the Google Photorealistic 3D
 * Tileset — by a meaningful margin (GPS-logged elevation is often
 * orthometric/MSL-referenced rather than the ellipsoidal height the scene
 * uses, on top of the logger's own vertical error), which is why tracks
 * could appear to float above or sink below the visible terrain. Heights
 * now come from `data/sceneHeight.js`, sampling the SAME scene the operator
 * sees (`scene.sampleHeight`) — the file's `ele` is now only ever used as a
 * last-resort fallback when the scene can't yet resolve a point. Sampling
 * every point of a very long track individually isn't worth the per-point
 * ray-pick cost, so a segment's line is built from a capped, evenly-spaced
 * subset of directly-sampled points with the rest linearly interpolated by
 * index (`data/heightInterp.js`); flag markers (start/end/interval) are few
 * enough per track to sample directly every time.
 *
 * Also places flag markers along each track: a start flag, a checkered end
 * flag, and interval flags every 100 m and every 2 minutes (both computed by
 * `gpsTrackParse.js`'s Cesium-free `trackFlags`) — separate marker sets
 * since a distance-based and a time-based interval land on different points
 * whenever the recorded pace isn't perfectly steady. Flags are optional per
 * track (`setFlagsVisible`) and track color is user-customizable after load
 * (`setColor`), not just the auto-cycled default.
 *
 * Kept separate from `gpsTrackParse.js` so the parsing stays unit-testable
 * without a Cesium/WebGL context; this module is the only one here that
 * imports Cesium.
 *
 * @module data/gpsTracks
 */

/** Vertical offset (meters) lifting sampled track/flag heights clear of the rendered mesh to avoid z-fighting — same idea as data/traffic.js's DOT_HEIGHT_OFFSET. */
const TRACK_HEIGHT_OFFSET_M = 2.0;
/** Above this many points, a segment's line samples only a spaced subset directly and interpolates the rest, rather than ray-picking every point. */
const MAX_DIRECT_HEIGHT_SAMPLES = 300;

/** Cycled per loaded track, matching the spirit of gpx_to_3d.py's own TRACK_COLORS palette. */
const TRACK_COLORS = [
  '#00d4ff', // accent cyan
  '#ff6b35', // orange
  '#7CFC00', // lawn green
  '#ff2d75', // magenta
  '#ffd60a', // amber
  '#a78bfa', // violet
  '#00ffa3', // spring green
  '#ff4444', // red
];

/** Offered in the track color picker alongside a free-form color input. */
export const TRACK_COLOR_SWATCHES = TRACK_COLORS;

let colorCursor = 0;
function nextColor() {
  const c = TRACK_COLORS[colorCursor % TRACK_COLORS.length];
  colorCursor += 1;
  return c;
}

function svgDataUri(svg) {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Solid-color pennant-on-a-pole flag icon, used for interval markers. */
function intervalFlagIcon(hexColor) {
  return svgDataUri(
    `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="22" viewBox="0 0 18 22">`
    + `<rect x="1.5" y="1" width="1.6" height="19" fill="#1a1a1a"/>`
    + `<path d="M3.1 1 L16 4.6 L3.1 8.2 Z" fill="${hexColor}" stroke="#111" stroke-width="0.8"/>`
    + `</svg>`,
  );
}

const START_FLAG_ICON = svgDataUri(
  '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="22" viewBox="0 0 18 22">'
  + '<rect x="1.5" y="1" width="1.6" height="19" fill="#1a1a1a"/>'
  + '<path d="M3.1 1 L16 4.6 L3.1 8.2 Z" fill="#22c55e" stroke="#0b3d1e" stroke-width="0.8"/>'
  + '</svg>',
);
const END_FLAG_ICON = svgDataUri(
  '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="22" viewBox="0 0 18 22">'
  + '<defs><pattern id="chk" width="4" height="4" patternUnits="userSpaceOnUse">'
  + '<rect width="2" height="2" fill="#000"/><rect x="2" y="2" width="2" height="2" fill="#000"/>'
  + '<rect x="2" width="2" height="2" fill="#fff"/><rect y="2" width="2" height="2" fill="#fff"/>'
  + '</pattern></defs>'
  + '<rect x="1.5" y="1" width="1.6" height="19" fill="#1a1a1a"/>'
  + '<path d="M3.1 1 L16 4.6 L3.1 8.2 Z" fill="url(#chk)" stroke="#111" stroke-width="0.8"/>'
  + '</svg>',
);

/**
 * Manages GPS track overlays as Cesium entities: one polyline per segment
 * (a segment break — logger dropout or big time gap — is a real gap, never
 * a straight-line teleport across it), grouped under a per-track record so
 * the whole track can be hidden, removed, or flown to as a unit.
 */
export class GpsTrackOverlay {
  constructor(viewer) {
    this.viewer = viewer;
    /** @type {Map<string, {id:string,name:string,color:string,visible:boolean,source:string,bounds:object,entities:Cesium.Entity[]}>} */
    this.tracks = new Map();
    this._nextId = 1;
  }

  /**
   * Add a parsed track (`{name, segments}`, as returned by parseTrackFile)
   * to the globe as a new overlay.
   * @param {{name:string, segments:Array<Array<{lat:number,lon:number,ele:number}>>}} parsed
   * @param {{sourceLabel?:string}} [opts]
   * @returns {{id:string,name:string,color:string,bounds:object,pointCount:number,segmentCount:number}}
   */
  addTrack(parsed, opts = {}) {
    const bounds = trackBounds(parsed.segments);
    if (!bounds) throw new Error('Track has no usable points to display');

    const id = `gps-track-${this._nextId++}`;
    const color = opts.color || nextColor();
    const lineEntities = [];

    parsed.segments.forEach((seg, segIdx) => {
      if (seg.length < 2) return; // a lone point can't draw a line; still counted in bounds/pointCount
      const heights = this._sampleSegmentHeights(seg);
      const positions = Cesium.Cartesian3.fromDegreesArrayHeights(
        seg.flatMap((p, i) => [p.lon, p.lat, heights[i] + TRACK_HEIGHT_OFFSET_M]),
      );
      const entity = this.viewer.entities.add({
        id: `${id}-seg-${segIdx}`,
        name: parsed.name,
        polyline: {
          positions,
          width: 4,
          material: Cesium.Color.fromCssColorString(color).withAlpha(0.9),
          clampToGround: false,
          arcType: Cesium.ArcType.GEODESIC,
        },
      });
      lineEntities.push(entity);

      // Small point markers at the segment's start/end so a break in the
      // track (vs. a continuous line) is visible at a glance.
      const start = seg[0];
      const end = seg[seg.length - 1];
      lineEntities.push(this.viewer.entities.add({
        id: `${id}-seg-${segIdx}-start`,
        position: Cesium.Cartesian3.fromDegrees(start.lon, start.lat, heights[0] + TRACK_HEIGHT_OFFSET_M),
        point: { pixelSize: 6, color: Cesium.Color.fromCssColorString(color), outlineColor: Cesium.Color.BLACK, outlineWidth: 1 },
      }));
      lineEntities.push(this.viewer.entities.add({
        id: `${id}-seg-${segIdx}-end`,
        position: Cesium.Cartesian3.fromDegrees(end.lon, end.lat, heights[heights.length - 1] + TRACK_HEIGHT_OFFSET_M),
        point: { pixelSize: 6, color: Cesium.Color.fromCssColorString(color), outlineColor: Cesium.Color.BLACK, outlineWidth: 1 },
      }));
    });

    if (!lineEntities.length) {
      throw new Error('Track has no segment with 2+ points to draw a line for');
    }

    const flagEntities = this._buildFlagEntities(id, parsed.segments);

    const record = {
      id,
      name: parsed.name,
      color,
      visible: true,
      flagsVisible: true,
      source: opts.sourceLabel || parsed.name,
      bounds,
      pointCount: bounds.pointCount,
      segmentCount: parsed.segments.length,
      lineEntities,
      flagEntities,
      get entities() { return [...lineEntities, ...flagEntities]; },
    };
    this.tracks.set(id, record);
    return { id, name: record.name, color, bounds, pointCount: record.pointCount, segmentCount: record.segmentCount };
  }

  /**
   * Real, scene-sampled heights (meters above the ellipsoid, one per point
   * in `seg`) for a track segment — see the module doc comment. Long
   * segments sample only a capped, evenly-spaced subset directly and
   * interpolate the rest by index; any point the scene still can't resolve
   * (interpolation had nothing finite to work from at all) falls back to
   * the file's own recorded `ele`, or 0 as a last resort.
   * @param {Array<{lat:number,lon:number,ele:number}>} seg
   * @returns {number[]}
   */
  _sampleSegmentHeights(seg) {
    const scene = this.viewer.scene;
    let heights;
    if (seg.length <= MAX_DIRECT_HEIGHT_SAMPLES) {
      heights = sampleSceneHeights(scene, seg.map((p) => ({ lon: p.lon, lat: p.lat })));
    } else {
      const idx = pickSampleIndices(seg.length, MAX_DIRECT_HEIGHT_SAMPLES);
      const sampled = sampleSceneHeights(scene, idx.map((i) => ({ lon: seg[i].lon, lat: seg[i].lat })));
      heights = interpolateHeights(seg.length, idx, sampled);
    }
    return heights.map((h, i) => (Number.isFinite(h) ? h : (Number.isFinite(seg[i].ele) ? seg[i].ele : 0)));
  }

  /**
   * Start (green), end (checkered), and every-100m/every-2min interval
   * flags for a track, computed by `trackFlags` — see the module doc
   * comment for why distance and time intervals are separate marker sets.
   * Flag counts per track are small regardless of track length, so each
   * flag point is sampled directly rather than reusing the line's
   * interpolated heights.
   */
  _buildFlagEntities(id, segments) {
    const { start, end, distanceFlags, timeFlags } = trackFlags(segments);
    const entities = [];

    const flagPoints = [start, end, ...distanceFlags.map((f) => f.point), ...timeFlags.map((f) => f.point)]
      .filter(Boolean);
    const sampled = sampleSceneHeights(this.viewer.scene, flagPoints.map((p) => ({ lon: p.lon, lat: p.lat })));
    const heightByPoint = new Map();
    flagPoints.forEach((p, i) => {
      const h = Number.isFinite(sampled[i]) ? sampled[i] : (Number.isFinite(p.ele) ? p.ele : 0);
      heightByPoint.set(p, h + TRACK_HEIGHT_OFFSET_M);
    });
    const heightOf = (p) => heightByPoint.get(p) ?? ((Number.isFinite(p.ele) ? p.ele : 0) + TRACK_HEIGHT_OFFSET_M);

    if (start) {
      entities.push(this.viewer.entities.add({
        id: `${id}-flag-start`,
        position: Cesium.Cartesian3.fromDegrees(start.lon, start.lat, heightOf(start)),
        billboard: { image: START_FLAG_ICON, verticalOrigin: Cesium.VerticalOrigin.BOTTOM, scale: 1 },
        label: {
          text: 'START', font: 'bold 11px sans-serif', fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK, outlineWidth: 3, style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM, pixelOffset: new Cesium.Cartesian2(10, -18),
        },
      }));
    }
    if (end) {
      entities.push(this.viewer.entities.add({
        id: `${id}-flag-end`,
        position: Cesium.Cartesian3.fromDegrees(end.lon, end.lat, heightOf(end)),
        billboard: { image: END_FLAG_ICON, verticalOrigin: Cesium.VerticalOrigin.BOTTOM, scale: 1 },
        label: {
          text: 'END', font: 'bold 11px sans-serif', fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK, outlineWidth: 3, style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM, pixelOffset: new Cesium.Cartesian2(10, -18),
        },
      }));
    }
    const distanceIcon = intervalFlagIcon('#00d4ff');
    distanceFlags.forEach((flag, i) => {
      entities.push(this.viewer.entities.add({
        id: `${id}-flag-dist-${i}`,
        position: Cesium.Cartesian3.fromDegrees(flag.point.lon, flag.point.lat, heightOf(flag.point)),
        billboard: { image: distanceIcon, verticalOrigin: Cesium.VerticalOrigin.BOTTOM, scale: 0.85 },
        label: {
          text: `${flag.meters} m`, font: '10px sans-serif', fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK, outlineWidth: 2, style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM, pixelOffset: new Cesium.Cartesian2(9, -14),
          scaleByDistance: new Cesium.NearFarScalar(500, 1, 20000, 0.5),
        },
      }));
    });
    const timeIcon = intervalFlagIcon('#ffd60a');
    timeFlags.forEach((flag, i) => {
      entities.push(this.viewer.entities.add({
        id: `${id}-flag-time-${i}`,
        position: Cesium.Cartesian3.fromDegrees(flag.point.lon, flag.point.lat, heightOf(flag.point)),
        billboard: { image: timeIcon, verticalOrigin: Cesium.VerticalOrigin.TOP, scale: 0.85 },
        label: {
          text: `${flag.minutes} min`, font: '10px sans-serif', fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK, outlineWidth: 2, style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: Cesium.VerticalOrigin.TOP, pixelOffset: new Cesium.Cartesian2(9, 14),
          scaleByDistance: new Cesium.NearFarScalar(500, 1, 20000, 0.5),
        },
      }));
    });
    return entities;
  }

  removeTrack(id) {
    const record = this.tracks.get(id);
    if (!record) return;
    record.lineEntities.forEach((e) => this.viewer.entities.remove(e));
    record.flagEntities.forEach((e) => this.viewer.entities.remove(e));
    this.tracks.delete(id);
  }

  /** Recolor an already-loaded track's line and start/end point markers. */
  setColor(id, hexColor) {
    const record = this.tracks.get(id);
    if (!record || !hexColor) return;
    const cesiumColor = Cesium.Color.fromCssColorString(hexColor);
    record.lineEntities.forEach((e) => {
      if (e.polyline) e.polyline.material = cesiumColor.withAlpha(0.9);
      if (e.point) e.point.color = cesiumColor;
    });
    record.color = hexColor;
  }

  /** Show/hide a track's start/end/interval flags independent of the line itself. */
  setFlagsVisible(id, visible) {
    const record = this.tracks.get(id);
    if (!record) return;
    record.flagsVisible = visible;
    record.flagEntities.forEach((e) => { e.show = record.visible && visible; });
  }

  toggleFlagsVisible(id) {
    const record = this.tracks.get(id);
    if (!record) return;
    this.setFlagsVisible(id, !record.flagsVisible);
  }

  removeAll() {
    [...this.tracks.keys()].forEach((id) => this.removeTrack(id));
  }

  setVisible(id, visible) {
    const record = this.tracks.get(id);
    if (!record) return;
    record.visible = visible;
    record.lineEntities.forEach((e) => { e.show = visible; });
    // A hidden track hides its flags too, but showing the track again only
    // restores flags if they weren't separately hidden via setFlagsVisible.
    record.flagEntities.forEach((e) => { e.show = visible && record.flagsVisible; });
  }

  toggleVisible(id) {
    const record = this.tracks.get(id);
    if (!record) return;
    this.setVisible(id, !record.visible);
  }

  /** Fly the camera to frame the given track's bounding box. */
  flyTo(id, opts = {}) {
    const record = this.tracks.get(id);
    if (!record) return;
    const { minLat, maxLat, minLon, maxLon } = record.bounds;
    // A single-point (or near-point) track has a degenerate rectangle —
    // fromDegrees a Rectangle needs positive extent, so pad it a little.
    const padLat = Math.max(maxLat - minLat, 0.002) * 0.5;
    const padLon = Math.max(maxLon - minLon, 0.002) * 0.5;
    const rectangle = Cesium.Rectangle.fromDegrees(
      minLon - padLon, minLat - padLat, maxLon + padLon, maxLat + padLat,
    );
    this.viewer.camera.flyTo({
      destination: rectangle,
      duration: opts.duration ?? 2.5,
    });
  }

  list() {
    return [...this.tracks.values()].map((r) => ({
      id: r.id, name: r.name, color: r.color, visible: r.visible, flagsVisible: r.flagsVisible, source: r.source,
      bounds: r.bounds, pointCount: r.pointCount, segmentCount: r.segmentCount,
    }));
  }

  destroy() {
    this.removeAll();
  }
}

/**
 * @param {Cesium.Viewer} viewer
 * @returns {GpsTrackOverlay}
 */
export function initGpsTrackOverlay(viewer) {
  return new GpsTrackOverlay(viewer);
}
