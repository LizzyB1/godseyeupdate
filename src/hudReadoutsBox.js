import { buildMiniBox } from './miniBox.js';

/**
 * @file Standalone "HUD Readouts" mini control box: the individual
 * intelligence-HUD data readouts — MGRS, lat/lon, GSD/NIIRS, ALT/SUN, AIS,
 * COLL, and ONA — that used to be baked uncontrolled into `#intel-hud`'s
 * corner brackets (see `hud.js`). They're pure data sinks: `hud.js`'s
 * `_updateCameraData()` and `data/aisLiveVessels.js` write into them by
 * element id exactly as before — this module just owns where those
 * elements physically live (in their own movable/resizable/collapsible
 * box, with a copy-to-clipboard button) instead of fixed inside the
 * cinematic HUD overlay. (The classification banner, mode label,
 * mission/sensor-ID line, REC blink dot, and ORB/PASS orbital line were
 * pure decoration/redundant with the "ACTIVE STYLE" indicator elsewhere on
 * screen — those were deleted outright, not relocated; see `hud.js`'s
 * `_buildDOM` comment. The rolling semantic SUMMARY sentence and the UTC
 * timestamp now live in their own standalone box — see `summaryBox.js`.
 * The old combined "bottom line" row — a literal duplicate of the MGRS and
 * lat/lon rows already above it — was removed outright rather than moved;
 * `hud.js` now marks that same coordinate directly on the map instead,
 * with a ring reticle at the camera's ground subpoint — see
 * `hud.js#_updateGroundPointer`.)
 *
 * These readouts only update while `hud.js`'s own visibility flag is on
 * (the Intel HUD toggle in the Display panel — see `IntelHUD#show`/
 * `#hide`), so this box shows whatever was last written at the moment the
 * Intel HUD itself is switched off, rather than resetting to placeholders
 * — a minor, intentional trade-off of decoupling this box's own show/hide
 * from the HUD's.
 *
 * Same movable/resizable/persisted-position/collapsible box mechanics as
 * `cameraControls.js`/`mapOverlayControls.js`/`coordinatesBox.js`, all
 * built on the shared `miniBox.js` helper.
 *
 * @module hudReadoutsBox
 */

/**
 * id, default placeholder text, and (where relevant) extra class — mirrors
 * `hud.js`'s old inline template exactly, so nothing else needs to change
 * to keep writing into these by id.
 */
const READOUTS = [
  { id: 'hud-mgrs', text: 'MGRS: ---' },
  { id: 'hud-latlon', text: '--°--\'--"N ---°--\'--"W' },
  { id: 'hud-gsd', text: 'GSD: --m  NIIRS: --' },
  { id: 'hud-alt', text: 'ALT: --m   SUN: --° EL' },
  { id: 'hud-ais-vessel', text: 'AIS: --', className: 'hud-ais-vessel' },
  { id: 'hud-coll', text: 'COLL: --:--:--Z' },
  { id: 'hud-ona', text: 'ONA: --°' },
];

export class HudReadoutsBox {
  constructor() {
    this._build();
  }

  _build() {
    const box = buildMiniBox({
      idPrefix: 'hudread',
      storagePrefix: 'godsEyeView.hudReadoutsBox.',
      title: 'HUD READOUTS',
      ariaLabel: 'Intelligence HUD data readouts: MGRS, lat/long, and sensor metrics',
      defaultWidth: 260,
      defaultHeight: 260,
      minWidth: 200,
      maxWidth: 420,
      minHeight: 150,
      maxHeight: 560,
      anchor: { left: '16px', top: '16px' },
    });
    this._box = box;
    const body = box.body;

    const section = document.createElement('div');
    section.className = 'hudread-section';
    this._rows = {};
    for (const { id, text, className } of READOUTS) {
      const row = document.createElement('div');
      row.id = id;
      row.className = className ? `hudread-row ${className}` : 'hudread-row';
      row.textContent = text;
      section.appendChild(row);
      this._rows[id] = row;
    }
    body.appendChild(section);

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'hudread-btn hudread-copy-btn';
    copyBtn.textContent = 'Copy readouts';
    copyBtn.addEventListener('click', () => this._copy(copyBtn));
    body.appendChild(copyBtn);

    const status = document.createElement('div');
    status.className = 'hudread-status';
    body.appendChild(status);
    this._status = status;
  }

  async _copy(btn) {
    const lines = READOUTS.map(({ id }) => this._rows[id]?.textContent || '');
    const text = lines.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      const original = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = original; }, 1200);
    } catch {
      this._status.textContent = 'Clipboard unavailable — select and copy manually.';
    }
  }

  destroy() {
    this._box.destroy();
  }
}

/** @returns {HudReadoutsBox} */
export function initHudReadoutsBox() {
  return new HudReadoutsBox();
}
