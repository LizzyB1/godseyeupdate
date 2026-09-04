import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_STATE, MapOverlaysEngine, STALE_STATUS_TEXT, tooWideStatusText } from './mapOverlays.js';

/**
 * The engine's constructor wires Cesium primitives, data sources and camera
 * listeners, none of which the view-span/status bookkeeping touches — so
 * these exercise the methods directly against the minimal state they read.
 */
function stubEngine({
  contoursEnabled = true, maxSpanDeg = 2.5, status = '', autoRecompute = false, spanDeg = 0.7,
} = {}) {
  const published = [];
  const statuses = [];
  const scheduled = [];
  return {
    state: {
      contoursEnabled,
      contourMaxViewSpanDeg: maxSpanDeg,
      contourAutoRecompute: autoRecompute,
    },
    _contourStatus: status,
    _contourPhase: 'offline',
    _lastViewSpanDeg: null,
    onViewSpanChange: (spanDeg, limitDeg) => published.push([spanDeg, limitDeg]),
    _setStatus: MapOverlaysEngine.prototype._setStatus,
    onStatusChange: (text, phase) => statuses.push([text, phase]),
    _markContoursStale: MapOverlaysEngine.prototype._markContoursStale,
    _publishViewSpan: MapOverlaysEngine.prototype._publishViewSpan,
    _syncSpanGateStatus: MapOverlaysEngine.prototype._syncSpanGateStatus,
    _currentViewSpanDeg: () => spanDeg,
    _scheduleRecompute: () => scheduled.push(true),
    _recomputeGrid() {},
    _recomputeChartDatum() {},
    published,
    statuses,
    scheduled,
  };
}

const moveEnd = (engine) => MapOverlaysEngine.prototype._onCameraMoveEnd.call(engine);

const publish = (engine, spanDeg) => MapOverlaysEngine.prototype._publishViewSpan.call(engine, spanDeg);
const syncGate = (engine, spanDeg) => MapOverlaysEngine.prototype._syncSpanGateStatus.call(engine, spanDeg);

test('the too-wide sentence reports the span and the limit it breached', () => {
  assert.equal(
    tooWideStatusText(3.4, 2.5),
    'Zoom in to compute contours (view is 3.4° wide, need < 2.5°).',
  );
});

test('publishing a span records it and pushes it, with the current limit, at the UI', () => {
  const engine = stubEngine({ maxSpanDeg: 2.5 });
  publish(engine, 0.7);
  assert.equal(engine._lastViewSpanDeg, 0.7);
  assert.deepEqual(engine.published, [[0.7, 2.5]]);
});

test('an unavailable span leaves the last known one alone rather than blanking it', () => {
  const engine = stubEngine();
  publish(engine, 0.7);
  publish(engine, null);
  publish(engine, Number.NaN);
  assert.equal(engine._lastViewSpanDeg, 0.7);
  assert.equal(engine.published.length, 1);
});

test('zooming back inside the limit, without auto-recompute, points at the refresh button', () => {
  const engine = stubEngine({ status: tooWideStatusText(3.4, 2.5) });
  syncGate(engine, 0.7);
  assert.deepEqual(engine.statuses, [[STALE_STATUS_TEXT, 'offline']]);
});

test('zooming back inside the limit clears the stale too-wide status', () => {
  // The reported bug: "View span: 0.7° (limit 2.5°)" next to "Zoom in to
  // compute contours (view is 3.4° wide…)" — the status left over from the
  // wider view the readout had already moved on from.
  const engine = stubEngine({ status: tooWideStatusText(3.4, 2.5), autoRecompute: true });
  syncGate(engine, 0.7);
  assert.deepEqual(engine.statuses, [['Sampling scene heights…', 'computing']]);
  assert.ok(!engine._contourStatus.startsWith('Zoom in'));
});

test('a span past the limit states the limit it broke, without waiting for a recompute', () => {
  const engine = stubEngine({ status: '3 levels, 812 segments (10–240 m relief).' });
  syncGate(engine, 3.4);
  assert.deepEqual(engine.statuses, [[tooWideStatusText(3.4, 2.5), 'offline']]);
});

test('a legal span leaves a status that was never about the span alone', () => {
  const engine = stubEngine({ status: '3 levels, 812 segments (10–240 m relief).' });
  syncGate(engine, 0.7);
  assert.deepEqual(engine.statuses, []);
});

test('recompute-on-camera-move is off out of the box', () => {
  assert.equal(DEFAULT_STATE.contourAutoRecompute, false);
});

test('a camera move does not recompute on its own, it asks for a refresh', () => {
  const engine = stubEngine({ status: '3 levels, 812 segments (10–240 m relief).', spanDeg: 0.7 });
  moveEnd(engine);
  assert.deepEqual(engine.scheduled, []);
  assert.deepEqual(engine.published, [[0.7, 2.5]]);
  assert.deepEqual(engine.statuses, [[STALE_STATUS_TEXT, 'offline']]);
  assert.equal(engine._contoursStale, true);
});

test('a camera move past the limit says so rather than offering a refresh that cannot run', () => {
  const engine = stubEngine({ spanDeg: 3.4 });
  moveEnd(engine);
  assert.deepEqual(engine.statuses, [[tooWideStatusText(3.4, 2.5), 'offline']]);
});

test('with auto-recompute on, a camera move schedules one and claims no staleness', () => {
  const engine = stubEngine({ autoRecompute: true, spanDeg: 0.7 });
  moveEnd(engine);
  assert.deepEqual(engine.scheduled, [true]);
  assert.notEqual(engine._contoursStale, true);
});

test('the span gate says nothing while contours are switched off', () => {
  const engine = stubEngine({ contoursEnabled: false, status: 'anything' });
  syncGate(engine, 3.4);
  assert.deepEqual(engine.statuses, []);
});
