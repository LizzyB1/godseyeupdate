// src/data/aircraftIdentity.js
/**
 * What a tracked aircraft LOOKS like, in one presentation model: the operator's
 * logo, the type silhouette in the operator's colours, and — when Planespotters
 * has one — a photo of that exact airframe.
 *
 * Three sources with three different licences meet here, so the rules live in
 * one place instead of in the HUD:
 *   - Logos and silhouettes are bundled, so they are always available offline.
 *   - The photo is remote and must carry its photographer and a link back
 *     (see aircraftPhotos.js), so it is only ever emitted with both.
 *   - The silhouette is the floor: an unphotographed airframe on an unknown
 *     airline still gets its planform, never an empty box.
 */

import { classifyAircraft } from './aircraftClass.js';
import { aircraftIcon } from './aircraftIcons.js';
import { airlineForCallsignSync } from './airlineLogos.js';
import { cachedPhoto } from './aircraftPhotos.js';

/** Silhouette raster: the HUD draws it at ~34 CSS px, Retina doubles that. */
const SILHOUETTE_PX = 96;
/** Fallback hue when the operator is unknown or publishes no brand colour. */
const NEUTRAL_TINT = '#cfe9f5';

/**
 * Presentation model for a tracked aircraft's imagery.
 * @param {object} info Tracked-aircraft info (callsign, registration, icao24,
 *   typeCode, airline).
 * @param {{airline?: object|null, photo?: object|null}} [overrides] Resolved
 *   airline/photo, for callers holding them already (and for tests). Omitted
 *   fields fall back to whatever the bundled pack and photo cache can answer
 *   synchronously.
 * @returns {{operator: string, logo: string, color: string, silhouette: string,
 *   klass: string, photo: object|null}}
 */
export function aircraftIdentity(info, overrides = {}) {
  const airline = overrides.airline !== undefined
    ? overrides.airline
    : airlineForCallsignSync(info?.callsign);
  const photo = overrides.photo !== undefined
    ? overrides.photo
    : cachedPhoto({ icao24: info?.icao24, registration: info?.registration })?.photo ?? null;

  const klass = classifyAircraft({
    typeCode: info?.typeCode || '',
    category: info?.category,
  });
  const color = airline?.color || NEUTRAL_TINT;
  return {
    // The airline pack names the operator properly ("Ryanair"); the feed's own
    // `airline` field is whatever the enrichment had, and the callsign prefix
    // is the last resort so the plate is never blank.
    operator: airline?.name || String(info?.airline || '').trim() || '',
    logo: airline?.logo || '',
    color,
    klass,
    silhouette: aircraftIcon(klass, SILHOUETTE_PX, color),
    photo: photo && photo.thumbnail && photo.link && photo.photographer ? photo : null,
  };
}

/**
 * Signature for an identity, so the HUD can skip DOM writes when nothing about
 * the aircraft's imagery changed between frames.
 * @param {object} identity Result of aircraftIdentity().
 * @returns {string}
 */
export function identitySignature(identity) {
  return [
    identity?.operator || '',
    identity?.klass || '',
    identity?.color || '',
    identity?.photo?.link || '',
  ].join('|');
}
