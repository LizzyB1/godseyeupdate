import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateBytes, planEviction, namespacedKey, MAX_CACHE_BYTES } from './apiCache.js';

test('MAX_CACHE_BYTES is the required 5 GB budget', () => {
  assert.equal(MAX_CACHE_BYTES, 5 * 1024 * 1024 * 1024);
});

test('namespacedKey separates different logical caches sharing the same key', () => {
  assert.equal(namespacedKey('geocode', '1,2'), 'geocode::1,2');
  assert.notEqual(namespacedKey('overpassTiles', 'a'), namespacedKey('geocode', 'a'));
});

test('estimateBytes returns the JSON-serialized byte length', () => {
  assert.equal(estimateBytes('abc'), Buffer.byteLength(JSON.stringify('abc')));
  assert.equal(estimateBytes({ a: 1, b: [1, 2, 3] }), Buffer.byteLength(JSON.stringify({ a: 1, b: [1, 2, 3] })));
});

test('estimateBytes tolerates unserializable values without throwing', () => {
  const circular = {};
  circular.self = circular;
  assert.equal(estimateBytes(circular), 0);
});

test('planEviction evicts nothing when comfortably under budget', () => {
  const { toEvictSeqs, totalBytesAfter } = planEviction(
    [{ seq: 1, bytes: 100 }, { seq: 2, bytes: 200 }], 50, 1000,
  );
  assert.deepEqual(toEvictSeqs, []);
  assert.equal(totalBytesAfter, 350);
});

test('planEviction evicts the single oldest entry when just barely over budget', () => {
  const entries = [{ seq: 1, bytes: 400 }, { seq: 2, bytes: 400 }, { seq: 3, bytes: 100 }];
  const { toEvictSeqs, totalBytesAfter } = planEviction(entries, 300, 1000);
  assert.deepEqual(toEvictSeqs, [1]);
  assert.equal(totalBytesAfter, 800);
});

test('planEviction evicts multiple oldest entries in write order, not by size', () => {
  const entries = [{ seq: 1, bytes: 10 }, { seq: 2, bytes: 10 }, { seq: 3, bytes: 500 }];
  const { toEvictSeqs, totalBytesAfter } = planEviction(entries, 990, 1000);
  assert.deepEqual(toEvictSeqs, [1, 2, 3]);
  assert.equal(totalBytesAfter, 990);
});

test('planEviction reports the state even when a single incoming entry alone exceeds maxBytes', () => {
  const { toEvictSeqs, totalBytesAfter } = planEviction([{ seq: 1, bytes: 10 }], 5000, 1000);
  assert.deepEqual(toEvictSeqs, [1]);
  assert.equal(totalBytesAfter, 5000);
});

test('planEviction with no existing entries just reports the incoming size', () => {
  const { toEvictSeqs, totalBytesAfter } = planEviction([], 200, 1000);
  assert.deepEqual(toEvictSeqs, []);
  assert.equal(totalBytesAfter, 200);
});
