/**
 * @file Generic movable, resizable, collapsible "mini control box" — the
 * same drag/resize/persist mechanics originally built for the on-screen
 * camera pad, factored out so small toggleable-controls panels (camera
 * controls, map overlays) don't each reimplement pointer-drag math,
 * localStorage geometry persistence, and viewport clamping.
 *
 * `cameraControls.js`'s `buildControlBox` now builds on this helper too
 * (via `idPrefix: 'camctl'`), so all of the app's mini control boxes share
 * one implementation.
 *
 * @module miniBox
 */

const EDGE_INSET = 6;

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
 * @param {(header:HTMLElement)=>void} [opts.onHeaderBuilt] - Append extra header controls (e.g. a screenshot button) after the title/collapse toggle.
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

  const collapseBtn = document.createElement('button');
  collapseBtn.type = 'button';
  collapseBtn.className = cls('collapse-btn');
  collapseBtn.title = 'Collapse/expand';
  collapseBtn.setAttribute('aria-label', 'Collapse or expand panel');
  collapseBtn.textContent = '−';
  header.appendChild(collapseBtn);

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

  const resizeHandle = document.createElement('div');
  resizeHandle.className = cls('resize-handle');
  resizeHandle.title = 'Drag to resize';
  resizeHandle.setAttribute('role', 'separator');
  resizeHandle.setAttribute('aria-label', `Resize ${title} panel`);
  root.appendChild(resizeHandle);

  document.body.appendChild(root);

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

  let resizeStartX = 0;
  let resizeStartY = 0;
  let resizeStartW = 0;
  let resizeStartH = 0;
  const onResizeMove = (event) => {
    const width = Math.max(minWidth, Math.min(maxWidth, resizeStartW + (event.clientX - resizeStartX)));
    const height = Math.max(minHeight, Math.min(maxHeight, resizeStartH + (event.clientY - resizeStartY)));
    root.style.width = `${width}px`;
    root.style.height = `${height}px`;
  };
  const onResizeUp = () => {
    window.removeEventListener('pointermove', onResizeMove);
    window.removeEventListener('pointerup', onResizeUp);
    window.removeEventListener('pointercancel', onResizeUp);
    resizeHandle.classList.remove('is-active');
    saveSize();
    const rect = currentRect();
    const { left, top } = clampToViewport(rect.left, rect.top, rect.width, rect.height);
    root.style.left = `${left}px`;
    root.style.top = `${top}px`;
    root.style.right = 'auto';
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
      window.removeEventListener('pointermove', onResizeMove);
      window.removeEventListener('pointerup', onResizeUp);
      window.removeEventListener('pointercancel', onResizeUp);
      root.remove();
    },
  };
}
