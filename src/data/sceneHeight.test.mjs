import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { sampleSceneHeights, sceneHeightSupported } from './sceneHeight.js';

function fakeScene(heightForCarto) {
  return {
    mode: Cesium.SceneMode.SCENE3D,
    sampleHeightSupported: true,
    sampleHeight: (carto) => heightForCarto(carto),
  };
}

test('sampleSceneHeights returns a plausible finite height unchanged', () => {
  const scene = fakeScene(() => 842.5);
  const [h] = sampleSceneHeights(scene, [{ lon: 2.75, lat: 39.8 }]);
  assert.equal(h, 842.5);
});

test('sampleSceneHeights turns an unresolved sample (undefined) into NaN', () => {
  const scene = fakeScene(() => undefined);
  const [h] = sampleSceneHeights(scene, [{ lon: 2.75, lat: 39.8 }]);
  assert.ok(Number.isNaN(h));
});

test('sampleSceneHeights rejects the sampleHeight negative-Earth-radius bug as NaN, not a real relief value', () => {
  // The exact magnitude field-reported in a broken contour render: a single
  // grid point sampled -6344508 m, which blew out the whole view's min
  // height and pushed every generated contour level ~6,000 km underground —
  // none of them ever crossed the real terrain, so the lines went dark
  // while a cluster of flags with "-6344490 m"-style labels piled up at
  // that one rogue point.
  const scene = fakeScene(() => -6344508);
  const [h] = sampleSceneHeights(scene, [{ lon: 2.75, lat: 39.8 }]);
  assert.ok(Number.isNaN(h), 'a ~6,000 km-deep "height" must never reach a min/max relief computation');
});

test('sampleSceneHeights keeps legitimate extremes: Everest and the Mariana Trench floor', () => {
  const scene = fakeScene((carto) => (carto.longitude > 0 ? 8848 : -10935));
  const heights = sampleSceneHeights(scene, [
    { lon: 86.9, lat: 27.98 },
    { lon: -142, lat: 11.35 },
  ]);
  assert.equal(heights[0], 8848);
  assert.equal(heights[1], -10935);
});

test('sampleSceneHeights rejects a smaller-but-still-implausible outlier the same way', () => {
  const scene = fakeScene(() => -50000); // well past any real terrain, but nowhere near Earth-radius scale either
  const [h] = sampleSceneHeights(scene, [{ lon: 0, lat: 0 }]);
  assert.ok(Number.isNaN(h));
});

test('sampleSceneHeights returns all-NaN when sampling is unsupported, without calling sampleHeight', () => {
  let called = false;
  const scene = {
    mode: Cesium.SceneMode.SCENE3D,
    sampleHeightSupported: false,
    sampleHeight: () => { called = true; return 100; },
  };
  const heights = sampleSceneHeights(scene, [{ lon: 0, lat: 0 }, { lon: 1, lat: 1 }]);
  assert.ok(heights.every(Number.isNaN));
  assert.equal(called, false);
});

test('sceneHeightSupported requires 3D scene mode and sampleHeightSupported both true', () => {
  assert.equal(sceneHeightSupported(null), false);
  assert.equal(sceneHeightSupported({ mode: Cesium.SceneMode.SCENE3D, sampleHeightSupported: false }), false);
  assert.equal(sceneHeightSupported({ mode: Cesium.SceneMode.SCENE2D, sampleHeightSupported: true }), false);
  assert.equal(sceneHeightSupported({ mode: Cesium.SceneMode.SCENE3D, sampleHeightSupported: true }), true);
});
