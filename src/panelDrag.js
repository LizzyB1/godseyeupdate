/**
 * @file Makes select HUD panels independently movable ("undockable").
 *
 * ui.js already runs a fairly elaborate adaptive layout engine for the left
 * accordion and right rail — obstacle avoidance, corridor sizing,
 * collapse-driven height allocation (see `_syncLeftPanelAdaptiveLayout` /
 * `_layoutRightPanels`). Rather than editing that engine, an undocked panel
 * is simply reparented out of its managed stack container
 * (`document.body.appendChild`) and a synthetic `resize` event is fired —
 * the very signal ui.js already listens for to recompute both rails — so
 * the remaining panels close the gap exactly as if the removed panel had
 * never been there. Re-docking reverses the reparent and fires the same
 * event.
 *
 * In their managed stacks, these panels are CSS-overridden to
 * `position: relative` flex children (`#left-panel-stack > #data-panel`
 * etc. beats the standalone `#data-panel { position: fixed }` fallback
 * rule); once reparented to `<body>` that override no longer applies, so
 * this module sets `position: fixed` explicitly whenever a panel is
 * undocked. The per-panel scroll-container rules are also scoped to the
 * managed stack (`#left-panel-stack > #data-panel:not(.collapsed)
 * .data-panel-inner { height:100%; overflow:hidden }` and siblings), so
 * style.css carries an equivalent `.gev-panel-undocked` rule for the
 * floating state — see the "Movable HUD panels" section there.
 *
 * Note: `homeParent`/`homeNext` are captured from the LIVE DOM at register()
 * time, not assumed from index.html's markup order — ui.js's
 * `_initRightPanelAdaptiveLayout()` already reparents `#pp-toggles` and
 * `#cctv-panel` from `#left-panel-stack` into `#right-context-rail` once,
 * during its own startup, before this module ever runs. Docking a panel
 * always returns it to wherever it actually lived, not to its markup home.
 *
 * `#global-context-panel` also lives in `#right-context-rail` and leans on
 * descendant-scoped CSS the same way `#pp-toggles`/`#cctv-panel` do — its
 * width already comes from its own `--panel-expanded-width` rule (not a
 * rail-scoped one, so undocking doesn't need a pp-toggles-style width
 * fallback), and style.css carries an equivalent `.gev-panel-undocked`
 * scroll/collapsed-height rule for `.global-context-panel-inner` — see the
 * "Movable HUD panels" section there.
 *
 * Deliberately NOT wired up: the command-dock hover trays `#control-panel`
 * / `#location-bar` (native `<button>` headers with their own hover/pin
 * choreography — full drag would fight that interaction model). Both still
 * get full-hide (panelVisibility.js) and their existing collapse-to-strip.
 *
 * The whole header row is the drag handle (pointerdown anywhere on it that
 * isn't a button/input/select/link starts the drag) — the same
 * grab-anywhere-on-the-bar behaviour `miniBox.js`'s boxes (Camera, Compass,
 * Map Overlays, ...) already had. This module used to only start a drag
 * from a small `⠿` grip glyph planted at the header's left edge, which
 * meant grabbing the rest of the bar did nothing — the grip is gone now
 * that the header itself owns pointerdown.
 *
 * @module panelDrag
 */

/** Buttons, form controls and links inside a header must keep their own
 * click behaviour — a pointerdown on one of these must not also start a
 * panel drag. */
const INTERACTIVE_SELECTOR = 'button, input, select, textarea, a';

import { attachResizeHandles } from './panelResize.js';

const STORAGE_PREFIX = 'godsEyeView.panelDragV1.';
// Shared with miniBox.js's own EDGE_INSET — was 6px here vs 1px there, so an
// undocked static panel (this file) sat noticeably further from the screen
// edge than a mini box (Telemetry, Compass, ...) did, and only THIS system's
// resize handles skipped viewport clamping entirely (see _installResizeHandle
// below), which is what let a panel get dragged/resized clean off-screen.
// Per a direct user ask ("all windows can only get to the edge of the
// screen... some windows still have a buffer pixels at edge and some can go
// clean through the edge") both bugs are fixed together: one inset, and
// live-frame clamping during resize (attachResizeHandles's `edgeInset`).
const EDGE_INSET = 1;
/** Undocked panels float in [Z_BASE, Z_MAX] — above the base HUD panel band
 * (100-110) but below the voice pill (150), toasts (200), and the clean-view
 * exit control (300). */
const Z_BASE = 120;
const Z_MAX = 149;
/** Floor for the vertical handles, which only apply to an undocked panel. */
const MIN_UNDOCKED_HEIGHT = 90;

function clampToViewport(left, top, rect) {
  const maxLeft = Math.max(EDGE_INSET, window.innerWidth - rect.width - EDGE_INSET);
  const maxTop = Math.max(EDGE_INSET, window.innerHeight - rect.height - EDGE_INSET);
  return {
    left: Math.max(EDGE_INSET, Math.min(maxLeft, left)),
    top: Math.max(EDGE_INSET, Math.min(maxTop, top)),
  };
}

function fireResize() {
  // The exact signal ui.js's window resize listener already reacts to
  // (_scheduleLeftPanelLayout / _scheduleRightPanelLayout / _syncCctvPanelViewport)
  // — reused here instead of reaching into its private methods.
  window.dispatchEvent(new Event('resize'));
}

class DraggablePanel {
  /**
   * @param {string} id
   * @param {HTMLElement} panelEl
   * @param {HTMLElement} headerEl
   * @param {PanelDragManager} manager
   * @param {{varName:string,min:number,max:number}|null} resize - Width-resize config: the
   *   panel's own CSS custom property that controls its expanded width (e.g.
   *   `--panel-expanded-width`), and the px bounds to clamp it to. Height
   *   follows the vertical handles only once the panel is undocked — while
   *   docked it's owned every layout pass by ui.js's adaptive corridor engine
   *   (`--left-panel-allocated-height`), which would silently overwrite a
   *   manual height a frame later.
   */
  constructor(id, panelEl, headerEl, manager, resize = null) {
    this.id = id;
    this.el = panelEl;
    this.header = headerEl;
    this.manager = manager;
    this.resize = resize;
    this.undocked = false;
    this.homeParent = panelEl.parentElement;
    this.homeNext = panelEl.nextElementSibling;

    this._onPointerDown = this._onPointerDown.bind(this);
    this._onMove = this._onMove.bind(this);
    this._onUp = this._onUp.bind(this);

    // The whole header is the drag handle now — a pointerdown on any of its
    // own buttons/inputs/selects/links (collapse, close, and whatever else
    // a given header carries, e.g. global-context-panel's radio toggle)
    // must keep doing its own thing instead of starting a drag.
    this.header.addEventListener('pointerdown', this._onPointerDown);
    this.header.addEventListener('dblclick', (event) => {
      if (event.target.closest(INTERACTIVE_SELECTOR)) return;
      event.preventDefault();
      this.dock();
    });

    if (this.resize) this._installResizeHandle();
    this._restore();
    this._restoreWidth();
  }

  _widthStorageKey() {
    return `${STORAGE_PREFIX}${this.id}.width`;
  }

  _installResizeHandle() {
    attachResizeHandles(this.el, {
      legacyClassName: 'gev-panel-resize-handle',
      legacyDir: 'e',
      label: `${this.id} panel`,
      getRect: () => {
        const rect = this.el.getBoundingClientRect();
        return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
      },
      getLimits: () => ({
        minWidth: this.resize.min,
        maxWidth: this.resize.max,
        minHeight: MIN_UNDOCKED_HEIGHT,
        maxHeight: window.innerHeight,
      }),
      // Was missing entirely on this system (unlike miniBox.js's mini
      // boxes) — an undocked panel resized from its n/w handles could be
      // dragged clean off-screen with nothing ever pulling it back.
      edgeInset: EDGE_INSET,
      onResize: ({ left, top, width, height }, dir) => {
        if (dir.includes('e') || dir.includes('w')) {
          this.el.style.setProperty(this.resize.varName, `${Math.round(width)}px`);
        }
        // A docked panel's height and position belong to ui.js's layout
        // engine; only its width is ours to set.
        if (!this.undocked) return;
        if (dir.includes('n') || dir.includes('s')) this.el.style.height = `${Math.round(height)}px`;
        if (dir.includes('w')) this.el.style.left = `${Math.round(left)}px`;
        if (dir.includes('n')) this.el.style.top = `${Math.round(top)}px`;
      },
      onEnd: () => {
        const width = parseFloat(getComputedStyle(this.el).getPropertyValue(this.resize.varName));
        if (Number.isFinite(width)) {
          try { localStorage.setItem(this._widthStorageKey(), String(Math.round(width))); } catch { /* storage unavailable */ }
        }
        if (!this.undocked) return;
        // Safety net to match miniBox.js's onEnd clamp — belt-and-braces
        // alongside the live edgeInset clamp above, in case the viewport
        // itself shrank mid-drag.
        const rect = this.el.getBoundingClientRect();
        const { left, top } = clampToViewport(rect.left, rect.top, rect);
        this.el.style.left = `${left}px`;
        this.el.style.top = `${top}px`;
        this._save();
      },
    });
  }

  _restoreWidth() {
    if (!this.resize) return;
    let raw;
    try { raw = localStorage.getItem(this._widthStorageKey()); } catch { raw = null; }
    const width = Number(raw);
    if (!Number.isFinite(width) || width <= 0) return;
    const clamped = Math.max(this.resize.min, Math.min(this.resize.max, width));
    this.el.style.setProperty(this.resize.varName, `${Math.round(clamped)}px`);
  }

  _storageKey() {
    return `${STORAGE_PREFIX}${this.id}`;
  }

  _undock() {
    if (this.undocked) return;
    this.undocked = true;
    this.el.classList.add('gev-panel-undocked');
    document.body.appendChild(this.el);
    fireResize();
  }

  /**
   * Resets this panel to its defaults: re-docks it to its original stack
   * slot if it was dragged free, and drops any saved width regardless of
   * dock state (width can be resized while still docked).
   */
  dock() {
    if (this.resize) {
      this.el.style.removeProperty(this.resize.varName);
      try { localStorage.removeItem(this._widthStorageKey()); } catch { /* storage unavailable */ }
    }
    if (!this.undocked) return;
    this.undocked = false;
    this.el.classList.remove('gev-panel-undocked');
    this.el.style.removeProperty('height');
    this.el.style.removeProperty('position');
    this.el.style.removeProperty('left');
    this.el.style.removeProperty('top');
    this.el.style.removeProperty('right');
    this.el.style.removeProperty('bottom');
    this.el.style.removeProperty('z-index');
    if (this.homeNext && this.homeNext.isConnected && this.homeNext.parentElement === this.homeParent) {
      this.homeParent.insertBefore(this.el, this.homeNext);
    } else {
      this.homeParent.appendChild(this.el);
    }
    try { localStorage.removeItem(this._storageKey()); } catch { /* storage unavailable */ }
    fireResize();
  }

  _onPointerDown(event) {
    if (event.button !== 0) return;
    // Let the header's own controls (collapse, close, the Context panel's
    // radio toggle, ...) handle their own click — only the bare bar starts
    // a drag.
    if (event.target.closest(INTERACTIVE_SELECTOR)) return;
    event.preventDefault();
    const rect = this.el.getBoundingClientRect();
    this._offsetX = event.clientX - rect.left;
    this._offsetY = event.clientY - rect.top;

    this._undock();
    this.el.style.position = 'fixed';
    this.el.style.left = `${rect.left}px`;
    this.el.style.top = `${rect.top}px`;
    this.el.style.right = 'auto';
    this.el.style.bottom = 'auto';
    this.el.classList.add('gev-panel-dragging');
    this.header.classList.add('is-dragging');
    this.manager._bringToFront(this);

    window.addEventListener('pointermove', this._onMove);
    window.addEventListener('pointerup', this._onUp);
    window.addEventListener('pointercancel', this._onUp);
  }

  _onMove(event) {
    const rect = this.el.getBoundingClientRect();
    const { left, top } = clampToViewport(
      event.clientX - this._offsetX,
      event.clientY - this._offsetY,
      rect,
    );
    this.el.style.left = `${left}px`;
    this.el.style.top = `${top}px`;
  }

  _onUp() {
    window.removeEventListener('pointermove', this._onMove);
    window.removeEventListener('pointerup', this._onUp);
    window.removeEventListener('pointercancel', this._onUp);
    this.el.classList.remove('gev-panel-dragging');
    this.header.classList.remove('is-dragging');
    this._save();
  }

  _save() {
    const rect = this.el.getBoundingClientRect();
    try {
      localStorage.setItem(this._storageKey(), JSON.stringify({
        left: Math.round(rect.left),
        top: Math.round(rect.top),
      }));
    } catch { /* storage unavailable */ }
  }

  _restore() {
    let raw;
    try { raw = localStorage.getItem(this._storageKey()); } catch { raw = null; }
    if (!raw) return;
    let pos;
    try { pos = JSON.parse(raw); } catch { return; }
    if (!pos || !Number.isFinite(pos.left) || !Number.isFinite(pos.top)) return;

    this._undock();
    this.el.style.position = 'fixed';
    const rect = this.el.getBoundingClientRect();
    const { left, top } = clampToViewport(pos.left, pos.top, rect);
    this.el.style.left = `${left}px`;
    this.el.style.top = `${top}px`;
    this.el.style.right = 'auto';
    this.el.style.bottom = 'auto';
  }
}

/** Owns z-order across every draggable panel and exposes bulk reset. */
class PanelDragManager {
  constructor() {
    this._panels = [];
    this._zCounter = Z_BASE;
  }

  /**
   * @param {string} id - Stable id (used as the localStorage key and DOM lookup fallback).
   * @param {string} panelSelector - CSS selector for the panel element.
   * @param {string} headerSelector - CSS selector (relative to document) for the header that acts as the drag handle.
   * @param {{varName:string,min:number,max:number}|null} [resize] - Optional width-resize config (see DraggablePanel).
   */
  register(id, panelSelector, headerSelector, resize = null) {
    const panelEl = document.querySelector(panelSelector);
    const headerEl = document.querySelector(headerSelector);
    if (!panelEl || !headerEl) return null;

    headerEl.title = 'Drag to move · double-click to reset position';
    headerEl.setAttribute('aria-label', `${headerEl.getAttribute('aria-label') || ''} — drag to move, double-click to reset position`.trim());

    const panel = new DraggablePanel(id, panelEl, headerEl, this, resize);
    this._panels.push(panel);
    return panel;
  }

  _bringToFront(panel) {
    this._zCounter += 1;
    if (this._zCounter > Z_MAX) {
      const ordered = this._panels
        .filter((p) => p.el.style.zIndex)
        .sort((a, b) => Number(a.el.style.zIndex) - Number(b.el.style.zIndex));
      let z = Z_BASE + 1;
      for (const p of ordered) {
        p.el.style.zIndex = String(z);
        z += 1;
      }
      this._zCounter = z;
    }
    panel.el.style.zIndex = String(this._zCounter);
  }

  /** Re-docks every undocked panel to its default managed position. */
  resetAll() {
    for (const panel of this._panels) panel.dock();
  }

  /** True if any panel has been dragged out of its default position. */
  hasCustomLayout() {
    return this._panels.some((p) => p.undocked);
  }
}

/**
 * Wires up dragging for the standard HUD panel set. Safe to call once,
 * after the panels it references exist in the DOM.
 * @returns {PanelDragManager}
 */
export function initPanelDragging() {
  const manager = new PanelDragManager();
  const specs = [
    {
      id: 'pp-toggles', panel: '#pp-toggles', header: '#pp-toggles > .pp-header-row',
      resize: { varName: '--pp-expanded-width', min: 180, max: 480 },
    },
    {
      id: 'data-panel', panel: '#data-panel', header: '#data-panel .panel-header',
      resize: { varName: '--panel-expanded-width', min: 220, max: 640 },
    },
    {
      id: 'cctv-panel', panel: '#cctv-panel', header: '#cctv-panel .panel-header',
      resize: { varName: '--panel-expanded-width', min: 240, max: 720 },
    },
    {
      id: 'scene-panel', panel: '#scene-panel', header: '#scene-panel .panel-header',
      resize: { varName: '--panel-expanded-width', min: 240, max: 640 },
    },
    {
      id: 'global-context-panel', panel: '#global-context-panel', header: '#global-context-panel .panel-header',
      resize: { varName: '--panel-expanded-width', min: 260, max: 520 },
    },
    {
      id: 'control-panel', panel: '#control-panel', header: '#control-panel .panel-header',
      resize: { varName: '--panel-expanded-width', min: 280, max: 720 },
    },
    {
      id: 'location-bar', panel: '#location-bar', header: '#location-bar .panel-header',
      resize: { varName: '--panel-expanded-width', min: 280, max: 760 },
    },
  ];
  for (const spec of specs) manager.register(spec.id, spec.panel, spec.header, spec.resize);

  // A window resize can leave a manually-placed panel off-screen (e.g. the
  // browser shrinks after a position was saved at a larger size) — reclamp
  // any currently-undocked panel's saved spot back on-screen.
  window.addEventListener('resize', () => {
    for (const panel of manager._panels) {
      if (!panel.undocked) continue;
      const rect = panel.el.getBoundingClientRect();
      const { left, top } = clampToViewport(rect.left, rect.top, rect);
      panel.el.style.left = `${left}px`;
      panel.el.style.top = `${top}px`;
    }
  });

  return manager;
}
