import { buildMiniBox } from './miniBox.js';

/**
 * @file Standalone "Coordinates" mini control box: the cursor/pin tool for
 * reading out a location's lat/long, height, address, and Google Maps link,
 * plus a copy-to-clipboard button — driven by `src/data/mapOverlays.js`'s
 * `MapOverlaysEngine`, same as `contoursBox.js`/`gridBox.js`.
 *
 * Split out of the old "MAP OVERLAYS" box so it can be moved, resized,
 * collapsed, and reset independently of the rest of Map Overlays (contours /
 * exaggeration / grid) — both boxes share one engine instance.
 *
 * Reuses the `.mapovl-*` content classes (section/btn/output/output-row)
 * verbatim: those aren't scoped to a particular box's `idPrefix`, only the
 * chrome classes are (`.coordbox-*` here, see style.css), so sharing them
 * keeps the two boxes visually consistent without duplicating CSS. Every
 * action button (place/clear pin, copy, open in Google Maps, reset) lives
 * together in one `.coordbox-toolbar` row above the readout, in smaller
 * text than elsewhere in the app since five buttons share the space.
 *
 * Same movable/resizable/persisted-position/collapsible box mechanics as
 * `cameraControls.js` and `contoursBox.js`, all built on the shared
 * `miniBox.js` helper.
 *
 * @module coordinatesBox
 */

function el(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html != null) node.innerHTML = html;
  return node;
}

export class CoordinatesBox {
  constructor(engine) {
    this.engine = engine;
    this._build();
    this.engine.onCursorChange = () => this._refresh();
    this._refresh();
  }

  _build() {
    const box = buildMiniBox({
      idPrefix: 'coordbox',
      storagePrefix: 'godsEyeView.coordinatesBox.',
      title: 'COORDINATES',
      ariaLabel: 'Coordinate cursor tool: drop a pin and read its position',
      defaultWidth: 260,
      defaultHeight: 260,
      minWidth: 200,
      maxWidth: 420,
      minHeight: 180,
      maxHeight: 520,
      anchor: { right: '16px', bottom: '16px' },
    });
    this._box = box;
    const body = box.body;

    const coordSection = el('div', 'mapovl-section');

    // Every action lives together in one compact row at the top — place/
    // clear the pin, copy the reading, jump to Google Maps, reset the tool
    // — in smaller text than the app's other button rows since five share
    // the space; the output readout (lat/long, height, address) sits below
    // it, always in the same place regardless of which buttons are enabled.
    const toolbar = el('div', 'coordbox-toolbar');

    const cursorToggle = document.createElement('button');
    cursorToggle.type = 'button';
    cursorToggle.className = 'mapovl-btn';
    cursorToggle.textContent = '📍 Place cursor';
    cursorToggle.title = 'Click the map to drop/move a coordinate cursor';
    toolbar.appendChild(cursorToggle);
    this._cursorToggle = cursorToggle;

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'mapovl-btn';
    clearBtn.textContent = 'Clear pin';
    toolbar.appendChild(clearBtn);

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'mapovl-btn';
    copyBtn.textContent = 'Copy coordinates';
    toolbar.appendChild(copyBtn);
    this._copyBtn = copyBtn;

    // A real button (not the old inline text link buried in the output
    // rows), disabled-looking until a position exists to link to.
    const mapsBtn = document.createElement('a');
    mapsBtn.className = 'mapovl-btn coordbox-maps-btn';
    mapsBtn.textContent = 'Open in Google Maps ↗';
    mapsBtn.target = '_blank';
    mapsBtn.rel = 'noopener noreferrer';
    mapsBtn.setAttribute('aria-disabled', 'true');
    toolbar.appendChild(mapsBtn);
    this._mapsBtn = mapsBtn;

    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'mapovl-btn';
    resetBtn.textContent = 'Reset coordinate tool';
    toolbar.appendChild(resetBtn);

    coordSection.appendChild(toolbar);

    const output = el('div', 'mapovl-output');
    const outLat = el('div', 'mapovl-output-row');
    const outHeight = el('div', 'mapovl-output-row');
    const outAddr = el('div', 'mapovl-output-row');
    output.appendChild(outLat);
    output.appendChild(outHeight);
    output.appendChild(outAddr);
    coordSection.appendChild(output);
    this._outLat = outLat;
    this._outHeight = outHeight;
    this._outAddr = outAddr;

    const copyStatus = el('div', 'mapovl-status', '');
    coordSection.appendChild(copyStatus);
    this._copyStatus = copyStatus;

    body.appendChild(coordSection);

    cursorToggle.addEventListener('click', () => {
      this.engine.setCursorActive(!this.engine.isCursorActive());
    });
    clearBtn.addEventListener('click', () => this.engine.clearCursor());
    copyBtn.addEventListener('click', () => this._copyCoordinates());
    mapsBtn.addEventListener('click', (event) => {
      if (mapsBtn.getAttribute('aria-disabled') === 'true') event.preventDefault();
    });
    resetBtn.addEventListener('click', () => {
      this.engine.clearCursor();
      this.engine.setCursorActive(false);
      this._copyStatus.textContent = '';
    });
  }

  /** Point the Google Maps button at a live link, or grey it out when there's no position yet. */
  _setMapsLink(href) {
    if (href) {
      this._mapsBtn.href = href;
      this._mapsBtn.removeAttribute('aria-disabled');
    } else {
      this._mapsBtn.removeAttribute('href');
      this._mapsBtn.setAttribute('aria-disabled', 'true');
    }
  }

  _refresh() {
    const active = this.engine.isCursorActive();
    this._cursorToggle.classList.toggle('is-active', active);
    this._cursorToggle.textContent = active ? '📍 Cursor active — click map' : '📍 Place cursor';

    const out = this.engine.getCursorOutput() || this.engine.getCameraOutput();
    if (!out) {
      this._outLat.textContent = 'No position yet.';
      this._outHeight.textContent = '';
      this._outAddr.textContent = '';
      this._setMapsLink(null);
      return;
    }
    this._outLat.textContent = `${out.dms}  (${out.decimal})`;
    this._outHeight.textContent = out.height ? `Height: ${out.height}` : '';
    this._outAddr.textContent = out.address ? `Address: ${out.address}` : '';
    this._setMapsLink(out.mapsLink || null);
  }

  async _copyCoordinates() {
    const out = this.engine.getCursorOutput() || this.engine.getCameraOutput();
    if (!out) return;
    const lines = [out.dms, out.decimal];
    if (out.height) lines.push(out.height);
    if (out.address) lines.push(out.address);
    if (out.mapsLink) lines.push(out.mapsLink);
    const text = lines.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      const original = this._copyBtn.textContent;
      this._copyBtn.textContent = 'Copied!';
      setTimeout(() => { this._copyBtn.textContent = original; }, 1200);
    } catch {
      this._copyStatus.textContent = 'Clipboard unavailable — select and copy manually.';
    }
  }

  destroy() {
    this._box.destroy();
  }
}

/**
 * @param {import('./data/mapOverlays.js').MapOverlaysEngine} engine
 * @returns {CoordinatesBox}
 */
export function initCoordinatesBox(engine) {
  return new CoordinatesBox(engine);
}
