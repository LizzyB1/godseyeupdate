import { buildMiniBox } from './miniBox.js';

/**
 * @file Standalone "Summary" mini control box: the rolling semantic SUMMARY
 * sentence plus the UTC timestamp, split out of `hudReadoutsBox.js` into
 * their own small box — see that file's header comment for the fuller
 * history (both used to live inside "HUD Readouts", above the individual
 * numeric telemetry rows).
 *
 * Like `hudReadoutsBox.js`, this is a pure data sink: `hud.js`'s
 * `_startTimers()`/`_setSummaryText()`/`_typeSummary()` write into
 * `#hud-timestamp`/`#hud-summary-label`/`#hud-summary` purely by element
 * id, with zero awareness of which box those elements physically live in —
 * so relocating them here required no changes to hud.js at all.
 *
 * Same movable/resizable/persisted-position/collapsible/hideable box
 * mechanics as the app's other mini-boxes (`miniBox.js` +
 * `panelVisibility.js`).
 *
 * @module summaryBox
 */

export class SummaryBox {
  constructor() {
    this._build();
  }

  _build() {
    const box = buildMiniBox({
      idPrefix: 'summarybox',
      storagePrefix: 'godsEyeView.summaryBox.',
      title: 'SUMMARY',
      ariaLabel: 'Summary — current time and rolling semantic HUD summary',
      defaultWidth: 260,
      defaultHeight: 150,
      minWidth: 200,
      maxWidth: 420,
      minHeight: 110,
      maxHeight: 360,
      // Sits directly below HUD Readouts (also 260px wide, anchored at
      // left:16px, defaultHeight 260px) now that HUD Readouts is shorter
      // without the summary section and timestamp row it used to carry.
      anchor: { left: '16px', top: '286px' },
    });
    this._box = box;
    const body = box.body;

    // UTC timestamp — reuses the same row look as HUD Readouts' own data
    // rows (.hudread-row) rather than inventing a near-identical class,
    // per this codebase's established pattern of sharing content classes
    // across mini-boxes (see aboutBox.js reusing .mapovl-hint/.mapovl-section).
    const timestamp = document.createElement('div');
    timestamp.id = 'hud-timestamp';
    timestamp.className = 'hudread-row';
    timestamp.textContent = '2026-01-01 00:00:00Z';
    body.appendChild(timestamp);
    this._timestamp = timestamp;

    // The rolling semantic summary line — reuses the existing
    // .hudread-summary-section/-label/-body classes verbatim (same reason
    // as above).
    const summarySection = document.createElement('div');
    summarySection.className = 'hudread-summary-section';
    const summaryLabel = document.createElement('div');
    summaryLabel.id = 'hud-summary-label';
    summaryLabel.className = 'hudread-summary-label';
    summaryLabel.textContent = 'SUMMARY';
    const summary = document.createElement('div');
    summary.id = 'hud-summary';
    summary.className = 'hudread-summary';
    summary.textContent = 'Awaiting telemetry...';
    summarySection.appendChild(summaryLabel);
    summarySection.appendChild(summary);
    body.appendChild(summarySection);
    this._summaryLabel = summaryLabel;
    this._summary = summary;
  }

  destroy() {
    this._box.destroy();
  }
}

/** @returns {SummaryBox} */
export function initSummaryBox() {
  return new SummaryBox();
}
