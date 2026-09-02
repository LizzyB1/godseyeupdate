// src/data/vesselAnchorState.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANCHOR_SPEED_THRESHOLD_KT,
  ANCHOR_SUSTAIN_MS,
  trackLowSpeed,
} from './vesselAnchorState.js';

test('speed above the threshold is not low: no timer, not anchored', () => {
  const result = trackLowSpeed(null, 0.3, 1000);
  assert.deepEqual(result, { lowSpeedSinceMs: null, inferredAnchored: false });
});

test('speed exactly at the threshold does NOT count as low (strictly less-than)', () => {
  const result = trackLowSpeed(null, ANCHOR_SPEED_THRESHOLD_KT, 1000);
  assert.deepEqual(result, { lowSpeedSinceMs: null, inferredAnchored: false });
});

test('a fresh low reading starts the timer but is not yet anchored', () => {
  const now = 1_000_000;
  const result = trackLowSpeed(null, 0.1, now);
  assert.equal(result.lowSpeedSinceMs, now);
  assert.equal(result.inferredAnchored, false);
});

test('a low reading carried forward from a previous record does not reset the clock', () => {
  const startedAt = 1_000_000;
  const result = trackLowSpeed({ lowSpeedSinceMs: startedAt }, 0.05, startedAt + 60_000);
  assert.equal(result.lowSpeedSinceMs, startedAt);
  assert.equal(result.inferredAnchored, false);
});

test('nowMs advancing past the sustain threshold flips inferredAnchored true', () => {
  const startedAt = 1_000_000;
  const justBefore = trackLowSpeed({ lowSpeedSinceMs: startedAt }, 0.1, startedAt + ANCHOR_SUSTAIN_MS - 1);
  assert.equal(justBefore.inferredAnchored, false);
  assert.equal(justBefore.lowSpeedSinceMs, startedAt);

  const atThreshold = trackLowSpeed({ lowSpeedSinceMs: startedAt }, 0.1, startedAt + ANCHOR_SUSTAIN_MS);
  assert.equal(atThreshold.inferredAnchored, true);
  assert.equal(atThreshold.lowSpeedSinceMs, startedAt);

  const wellPast = trackLowSpeed({ lowSpeedSinceMs: startedAt }, 0.1, startedAt + ANCHOR_SUSTAIN_MS + 3_600_000);
  assert.equal(wellPast.inferredAnchored, true);
});

test('a single at/above-threshold reading after a long low streak immediately resets', () => {
  const startedAt = 1_000_000;
  const nowMs = startedAt + ANCHOR_SUSTAIN_MS + 10_000; // long past sustain
  const result = trackLowSpeed({ lowSpeedSinceMs: startedAt }, ANCHOR_SPEED_THRESHOLD_KT, nowMs);
  assert.deepEqual(result, { lowSpeedSinceMs: null, inferredAnchored: false });

  const resultAbove = trackLowSpeed({ lowSpeedSinceMs: startedAt }, 5.2, nowMs);
  assert.deepEqual(resultAbove, { lowSpeedSinceMs: null, inferredAnchored: false });
});

test('invalid speed readings (null/undefined/NaN/negative) reset the timer, same as an above-threshold reading', () => {
  const prevState = { lowSpeedSinceMs: 1_000_000 };
  const nowMs = 2_000_000;
  for (const badSpeed of [null, undefined, NaN, -1]) {
    const result = trackLowSpeed(prevState, badSpeed, nowMs);
    assert.deepEqual(
      result,
      { lowSpeedSinceMs: null, inferredAnchored: false },
      `expected reset for speedKt=${badSpeed}`,
    );
  }
});
