/**
 * @file Generic movable, resizable, collapsible, hideable "mini control
 * box" — the same drag/resize/persist mechanics originally built for the
 * on-screen camera pad, factored out so small toggleable-controls panels
 * (camera controls, map overlays) don't each reimplement pointer-drag math,
 * localStorage geometry persistence, and viewport clamping.
 *
 * `cameraControls.js`'s `buildControlBox` now builds on this helper too
 * (via `idPrefix: 'camctl'`), so all of the app's mini control boxes share
 * one implementation.
 *
 * Full "Hide panel" (×) support is built in here (see `hideable` below) and
 * on by default, so every box built on this helper — current and future —
 * is hideable from the Hidden Panels tray with zero extra per-box code;
 * individual boxes used to each hand-roll their own close button wired
 * into `panelVisibility.js`, which meant it was easy for a new box to
 * quietly ship without one (as happened with Camera, Map Overlays,
 * Coordinates, and HUD Readouts before this).
 *
 * @module miniBox
 */

import { hidePanel, isPanelHidden, registerPanelLabel } from './panelVisibility.js';
import { attachResizeHandles } from './panelResize.js';

// Per a direct user ask ("allow boxes to touch the edge of the screen") —
// was 6px; a small residual inset is kept only so the header/resize-handle
// hit areas never sit literally under the OS/browser chrome edge, but a
// box can now sit almost flush against the viewport.
const EDGE_INSET = 1;

/** Clamp a box's top-left so it stays fully on-screen at its current size. */
function clampToViewport(left, top, width, height) {
  const maxLeft = Math.max(EDGE_INSET, window.innerWidth - width - EDGE_INSET);
  const maxTop = Math.max(EDGE_INSET, window.innerHeight - height - EDGE_INSET);
  return {
    left: Math.max(EDGE_INSET, Math.min(maxLeft, left)),
    top: Math.max(EDGE_INSET, Math.min(maxTop, top)),
  };
}

/**
 * @param {Object} opts
 * @param {string} opts.idPrefix - e.g. 'mapovl' -> id="mapovl-pad", classes "mapovl-pad"/"mapovl-*".
 * @param {string} opts.storagePrefix - localStorage key prefix, e.g. 'godsEyeView.mapOverlayBox.'.
 * @param {string} opts.title - Header title text.
 * @param {string} [opts.ariaLabel]
 * @param {number} [opts.defaultWidth=220]
 * @param {number} [opts.defaultHeight=360]
 * @param {number} [opts.minWidth=180]
 * @param {number} [opts.maxWidth=440]
 * @param {number} [opts.minHeight=180]
 * @param {number} [opts.maxHeight=720]
 * @param {Object} [opts.anchor] - CSS anchor for the default position, e.g. {right:'16px', top:'16px'} or {left:'16px', bottom:'calc(2vh + 4.5rem)'}.
 * @param {(header:HTMLElement)=>void} [opts.onHeaderBuilt] - Append extra header controls (e.g. a screenshot button) before the hide/collapse toggles.
 * @param {boolean} [opts.hideable=true] - Add a "×" hide button wired into `panelVisibility.js` (keyed on the box's own id, e.g. "camctl-pad") and self-register its label for the Hidden Panels restore tray. Pass `false` only for a box that must always stay on screen (e.g. the restore tray itself, which is everyone's way back).
 * @returns {{root:HTMLElement, body:HTMLElement, header:HTMLElement, resetGeometry:Function, destroy:Function}}
 */
export function buildMiniBox(opts) {
  const {
    idPrefix,
    storagePrefix,
    title,
    ariaLabel = title,
    defaultWidth = 220,
    defaultHeight = 360,
    minWidth = 180,
    maxWidth = 440,
    minHeight = 180,
    maxHeight = 720,
    anchor = { left: '24px', bottom: 'calc(2vh + 4.5rem)' },
    onHeaderBuilt,
    hideable = true,
  } = opts;

  const cls = (suffix) => `${idPrefix}-${suffix}`;

  const root = document.createElement('div');
  root.id = cls('pad');
  root.className = cls('pad');
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', ariaLabel);

  const header = document.createElement('div');
  header.className = cls('header');
  header.title = 'Drag to move · double-click to reset position and size';

  const grip = document.createElement('span');
  grip.className = cls('grip');
  grip.textContent = '⋮⋮';
  grip.setAttribute('aria-hidden', 'true');
  header.appendChild(grip);

  const titleEl = document.createElement('span');
  titleEl.className = cls('title');
  titleEl.textContent = title;
  header.appendChild(titleEl);

  if (typeof onHeaderBuilt === 'function') onHeaderBuilt(header);

  // Collapse (−) before close/hide (×) — per a direct user ask ("swap the
  // close and minimise in the gui"). Collapse is the low-stakes, frequent
  // action (just tucks the body away, box stays put); close/hide is the
  // rarer, bigger one (drops the panel into the Hidden Panels tray), so it
  // now sits furthest from where a header click naturally lands first.
  const collapseBtn = document.createElement('button');
  collapseBtn.type = 'button';
  collapseBtn.className = cls('collapse-btn');
  collapseBtn.title = 'Collapse/expand';
  collapseBtn.setAttribute('aria-label', 'Collapse or expand panel');
  collapseBtn.textContent = '−';
  header.appendChild(collapseBtn);

  if (hideable) {
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = cls('close-btn');
    closeBtn.title = 'Hide panel — restore it from the Hidden Panels tray';
    closeBtn.setAttribute('aria-label', `Hide ${title} panel`);
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      hidePanel(root.id);
    });
    header.appendChild(closeBtn);
    registerPanelLabel(root.id, title);
  }

  root.appendChild(header);

  const body = document.createElement('div');
  body.className = cls('body');
  root.appendChild(body);

  collapseBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    const collapsed = body.hidden = !body.hidden;
    collapseBtn.textContent = collapsed ? '+' : '−';
    root.classList.toggle('is-collapsed', collapsed);
  });

  document.body.appendChild(root);

  // Boxes are built well after ui.js's one-time startup
  // `applyStoredHiddenState()` pass (most don't exist yet at that point),
  // so a previously-hidden state has to be re-applied here instead of
  // relying on that pass.
  if (hideable) root.classList.toggle('panel-fully-hidden', isPanelHidden(root.id));

  const posKey = `${storagePrefix}pos`;
  const sizeKey = `${storagePrefix}size`;

  function applyDefaultGeometry() {
    root.style.width = `${defaultWidth}px`;
    root.style.height = `${defaultHeight}px`;
    root.style.left = anchor.left ?? 'auto';
    root.style.right = anchor.right ?? 'auto';
    root.style.top = anchor.top ?? 'auto';
    root.style.bottom = anchor.bottom ?? 'auto';
  }
  applyDefaultGeometry();

  function currentRect() {
    return root.getBoundingClientRect();
  }

  function pinToLeftTop() {
    const rect = currentRect();
    root.style.top = `${rect.top}px`;
    root.style.bottom = 'auto';
    root.style.left = `${rect.left}px`;
    root.style.right = 'auto';
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
          root.style.width = `${Math.max(minWidth, Math.min(maxWidth, size.width))}px`;
          root.style.height = `${Math.max(minHeight, Math.min(maxHeight, size.height))}px`;
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
          const { left, top } = clampToViewport(pos.left, pos.top, rect.width, rect.height);
          root.style.left = `${left}px`;
          root.style.top = `${top}px`;
          root.style.right = 'auto';
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

  let dragOffsetX = 0;
  let dragOffsetY = 0;
  const onDragMove = (event) => {
    const rect = currentRect();
    const { left, top } = clampToViewport(event.clientX - dragOffsetX, event.clientY - dragOffsetY, rect.width, rect.height);
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
    if (event.target === collapseBtn) return;
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
    if (event.target === collapseBtn) return;
    event.preventDefault();
    resetGeometry();
  });

  // Every edge and corner, not just the bottom-right grip this box used to
  // carry — a box parked against the right or bottom of the viewport could
  // only be grown away from where the space actually was.
  const resizer = attachResizeHandles(root, {
    legacyClassName: cls('resize-handle'),
    label: `${title} panel`,
    onStart: () => pinToLeftTop(),
    getRect: () => {
      const rect = currentRect();
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    },
    getLimits: () => ({ minWidth, maxWidth, minHeight, maxHeight }),
    onResize: ({ left, top, width, height }) => {
      root.style.width = `${width}px`;
      root.style.height = `${height}px`;
      root.style.left = `${left}px`;
      root.style.top = `${top}px`;
    },
    onEnd: () => {
      saveSize();
      const rect = currentRect();
      const { left, top } = clampToViewport(rect.left, rect.top, rect.width, rect.height);
      root.style.left = `${left}px`;
      root.style.top = `${top}px`;
      root.style.right = 'auto';
      root.style.bottom = 'auto';
      savePos();
    },
  });

  const onWindowResize = () => {
    const rect = currentRect();
    const { left, top } = clampToViewport(rect.left, rect.top, rect.width, rect.height);
    if (root.style.left && root.style.left !== 'auto') root.style.left = `${left}px`;
    if (root.style.top && root.style.top !== 'auto') root.style.top = `${top}px`;
  };
  window.addEventListener('resize', onWindowResize);

  return {
    root,
    body,
    header,
    resetGeometry,
    destroy() {
      window.removeEventListener('resize', onWindowResize);
      window.removeEventListener('pointermove', onDragMove);
      window.removeEventListener('pointerup', onDragUp);
      window.removeEventListener('pointercancel', onDragUp);
      resizer.destroy();
      root.remove();
    },
  };
}
