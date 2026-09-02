import { buildMiniBox } from './miniBox.js';
import {
  getHiddenPanelIds,
  PANEL_LABELS,
  showPanel,
  subscribeHiddenPanels,
} from './panelVisibility.js';

/**
 * @file "Hidden Panels" restore tray: a small persistent box listing every
 * major panel currently fully hidden (via its own "×" close button — see
 * `panelVisibility.js`), each with a one-click Restore button. This is the
 * "gui element that takes note of fully hidden/closed options with the
 * option to reshow them" — the counterpart to every panel's new full-hide
 * capability.
 *
 * Same movable/resizable/persisted-position/collapsible box mechanics as
 * the app's other mini-boxes, all built on `miniBox.js`. Unlike those,
 * this box is never itself hidable via the panel-visibility registry —
 * that would have no way back.
 *
 * @module panelRestoreTray
 */

export class PanelRestoreTray {
  constructor() {
    this._build();
    this._unsubscribe = subscribeHiddenPanels(() => this._render());
    this._render();
  }

  _build() {
    const box = buildMiniBox({
      idPrefix: 'restoretray',
      storagePrefix: 'godsEyeView.panelRestoreTray.',
      title: 'HIDDEN PANELS',
      ariaLabel: 'Hidden panels — restore any panel you closed',
      defaultWidth: 200,
      defaultHeight: 150,
      minWidth: 160,
      maxWidth: 320,
      minHeight: 90,
      maxHeight: 400,
      anchor: { left: '16px', bottom: '16px' },
    });
    this._box = box;
    this._list = document.createElement('div');
    this._list.className = 'restoretray-list';
    box.body.appendChild(this._list);
  }

  _render() {
    const ids = getHiddenPanelIds();
    this._list.innerHTML = '';
    if (!ids.length) {
      const empty = document.createElement('div');
      empty.className = 'restoretray-empty';
      empty.textContent = 'No panels hidden.';
      this._list.appendChild(empty);
      return;
    }
    for (const id of ids) {
      const row = document.createElement('div');
      row.className = 'restoretray-row';
      const label = document.createElement('span');
      label.className = 'restoretray-label';
      label.textContent = PANEL_LABELS[id] || id;
      row.appendChild(label);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'restoretray-btn';
      btn.textContent = 'Restore';
      btn.addEventListener('click', () => showPanel(id));
      row.appendChild(btn);
      this._list.appendChild(row);
    }
  }

  destroy() {
    this._unsubscribe?.();
    this._box.destroy();
  }
}

/** @returns {PanelRestoreTray} */
export function initPanelRestoreTray() {
  return new PanelRestoreTray();
}
