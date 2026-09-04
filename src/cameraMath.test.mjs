import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { compassTapeMarks, computeHorizontalForward, signedRollFromLevel } from './cameraMath.js';

const ellipsoid = Cesium.Ellipsoid.WGS84;
const position = Cesium.Cartesian3.fromDegrees(0, 0, 1000); // equator, 1km up
const enu = Cesium.Transforms.eastNorthUpToFixedFrame(position, ellipsoid);

/** World-space view direction for a given heading/pitch (Cesium convention: heading 0 = north, clockwise; pitch + = up). */
function worldDirectionForHeadingPitch(headingRad, pitchRad) {
  const local = new Cesium.Cartesian3(
    Math.sin(headingRad) * Math.cos(pitchRad),
    Math.cos(headingRad) * Math.cos(pitchRad),
    Math.sin(pitchRad),
  );
  return Cesium.Matrix4.multiplyByPointAsVector(enu, local, new Cesium.Cartesian3());
}

/** World-space unit vector for a local (east, north, up) direction at `position`. */
function worldUnit(local) {
  const world = Cesium.Matrix4.multiplyByPointAsVector(enu, local, new Cesium.Cartesian3());
  return Cesium.Cartesian3.normalize(world, world);
}

const NORTH = worldUnit(new Cesium.Cartesian3(0, 1, 0));
const EAST = worldUnit(new Cesium.Cartesian3(1, 0, 0));

test('facing north and level: horizontal forward points north, not east/west', () => {
  const forward = computeHorizontalForward(position, worldDirectionForHeadingPitch(0, 0), ellipsoid);
  assert.ok(Cesium.Cartesian3.dot(forward, NORTH) > 0.999);
  assert.ok(Math.abs(Cesium.Cartesian3.dot(forward, EAST)) < 1e-6);
});

test('facing east and level: horizontal forward points east, not north/south', () => {
  const forward = computeHorizontalForward(position, worldDirectionForHeadingPitch(Math.PI / 2, 0), ellipsoid);
  assert.ok(Cesium.Cartesian3.dot(forward, EAST) > 0.999);
  assert.ok(Math.abs(Cesium.Cartesian3.dot(forward, NORTH)) < 1e-6);
});

test('pitching down while facing north still moves forward (north), never sideways (east/west)', () => {
  const direction = worldDirectionForHeadingPitch(0, Cesium.Math.toRadians(-60));
  const forward = computeHorizontalForward(position, direction, ellipsoid);
  assert.ok(Cesium.Cartesian3.dot(forward, NORTH) > 0.999);
  assert.ok(Math.abs(Cesium.Cartesian3.dot(forward, EAST)) < 1e-6);
});

test('pitching up while facing east still moves forward (east), never sideways (north/south)', () => {
  const direction = worldDirectionForHeadingPitch(Math.PI / 2, Cesium.Math.toRadians(45));
  const forward = computeHorizontalForward(position, direction, ellipsoid);
  assert.ok(Cesium.Cartesian3.dot(forward, EAST) > 0.999);
  assert.ok(Math.abs(Cesium.Cartesian3.dot(forward, NORTH)) < 1e-6);
});

test('the same heading yields the same horizontal forward regardless of how steep the pitch is', () => {
  const heading = Cesium.Math.toRadians(37);
  const level = computeHorizontalForward(position, worldDirectionForHeadingPitch(heading, 0), ellipsoid);
  const pitchedDown = computeHorizontalForward(position, worldDirectionForHeadingPitch(heading, Cesium.Math.toRadians(-70)), ellipsoid);
  const pitchedUp = computeHorizontalForward(position, worldDirectionForHeadingPitch(heading, Cesium.Math.toRadians(80)), ellipsoid);
  assert.ok(Cesium.Cartesian3.dot(level, pitchedDown) > 0.9999);
  assert.ok(Cesium.Cartesian3.dot(level, pitchedUp) > 0.9999);
});

test('looking (near-)straight down returns null rather than an arbitrary sideways vector', () => {
  const direction = worldDirectionForHeadingPitch(0, Cesium.Math.toRadians(-90));
  assert.equal(computeHorizontalForward(position, direction, ellipsoid), null);
});

test('looking (near-)straight up returns null rather than an arbitrary sideways vector', () => {
  const direction = worldDirectionForHeadingPitch(0, Cesium.Math.toRadians(90));
  assert.equal(computeHorizontalForward(position, direction, ellipsoid), null);
});

test('a missing position or direction returns null rather than throwing', () => {
  assert.equal(computeHorizontalForward(null, new Cesium.Cartesian3(1, 0, 0), ellipsoid), null);
  assert.equal(computeHorizontalForward(position, null, ellipsoid), null);
});

test('signedRollFromLevel reports zero for a level camera', () => {
  assert.equal(signedRollFromLevel(0), 0);
});

test('signedRollFromLevel reports a small signed deviation near either wraparound edge', () => {
  const justUnderTwoPi = Cesium.Math.TWO_PI - Cesium.Math.toRadians(2);
  assert.ok(Math.abs(signedRollFromLevel(justUnderTwoPi) - (-Cesium.Math.toRadians(2))) < 1e-9);
  assert.ok(Math.abs(signedRollFromLevel(Cesium.Math.toRadians(2)) - Cesium.Math.toRadians(2)) < 1e-9);
});

test('signedRollFromLevel reports a large deviation for a camera rolled onto its side', () => {
  assert.ok(Math.abs(signedRollFromLevel(Cesium.Math.PI_OVER_TWO)) > Cesium.Math.toRadians(80));
});

test('compass tape centers the current heading and spans the requested arc', () => {
  const marks = compassTapeMarks(90, { halfSpanDeg: 60, stepDeg: 15 });
  assert.deepEqual(marks.map((mark) => mark.deg), [30, 45, 60, 75, 90, 105, 120, 135, 150]);
  const center = marks.find((mark) => mark.deg === 90);
  assert.equal(center.offsetRatio, 0);
  assert.equal(center.label, 'E');
  assert.equal(marks.at(0).offsetRatio, -1);
  assert.equal(marks.at(-1).offsetRatio, 1);
});

test('compass tape marks stay ordered across the 360/0 seam', () => {
  const marks = compassTapeMarks(0, { halfSpanDeg: 60, stepDeg: 15 });
  assert.deepEqual(marks.map((mark) => mark.deg), [300, 315, 330, 345, 0, 15, 30, 45, 60]);
  const offsets = marks.map((mark) => mark.offsetRatio);
  assert.deepEqual(offsets, [...offsets].sort((a, b) => a - b));
  assert.equal(marks.find((mark) => mark.deg === 315).label, 'NW');
});

test('compass tape labels only the eight cardinal and intercardinal marks', () => {
  const labelled = compassTapeMarks(180, { halfSpanDeg: 180, stepDeg: 15 })
    .filter((mark) => mark.cardinal)
    .map((mark) => mark.label);
  assert.deepEqual(new Set(labelled), new Set(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']));
  assert.ok(compassTapeMarks(180).filter((mark) => !mark.cardinal).every((mark) => mark.label === ''));
});

test('compass tape slides smoothly between marks rather than snapping', () => {
  const marks = compassTapeMarks(7, { halfSpanDeg: 60, stepDeg: 15 });
  const north = marks.find((mark) => mark.deg === 0);
  assert.ok(Math.abs(north.offsetRatio - (-7 / 60)) < 1e-9);
});

test('compass tape returns nothing for an unavailable heading', () => {
  assert.deepEqual(compassTapeMarks(Number.NaN), []);
  assert.deepEqual(compassTapeMarks(null), []);
});
