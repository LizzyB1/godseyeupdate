/**
 * @file Elevation contours and the lat/lon graticule as first-class data
 * layers, so they turn on and off from the same layer list as flights,
 * traffic and the rest instead of from a settings box of their own.
 *
 * Both are thin adapters over the single `MapOverlaysEngine` instance
 * (`data/mapOverlays.js`) — the engine still owns the geometry, the cache
 * and every setting; these modules only own the on/off edge and the
 * counters the layer row shows. The remaining settings live in the
 * per-feature boxes (`contoursBox.js`, `gridBox.js`), which deliberately no
 * longer carry an enable checkbox: one switch per feature, and it is the
 * layer row.
 *
 * Enablement therefore belongs to `DataLayerManager` (and through it to the
 * persisted layer state and share links), not to the engine's own persisted
 * `contoursEnabled`/`gridEnabled` flags. `createOverlayLayers` turns both
 * engine flags off as it builds the modules so a stale engine flag cannot
 * contradict the layer list on the next load.
 *
 * @module data/overlayLayers
 */

/**
 * Build the contour and grid layer modules for one overlays engine.
 * @param {import('./mapOverlays.js').MapOverlaysEngine} engine The live engine.
 * @returns {Array<object>} `[contours, gridLines]`, ready to register.
 */
export function createOverlayLayers(engine) {
  engine.setContoursEnabled(false);
  engine.setGridEnabled(false);

  const contours = {
    id: 'contours',
    name: 'Elevation Contours',
    icon: '◠',
    source: 'Terrain',
    init() {
      return true;
    },
    enable() {
      engine.setContoursEnabled(true);
      return true;
    },
    disable() {
      engine.setContoursEnabled(false);
      return true;
    },
    // Contours are computed on demand only (⟳ Refresh contours) — a poll
    // tick here would reinstate exactly the automatic recompute that was
    // removed for stalling the app on camera moves.
    update() {
      return true;
    },
    getStats() {
      const telemetry = engine.getTelemetry();
      return {
        count: 0,
        lastUpdate: null,
        status: telemetry.phase === 'done' ? 'nominal' : 'idle',
        stale: telemetry.stale,
        loading: telemetry.phase === 'computing' || telemetry.phase === 'loading',
        detail: telemetry.status,
        viewSpanDeg: telemetry.viewSpanDeg,
        maxViewSpanDeg: telemetry.maxViewSpanDeg,
      };
    },
  };

  const gridLines = {
    id: 'grid-lines',
    name: 'Grid Lines',
    icon: '#',
    source: 'Graticule',
    init() {
      return true;
    },
    enable() {
      engine.setGridEnabled(true);
      return true;
    },
    disable() {
      engine.setGridEnabled(false);
      return true;
    },
    update() {
      return true;
    },
    getStats() {
      return {
        count: 0,
        lastUpdate: null,
        status: 'nominal',
        spacingDeg: engine.state.gridSpacingDeg,
        labels: engine.state.lineLabelsEnabled,
      };
    },
  };

  return [contours, gridLines];
}
