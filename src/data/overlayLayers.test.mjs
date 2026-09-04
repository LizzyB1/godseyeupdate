import test from 'node:test';
import assert from 'node:assert/strict';

import { createOverlayLayers } from './overlayLayers.js';
import { LAYER_STATE_REGISTRY } from './layerState.js';

function fakeEngine() {
  return {
    calls: [],
    state: { gridSpacingDeg: 1, lineLabelsEnabled: false },
    telemetry: { phase: 'offline', status: '', stale: false, viewSpanDeg: 3.4, maxViewSpanDeg: 2.5 },
    setContoursEnabled(enabled) { this.calls.push(['contours', enabled]); },
    setGridEnabled(enabled) { this.calls.push(['grid', enabled]); },
    getTelemetry() { return this.telemetry; },
  };
}

test('building the overlay layers leaves both engine features off', () => {
  const engine = fakeEngine();
  const [contours, grid] = createOverlayLayers(engine);

  assert.deepEqual(engine.calls, [['contours', false], ['grid', false]]);
  assert.equal(contours.id, 'contours');
  assert.equal(grid.id, 'grid-lines');
});

test('each layer row drives only its own engine feature', () => {
  const engine = fakeEngine();
  const [contours, grid] = createOverlayLayers(engine);
  engine.calls.length = 0;

  contours.enable();
  grid.enable();
  contours.disable();
  grid.disable();

  assert.deepEqual(engine.calls, [
    ['contours', true], ['grid', true], ['contours', false], ['grid', false],
  ]);
});

test('the contour row polls nothing — refresh stays the only thing that computes', () => {
  const engine = fakeEngine();
  const [contours] = createOverlayLayers(engine);
  engine.calls.length = 0;

  for (let i = 0; i < 5; i += 1) contours.update();

  assert.deepEqual(engine.calls, []);
});

test('the contour row reports the engine phase as feed status', () => {
  const engine = fakeEngine();
  const [contours] = createOverlayLayers(engine);

  assert.equal(contours.getStats().loading, false);
  engine.telemetry = { ...engine.telemetry, phase: 'computing' };
  assert.equal(contours.getStats().loading, true);
  engine.telemetry = { ...engine.telemetry, phase: 'done' };
  assert.equal(contours.getStats().status, 'nominal');
});

test('both rows are serializable layers with unique share tokens', () => {
  const entries = LAYER_STATE_REGISTRY.filter((entry) => entry.id === 'contours' || entry.id === 'grid-lines');
  assert.equal(entries.length, 2);
  for (const entry of entries) assert.equal(entry.disposition, 'enabled-only');

  const tokens = LAYER_STATE_REGISTRY.map((entry) => entry.token);
  assert.equal(new Set(tokens).size, tokens.length);
});
