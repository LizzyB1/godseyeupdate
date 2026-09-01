import * as Cesium from 'cesium';
import { trackBounds } from './gpsTrackParse.js';

/**
 * @file Cesium rendering layer for parsed GPS tracks — turns the plain
 * `{ name, segments }` shape produced by `gpsTrackParse.js` into glowing
 * polyline entities on the live globe, draped on the real terrain the app
 * already renders (no separate DEM fetch / mesh export needed — that's the
 * part of gpx_to_3d.py this feature deliberately leaves out).
 *
 * Kept separate from `gpsTrackParse.js` so the parsing stays unit-testable
 * without a Cesium/WebGL context; this module is the only one here that
 * imports Cesium.
 *
 * @module data/gpsTracks
 */

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

let colorCursor = 0;
function nextColor() {
  const c = TRACK_COLORS[colorCursor % TRACK_COLORS.length];
  colorCursor += 1;
  return c;
}

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
    const color = nextColor();
    const cesiumColor = Cesium.Color.fromCssColorString(color);
    const entities = [];

    parsed.segments.forEach((seg, segIdx) => {
      if (seg.length < 2) return; // a lone point can't draw a line; still counted in bounds/pointCount
      const positions = Cesium.Cartesian3.fromDegreesArrayHeights(
        seg.flatMap((p) => [p.lon, p.lat, Number.isFinite(p.ele) ? p.ele : 0]),
      );
      const entity = this.viewer.entities.add({
        id: `${id}-seg-${segIdx}`,
        name: parsed.name,
        polyline: {
          positions,
          width: 4,
          material: cesiumColor.withAlpha(0.9),
          clampToGround: false,
          arcType: Cesium.ArcType.GEODESIC,
        },
      });
      entities.push(entity);

      // Small point markers at the segment's start/end so a break in the
      // track (vs. a continuous line) is visible at a glance.
      const start = seg[0];
      const end = seg[seg.length - 1];
      entities.push(this.viewer.entities.add({
        id: `${id}-seg-${segIdx}-start`,
        position: Cesium.Cartesian3.fromDegrees(start.lon, start.lat, start.ele || 0),
        point: { pixelSize: 6, color: cesiumColor, outlineColor: Cesium.Color.BLACK, outlineWidth: 1 },
      }));
      entities.push(this.viewer.entities.add({
        id: `${id}-seg-${segIdx}-end`,
        position: Cesium.Cartesian3.fromDegrees(end.lon, end.lat, end.ele || 0),
        point: { pixelSize: 6, color: cesiumColor, outlineColor: Cesium.Color.BLACK, outlineWidth: 1 },
      }));
    });

    if (!entities.length) {
      throw new Error('Track has no segment with 2+ points to draw a line for');
    }

    const record = {
      id,
      name: parsed.name,
      color,
      visible: true,
      source: opts.sourceLabel || parsed.name,
      bounds,
      pointCount: bounds.pointCount,
      segmentCount: parsed.segments.length,
      entities,
    };
    this.tracks.set(id, record);
    return { id, name: record.name, color, bounds, pointCount: record.pointCount, segmentCount: record.segmentCount };
  }

  removeTrack(id) {
    const record = this.tracks.get(id);
    if (!record) return;
    record.entities.forEach((e) => this.viewer.entities.remove(e));
    this.tracks.delete(id);
  }

  removeAll() {
    [...this.tracks.keys()].forEach((id) => this.removeTrack(id));
  }

  setVisible(id, visible) {
    const record = this.tracks.get(id);
    if (!record) return;
    record.visible = visible;
    record.entities.forEach((e) => { e.show = visible; });
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
      id: r.id, name: r.name, color: r.color, visible: r.visible, source: r.source,
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
