import { buildMiniBox } from './miniBox.js';
import { hidePanel, isPanelHidden } from './panelVisibility.js';

/**
 * @file "Bathymetry" mini control box: toggles for undersea depth contour
 * lines and depth markers, driven by `src/data/bathymetry.js`'s
 * `BathymetryEngine`. Same movable/resizable/persisted-position/collapsible
 * box mechanics as the app's other mini-boxes (`miniBox.js`), and reuses
 * the shared `.mapovl-*` content classes verbatim (section/row/status) —
 * see `coordinatesBox.js` for why that's safe: those classes aren't
 * scoped to a particular box's `idPrefix`, only the chrome classes are.
 *
 * Also gets a header "×" hide button wired straight into the shared
 * `panelVisibility.js` registry (see `PANEL_LABELS['bathy-pad']` there),
 * so closing it surfaces a "Restore" entry in the Hidden Panels tray like
 * every other panel in the app.
 *
 * @module bathymetryBox
 */

function el(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html != null) node.innerHTML = html;
  return node;
}

export class BathymetryBox {
  constructor(engine) {
    this.engine = engine;
    this._build();
    this.engine.onStatusChange = (text) => this._setStatus(text);
    this._setStatus(this.engine.getStatus());
  }

  _build() {
    const box = buildMiniBox({
      idPrefix: 'bathy',
      storagePrefix: 'godsEyeView.bathymetryBox.',
      title: 'BATHYMETRY',
      ariaLabel: 'Bathymetry controls: undersea depth contours and depth markers',
      defaultWidth: 240,
      defaultHeight: 260,
      minWidth: 200,
      maxWidth: 400,
      minHeight: 180,
      maxHeight: 460,
      anchor: { right: '16px', top: '160px' },
      onHeaderBuilt: (header) => {
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'bathy-close-btn';
        closeBtn.title = 'Hide panel — restore it from the Hidden Panels tray';
        closeBtn.setAttribute('aria-label', 'Hide Bathymetry panel');
        closeBtn.textContent = '×';
        closeBtn.addEventListener('click', (event) => {
          event.stopPropagation();
          hidePanel('bathy-pad');
        });
        header.appendChild(closeBtn);
      },
    });
    this._box = box;
    // The box is built well after ui.js's one-time `applyStoredHiddenState()`
    // pass (it doesn't exist yet at that point), so a previously-hidden
    // state has to be re-applied here instead of relying on that pass.
    box.root.classList.toggle('panel-fully-hidden', isPanelHidden('bathy-pad'));
    const body = box.body;

    const section = el('div', 'mapovl-section');
    section.appendChild(el('div', 'mapovl-section-title', 'UNDERSEA DATA'));

    const contourRow = el('label', 'mapovl-row');
    const contourEnable = document.createElement('input');
    contourEnable.type = 'checkbox';
    contourEnable.checked = this.engine.state.contoursEnabled;
    contourRow.appendChild(contourEnable);
    contourRow.appendChild(document.createTextNode('Show depth contours'));
    section.appendChild(contourRow);
    contourEnable.addEventListener('change', () => this.engine.setContoursEnabled(contourEnable.checked));

    const markerRow = el('label', 'mapovl-row');
    const markerEnable = document.createElement('input');
    markerEnable.type = 'checkbox';
    markerEnable.checked = this.engine.state.markersEnabled;
    markerRow.appendChild(markerEnable);
    markerRow.appendChild(document.createTextNode('Show depth markers'));
    section.appendChild(markerRow);
    markerEnable.addEventListener('change', () => this.engine.setMarkersEnabled(markerEnable.checked));

    const flagRow = el('label', 'mapovl-row');
    const flagEnable = document.createElement('input');
    flagEnable.type = 'checkbox';
    flagEnable.checked = this.engine.state.depthFlagsEnabled;
    flagRow.appendChild(flagEnable);
    flagRow.appendChild(document.createTextNode('Show depth flags'));
    section.appendChild(flagRow);
    flagEnable.addEventListener('change', () => this.engine.setDepthFlagsEnabled(flagEnable.checked));

    section.appendChild(el(
      'div',
      'mapovl-hint',
      'Isobaths and depth readouts: GEBCO grid via opentopodata.org (public, no key, rate-limited — cached once looked up). Depth flags need "Show depth contours" on, and nudge clear of any control panel in the way.',
    ));

    body.appendChild(section);

    const status = el('div', 'mapovl-status', '');
    body.appendChild(status);
    this._status = status;
  }

  _setStatus(text) {
    this._status.textContent = text || '';
  }

  destroy() {
    this._box.destroy();
  }
}

/**
 * @param {import('./data/bathymetry.js').BathymetryEngine} engine
 * @returns {BathymetryBox}
 */
export function initBathymetryBox(engine) {
  return new BathymetryBox(engine);
}
