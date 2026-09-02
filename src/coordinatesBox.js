import { buildMiniBox } from './miniBox.js';

/**
 * @file Standalone "Coordinates" mini control box: the cursor/pin tool for
 * reading out a location's lat/long, height, address, and Google Maps link,
 * plus a copy-to-clipboard button — driven by `src/data/mapOverlays.js`'s
 * `MapOverlaysEngine`, same as `mapOverlayControls.js`.
 *
 * Split out of `mapOverlayControls.js` so it can be moved, resized,
 * collapsed, and reset independently of the rest of Map Overlays (contours /
 * exaggeration / grid) — both boxes share one engine instance.
 *
 * Reuses the `.mapovl-*` content classes (section/row/btn/output/output-row)
 * verbatim: those aren't scoped to a particular box's `idPrefix`, only the
 * chrome classes are (`.coordbox-*` here, see style.css), so sharing them
 * keeps the two boxes visually consistent without duplicating CSS.
 *
 * Same movable/resizable/persisted-position/collapsible box mechanics as
 * `cameraControls.js` and `mapOverlayControls.js`, all built on the shared
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

    const cursorRow = el('div', 'mapovl-row');
    const cursorToggle = document.createElement('button');
    cursorToggle.type = 'button';
    cursorToggle.className = 'mapovl-btn';
    cursorToggle.textContent = '📍 Place cursor';
    cursorToggle.title = 'Click the map to drop/move a coordinate cursor';
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'mapovl-btn';
    clearBtn.textContent = 'Clear pin';
    cursorRow.appendChild(cursorToggle);
    cursorRow.appendChild(clearBtn);
    coordSection.appendChild(cursorRow);
    this._cursorToggle = cursorToggle;

    const output = el('div', 'mapovl-output');
    const outLat = el('div', 'mapovl-output-row');
    const outHeight = el('div', 'mapovl-output-row');
    const outAddr = el('div', 'mapovl-output-row');
    const outLink = el('div', 'mapovl-output-row');
    output.appendChild(outLat);
    output.appendChild(outHeight);
    output.appendChild(outAddr);
    output.appendChild(outLink);
    coordSection.appendChild(output);
    this._outLat = outLat;
    this._outHeight = outHeight;
    this._outAddr = outAddr;
    this._outLink = outLink;

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'mapovl-btn mapovl-copy-btn';
    copyBtn.textContent = 'Copy coordinates';
    coordSection.appendChild(copyBtn);
    this._copyBtn = copyBtn;

    const copyStatus = el('div', 'mapovl-status', '');
    coordSection.appendChild(copyStatus);
    this._copyStatus = copyStatus;

    body.appendChild(coordSection);

    cursorToggle.addEventListener('click', () => {
      this.engine.setCursorActive(!this.engine.isCursorActive());
    });
    clearBtn.addEventListener('click', () => this.engine.clearCursor());
    copyBtn.addEventListener('click', () => this._copyCoordinates());

    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'mapovl-btn mapovl-reset-btn';
    resetBtn.textContent = 'Reset coordinate tool';
    resetBtn.addEventListener('click', () => {
      this.engine.clearCursor();
      this.engine.setCursorActive(false);
      this._copyStatus.textContent = '';
    });
    body.appendChild(resetBtn);
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
      this._outLink.textContent = '';
      return;
    }
    this._outLat.textContent = `${out.dms}  (${out.decimal})`;
    this._outHeight.textContent = out.height ? `Height: ${out.height}` : '';
    this._outAddr.textContent = out.address ? `Address: ${out.address}` : '';
    if (out.mapsLink) {
      this._outLink.innerHTML = '';
      const a = document.createElement('a');
      a.href = out.mapsLink;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = 'Open in Google Maps ↗';
      this._outLink.appendChild(a);
    } else {
      this._outLink.textContent = '';
    }
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
