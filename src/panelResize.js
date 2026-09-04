/**
 * @file Eight-way (every edge, every corner) pointer resizing, shared by
 * every panel that can be resized at all: the `miniBox.js` mini control
 * boxes and the undockable HUD panels in `panelDrag.js`, which each used
 * to carry their own single handle — a bottom-right corner grip and a
 * right-edge width bar respectively.
 *
 * The geometry is `resizeRect`, a pure function: dragging a north or west
 * handle has to move the box's top-left as the size changes, and clamping
 * has to happen before that offset is derived (otherwise a box pinned at
 * its minimum size keeps sliding while the pointer travels). Keeping that
 * out of the pointer plumbing is what makes it testable.
 *
 * @module panelResize
 */

/** Every direction, corners last so a corner handle stacks over the two edges it overlaps. */
export const RESIZE_DIRECTIONS = Object.freeze(['n', 'e', 's', 'w', 'ne', 'se', 'sw', 'nw']);

const DIRECTION_NAMES = Object.freeze({
  n: 'top edge',
  s: 'bottom edge',
  e: 'right edge',
  w: 'left edge',
  ne: 'top-right corner',
  nw: 'top-left corner',
  se: 'bottom-right corner',
  sw: 'bottom-left corner',
});

const CURSORS = Object.freeze({
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
});

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Geometry for one resize drag.
 * @param {string} dir One of RESIZE_DIRECTIONS.
 * @param {{left:number, top:number, width:number, height:number}} start Rect at pointerdown.
 * @param {number} dx Pointer x travel since pointerdown.
 * @param {number} dy Pointer y travel since pointerdown.
 * @param {{minWidth:number, maxWidth:number, minHeight:number, maxHeight:number}} limits
 * @returns {{left:number, top:number, width:number, height:number}} The resized rect.
 */
export function resizeRect(dir, start, dx, dy, limits) {
  const { minWidth, maxWidth, minHeight, maxHeight } = limits;
  let { left, top, width, height } = start;

  if (dir.includes('e')) width = clamp(start.width + dx, minWidth, maxWidth);
  if (dir.includes('w')) {
    width = clamp(start.width - dx, minWidth, maxWidth);
    // Derived from the CLAMPED width, so the far edge stays put once the
    // box can't shrink any further.
    left = start.left + (start.width - width);
  }
  if (dir.includes('s')) height = clamp(start.height + dy, minHeight, maxHeight);
  if (dir.includes('n')) {
    height = clamp(start.height - dy, minHeight, maxHeight);
    top = start.top + (start.height - height);
  }

  return { left, top, width, height };
}

/**
 * Plant resize handles around `root` and drive `onResize` with the rect the
 * current drag implies.
 *
 * @param {HTMLElement} root Panel element; handles are appended to it.
 * @param {Object} opts
 * @param {() => {left:number, top:number, width:number, height:number}} opts.getRect Current geometry.
 * @param {() => {minWidth:number, maxWidth:number, minHeight:number, maxHeight:number}} opts.getLimits
 * @param {(rect:{left:number, top:number, width:number, height:number}, dir:string) => void} opts.onResize
 * @param {(dir:string) => void} [opts.onStart] Runs once at pointerdown, before the first onResize.
 * @param {(dir:string) => void} [opts.onEnd]
 * @param {string} [opts.legacyClassName] Extra class for one handle only, so a panel's
 *   existing grip styling keeps applying to the edge or corner it was written for.
 * @param {string} [opts.legacyDir='se'] Which handle `legacyClassName` lands on.
 * @param {string} [opts.label='panel'] Panel name, for the handles' accessible labels.
 * @returns {{destroy: () => void}}
 */
export function attachResizeHandles(root, {
  getRect, getLimits, onResize, onStart, onEnd, legacyClassName, legacyDir = 'se',
  label = 'panel',
}) {
  let startRect = null;
  let startX = 0;
  let startY = 0;
  let activeDir = '';
  let activeHandle = null;

  const onMove = (event) => {
    if (!startRect) return;
    onResize(
      resizeRect(activeDir, startRect, event.clientX - startX, event.clientY - startY, getLimits()),
      activeDir,
    );
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    activeHandle?.classList.remove('is-active');
    startRect = null;
    activeHandle = null;
    onEnd?.(activeDir);
  };

  const handles = [];
  for (const dir of RESIZE_DIRECTIONS) {
    const handle = document.createElement('div');
    handle.className = `panel-resize-handle panel-resize-handle--${dir}`;
    if (dir === legacyDir && legacyClassName) handle.className += ` ${legacyClassName}`;
    handle.dataset.resizeDir = dir;
    handle.style.cursor = CURSORS[dir];
    handle.title = 'Drag to resize';
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', dir === 'e' || dir === 'w' ? 'vertical' : 'horizontal');
    handle.setAttribute('aria-label', `Resize ${label} from its ${DIRECTION_NAMES[dir]}`);
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      activeDir = dir;
      activeHandle = handle;
      onStart?.(dir);
      startRect = getRect();
      startX = event.clientX;
      startY = event.clientY;
      handle.classList.add('is-active');
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    });
    root.appendChild(handle);
    handles.push(handle);
  }

  return {
    destroy() {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      for (const handle of handles) handle.remove();
    },
  };
}
