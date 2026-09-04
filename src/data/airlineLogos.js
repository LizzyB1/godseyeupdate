// src/data/airlineLogos.js
/**
 * Airline identity for a tracked flight: the operator's name, brand colour and
 * logo, resolved from the callsign.
 *
 * ADS-B gives a callsign, not an operator — "RYR4XM" is Ryanair only if you
 * know the first three letters are an ICAO airline designator. That mapping and
 * the marks themselves are built into local_data/airlineLogos.json by
 * scripts/build-airline-logos.mjs from the MIT-licensed Soaring Symbols set;
 * the logos stay the airlines' trademarks and identify the operator, nothing
 * more.
 *
 * The pack is ~240 KB of inline SVG, so it is a dynamic import on the same
 * terms as airportLookup.js: nothing downloads until a callsign resolves, and a
 * failed load is not memoized. Once loaded it is offline for good — no network
 * per aircraft.
 */

let _pack = null;
let _loading = null;

/** Registration-style callsigns ("N914DL", "G-EUUU") carry no operator code. */
const AIRLINE_CALLSIGN = /^([A-Z]{3})(\d[A-Z0-9]*)$/;

/**
 * The ICAO airline designator inside a callsign, if it has one.
 * @param {string} callsign Raw ADS-B callsign.
 * @returns {string} Three-letter designator, or '' when the callsign is a
 *   registration, a private tail or otherwise not airline-formatted.
 */
export function airlineCodeFromCallsign(callsign) {
  const text = String(callsign || '').trim().toUpperCase().replace(/\s+/g, '');
  const match = AIRLINE_CALLSIGN.exec(text);
  return match ? match[1] : '';
}

/**
 * Normalize the built pack into the shape lookups read.
 * @param {object} raw Parsed airlineLogos.json.
 * @returns {{records: Array, byCode: object}} Pack.
 */
export function indexAirlinePack(raw) {
  return {
    records: Array.isArray(raw?.records) ? raw.records : [],
    byCode: raw?.byCode || {},
  };
}

/**
 * Look up an airline in a given pack.
 * @param {object|null} pack Indexed pack.
 * @param {string} code ICAO or IATA airline code.
 * @returns {{code: string, name: string, color: string, logo: string}|null}
 *   `logo` is an inline SVG data URI usable straight as an <img> src.
 */
export function lookupAirlineIn(pack, code) {
  const key = String(code || '').trim().toUpperCase();
  if (!key || !pack) return null;
  const index = pack.byCode[key];
  if (!Number.isInteger(index)) return null;
  const record = pack.records[index];
  if (!record) return null;
  const [name, color, svg] = record;
  return {
    code: key,
    name: name || key,
    color: color || '',
    logo: svg ? `data:image/svg+xml;utf8,${encodeURIComponent(svg)}` : '',
  };
}

/**
 * Load (once) the airline pack.
 * @returns {Promise<object|null>} The pack, or null when it cannot load.
 */
export async function loadAirlinePack() {
  if (_pack) return _pack;
  if (!_loading) {
    _loading = import('./local_data/airlineLogos.json')
      .then((mod) => {
        _pack = indexAirlinePack(mod.default ?? mod);
        return _pack;
      })
      .catch((err) => {
        console.warn('[airlines] logo pack unavailable:', err?.message || err);
        return null;
      })
      .finally(() => { _loading = null; });
  }
  return _loading;
}

/**
 * Airline for a code, from the already-loaded pack.
 * @param {string} code ICAO or IATA airline code.
 * @returns {{code: string, name: string, color: string, logo: string}|null}
 */
export function lookupAirlineSync(code) {
  return lookupAirlineIn(_pack, code);
}

/**
 * Airline operating a callsign, from the already-loaded pack.
 * @param {string} callsign Raw ADS-B callsign.
 * @returns {{code: string, name: string, color: string, logo: string}|null}
 */
export function airlineForCallsignSync(callsign) {
  return lookupAirlineSync(airlineCodeFromCallsign(callsign));
}

/**
 * Airline operating a callsign, loading the pack if this is the first one.
 * @param {string} callsign Raw ADS-B callsign.
 * @returns {Promise<{code: string, name: string, color: string, logo: string}|null>}
 */
export async function describeAirline(callsign) {
  const code = airlineCodeFromCallsign(callsign);
  if (!code) return null;
  await loadAirlinePack();
  return lookupAirlineSync(code);
}
