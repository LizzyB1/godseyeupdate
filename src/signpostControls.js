import { buildMiniBox } from './miniBox.js';
import { DETAIL_LEVELS } from './data/signpostLabels.js';

/**
 * @file "Signposts" mini control box: on/off toggle plus a single detail-
 * level stepper (major place names only, all the way down to small
 * features) for `src/data/signpostLabels.js`'s peak/place-name labels.
 *
 * @module signpostControls
 */

export class SignpostControls {
  constructor(engine) {
    this.engine = engine;
    this._build();
    this.engine.onStatusChange = (text) => { this._status.textContent = text || ''; };
  }

  _build() {
    const box = buildMiniBox({
      idPrefix: 'signpost',
      storagePrefix: 'godsEyeView.signpostBox.',
      title: 'SIGNPOSTS',
      ariaLabel: 'Peak and place-name signpost label controls',
      defaultWidth: 240,
      defaultHeight: 210,
      minWidth: 200,
      maxWidth: 400,
      minHeight: 170,
      maxHeight: 420,
      anchor: { left: '16px', top: '64px' },
    });
    this._box = box;
    const body = box.body;

    const enableRow = document.createElement('label');
    enableRow.className = 'signpost-row';
    const enableCheckbox = document.createElement('input');
    enableCheckbox.type = 'checkbox';
    enableCheckbox.checked = this.engine.state.enabled;
    enableRow.appendChild(enableCheckbox);
    enableRow.appendChild(document.createTextNode('Show peak / place signposts'));
    body.appendChild(enableRow);

    const levelSection = document.createElement('div');
    levelSection.className = 'signpost-level';

    const levelLabel = document.createElement('div');
    levelLabel.className = 'signpost-level-label';
    body.appendChild(levelSection);
    levelSection.appendChild(levelLabel);

    const stepperRow = document.createElement('div');
    stepperRow.className = 'signpost-stepper';
    const minusBtn = document.createElement('button');
    minusBtn.type = 'button';
    minusBtn.className = 'signpost-btn';
    minusBtn.textContent = '−';
    minusBtn.title = 'Fewer signposts (higher-importance features only)';
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = String(DETAIL_LEVELS.length - 1);
    slider.step = '1';
    slider.value = String(this.engine.state.detailLevel);
    slider.className = 'signpost-slider';
    const plusBtn = document.createElement('button');
    plusBtn.type = 'button';
    plusBtn.className = 'signpost-btn';
    plusBtn.textContent = '+';
    plusBtn.title = 'More signposts (down to smaller features)';
    stepperRow.appendChild(minusBtn);
    stepperRow.appendChild(slider);
    stepperRow.appendChild(plusBtn);
    levelSection.appendChild(stepperRow);

    const hint = document.createElement('div');
    hint.className = 'signpost-hint';
    hint.textContent = 'From major place names up to full detail when zoomed in.';
    body.appendChild(hint);

    const status = document.createElement('div');
    status.className = 'signpost-status';
    body.appendChild(status);
    this._status = status;

    const updateLevelLabel = () => {
      levelLabel.textContent = `Level ${this.engine.state.detailLevel}: ${this.engine.levelLabel()}`;
    };
    updateLevelLabel();

    enableCheckbox.addEventListener('change', () => this.engine.setEnabled(enableCheckbox.checked));
    slider.addEventListener('input', () => {
      this.engine.setDetailLevel(Number(slider.value));
      updateLevelLabel();
    });
    minusBtn.addEventListener('click', () => {
      const next = Math.max(0, Number(slider.value) - 1);
      slider.value = String(next);
      this.engine.setDetailLevel(next);
      updateLevelLabel();
    });
    plusBtn.addEventListener('click', () => {
      const next = Math.min(DETAIL_LEVELS.length - 1, Number(slider.value) + 1);
      slider.value = String(next);
      this.engine.setDetailLevel(next);
      updateLevelLabel();
    });

    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'signpost-btn signpost-reset-btn';
    resetBtn.textContent = 'Reset';
    resetBtn.addEventListener('click', () => {
      this.engine.reset();
      enableCheckbox.checked = this.engine.state.enabled;
      slider.value = String(this.engine.state.detailLevel);
      updateLevelLabel();
      status.textContent = '';
    });
    body.appendChild(resetBtn);
  }

  destroy() {
    this._box.destroy();
  }
}

export function initSignpostControls(engine) {
  return new SignpostControls(engine);
}
