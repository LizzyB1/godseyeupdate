import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tilesForRect, dedupeElements } from './overpassTiling.js';

test('a view smaller than one tile returns exactly one tile covering it', () => {
  const tiles = tilesForRect(10.1, 20.1, 10.4, 20.4, 0.5, 16);
  assert.equal(tiles.length, 1);
  assert.equal(tiles[0].south, 10);
  assert.equal(tiles[0].north, 10.5);
  assert.equal(tiles[0].west, 20);
  assert.equal(tiles[0].east, 20.5);
});

test('a view spanning two tiles on one axis returns two tiles', () => {
  const tiles = tilesForRect(10.1, 20.1, 10.6, 20.4, 0.5, 16);
  assert.equal(tiles.length, 2);
});

test('returns null (fall back to a direct query) when the view needs more than maxTiles tiles', () => {
  const tiles = tilesForRect(0, 0, 10, 10, 0.5, 16); // 20x20 = 400 tiles
  assert.equal(tiles, null);
});

test('tile keys are distinct across every tile in a multi-tile result', () => {
  const tiles = tilesForRect(10.1, 20.1, 10.6, 20.6, 0.5, 16);
  const keys = tiles.map((t) => t.key);
  assert.equal(new Set(keys).size, keys.length);
});

test('nearby viewports that share a tile produce the same tile key', () => {
  const a = tilesForRect(10.05, 20.05, 10.2, 20.2, 0.5, 16)[0];
  const b = tilesForRect(10.3, 20.1, 10.45, 20.3, 0.5, 16)[0];
  assert.equal(a.key, b.key);
});

test('degenerate rectangles (non-positive extent) return null', () => {
  assert.equal(tilesForRect(10, 20, 10, 20, 0.5, 16), null);
  assert.equal(tilesForRect(10, 20, 5, 25, 0.5, 16), null);
});

test('dedupeElements drops exact repeats and keeps distinct points', () => {
  const els = [
    { kind: 'peak', name: 'A', lat: 1.00001, lon: 2.00001 },
    { kind: 'peak', name: 'A', lat: 1.00001, lon: 2.00001 }, // exact duplicate
    { kind: 'place', name: 'A', lat: 1.00001, lon: 2.00001 }, // different kind, kept
    { kind: 'peak', name: 'B', lat: 3, lon: 4 }, // different point, kept
  ];
  assert.equal(dedupeElements(els).length, 3);
});
