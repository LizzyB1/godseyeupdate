import * as Cesium from 'cesium';

/**
 * Keyboard + mouse + on-screen camera controls, housed in one movable,
 * resizable control box (bottom-left by default).
 *
 * Arrow keys (and WASD as an alias) translate the camera — Up/W and Down/S
 * move it LATERALLY (side to side, perpendicular to where it's looking),
 * Left/A and Right/D ORBIT it instead of turning it: the camera swings
 * around a ground focal point — wherever it was looking when the orbit key
 * was first pressed — rather than spinning in place around its own eye
 * position. Concretely, an orbit key press: (1) casts a ray from the
 * camera along its current view direction to find where it meets the
 * ellipsoid (falling back to the point straight below the camera if the
 * view is tilted above the horizon, e.g. toward the sky) and holds that
 * point fixed for as long as the key stays down; (2) every frame, moves
 * the camera's heading around that fixed point while holding pitch and
 * distance-to-point constant (`camera.lookAt` with a `HeadingPitchRange`,
 * transform reset to identity immediately after so every other camera
 * method keeps working in world space). The same patch of ground stays
 * framed while the vantage point swings around it — a proper orbit,
 * distinct from `camera.lookLeft/lookRight`, which would just re-aim the
 * camera from a fixed position and let that ground point slide out of
 * view. Releasing and re-pressing an orbit key re-picks the focal point
 * from wherever the camera ends up looking next.
 *
 * Move speed (lateral translation) scales with current altitude (a
 * fraction of camera height per second, floored so it still moves at
 * ground level) — the same scaling R/F zoom already uses for its own
 * forward/backward dolly.
 *
 * Pitch — tilting the view up/down — has its own dedicated pair:
 * PageUp/PageDown, aliased to 1/3 for continuity with the old arrow-key
 * pitch binding. Q/E roll the camera (rotate about the view axis — a
 * different motion from the A/D orbit above); R/F zoom, which already
 * doubles as forward/backward dolly since lateral movement no longer
 * covers that axis.
 *
 * A live orientation readout lives at the top of the control box: a compass
 * needle that swings to the camera's current heading, with a small
 * camera-lens glyph at its tip that banks with roll, plus a text readout of
 * heading/pitch/roll in degrees. It updates on every rendered frame via
 * Cesium's `scene.postRender`, so it stays accurate no matter what moved
 * the camera — keys, the on-screen pad, mouse-drag, or Cesium's own native
 * orbit/pan.
 *
 * Mouse: holding the left+right buttons together and dragging vertically
 * pitches (same axis as PageUp/PageDown/1/3); holding the right button
 * alone and dragging horizontally rolls (same axis as Q/E). This claims
 * the right mouse button, so Cesium's native right-drag zoom is disabled
 * in favor of it (scroll-wheel zoom, and the R/F keys, still work).
 *
 * Opposite-direction cancellation: holding both keys of an axis (lateral
 * left+right, orbit left+right, or pitch up+down) at once cancels that
 * axis to a stop, exactly like holding neither — there is no extra "which
 * one wins" bookkeeping. The moment one of the two is released, the axis
 * falls through to whichever single key is still held, so movement resumes
 * in that key's direction immediately. For orbit specifically, this also
 * means the held focal point survives a brief overlap (both keys down for
 * one frame) and is only released once BOTH orbit keys are up.
 *
 * The whole control box — grip header, orientation readout, lateral pair,
 * orbit pair, pitch pair, roll/zoom pair, legend, resize handle — is one
 * DOM subtree, so it can be dragged (grip the header) and resized (drag
 * the bottom-right corner) as a unit. Position and size persist to
 * localStorage under the `godsEyeView.camCtlBox.` prefix; double-clicking
 * the header resets both to their defaults.
 */

const MOVE_RATE_PER_S = 0.6; // fraction of current camera height, per second — W/S/A/D lateral speed
const MIN_MOVE_STEP_M = 0.5; // floor so lateral movement still moves at very low altitude
const ORBIT_RATE_RAD_S = Cesium.Math.toRadians(50); // A/D orbit-around-focal-point speed
const PITCH_RATE_RAD_S = Cesium.Math.toRadians(65); // PageUp/PageDown/1-3 pitch speed
const TWIST_RATE_RAD_S = Cesium.Math.toRadians(50); // Q/E roll speed
const ZOOM_RATE_PER_S = 0.9; // fraction of current camera height, per second
const MIN_ZOOM_STEP_M = 0.5; // floor so zoom still moves at very low altitude
const MAX_FRAME_DT_S = 0.1; // clamp dt after a tab is backgrounded/throttled
const PITCH_DRAG_RAD_PER_PX = Cesium.Math.toRadians(0.15); // L+R drag → pitch
const ROLL_DRAG_RAD_PER_PX = Cesium.Math.toRadians(0.15); // right-drag → roll
const MAX_DRAG_STEP_PX = 60; // clamp a single mousemove delta (e.g. after pointer warp/lag)

/** Box drag/resize persistence + bounds. */
const STORAGE_PREFIX = 'godsEyeView.camCtlBox.';
const EDGE_INSET = 6;
const DEFAULT_WIDTH = 176;
const DEFAULT_HEIGHT = 330;
const MIN_WIDTH = 150;
const MAX_WIDTH = 360;
const MIN_HEIGHT = 220;
const MAX_HEIGHT = 560;

/** Keys mapped to a held "direction"/"action" name. Arrow keys are primary; WASD/PageUp-Down/1-3/QE/RF are aliases. Keyed by KeyboardEvent.code so layout doesn't matter. */
const KEY_TO_ACTION = {
  ArrowUp: 'lateralLeft', ArrowDown: 'lateralRight', ArrowLeft: 'orbitLeft', ArrowRight: 'orbitRight',
  KeyW: 'lateralLeft', KeyS: 'lateralRight', KeyA: 'orbitLeft', KeyD: 'orbitRight',
  PageUp: 'pitchUp', PageDown: 'pitchDown',
  Digit1: 'pitchUp', Digit3: 'pitchDown', // second pitch alias, held over from the old arrow-key binding
  KeyQ: 'rollLeft', KeyE: 'rollRight',
  KeyR: 'zoomIn', KeyF: 'zoomOut',
};

/** Lateral (side-to-side) translation pair — W/S / Up/Down. Perpendicular
 * to the view direction, at constant pitch/height — a pure sideways slide
 * across the surface, not a dive toward or climb away from it. */
const LATERAL_BUTTONS = [
  { actions: ['lateralLeft'], label: '←', title: 'Move laterally left (W / Up)' },
  { actions: ['lateralRight'], label: '→', title: 'Move laterally right (S / Down)' },
];

/** Orbit pair — A/D / Left/Right. Swings the camera around a ground focal
 * point picked from wherever it's currently looking, instead of spinning
 * it in place — see the module doc comment above. */
const ORBIT_BUTTONS = [
  { actions: ['orbitLeft'], label: '↶', title: 'Orbit left around ground point (A / Left)' },
  { actions: ['orbitRight'], label: '↷', title: 'Orbit right around ground point (D / Right)' },
];

/** Dedicated pitch pair. */
const PITCH_BUTTONS = [
  { actions: ['pitchUp'], label: '▲', title: 'Pitch up (PageUp / 1)' },
  { actions: ['pitchDown'], label: '▼', title: 'Pitch down (PageDown / 3)' },
];

const ROLL_ZOOM_BUTTONS = [
  { actions: ['rollLeft'], label: '⟲', title: 'Roll left (Q)', group: 'rotate' },
  { actions: ['rollRight'], label: '⟳', title: 'Roll right (E)', group: 'rotate' },
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
 * Q/E, R, PageUp/PageDown) is left to bubble normally — several existing
 * widgets (e.g. the Global Context tab row's roving arrow-key navigation,
 * the radio tuner slider) also read arrow keys while focused, and
 * suppressing propagation for those would break that existing keyboard
 * navigation.
 */
const LEGACY_SHORTCUT_CODES = new Set(['KeyF', 'KeyD', 'Digit1', 'Digit3']);

/** Clamp a box's top-left so it stays fully on-screen at its current size. */
function clampBoxToViewport(left, top, width, height) {
  const maxLeft = Math.max(EDGE_INSET, window.innerWidth - width - EDGE_INSET);
  const maxTop = Math.max(EDGE_INSET, window.innerHeight - height - EDGE_INSET);
  return {
    left: Math.max(EDGE_INSET, Math.min(maxLeft, left)),
    top: Math.max(EDGE_INSET, Math.min(maxTop, top)),
  };
}

/** Radians → unsigned compass degrees in [0, 360). */
function toCompassDeg(rad) {
  let deg = Cesium.Math.toDegrees(rad) % 360;
  if (deg < 0) deg += 360;
  return deg;
}

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
 * Builds the movable/resizable control box (header + orientation readout +
 * move pad + pitch pair + roll/zoom pair + legend + resize handle) and
 * wires pointer press-and-hold to the given callbacks.
 */
function buildControlBox({ onPress, onRelease }) {
  const root = document.createElement('div');
  root.id = 'camctl-pad';
  root.className = 'camctl-pad';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Camera lateral move, orbit, pitch, roll, zoom, and orientation controls');

  // ── Header: drag grip, title, and a compact live heading readout ──────
  const header = document.createElement('div');
  header.className = 'camctl-header';
  header.title = 'Drag to move · double-click to reset position and size';

  const grip = document.createElement('span');
  grip.className = 'camctl-grip';
  grip.textContent = '⋮⋮';
  grip.setAttribute('aria-hidden', 'true');
  header.appendChild(grip);

  const title = document.createElement('span');
  title.className = 'camctl-title';
  title.textContent = 'CAMERA';
  header.appendChild(title);

  const headingChip = document.createElement('span');
  headingChip.className = 'camctl-heading-chip';
  headingChip.textContent = '000°';
  header.appendChild(headingChip);

  root.appendChild(header);

  // ── Body ────────────────────────────────────────────────────────────
  const body = document.createElement('div');
  body.className = 'camctl-body';
  root.appendChild(body);

  // Orientation: compass ring (static, N-up) + rotating needle tipped with
  // a camera-lens glyph that banks with roll, plus a text readout.
  const orient = document.createElement('div');
  orient.className = 'camctl-orient';
  orient.setAttribute('aria-hidden', 'true');

  const compass = document.createElement('div');
  compass.className = 'camctl-orient-compass';

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 40 40');
  svg.setAttribute('class', 'camctl-orient-svg');
  svg.setAttribute('focusable', 'false');

  const ring = document.createElementNS(svg.namespaceURI, 'circle');
  ring.setAttribute('class', 'camctl-orient-ring');
  ring.setAttribute('cx', '20');
  ring.setAttribute('cy', '20');
  ring.setAttribute('r', '17.5');
  svg.appendChild(ring);

  const nTick = document.createElementNS(svg.namespaceURI, 'text');
  nTick.setAttribute('class', 'camctl-orient-n');
  nTick.setAttribute('x', '20');
  nTick.setAttribute('y', '7');
  nTick.setAttribute('text-anchor', 'middle');
  nTick.textContent = 'N';
  svg.appendChild(nTick);

  const needle = document.createElementNS(svg.namespaceURI, 'g');
  needle.setAttribute('class', 'camctl-orient-needle');

  const cone = document.createElementNS(svg.namespaceURI, 'path');
  cone.setAttribute('class', 'camctl-orient-cone');
  cone.setAttribute('d', 'M20 20 L16.2 10.5 L20 6.5 L23.8 10.5 Z');
  needle.appendChild(cone);

  const camGroup = document.createElementNS(svg.namespaceURI, 'g');
  camGroup.setAttribute('class', 'camctl-orient-cam');

  const lensBody = document.createElementNS(svg.namespaceURI, 'circle');
  lensBody.setAttribute('class', 'camctl-orient-lens-body');
  lensBody.setAttribute('cx', '20');
  lensBody.setAttribute('cy', '9');
  lensBody.setAttribute('r', '4.1');
  camGroup.appendChild(lensBody);

  const lens = document.createElementNS(svg.namespaceURI, 'circle');
  lens.setAttribute('class', 'camctl-orient-lens');
  lens.setAttribute('cx', '20');
  lens.setAttribute('cy', '9');
  lens.setAttribute('r', '1.7');
  camGroup.appendChild(lens);

  needle.appendChild(camGroup);
  svg.appendChild(needle);

  const hub = document.createElementNS(svg.namespaceURI, 'circle');
  hub.setAttribute('class', 'camctl-orient-hub');
  hub.setAttribute('cx', '20');
  hub.setAttribute('cy', '20');
  hub.setAttribute('r', '2');
  svg.appendChild(hub);

  compass.appendChild(svg);
  orient.appendChild(compass);

  const readout = document.createElement('div');
  readout.className = 'camctl-orient-readout';
  readout.innerHTML =
    '<span class="camctl-orient-field"><b>HDG</b><i data-f="hdg">000°</i></span>' +
    '<span class="camctl-orient-field"><b>PIT</b><i data-f="pit">+0°</i></span>' +
    '<span class="camctl-orient-field"><b>ROL</b><i data-f="rol">+0°</i></span>';
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

  // Lateral (side-to-side translation) pair.
  const lateralRow = document.createElement('div');
  lateralRow.className = 'camctl-row';
  lateralRow.title = 'Move sideways at constant height (W/Up = left, S/Down = right)';
  for (const { actions, label, title: btnTitle } of LATERAL_BUTTONS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'camctl-btn camctl-row-btn';
    btn.title = btnTitle;
    btn.setAttribute('aria-label', btnTitle);
    btn.textContent = label;
    bind(btn, actions);
    lateralRow.appendChild(btn);
  }
  body.appendChild(lateralRow);

  // Orbit pair — swings around a ground focal point instead of spinning in place.
  const orbitRow = document.createElement('div');
  orbitRow.className = 'camctl-row';
  orbitRow.title = 'Orbit around the ground point currently in view (A/Left, D/Right)';
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

  // Roll + zoom.
  const aux = document.createElement('div');
  aux.className = 'camctl-aux';
  for (const { actions, label, title: btnTitle, group } of ROLL_ZOOM_BUTTONS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `camctl-btn camctl-aux-btn camctl-${group}`;
    btn.title = btnTitle;
    btn.setAttribute('aria-label', btnTitle);
    btn.textContent = label;
    bind(btn, actions);
    aux.appendChild(btn);
  }
  body.appendChild(aux);

  const legend = document.createElement('div');
  legend.className = 'camctl-legend';
  legend.title = 'W/S/Up/Down slide sideways · A/D/Left/Right orbit a ground point · PageUp/PageDown or 1/3 pitch · Q/E or right-drag roll · R/F zoom · mouse L+R drag pitch';
  legend.textContent = 'W/S lateral · A/D orbit · PgUp/PgDn pitch · Q/E roll · R/F zoom';
  body.appendChild(legend);

  // ── Resize handle (bottom-right corner) ────────────────────────────
  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'camctl-resize-handle';
  resizeHandle.title = 'Drag to resize';
  resizeHandle.setAttribute('role', 'separator');
  resizeHandle.setAttribute('aria-label', 'Resize camera control box');
  root.appendChild(resizeHandle);

  document.body.appendChild(root);

  // ── Position/size: restore, drag, resize, persist, clamp on window resize ──
  const posKey = `${STORAGE_PREFIX}pos`;
  const sizeKey = `${STORAGE_PREFIX}size`;

  function applyDefaultGeometry() {
    root.style.width = `${DEFAULT_WIDTH}px`;
    root.style.height = `${DEFAULT_HEIGHT}px`;
    root.style.left = '24px';
    root.style.top = 'auto';
    root.style.bottom = 'calc(2vh + 4.5rem)';
    root.style.right = 'auto';
  }
  applyDefaultGeometry();

  function currentRect() {
    return root.getBoundingClientRect();
  }

  function pinToLeftTop() {
    // Once dragged/resized, the box is positioned by left/top rather than
    // the default bottom-anchored placement.
    const rect = currentRect();
    root.style.top = `${rect.top}px`;
    root.style.bottom = 'auto';
    root.style.left = `${rect.left}px`;
  }

  function savePos() {
    const rect = currentRect();
    try {
      localStorage.setItem(posKey, JSON.stringify({ left: Math.round(rect.left), top: Math.round(rect.top) }));
    } catch { /* storage unavailable */ }
  }

  function saveSize() {
    const rect = currentRect();
    try {
      localStorage.setItem(sizeKey, JSON.stringify({ width: Math.round(rect.width), height: Math.round(rect.height) }));
    } catch { /* storage unavailable */ }
  }

  function restore() {
    let sizeRaw;
    try { sizeRaw = localStorage.getItem(sizeKey); } catch { sizeRaw = null; }
    if (sizeRaw) {
      try {
        const size = JSON.parse(sizeRaw);
        if (Number.isFinite(size?.width) && Number.isFinite(size?.height)) {
          root.style.width = `${Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, size.width))}px`;
          root.style.height = `${Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, size.height))}px`;
        }
      } catch { /* ignore malformed */ }
    }

    let posRaw;
    try { posRaw = localStorage.getItem(posKey); } catch { posRaw = null; }
    if (posRaw) {
      try {
        const pos = JSON.parse(posRaw);
        if (Number.isFinite(pos?.left) && Number.isFinite(pos?.top)) {
          const rect = currentRect();
          const { left, top } = clampBoxToViewport(pos.left, pos.top, rect.width, rect.height);
          root.style.left = `${left}px`;
          root.style.top = `${top}px`;
          root.style.bottom = 'auto';
        }
      } catch { /* ignore malformed */ }
    }
  }
  restore();

  function resetGeometry() {
    try { localStorage.removeItem(posKey); } catch { /* storage unavailable */ }
    try { localStorage.removeItem(sizeKey); } catch { /* storage unavailable */ }
    applyDefaultGeometry();
  }

  // Drag-to-move via the header.
  let dragOffsetX = 0;
  let dragOffsetY = 0;
  const onDragMove = (event) => {
    const rect = currentRect();
    const { left, top } = clampBoxToViewport(event.clientX - dragOffsetX, event.clientY - dragOffsetY, rect.width, rect.height);
    root.style.left = `${left}px`;
    root.style.top = `${top}px`;
  };
  const onDragUp = () => {
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', onDragUp);
    window.removeEventListener('pointercancel', onDragUp);
    header.classList.remove('is-dragging');
    savePos();
  };
  header.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const rect = currentRect();
    dragOffsetX = event.clientX - rect.left;
    dragOffsetY = event.clientY - rect.top;
    pinToLeftTop();
    header.classList.add('is-dragging');
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragUp);
    window.addEventListener('pointercancel', onDragUp);
  });
  header.addEventListener('dblclick', (event) => {
    event.preventDefault();
    resetGeometry();
  });

  // Drag-to-resize via the corner handle.
  let resizeStartX = 0;
  let resizeStartY = 0;
  let resizeStartW = 0;
  let resizeStartH = 0;
  const onResizeMove = (event) => {
    const width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, resizeStartW + (event.clientX - resizeStartX)));
    const height = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, resizeStartH + (event.clientY - resizeStartY)));
    root.style.width = `${width}px`;
    root.style.height = `${height}px`;
  };
  const onResizeUp = () => {
    window.removeEventListener('pointermove', onResizeMove);
    window.removeEventListener('pointerup', onResizeUp);
    window.removeEventListener('pointercancel', onResizeUp);
    resizeHandle.classList.remove('is-active');
    saveSize();
    // Resizing can push the bottom/right edge off-screen; pull it back.
    const rect = currentRect();
    const { left, top } = clampBoxToViewport(rect.left, rect.top, rect.width, rect.height);
    root.style.left = `${left}px`;
    root.style.top = `${top}px`;
    root.style.bottom = 'auto';
  };
  resizeHandle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    pinToLeftTop();
    const rect = currentRect();
    resizeStartX = event.clientX;
    resizeStartY = event.clientY;
    resizeStartW = rect.width;
    resizeStartH = rect.height;
    resizeHandle.classList.add('is-active');
    window.addEventListener('pointermove', onResizeMove);
    window.addEventListener('pointerup', onResizeUp);
    window.addEventListener('pointercancel', onResizeUp);
  });

  const onWindowResize = () => {
    const rect = currentRect();
    const { left, top } = clampBoxToViewport(rect.left, rect.top, rect.width, rect.height);
    if (root.style.left) root.style.left = `${left}px`;
    if (root.style.top && root.style.top !== 'auto') root.style.top = `${top}px`;
  };
  window.addEventListener('resize', onWindowResize);

  return {
    headingChip,
    orientFields: {
      hdg: readout.querySelector('[data-f="hdg"]'),
      pit: readout.querySelector('[data-f="pit"]'),
      rol: readout.querySelector('[data-f="rol"]'),
    },
    needleEl: needle,
    camGroupEl: camGroup,
    destroy() {
      window.removeEventListener('resize', onWindowResize);
      window.removeEventListener('pointermove', onDragMove);
      window.removeEventListener('pointerup', onDragUp);
      window.removeEventListener('pointercancel', onDragUp);
      window.removeEventListener('pointermove', onResizeMove);
      window.removeEventListener('pointerup', onResizeUp);
      window.removeEventListener('pointercancel', onResizeUp);
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

    // Orbit's held ground focal point (Cartesian3) — picked once when an
    // orbit key/button is first pressed, cleared once BOTH orbit keys are
    // up (see the opposite-direction-cancellation note in the module doc
    // comment). Range/pitch are captured alongside it so every subsequent
    // frame's `camera.lookAt` only advances heading, keeping the same
    // ground point framed at a constant distance and tilt.
    this._orbitFocus = null;
    this._orbitRange = 0;
    this._orbitPitch = 0;

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
      // matching the same convention as PageUp/1 and non-inverted FPS-style
      // mouselook.
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
    // W/A/S, Q/E, R, PageUp/PageDown) still reaches any element-specific handler.
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
   * Reads the camera's current heading/pitch/roll and updates the
   * orientation compass + text readout. Cheap DOM/CSS-transform writes
   * only — safe to run on every `postRender`.
   */
  _updateOrientation() {
    const box = this._box;
    if (!box) return;
    const camera = this.viewer.camera;
    if (!camera) return;

    const headingDeg = toCompassDeg(camera.heading);
    const pitchDeg = toSignedDeg(camera.pitch);
    const rollDeg = toSignedDeg(camera.roll);

    // Needle points where the camera is looking (0 = N/up, clockwise),
    // matching Cesium's own heading convention 1:1. Uses SVG's native
    // `transform` attribute (rotate around an explicit pivot point) rather
    // than a CSS transform — CSS transform-origin on an SVG <g> resolves
    // against its bounding box, which drifts as the needle's own content
    // rotates; the attribute form pivots exactly around (20,20) every time.
    box.needleEl.setAttribute('transform', `rotate(${headingDeg} 20 20)`);
    // The lens glyph at the needle's tip banks independently with roll,
    // pivoting around its own center (20,9).
    box.camGroupEl.setAttribute('transform', `rotate(${rollDeg} 20 9)`);

    const hdgText = `${Math.round(headingDeg).toString().padStart(3, '0')}°`;
    box.headingChip.textContent = hdgText;
    box.orientFields.hdg.textContent = hdgText;
    box.orientFields.pit.textContent = fmtSignedDeg(pitchDeg);
    box.orientFields.rol.textContent = fmtSignedDeg(rollDeg);
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
    const lateralDir = (active.has('lateralRight') ? 1 : 0) - (active.has('lateralLeft') ? 1 : 0);
    if (lateralDir !== 0) {
      const height = camera.positionCartographic?.height;
      const amount = Math.max(MIN_MOVE_STEP_M, (Number.isFinite(height) ? height : 1000) * MOVE_RATE_PER_S * dt);
      // Pure sideways translation — perpendicular to view direction, no
      // forward/backward component — so it slides across the surface at
      // constant height instead of diving toward or climbing away from it
      // the way `moveForward`/`moveBackward` would at any nonzero pitch.
      if (lateralDir > 0) camera.moveRight(amount);
      else camera.moveLeft(amount);
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

    const rollDir = (active.has('rollRight') ? 1 : 0) - (active.has('rollLeft') ? 1 : 0);
    if (rollDir > 0) camera.twistRight(TWIST_RATE_RAD_S * dt);
    else if (rollDir < 0) camera.twistLeft(TWIST_RATE_RAD_S * dt);

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
 * Install keyboard + on-screen camera strafe/pitch/roll/zoom controls.
 * @param {Cesium.Viewer} viewer
 * @returns {CameraControls}
 */
export function initCameraControls(viewer) {
  return new CameraControls(viewer);
}
