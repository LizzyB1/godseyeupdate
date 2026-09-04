import { buildMiniBox } from './miniBox.js';
import { getSelectedEntityContext } from './data/contextStore.js';

/**
 * @file "Target Info" mini control box: shows every available field for
 * whatever the user just clicked — a ship or an aircraft — in one place.
 * Per a direct user ask: "when you click a ship or a flight, bring a box up
 * that tells you about 'Target Info' with any other information that can be
 * gleaned from the api / data on the flight or AIS data manifest."
 *
 * Deliberately reads the SAME shared selection slot every other consumer
 * (voice, Cockpit, the Contacts panel) already reads — `data/contextStore.js`
 * — rather than adding a new selection channel: every layer that already
 * calls `selectEntityContext`/`selectTrackedSubjectContext` (AIS vessels,
 * live/military flights, FIRMS fires, local GeoJSON features, military
 * installations) shows up here automatically, with zero changes to those
 * layers beyond whatever fields they already publish into `properties`.
 *
 * Two publication lanes exist (see contextStore.js's own comments for why):
 * - `gev:entity-selected` fires WITH the full record as `event.detail` —
 *   used by AIS vessels, FIRMS, local GeoJSON, military installations.
 * - `gev:awareness-subject-selected` fires with only an id/label/position
 *   (tracking layers' own lane) — used by civilian/military flights. The
 *   full record lands in the context store on the very next line of the
 *   caller (`selectTrackedSubjectContext`, called right after the event
 *   dispatch returns), so this box reads it back via `getSelectedEntityContext()`
 *   deferred to a microtask rather than off the event itself, which would
 *   still be empty when this box's own listener runs synchronously during
 *   `dispatchEvent`.
 *
 * Same movable/resizable/persisted-position/collapsible box mechanics as
 * the app's other mini-boxes (`miniBox.js`).
 *
 * @module targetInfoBox
 */

/** Fields that get their own explicit ordering/label instead of the generic
 * camelCase-to-Title-Case fallback, and are never duplicated below the
 * fold when they also appear in `properties`. */
const FIELD_LABELS = {
  mmsi: 'MMSI',
  imo: 'IMO',
  icao24: 'ICAO24',
  callsign: 'Callsign',
  registration: 'Registration',
  operator: 'Operator',
  type: 'Type',
  altitude: 'Altitude',
  speed: 'Speed',
  speedKt: 'Speed',
  heading: 'Heading',
  course: 'Course',
  destination: 'Destination',
  route: 'Route',
  routeFrom: 'From',
  routeTo: 'To',
  status: 'Status',
  flagState: 'Flag',
};

function el(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html != null) node.innerHTML = html;
  return node;
}

/** camelCase/snake_case → "Title Case" for any property this box doesn't
 * already have an explicit label for, so a layer can add a new property
 * later and it just shows up instead of being silently dropped. */
function formatKey(key) {
  if (FIELD_LABELS[key]) return FIELD_LABELS[key];
  const spaced = String(key)
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced.replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatValue(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? String(Math.round(value * 100) / 100) : null;
  return String(value);
}

export class TargetInfoBox {
  constructor() {
    this._build();
    this._wireEvents();
    this._renderEmpty();
  }

  _build() {
    const box = buildMiniBox({
      idPrefix: 'targetinfo',
      storagePrefix: 'godsEyeView.targetInfoBox.',
      title: 'TARGET INFO',
      ariaLabel: 'Target info: full details for the currently selected ship or aircraft',
      defaultWidth: 280,
      defaultHeight: 300,
      minWidth: 220,
      maxWidth: 440,
      minHeight: 140,
      maxHeight: 560,
      anchor: { right: '16px', bottom: 'calc(2vh + 4.5rem)' },
    });
    this._box = box;
    this._body = box.body;
  }

  _wireEvents() {
    this._onEntitySelected = (event) => this._render(event.detail);
    this._onAwarenessSelected = () => {
      // Deferred: the tracking layer's context-store write
      // (selectTrackedSubjectContext) happens on the line right after it
      // dispatches this event, so reading the store synchronously here
      // (during that same dispatch) would still see the PREVIOUS selection.
      queueMicrotask(() => {
        const record = getSelectedEntityContext();
        if (record) this._render(record);
      });
    };
    this._onCleared = () => this._renderEmpty();
    window.addEventListener('gev:entity-selected', this._onEntitySelected);
    window.addEventListener('gev:awareness-subject-selected', this._onAwarenessSelected);
    window.addEventListener('gev:entity-selection-cleared', this._onCleared);
    window.addEventListener('gev:awareness-subject-cleared', this._onCleared);
  }

  _renderEmpty() {
    this._body.innerHTML = '';
    this._body.appendChild(el(
      'div',
      'mapovl-hint',
      'Click a ship or aircraft on the map to see everything known about it here.',
    ));
  }

  _render(record) {
    if (!record) { this._renderEmpty(); return; }
    this._body.innerHTML = '';

    // Vessel records already bake their flag emoji into `record.label`
    // (see aisLiveVessels.js's vesselFlagPrefix) — don't re-prepend
    // properties.flagEmoji here too, or the flag renders twice.
    const heading = el('div', 'mapovl-section');
    heading.appendChild(el(
      'div',
      'mapovl-section-title',
      escapeHtml(record.label || 'Unknown target'),
    ));
    if (record.layerName || record.source) {
      const sub = [record.layerName, record.source].filter(Boolean).join(' · ');
      heading.appendChild(el('div', 'mapovl-hint', escapeHtml(sub)));
    }
    this._body.appendChild(heading);

    const fields = el('div', 'mapovl-section');
    const seen = new Set();
    const addRow = (key, rawValue) => {
      const value = formatValue(rawValue);
      if (!value || seen.has(key)) return;
      seen.add(key);
      const row = el('div', 'mapovl-row');
      row.appendChild(el('span', 'targetinfo-field-label', `${formatKey(key)}: `));
      row.appendChild(document.createTextNode(value));
      fields.appendChild(row);
    };

    const props = record.properties || {};
    for (const key of Object.keys(FIELD_LABELS)) {
      if (key in props) addRow(key, props[key]);
    }
    for (const [key, value] of Object.entries(props)) {
      if (key === 'flagEmoji') continue; // shown inline with the title, not as a row
      addRow(key, value);
    }
    if (Number.isFinite(record.latitude) && Number.isFinite(record.longitude)) {
      addRow('position', `${record.latitude.toFixed(4)}, ${record.longitude.toFixed(4)}`);
    }
    if (record.updatedAt) {
      addRow('updated', new Date(record.updatedAt).toLocaleTimeString());
    }
    this._body.appendChild(fields);
  }

  destroy() {
    window.removeEventListener('gev:entity-selected', this._onEntitySelected);
    window.removeEventListener('gev:awareness-subject-selected', this._onAwarenessSelected);
    window.removeEventListener('gev:entity-selection-cleared', this._onCleared);
    window.removeEventListener('gev:awareness-subject-cleared', this._onCleared);
    this._box.destroy();
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = String(text ?? '');
  return div.innerHTML;
}

/** @returns {TargetInfoBox} */
export function initTargetInfoBox() {
  return new TargetInfoBox();
}
