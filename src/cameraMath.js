import * as Cesium from 'cesium';

/**
 * @file Pure camera-vector math for `cameraControls.js`, factored out so it
 * is unit-testable against the real `cesium` math library (`Cartesian3`,
 * `Ellipsoid`, `Transforms` — none of which need WebGL or a DOM) instead of
 * only being reasoned about by eye. Takes plain Cesium math values (a
 * position, a direction) rather than a live `Cesium.Camera`/`Viewer`, so a
 * test can construct an exact scenario — a known heading, a known pitch —
 * and assert the resulting vector numerically.
 *
 * `computeHorizontalForward` backs W/S and Up/Down-arrow forward/backward
 * movement: it flattens the camera's current view direction onto the local
 * horizontal plane, so pressing forward always slides across the ground in
 * whatever direction the camera is actually facing, never sideways,
 * regardless of pitch.
 *
 * @module cameraMath
 */

/**
 * A horizontal (pitch-independent) unit vector, in world space, pointing in
 * the direction `direction` currently faces once flattened onto the local
 * horizontal plane at `position` — i.e. the camera's view direction with its
 * vertical (surface-normal) component removed. Used for forward/backward
 * ground-plane translation, which — unlike left/right strafing — has no
 * built-in Cesium equivalent: `camera.moveForward`/`moveBackward` follow
 * `camera.direction` as-is, which tilts with pitch (so at any nonzero pitch
 * they'd dive toward or climb away from the ground instead of sliding
 * across it).
 * @param {Cesium.Cartesian3} position - world-space camera position.
 * @param {Cesium.Cartesian3} direction - world-space camera view direction (need not be a unit vector).
 * @param {Cesium.Ellipsoid} [ellipsoid]
 * @returns {?Cesium.Cartesian3} null if `direction` points (near-)vertically straight up/down, or an input is missing.
 */
export function computeHorizontalForward(position, direction, ellipsoid = Cesium.Ellipsoid.WGS84) {
  if (!position || !direction) return null;
  const up = ellipsoid.geodeticSurfaceNormal(position, new Cesium.Cartesian3());
  if (!up) return null;
  const dot = Cesium.Cartesian3.dot(direction, up);
  const horizontal = Cesium.Cartesian3.subtract(
    direction,
    Cesium.Cartesian3.multiplyByScalar(up, dot, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  const length = Cesium.Cartesian3.magnitude(horizontal);
  if (!(length > 1e-9)) return null; // looking (near-)straight up/down — no well-defined horizontal direction
  return Cesium.Cartesian3.divideByScalar(horizontal, length, horizontal);
}

/**
 * Signed roll (radians, in `(-pi, pi]`) relative to level — 0 means the
 * camera's horizon is level. Used to decide whether the "always horizontal"
 * auto-level needs to snap the camera back this frame.
 * @param {number} roll - `camera.roll`, in `[0, 2*pi)` per Cesium's convention.
 * @returns {number}
 */
export function signedRollFromLevel(roll) {
  return Cesium.Math.negativePiToPi(roll);
}

/** Cardinal/intercardinal labels, keyed by their compass degree. */
const CARDINAL_LABELS = new Map([
  [0, 'N'], [45, 'NE'], [90, 'E'], [135, 'SE'],
  [180, 'S'], [225, 'SW'], [270, 'W'], [315, 'NW'],
]);

/**
 * Marks for a horizontal compass tape centered on `headingDeg`: one entry per
 * `stepDeg` within `halfSpanDeg` either side of the center, positioned by a
 * `-1..1` ratio across the tape so the caller can lay them out without
 * knowing the tape's pixel width. Only the eight cardinal/intercardinal marks
 * carry a label; the rest are bare ticks.
 * @param {number} headingDeg - compass degrees under the center index.
 * @param {{halfSpanDeg?: number, stepDeg?: number}} [options]
 * @returns {Array<{deg: number, offsetRatio: number, label: string, cardinal: boolean}>}
 */
export function compassTapeMarks(headingDeg, { halfSpanDeg = 60, stepDeg = 15 } = {}) {
  if (!Number.isFinite(headingDeg)) return [];
  const span = Math.max(1, halfSpanDeg);
  const step = Math.max(1, stepDeg);
  const marks = [];
  // Walk absolute degrees around the (unwrapped) center so the offsets stay
  // monotonic across the 360/0 seam, then wrap only the label value.
  const first = Math.ceil((headingDeg - span) / step) * step;
  for (let deg = first; deg <= headingDeg + span + 1e-9; deg += step) {
    const wrapped = ((deg % 360) + 360) % 360;
    const label = CARDINAL_LABELS.get(wrapped) ?? '';
    marks.push({
      deg: wrapped,
      offsetRatio: (deg - headingDeg) / span,
      label,
      cardinal: label !== '',
    });
  }
  return marks;
}
