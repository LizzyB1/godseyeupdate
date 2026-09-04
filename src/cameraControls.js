import * as Cesium from 'cesium';
import { buildMiniBox } from './miniBox.js';
import { computeHorizontalForward, signedRollFromLevel } from './cameraMath.js';

/**
 * Keyboard + mouse + on-screen camera controls, housed in one movable,
 * resizable, collapsible control box (bottom-left by default) built on the
 * same shared `miniBox.js` mechanics as the Map Overlays panel.
 *
 * WASD (and Up/Down/Left/Right as a partial alias, see below) translate the
 * camera across the ground: W/Up moves forward, S/Down moves backward, A
 * moves left, D moves right — all four stay in the horizontal plane at
 * constant height/pitch, a pure slide across the surface rather than a dive
 * toward or climb away from it. Left/right strafing (A/D) reuses
 * `camera.moveLeft`/`moveRight`, which already stay horizontal regardless
 * of pitch (they move along the camera's `right` vector, the axis pitch
 * itself rotates around). Forward/backward (W/S/Up/Down) has no built-in
 * Cesium equivalent — pitch-independent forward motion — so it's computed
 * manually each frame by flattening the camera's current view direction
 * onto the local horizontal plane (`cameraMath.js`'s
 * `computeHorizontalForward`, unit-tested there against real Cesium math so
 * forward always tracks where the camera is actually facing and never
 * drifts sideways, whatever the pitch), added directly to
 * `camera.position`, scaled by the same altitude-proportional speed used
 * throughout.
 *
 * 1 and 3 (Left/Right arrow as a legacy alias, and Q/E) ORBIT the camera
 * around a ground focal point — wherever it was looking when the orbit
 * key was first pressed — rather than spinning in place around its own
 * eye position. Concretely, an orbit key press: (1) casts a ray from the
 * camera along its current view direction to find where it meets the
 * ellipsoid (falling back to the point straight below the camera if the
 * view is tilted above the horizon, e.g. toward the sky) and holds that
 * point fixed for as long as the key stays down; (2) every frame, moves
 * the camera's heading around that fixed point while holding pitch and
 * distance-to-point constant (`camera.lookAt` with a `HeadingPitchRange`,
 * transform reset to identity immediately after so every other camera
 * method keeps working in world space). The same patch of ground stays
 * framed while the vantage point swings around it. Releasing and
 * re-pressing an orbit key re-picks the focal point from wherever the
 * camera ends up looking next.
 *
 * Move speed (ground translation) scales with current altitude (a
 * fraction of camera height per second, floored so it still moves at
 * ground level) — the same scaling R/F zoom already uses for its own
 * forward/backward dolly.
 *
 * Pitch — tilting the view up/down — has its own dedicated pair: T/G
 * (T pitches up, G pitches down). R/F zoom, which already doubles as
 * forward/backward dolly since WASD/arrow movement covers ground-plane
 * translation instead.
 *
 * There is deliberately no roll control: the camera's horizon is always
 * kept level. Every rendered frame, if `camera.roll` has
 * drifted off level by more than a hair (native Cesium mouse-drag near the
 * poles is the main source; nothing in this module's own controls
 * introduces roll in the first place), it's snapped straight back to 0 via
 * `camera.setView` with the same heading/pitch — `cameraMath.js`'s
 * `signedRollFromLevel` decides whether a snap is needed. That's the
 * "always horizontal" guarantee: the horizon can never end up tilted, no
 * matter what moved the camera.
 *
 * A live orientation readout lives at the top of the control box: a flat
 * horizontal compass tape that slides its cardinal marks under a fixed
 * center index as the camera turns, with the heading underneath it. The
 * heading is MAGNETIC — what a compass on the ground under the camera would
 * read — derived from Cesium's true-north heading and the local magnetic
 * variation (`magneticVariation.js`), with the variation itself and the
 * pitch on one dim line below. Roll is not shown: it is locked level (see
 * below), so it never carried information. Where variation is unavailable
 * (outside the magnetic model's validity window) the readout falls back to
 * true heading and says so with a `T` suffix instead of `M`.
 *
 * The readout updates on every rendered frame via Cesium's
 * `scene.postRender`, so it stays accurate no matter what moved the camera —
 * keys, the on-screen pad, mouse-drag, or Cesium's own native orbit/pan.
 *
 * Mouse: holding the right button and dragging vertically pitches (same
 * axis as T/G); dragging horizontally yaws the view left/right in place —
 * turning where the camera is looking around its own position, not
 * orbiting a ground focal point the way the 1/3/Q/E orbit keys do. Drag
 * right to look right, drag left to look left, same non-inverted
 * mouselook pairing as the vertical axis. This claims the right mouse
 * button, so Cesium's native right-drag zoom is disabled in favor of it
 * (scroll-wheel zoom, and the R/F keys, still work). Raw pointermove deltas
 * are queued rather than applied instantly and eased out over several
 * rendered frames (`_applyMouseLookSmoothing`) — irregular per-event
 * mouse/OS timing would otherwise read as jerky rotation — which also
 * leaves a brief, natural glide for a couple of frames after the button
 * releases.
 *
 * Opposite-direction cancellation: holding both keys of an axis (forward
 * +backward, left+right, orbit left+right, or pitch up+down) at once
 * cancels that axis to a stop, exactly like holding neither — there is no
 * extra "which one wins" bookkeeping. The moment one of the two is
 * released, the axis falls through to whichever single key is still held,
 * so movement resumes in that key's direction immediately. For orbit
 * specifically, this also means the held focal point survives a brief
 * overlap (both keys down for one frame) and is only released once BOTH
 * orbit keys are up.
 *
 * The whole control box — grip header, collapse toggle, orientation
 * readout, ground-move pad, orbit pair, pitch pair, zoom pair, legend,
 * resize handle — is one DOM subtree built by `miniBox.js`, so it can be
 * dragged (grip the header), collapsed to just its header (the −/+ button),
 * and resized (drag the bottom-right corner) as a unit. Position and size
 * persist to localStorage under the `godsEyeView.camCtlBox.` prefix;
 * double-clicking the header resets both to their defaults.
 */

const MOVE_RATE_PER_S = 0.6; // fraction of current camera height, per second — ground move speed
const MIN_MOVE_STEP_M = 0.5; // floor so ground movement still moves at very low altitude
const ORBIT_RATE_RAD_S = Cesium.Math.toRadians(50); // 1/3 orbit-around-focal-point speed
const PITCH_RATE_RAD_S = Cesium.Math.toRadians(65); // T/G pitch speed
const ZOOM_RATE_PER_S = 0.9; // fraction of current camera height, per second
const MIN_ZOOM_STEP_M = 0.5; // floor so zoom still moves at very low altitude
const MAX_FRAME_DT_S = 0.1; // clamp dt after a tab is backgrounded/throttled
const PITCH_DRAG_RAD_PER_PX = Cesium.Math.toRadians(0.15); // right-drag vertical → pitch
const YAW_DRAG_RAD_PER_PX = Cesium.Math.toRadians(0.15); // right-drag horizontal → yaw (look left/right in place)
const MAX_DRAG_STEP_PX = 60; // clamp a single mousemove delta (e.g. after pointer warp/lag)
// Right-drag look is queued (see _onPointerMove) and eased out over several
// rendered frames instead of applied whole on each raw pointermove — see
// _applyMouseLookSmoothing. Fraction of the remaining queued rotation
// applied per frame: higher settles faster/snappier, lower glides longer.
const MOUSELOOK_SMOOTHING = 0.35;
// Once the queued rotation decays below this, snap it to exactly zero
// instead of asymptotically crawling toward it forever.
const MOUSELOOK_SETTLE_RAD = Cesium.Math.toRadians(0.02);
/** Below this much roll deviation, don't bother re-snapping — avoids a setView() call every single frame from float noise. */
const LEVEL_SNAP_EPSILON_RAD = Cesium.Math.toRadians(0.05);

/** Box drag/resize/collapse persistence + bounds — passed straight to `buildMiniBox`. */
const STORAGE_PREFIX = 'godsEyeView.camCtlBox.';
// Grown to fit the doubled-size touch buttons below (per a direct user
// ask — this box is for touch-screen use and is used rarely enough that a
// bigger footprint is worth the easier hit targets). The 3-wide D-pad
// alone now needs ~190px of button width before padding, so MIN_WIDTH in
// particular moves up with it.
const DEFAULT_WIDTH = 220;
const DEFAULT_HEIGHT = 480;
const MIN_WIDTH = 210;
const MAX_WIDTH = 420;
const MIN_HEIGHT = 340;
const MAX_HEIGHT = 680;

/** Keys mapped to a held "direction"/"action" name. Arrow keys carry over
 * the subset of the scheme they've always aliased (forward/back, orbit);
 * WASD/1-3/T-G/RF are keyed by KeyboardEvent.code so layout doesn't matter. */
const KEY_TO_ACTION = {
  ArrowUp: 'lateralForward', ArrowDown: 'lateralBackward', ArrowLeft: 'orbitLeft', ArrowRight: 'orbitRight',
  KeyW: 'lateralForward', KeyS: 'lateralBackward', KeyA: 'lateralLeft', KeyD: 'lateralRight',
  Digit1: 'orbitLeft', Digit3: 'orbitRight',
  KeyQ: 'orbitLeft', KeyE: 'orbitRight',
  KeyT: 'pitchUp', KeyG: 'pitchDown',
  KeyR: 'zoomIn', KeyF: 'zoomOut',
};

/** Ground-plane translation pad — WASD/arrows. All four stay in the
 * horizontal plane at constant pitch/height — a pure slide across the
 * surface, not a dive toward or climb away from it. Forward/backward (W/S)
 * follow the camera's current facing direction; left/right (A/D) strafe
 * perpendicular to it. */
const LATERAL_BUTTONS = [
  { actions: ['lateralForward'], label: '▲', title: 'Move forward (W / Up)', area: 'up' },
  { actions: ['lateralLeft'], label: '◀', title: 'Move left (A)', area: 'left' },
  { actions: ['lateralRight'], label: '▶', title: 'Move right (D)', area: 'right' },
  { actions: ['lateralBackward'], label: '▼', title: 'Move backward (S / Down)', area: 'down' },
];

/** Orbit pair — 1/3 / Left/Right. Swings the camera around a ground focal
 * point picked from wherever it's currently looking, instead of spinning
 * it in place — see the module doc comment above. */
const ORBIT_BUTTONS = [
  { actions: ['orbitLeft'], label: '↶', title: 'Orbit left around ground point (1 / Left / Q)' },
  { actions: ['orbitRight'], label: '↷', title: 'Orbit right around ground point (3 / Right / E)' },
];

/** Dedicated pitch pair. */
const PITCH_BUTTONS = [
  { actions: ['pitchUp'], label: '▲', title: 'Pitch up (T)' },
  { actions: ['pitchDown'], label: '▼', title: 'Pitch down (G)' },
];

/** Zoom pair — R/F. No yaw-in-place or roll controls exist any more: the horizon is always kept level (see module doc comment). */
const ZOOM_BUTTONS = [
  { actions: ['zoomOut'], label: '−', title: 'Zoom out (F)' },
  { actions: ['zoomIn'], label: '+', title: 'Zoom in (R)' },
];

function isEditableTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return Boolean(el.isContentEditable);
}

/**
 * Keys with a PRE-EXISTING single-press global shortcut elsewhere that this
 * module's letters/digits collide with: plain 'f' toggles the data panel,
 * plain 'd' cycles detection mode, plain '1'/'3' switch the sensor style to
 * Normal/Anime (StyleManager's `_globalKeydownHandler` in ui.js —
 * its `keyMap` covers '1'-'4', bubble-phase `keydown` on `document`). Those
 * four are suppressed with `stopPropagation()` while claimed as camera keys
 * so holding them doesn't also flicker the legacy toggle or swap styles.
 * ('c' used to need the same treatment for the removed yaw-in-place
 * control — now that this module doesn't touch 'c' at all, plain 'c' is
 * free to toggle CCTV overlays / cockpit view as normal.) Every other
 * claimed key (arrows, W/A/S/D, T, G, R) is left to bubble normally —
 * several existing widgets (e.g. the Global Context tab row's roving
 * arrow-key navigation, the radio tuner slider) also read arrow keys while
 * focused, and suppressing propagation for those would break that existing
 * keyboard navigation.
 */
const LEGACY_SHORTCUT_CODES = new Set(['KeyF', 'KeyD', 'Digit1', 'Digit3']);

/** Radians → signed degrees in (-180, 180]. */
function toSignedDeg(rad) {
  let deg = Cesium.Math.toDegrees(rad) % 360;
  if (deg > 180) deg -= 360;
  if (deg < -180) deg += 360;
  return deg;
}

function fmtSignedDeg(deg) {
  const rounded = Math.round(deg);
  const sign = rounded > 0 ? '+' : rounded < 0 ? '−' : '±';
  return `${sign}${Math.abs(rounded)}°`;
}

/**
 * Builds the movable/resizable/collapsible control box (header + orientation
 * readout + ground-move pad + orbit pair + pitch pair + zoom pair + legend)
 * on top of `miniBox.js`'s shared box mechanics, and wires pointer
 * press-and-hold to the given callbacks.
 */
function buildControlBox({ onPress, onRelease }) {
  const miniBox = buildMiniBox({
    // idPrefix/storagePrefix are unchanged (still "camctl"/the old camera
    // storage key) so everyone's saved position/size survives the rename —
    // only the visible title changed, from "CAMERA" to "CONTROLS", per a
    // direct user ask once the bearing tape moved out to the Compass box:
    // what's left is movement/orbit/pitch/zoom buttons, not orientation.
    idPrefix: 'camctl',
    storagePrefix: STORAGE_PREFIX,
    title: 'CONTROLS',
    ariaLabel: 'Camera movement controls: ground-move, orbit, pitch, and zoom',
    defaultWidth: DEFAULT_WIDTH,
    defaultHeight: DEFAULT_HEIGHT,
    minWidth: MIN_WIDTH,
    maxWidth: MAX_WIDTH,
    minHeight: MIN_HEIGHT,
    maxHeight: MAX_HEIGHT,
    anchor: { left: '24px', bottom: 'calc(2vh + 4.5rem)' },
    // No custom header content — the header already carries the
    // grip/title/hide/collapse controls, and a 5th item crammed in with
    // them read as cluttered. The heading lives in the body under the
    // compass tape instead — see the orient block below.
  });
  const body = miniBox.body;

  // Orientation: just the pitch readout now — the bearing tape and
  // magnetic-heading number that used to live here moved to the Compass
  // box (compassBox.js) per a direct user ask, so all heading/orientation
  // info lives in one place instead of being split across two boxes. Roll
  // is omitted — the horizon is locked level, so it only ever read ±0°.
  const orient = document.createElement('div');
  orient.className = 'camctl-orient';
  orient.setAttribute('aria-hidden', 'true');

  const readout = document.createElement('div');
  readout.className = 'camctl-orient-readout';
  const pitchField = document.createElement('span');
  pitchField.textContent = 'PIT ±0°';
  readout.append(pitchField);
  orient.appendChild(readout);

  body.appendChild(orient);

  const bind = (btn, actions) => {
    let pointerId = null;
    const start = (event) => {
      event.preventDefault();
      event.stopPropagation();
      pointerId = event.pointerId;
      btn.setPointerCapture?.(pointerId);
      btn.classList.add('is-active');
      onPress(actions);
    };
    const end = (event) => {
      if (pointerId != null && event.pointerId !== undefined && event.pointerId !== pointerId) return;
      pointerId = null;
      btn.classList.remove('is-active');
      onRelease(actions);
    };
    btn.addEventListener('pointerdown', start);
    btn.addEventListener('pointerup', end);
    btn.addEventListener('pointercancel', end);
    btn.addEventListener('pointerleave', (event) => {
      // Only release-on-leave for mouse (no capture); touch/pen keep moving via capture.
      if (event.pointerType === 'mouse') end(event);
    });
    btn.addEventListener('contextmenu', (event) => event.preventDefault());
  };

  // Lateral (ground-plane translation) pad — WASD, plus-shaped 4-way.
  const lateralPad = document.createElement('div');
  lateralPad.className = 'camctl-dpad';
  lateralPad.title = 'Move across the ground at constant height (W/Up forward, S/Down back, A left, D right)';
  for (const { actions, label, title: btnTitle, area } of LATERAL_BUTTONS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `camctl-btn camctl-dpad-btn camctl-dpad-${area}`;
    btn.title = btnTitle;
    btn.setAttribute('aria-label', btnTitle);
    btn.textContent = label;
    bind(btn, actions);
    lateralPad.appendChild(btn);
  }
  body.appendChild(lateralPad);

  // Orbit pair — swings around a ground focal point instead of spinning in place.
  const orbitRow = document.createElement('div');
  orbitRow.className = 'camctl-row';
  orbitRow.title = 'Orbit around the ground point currently in view (1/Left/Q, 3/Right/E)';
  for (const { actions, label, title: btnTitle } of ORBIT_BUTTONS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'camctl-btn camctl-row-btn';
    btn.title = btnTitle;
    btn.setAttribute('aria-label', btnTitle);
    btn.textContent = label;
    bind(btn, actions);
    orbitRow.appendChild(btn);
  }
  body.appendChild(orbitRow);

  // Dedicated pitch pair.
  const pitchRow = document.createElement('div');
  pitchRow.className = 'camctl-row';
  for (const { actions, label, title: btnTitle } of PITCH_BUTTONS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'camctl-btn camctl-row-btn';
    btn.title = btnTitle;
    btn.setAttribute('aria-label', btnTitle);
    btn.textContent = label;
    bind(btn, actions);
    pitchRow.appendChild(btn);
  }
  body.appendChild(pitchRow);

  // Zoom pair. No roll/yaw-in-place controls exist any more — see module doc comment.
  const zoomRow = document.createElement('div');
  zoomRow.className = 'camctl-aux';
  for (const { actions, label, title: btnTitle } of ZOOM_BUTTONS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'camctl-btn camctl-aux-btn';
    btn.title = btnTitle;
    btn.setAttribute('aria-label', btnTitle);
    btn.textContent = label;
    bind(btn, actions);
    zoomRow.appendChild(btn);
  }
  body.appendChild(zoomRow);

  const legend = document.createElement('div');
  legend.className = 'camctl-legend';
  legend.title = 'WASD/arrows slide across the ground (forward/back relative to where the camera faces) · 1/3/Left/Right/Q/E orbit a ground point · T/G pitch · R/F zoom · mouse right-drag pitches vertically and yaws left/right horizontally · horizon is always kept level';
  legend.textContent = 'WASD/arrows move · 1/3/Q/E orbit · T/G pitch · R/F zoom · right-drag look · horizon locked level';
  body.appendChild(legend);

  return {
    pitchField,
    destroy() {
      miniBox.destroy();
    },
  };
}

export class CameraControls {
  constructor(viewer) {
    this.viewer = viewer;
    /** Keys currently held, from the keyboard. */
    this._held = new Set();
    /** Actions currently held via the on-screen pad. */
    this._pointerHeld = new Set();
    this._raf = null;
    this._lastT = null;

    // Orbit's held ground focal point (Cartesian3) — picked once when an
    // orbit key/button is first pressed, cleared once BOTH orbit keys are
    // up (see the opposite-direction-cancellation note in the module doc
    // comment). Range/pitch are captured alongside it so every subsequent
    // frame's `camera.lookAt` only advances heading, keeping the same
    // ground point framed at a constant distance and tilt.
    this._orbitFocus = null;
    this._orbitRange = 0;
    this._orbitPitch = 0;

    // Right-button drag state (vertical drag pitches, horizontal drag yaws).
    this._dragActive = false;
    this._dragPointerId = null;
    this._lastDragX = 0;
    this._lastDragY = 0;
    // Queued-but-not-yet-applied look rotation, in radians, eased out over
    // several rendered frames by `_applyMouseLookSmoothing` instead of
    // being applied whole on each raw pointermove — see that method and
    // `_onPointerMove`. Deliberately not cleared on drag-end, so a flick
    // keeps gliding for a couple of frames after the button releases.
    this._pendingPitchRad = 0;
    this._pendingYawRad = 0;
    /** Cesium's own zoomEventTypes before we remove RIGHT_DRAG, for restore. */
    this._savedZoomEventTypes = null;
    /** Cesium's own enableRotate before we suspend it during a right-button drag. */
    this._savedEnableRotate = null;

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onBlur = this._onBlur.bind(this);
    this._tick = this._tick.bind(this);
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onContextMenu = this._onContextMenu.bind(this);
    this._updateOrientation = this._updateOrientation.bind(this);

    // Capture phase so the F/D/1/3 conflict check (LEGACY_SHORTCUT_CODES)
    // runs before ui.js's bubble-phase global shortcut handler; every other
    // key still bubbles through untouched (see isEditableTarget / the note
    // above LEGACY_SHORTCUT_CODES).
    window.addEventListener('keydown', this._onKeyDown, { capture: true });
    window.addEventListener('keyup', this._onKeyUp, { capture: true });
    window.addEventListener('blur', this._onBlur);

    this._box = buildControlBox({
      onPress: (actions) => {
        actions.forEach((a) => this._pointerHeld.add(a));
        this._ensureLoop();
      },
      onRelease: (actions) => {
        actions.forEach((a) => this._pointerHeld.delete(a));
      },
    });

    this._installMouseDrag();

    // Orientation readout tracks the camera every rendered frame, so it
    // stays live regardless of what moved the camera (keys, pad, native
    // mouse orbit/pan, or a scripted flight).
    this.viewer.scene?.postRender.addEventListener(this._updateOrientation);
    this._updateOrientation();
  }

  /**
   * Claim the right mouse button for look drag: dragging vertically while
   * the right button is held pitches (same axis as T/G), and dragging
   * horizontally yaws the view left/right in place. This repurposes
   * Cesium's native right-drag zoom, so RIGHT_DRAG is removed from the
   * controller's zoomEventTypes (wheel/pinch zoom is untouched); native
   * rotate is suspended only while the right button is actually down, so
   * plain left-drag orbiting is unaffected.
   */
  _installMouseDrag() {
    const canvas = this.viewer.canvas;
    if (!canvas) return;
    const controller = this.viewer.scene?.screenSpaceCameraController;
    if (controller) {
      this._savedZoomEventTypes = controller.zoomEventTypes;
      this._savedEnableRotate = controller.enableRotate;
      if (Array.isArray(controller.zoomEventTypes)) {
        controller.zoomEventTypes = controller.zoomEventTypes.filter(
          (t) => t !== Cesium.CameraEventType.RIGHT_DRAG,
        );
      }
    }
    canvas.addEventListener('pointerdown', this._onPointerDown);
    canvas.addEventListener('pointermove', this._onPointerMove);
    canvas.addEventListener('pointerup', this._onPointerUp);
    canvas.addEventListener('pointercancel', this._onPointerUp);
    canvas.addEventListener('contextmenu', this._onContextMenu);
  }

  _uninstallMouseDrag() {
    const canvas = this.viewer.canvas;
    if (canvas) {
      canvas.removeEventListener('pointerdown', this._onPointerDown);
      canvas.removeEventListener('pointermove', this._onPointerMove);
      canvas.removeEventListener('pointerup', this._onPointerUp);
      canvas.removeEventListener('pointercancel', this._onPointerUp);
      canvas.removeEventListener('contextmenu', this._onContextMenu);
    }
    const controller = this.viewer.scene?.screenSpaceCameraController;
    if (controller) {
      if (this._savedZoomEventTypes) controller.zoomEventTypes = this._savedZoomEventTypes;
      if (this._savedEnableRotate != null) controller.enableRotate = this._savedEnableRotate;
    }
  }

  /** Right button bit (2) of MouseEvent/PointerEvent#buttons. */
  static get _RIGHT_BIT() { return 2; }

  _onContextMenu(event) {
    // Only swallow the native menu when the right button was actually doing
    // camera work (it always was, by the time `contextmenu` fires post-up).
    event.preventDefault();
  }

  _onPointerDown(event) {
    const rightDown = (event.buttons & CameraControls._RIGHT_BIT) !== 0;
    if (!rightDown) return; // left-alone: leave Cesium's native orbit-drag alone
    event.preventDefault();
    this._dragActive = true;
    this._dragPointerId = event.pointerId;
    this._lastDragX = event.clientX;
    this._lastDragY = event.clientY;
    this.viewer.canvas.setPointerCapture?.(event.pointerId);
    const controller = this.viewer.scene?.screenSpaceCameraController;
    if (controller) controller.enableRotate = false;
  }

  _onPointerMove(event) {
    if (!this._dragActive || event.pointerId !== this._dragPointerId) return;
    const rightDown = (event.buttons & CameraControls._RIGHT_BIT) !== 0;
    if (!rightDown) { this._endDrag(event); return; }

    const dx = Cesium.Math.clamp(event.clientX - this._lastDragX, -MAX_DRAG_STEP_PX, MAX_DRAG_STEP_PX);
    const dy = Cesium.Math.clamp(event.clientY - this._lastDragY, -MAX_DRAG_STEP_PX, MAX_DRAG_STEP_PX);
    this._lastDragX = event.clientX;
    this._lastDragY = event.clientY;

    // Queued rather than applied immediately: raw pointermove events fire
    // at an irregular, OS/mouse-dependent rate (bursty on some hardware),
    // so rotating the camera directly off each one reads as jerky. Instead
    // the delta is queued here (vertical = pitch, horizontal = yaw, same
    // non-inverted conventions as before — up = pitch up, drag right =
    // look right) and eased out across rendered frames by
    // `_applyMouseLookSmoothing`, called every postRender from
    // `_updateOrientation`. The per-frame roll-level snap (module doc
    // comment) keeps the horizon flat regardless.
    this._pendingPitchRad += dy * PITCH_DRAG_RAD_PER_PX;
    this._pendingYawRad += dx * YAW_DRAG_RAD_PER_PX;
  }

  _onPointerUp(event) {
    if (event.pointerId !== this._dragPointerId) return;
    this._endDrag(event);
  }

  _endDrag(event) {
    this._dragActive = false;
    this._dragPointerId = null;
    this.viewer.canvas.releasePointerCapture?.(event.pointerId);
    const controller = this.viewer.scene?.screenSpaceCameraController;
    if (controller && this._savedEnableRotate != null) controller.enableRotate = this._savedEnableRotate;
  }

  _onKeyDown(event) {
    if (isEditableTarget(document.activeElement)) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return; // leave system/browser shortcuts alone
    const action = KEY_TO_ACTION[event.code];
    if (!action) return;
    event.preventDefault();
    // Only the keys with a confirmed pre-existing conflict are stopped
    // from bubbling — see LEGACY_SHORTCUT_CODES. Everything else (arrows,
    // WASD, T, G, R) still reaches any element-specific handler.
    if (LEGACY_SHORTCUT_CODES.has(event.code)) event.stopPropagation();
    this._held.add(action);
    this._ensureLoop();
  }

  _onKeyUp(event) {
    const action = KEY_TO_ACTION[event.code];
    if (!action) return;
    this._held.delete(action);
    if (LEGACY_SHORTCUT_CODES.has(event.code) && !isEditableTarget(document.activeElement)) {
      event.stopPropagation();
    }
  }

  _onBlur() {
    this._held.clear();
    this._pointerHeld.clear();
    this._orbitFocus = null;
  }

  /**
   * A horizontal (pitch-independent) unit vector, in world space, pointing
   * in the direction the camera is currently facing — used for W/S/Up/Down
   * forward/backward translation, which (unlike A/D strafing) has no
   * built-in Cesium equivalent since `moveForward`/`moveBackward` follow
   * `camera.direction`, which tilts with pitch. Delegates to
   * `cameraMath.js`'s `computeHorizontalForward`, which flattens
   * `camera.direction` onto the local horizontal plane directly (rather
   * than reconstructing a vector from `camera.heading`) and is
   * unit-tested there against real Cesium math for exactly the failure
   * this exists to rule out: forward drifting sideways under pitch.
   * @returns {?Cesium.Cartesian3} null only if the camera has no valid position/direction yet, or is looking (near-)straight up/down.
   */
  _computeHorizontalForward() {
    const camera = this.viewer.camera;
    if (!camera?.positionWC) return null;
    const ellipsoid = this.viewer.scene?.globe?.ellipsoid || Cesium.Ellipsoid.WGS84;
    return computeHorizontalForward(camera.positionWC, camera.directionWC, ellipsoid);
  }

  /**
   * Where the camera is currently looking, projected onto the ground —
   * cast a ray along the view direction and intersect it with the
   * ellipsoid. Deliberately ellipsoid-only (not terrain/3D-tile picking,
   * which needs an already-loaded tile and can return nothing mid-load):
   * this only needs to be an approximately correct orbit pivot, always
   * available synchronously.
   * @returns {?Cesium.Cartesian3} null only if the camera has no valid position yet.
   */
  _computeGroundFocus() {
    const camera = this.viewer.camera;
    if (!camera?.positionWC) return null;
    const ellipsoid = this.viewer.scene?.globe?.ellipsoid || Cesium.Ellipsoid.WGS84;
    const ray = new Cesium.Ray(camera.positionWC, camera.directionWC);
    const interval = Cesium.IntersectionTests.rayEllipsoid(ray, ellipsoid);
    if (interval) {
      return Cesium.Ray.getPoint(ray, interval.start);
    }
    // View tilted above the horizon (e.g. toward the sky) — the forward ray
    // never meets the ellipsoid. Fall back to the point straight beneath
    // the camera so orbit always has a valid pivot instead of doing nothing.
    return ellipsoid.scaleToGeodeticSurface(camera.positionWC) || camera.positionWC;
  }

  _ensureLoop() {
    if (this._raf != null) return;
    this._lastT = performance.now();
    this._raf = requestAnimationFrame(this._tick);
  }

  /** Union of keyboard-held and pad-held actions for this frame. */
  _activeActions() {
    if (this._pointerHeld.size === 0) return this._held;
    const union = new Set(this._held);
    this._pointerHeld.forEach((a) => union.add(a));
    return union;
  }

  /**
   * If the camera's roll has drifted off level, snaps it straight back to 0
   * (same heading/pitch, roll forced to 0) — the "always horizontal"
   * guarantee described in the module doc comment. Runs every rendered
   * frame regardless of what moved the camera, so it catches drift from
   * Cesium's own native mouse-drag as well as anything in this module.
   */
  _enforceLevelHorizon(camera) {
    const rollDelta = signedRollFromLevel(camera.roll);
    if (Math.abs(rollDelta) < LEVEL_SNAP_EPSILON_RAD) return;
    camera.setView({ orientation: { heading: camera.heading, pitch: camera.pitch, roll: 0 } });
  }

  /**
   * Eases the queued right-drag rotation (see `_onPointerMove`) toward
   * zero, applying only a fraction of what's left each rendered frame
   * instead of the raw delta in one step. This is what actually smooths
   * the look: it decouples how often the camera rotates (every frame, at
   * a steady cadence) from how often — and how unevenly — pointermove
   * events happen to fire, and it means a quick flick keeps gliding for a
   * couple of frames after the button comes up rather than stopping dead.
   */
  _applyMouseLookSmoothing(camera) {
    if (this._pendingPitchRad === 0 && this._pendingYawRad === 0) return;

    if (Math.abs(this._pendingPitchRad) <= MOUSELOOK_SETTLE_RAD) {
      this._pendingPitchRad = 0;
    } else {
      const step = this._pendingPitchRad * MOUSELOOK_SMOOTHING;
      if (step < 0) camera.lookUp(-step);
      else camera.lookDown(step);
      this._pendingPitchRad -= step;
    }

    if (Math.abs(this._pendingYawRad) <= MOUSELOOK_SETTLE_RAD) {
      this._pendingYawRad = 0;
    } else {
      const step = this._pendingYawRad * MOUSELOOK_SMOOTHING;
      if (step > 0) camera.lookRight(step);
      else camera.lookLeft(-step);
      this._pendingYawRad -= step;
    }
  }

  /**
   * Reads the camera's current heading/pitch and updates the compass tape +
   * heading readout. Cheap DOM/CSS-transform writes only — safe to run on
   * every `postRender`. Also drives the mouse-look smoothing above, on the
   * same every-frame cadence.
   */
  _updateOrientation() {
    const camera = this.viewer.camera;
    if (!camera) return;
    this._applyMouseLookSmoothing(camera);
    this._enforceLevelHorizon(camera);

    const box = this._box;
    if (!box) return;

    // Heading/bearing/variation now live entirely in the Compass box
    // (compassBox.js) — this box only still tracks its own pitch, which
    // is specific to how the camera is looking, not a compass reading.
    const pitchDeg = toSignedDeg(camera.pitch);
    const pitchText = `PIT ${fmtSignedDeg(pitchDeg)}`;
    if (box.pitchField.textContent !== pitchText) box.pitchField.textContent = pitchText;
  }

  _tick(t) {
    const dt = Math.min(MAX_FRAME_DT_S, Math.max(0, (t - (this._lastT ?? t)) / 1000));
    this._lastT = t;
    const active = this._activeActions();

    if (active.size === 0) {
      this._raf = null;
      // The loop is about to stop entirely, so the orbitDir!==0/else branch
      // below (which normally clears a released orbit's held focal point)
      // never runs its "else" this frame — clear it here instead, or a
      // stale focal point survives to be silently reused the next time an
      // orbit key is pressed with nothing else held (the common case).
      this._orbitFocus = null;
      return;
    }

    const camera = this.viewer.camera;

    // Opposite-direction cancellation on each axis independently: both held
    // (or neither) nets to 0 ("stop"); releasing one falls straight through
    // to the other's direction, with no separate "release" branch needed.
    const strafeDir = (active.has('lateralRight') ? 1 : 0) - (active.has('lateralLeft') ? 1 : 0);
    if (strafeDir !== 0) {
      const height = camera.positionCartographic?.height;
      const amount = Math.max(MIN_MOVE_STEP_M, (Number.isFinite(height) ? height : 1000) * MOVE_RATE_PER_S * dt);
      // Pure sideways translation — perpendicular to view direction, no
      // forward/backward component — so it slides across the surface at
      // constant height instead of diving toward or climbing away from it
      // the way `moveForward`/`moveBackward` would at any nonzero pitch.
      if (strafeDir > 0) camera.moveRight(amount);
      else camera.moveLeft(amount);
    }

    const forwardDir = (active.has('lateralForward') ? 1 : 0) - (active.has('lateralBackward') ? 1 : 0);
    if (forwardDir !== 0) {
      const height = camera.positionCartographic?.height;
      const amount = Math.max(MIN_MOVE_STEP_M, (Number.isFinite(height) ? height : 1000) * MOVE_RATE_PER_S * dt);
      // Pitch-independent forward/backward translation along the camera's
      // heading — see `_computeHorizontalForward` — so it slides across the
      // surface at constant height rather than following the tilted view
      // direction the way `moveForward`/`moveBackward` would.
      const forward = this._computeHorizontalForward();
      if (forward) {
        const delta = Cesium.Cartesian3.multiplyByScalar(forward, amount * forwardDir, new Cesium.Cartesian3());
        Cesium.Cartesian3.add(camera.position, delta, camera.position);
      }
    }

    const pitchDir = (active.has('pitchUp') ? 1 : 0) - (active.has('pitchDown') ? 1 : 0);
    if (pitchDir > 0) camera.lookUp(PITCH_RATE_RAD_S * dt);
    else if (pitchDir < 0) camera.lookDown(PITCH_RATE_RAD_S * dt);

    // Orbit around a held ground focal point — NOT camera.lookLeft/lookRight
    // (which would just re-aim the camera from a fixed position and let
    // whatever it was looking at slide out of view, i.e. "spin the camera
    // in place"). The focal point, distance, and pitch are captured once
    // when orbiting starts and held fixed for the duration of the press, so
    // only heading advances each frame — see the module doc comment and
    // `_computeGroundFocus`.
    const orbitDir = (active.has('orbitRight') ? 1 : 0) - (active.has('orbitLeft') ? 1 : 0);
    if (orbitDir !== 0) {
      if (!this._orbitFocus) {
        const focus = this._computeGroundFocus();
        if (focus) {
          this._orbitFocus = focus;
          this._orbitRange = Math.max(1, Cesium.Cartesian3.distance(camera.positionWC, focus));
          this._orbitPitch = camera.pitch;
        }
      }
      if (this._orbitFocus) {
        const newHeading = camera.heading + ORBIT_RATE_RAD_S * dt * orbitDir;
        camera.lookAt(this._orbitFocus, new Cesium.HeadingPitchRange(newHeading, this._orbitPitch, this._orbitRange));
        // lookAt() reassigns the camera's reference frame to orbit around
        // the target; reset it to identity/world immediately so every other
        // camera method (moveLeft/moveRight, lookUp/lookDown, zoomIn/zoomOut,
        // twistLeft/twistRight, next frame's own lookAt) keeps operating in
        // world space rather than the transform lookAt just installed.
        camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
      }
    } else {
      this._orbitFocus = null;
    }

    const zoomDir = (active.has('zoomIn') ? 1 : 0) - (active.has('zoomOut') ? 1 : 0);
    if (zoomDir !== 0) {
      const height = camera.positionCartographic?.height;
      const amount = Math.max(MIN_ZOOM_STEP_M, (Number.isFinite(height) ? height : 1000) * ZOOM_RATE_PER_S * dt);
      if (zoomDir > 0) camera.zoomIn(amount);
      else camera.zoomOut(amount);
    }

    this._raf = requestAnimationFrame(this._tick);
  }

  destroy() {
    window.removeEventListener('keydown', this._onKeyDown, { capture: true });
    window.removeEventListener('keyup', this._onKeyUp, { capture: true });
    window.removeEventListener('blur', this._onBlur);
    this._uninstallMouseDrag();
    this.viewer.scene?.postRender.removeEventListener(this._updateOrientation);
    if (this._raf != null) cancelAnimationFrame(this._raf);
    this._raf = null;
    this._box?.destroy();
  }
}

/**
 * Install keyboard + on-screen camera ground-move/orbit/pitch/zoom controls.
 * @param {Cesium.Viewer} viewer
 * @returns {CameraControls}
 */
export function initCameraControls(viewer) {
  return new CameraControls(viewer);
}
