import * as Cesium from 'cesium';

/**
 * Keyboard + mouse + on-screen camera controls.
 *
 * Arrow keys (and WASD as an alias) steer where the camera is looking —
 * 8-directional, including the four diagonals when two adjacent keys are
 * held together (e.g. Up+Right looks up-and-right). Up/Down is Y-axis
 * tilt — plane-style pitch — and keys 1/3 are a second alias for that same
 * pitch axis (1 = pitch up, 3 = pitch down), alongside Arrows/W-S. Q/E roll
 * the camera. R/F zoom in/out. An on-screen pad mirrors every key for
 * pointer/touch use, with a compact legend so the bindings are discoverable
 * without a manual.
 *
 * Mouse: holding the left+right buttons together and dragging vertically
 * pitches (same Y-axis tilt as Up/Down/1/3); holding the right button alone
 * and dragging horizontally rolls (same axis as Q/E). This claims the right
 * mouse button, so Cesium's native right-drag zoom is disabled in favor of
 * it (scroll-wheel zoom, and the R/F keys, still work).
 *
 * Opposite-direction cancellation: holding both Up and Down (or both Left
 * and Right) at once cancels that axis to a stop, exactly like holding
 * neither — there is no extra "which one wins" bookkeeping. The moment one
 * of the two is released, the axis falls through to whichever single key is
 * still held, so movement resumes in that key's direction immediately. This
 * "hold-both-to-halt" rule applies symmetrically to both axes.
 */

const LOOK_RATE_RAD_S = Cesium.Math.toRadians(65); // arrow/WASD/1-3 look-pan (pitch/yaw) speed
const TWIST_RATE_RAD_S = Cesium.Math.toRadians(50); // Q/E roll speed
const ZOOM_RATE_PER_S = 0.9; // fraction of current camera height, per second
const MIN_ZOOM_STEP_M = 0.5; // floor so zoom still moves at very low altitude
const MAX_FRAME_DT_S = 0.1; // clamp dt after a tab is backgrounded/throttled
const PITCH_DRAG_RAD_PER_PX = Cesium.Math.toRadians(0.15); // L+R drag → pitch
const ROLL_DRAG_RAD_PER_PX = Cesium.Math.toRadians(0.15); // right-drag → roll
const MAX_DRAG_STEP_PX = 60; // clamp a single mousemove delta (e.g. after pointer warp/lag)

/** Keys mapped to a held "direction"/"action" name. Arrow keys are primary; WASD/1-3/QE/RF are aliases. Keyed by KeyboardEvent.code so layout doesn't matter. */
const KEY_TO_ACTION = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right',
  Digit1: 'up', Digit3: 'down', // second pitch alias, alongside Arrows/W-S
  KeyQ: 'rotateLeft', KeyE: 'rotateRight',
  KeyR: 'zoomIn', KeyF: 'zoomOut',
};

/** On-screen pad buttons: each fires one or two actions at once (diagonals = two). */
const PAD_BUTTONS = [
  { cell: 'nw', actions: ['up', 'left'], label: '↖', title: 'Look up-left (W+A / Up+Left)' },
  { cell: 'n', actions: ['up'], label: '↑', title: 'Pitch up (W / Up / 1)' },
  { cell: 'ne', actions: ['up', 'right'], label: '↗', title: 'Look up-right (W+D / Up+Right)' },
  { cell: 'w', actions: ['left'], label: '←', title: 'Look left (A / Left)' },
  { cell: 'e', actions: ['right'], label: '→', title: 'Look right (D / Right)' },
  { cell: 'sw', actions: ['down', 'left'], label: '↙', title: 'Look down-left (S+A / Down+Left)' },
  { cell: 's', actions: ['down'], label: '↓', title: 'Pitch down (S / Down / 3)' },
  { cell: 'se', actions: ['down', 'right'], label: '↘', title: 'Look down-right (S+D / Down+Right)' },
];

const ROTATE_ZOOM_BUTTONS = [
  { actions: ['rotateLeft'], label: '⟲', title: 'Roll left (Q)', group: 'rotate' },
  { actions: ['rotateRight'], label: '⟳', title: 'Roll right (E)', group: 'rotate' },
  { actions: ['zoomOut'], label: '−', title: 'Zoom out (F)', group: 'zoom' },
  { actions: ['zoomIn'], label: '+', title: 'Zoom in (R)', group: 'zoom' },
];

function isEditableTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return Boolean(el.isContentEditable);
}

/**
 * Keys with a PRE-EXISTING single-press global shortcut elsewhere (bubble-
 * phase `keydown` on `document`) that this module's letters/digits collide
 * with: plain 'f' toggles the data panel, plain 'd' cycles detection mode,
 * and plain '1'/'3' switch the sensor style to Normal/Surveillance (see
 * StyleManager's `_globalKeydownHandler` in ui.js — its `keyMap` covers
 * '1'-'7'). Those four are suppressed with `stopPropagation()` while
 * claimed as camera keys so holding them doesn't also flicker the legacy
 * toggle or swap styles mid-pitch. Every other claimed key (arrows, W/A/S,
 * Q/E, R) is left to bubble normally — several existing widgets (e.g. the
 * Global Context tab row's roving arrow-key navigation, the radio tuner
 * slider) also read arrow keys while focused, and suppressing propagation
 * for those would break that existing keyboard navigation.
 */
const LEGACY_SHORTCUT_CODES = new Set(['KeyF', 'KeyD', 'Digit1', 'Digit3']);

/** Builds the on-screen pad + legend and wires pointer press-and-hold to the given callbacks. */
function buildControlPad({ onPress, onRelease }) {
  const root = document.createElement('div');
  root.id = 'camctl-pad';
  root.className = 'camctl-pad';
  root.setAttribute('aria-label', 'Camera look, rotate, and zoom controls');

  const grid = document.createElement('div');
  grid.className = 'camctl-grid';
  root.appendChild(grid);

  const info = document.createElement('div');
  info.className = 'camctl-info';
  info.title = 'Arrows / WASD / 1,3 look (1,3 = pitch) · corner cells look diagonally · Q/E roll · R/F zoom · mouse: hold L+R & drag to pitch, hold right & drag to roll';
  info.textContent = 'i';
  info.setAttribute('aria-hidden', 'true');
  grid.appendChild(info);

  const bind = (btn, actions) => {
    let pointerId = null;
    const start = (event) => {
      event.preventDefault();
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

  for (const { cell, actions, label, title } of PAD_BUTTONS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `camctl-btn camctl-${cell}`;
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.textContent = label;
    bind(btn, actions);
    grid.appendChild(btn);
  }

  const aux = document.createElement('div');
  aux.className = 'camctl-aux';
  root.appendChild(aux);

  for (const { actions, label, title, group } of ROTATE_ZOOM_BUTTONS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `camctl-btn camctl-aux-btn camctl-${group}`;
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.textContent = label;
    bind(btn, actions);
    aux.appendChild(btn);
  }

  const legend = document.createElement('div');
  legend.className = 'camctl-legend';
  legend.textContent = 'Arrows / WASD / 1 3 pitch · Q E or R-drag roll · R F zoom · L+R drag pitch';
  root.appendChild(legend);

  document.body.appendChild(root);

  return {
    destroy() {
      root.remove();
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

    // Right-button drag state (roll alone, pitch when combined with left).
    this._dragActive = false;
    this._dragPointerId = null;
    this._lastDragX = 0;
    this._lastDragY = 0;
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

    // Capture phase so the F/D/1/3 conflict check (LEGACY_SHORTCUT_CODES)
    // runs before ui.js's bubble-phase global shortcut handler; every other
    // key still bubbles through untouched (see isEditableTarget / the note
    // above LEGACY_SHORTCUT_CODES).
    window.addEventListener('keydown', this._onKeyDown, { capture: true });
    window.addEventListener('keyup', this._onKeyUp, { capture: true });
    window.addEventListener('blur', this._onBlur);

    this._pad = buildControlPad({
      onPress: (actions) => {
        actions.forEach((a) => this._pointerHeld.add(a));
        this._ensureLoop();
      },
      onRelease: (actions) => {
        actions.forEach((a) => this._pointerHeld.delete(a));
      },
    });

    this._installMouseDrag();
  }

  /**
   * Claim the right mouse button for pitch/roll drag: right-alone drag
   * (horizontal) rolls, left+right-together drag (vertical) pitches. This
   * repurposes Cesium's native right-drag zoom, so RIGHT_DRAG is removed
   * from the controller's zoomEventTypes (wheel/pinch zoom is untouched);
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
  static get _LEFT_BIT() { return 1; }

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
    const leftDown = (event.buttons & CameraControls._LEFT_BIT) !== 0;

    const dx = Cesium.Math.clamp(event.clientX - this._lastDragX, -MAX_DRAG_STEP_PX, MAX_DRAG_STEP_PX);
    const dy = Cesium.Math.clamp(event.clientY - this._lastDragY, -MAX_DRAG_STEP_PX, MAX_DRAG_STEP_PX);
    this._lastDragX = event.clientX;
    this._lastDragY = event.clientY;

    const camera = this.viewer.camera;
    if (leftDown) {
      // Both buttons: vertical drag pitches (Y-axis tilt) — up = pitch up,
      // matching the same convention as the Up/1 key and non-inverted
      // FPS-style mouselook.
      if (dy !== 0) {
        const step = Math.abs(dy) * PITCH_DRAG_RAD_PER_PX;
        if (dy < 0) camera.lookUp(step);
        else camera.lookDown(step);
      }
    } else if (dx !== 0) {
      // Right alone: horizontal drag rolls.
      const step = Math.abs(dx) * ROLL_DRAG_RAD_PER_PX;
      if (dx > 0) camera.twistRight(step);
      else camera.twistLeft(step);
    }
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
    // Only the two keys with a confirmed pre-existing conflict are stopped
    // from bubbling — see LEGACY_SHORTCUT_CODES. Everything else (arrows,
    // W/A/S, Q/E, R) still reaches any element-specific handler.
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

  _tick(t) {
    const dt = Math.min(MAX_FRAME_DT_S, Math.max(0, (t - (this._lastT ?? t)) / 1000));
    this._lastT = t;
    const active = this._activeActions();

    if (active.size === 0) {
      this._raf = null;
      return;
    }

    const camera = this.viewer.camera;

    // Opposite-direction cancellation on each axis independently: both held
    // (or neither) nets to 0 ("stop"); releasing one falls straight through
    // to the other's direction, with no separate "release" branch needed.
    const vertical = (active.has('up') ? 1 : 0) - (active.has('down') ? 1 : 0);
    const horizontal = (active.has('right') ? 1 : 0) - (active.has('left') ? 1 : 0);

    if (vertical !== 0 || horizontal !== 0) {
      // Diagonals combine a vertical and horizontal look in the same frame;
      // scale down so a corner pair isn't faster than a single cardinal.
      const scale = (vertical !== 0 && horizontal !== 0) ? Math.SQRT1_2 : 1;
      const step = LOOK_RATE_RAD_S * dt * scale;
      if (vertical > 0) camera.lookUp(step);
      else if (vertical < 0) camera.lookDown(step);
      if (horizontal > 0) camera.lookRight(step);
      else if (horizontal < 0) camera.lookLeft(step);
    }

    const rotateVertical = (active.has('rotateRight') ? 1 : 0) - (active.has('rotateLeft') ? 1 : 0);
    if (rotateVertical > 0) camera.twistRight(TWIST_RATE_RAD_S * dt);
    else if (rotateVertical < 0) camera.twistLeft(TWIST_RATE_RAD_S * dt);

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
    if (this._raf != null) cancelAnimationFrame(this._raf);
    this._raf = null;
    this._pad?.destroy();
  }
}

/**
 * Install keyboard + on-screen camera look/rotate/zoom controls.
 * @param {Cesium.Viewer} viewer
 * @returns {CameraControls}
 */
export function initCameraControls(viewer) {
  return new CameraControls(viewer);
}
