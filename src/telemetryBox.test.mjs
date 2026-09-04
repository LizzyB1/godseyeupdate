import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { fpsFromFrameTimes, relativeAge, statScalars } from './telemetryBox.js';

test('fps counts rendered frames in the trailing window only', () => {
  const now = 10_000;
  const inWindow = [now - 1000, now - 800, now - 600, now - 400, now - 200, now];
  assert.equal(fpsFromFrameTimes(inWindow, now), 5);
  // Idle render mode draws nothing: the honest answer is 0, not the last
  // rate seen before the scene went quiet.
  assert.equal(fpsFromFrameTimes([now - 9000, now - 8000], now), 0);
  assert.equal(fpsFromFrameTimes([], now), 0);
});

test('ages read as short relative spans', () => {
  const now = 1_000_000;
  assert.equal(relativeAge(now - 500, now), 'now');
  assert.equal(relativeAge(now - 12_000, now), '12s');
  assert.equal(relativeAge(now - 180_000, now), '3m');
  assert.equal(relativeAge(null, now), '');
});

test('raw stat dump keeps scalars and drops what the row already shows', () => {
  const scalars = statScalars({
    count: 42,
    lastUpdate: 1234,
    loading: false,
    mode: 'live',
    flowCoveragePct: 61.5,
    stale: true,
    flowBuckets: { free: 1 },
    error: null,
  });
  assert.deepEqual(scalars, ['mode=live', 'flowCoveragePct=61.50', 'stale=y']);
  assert.equal(statScalars({ a: 1, b: 2, c: 3 }, 2).length, 2);
});

test('the retired status box is gone and telemetry replaced it everywhere', () => {
  const main = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
  assert.match(main, /initTelemetryBox\(\{ viewer, dataManager, bathymetry, mapOverlays \}\)/);
  assert.doesNotMatch(main, /statusBox/);
  const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
  assert.match(css, /\.telemetry-pad \{/);
  assert.doesNotMatch(css, /statusbox/);
});
