// src/data/airportLookup.js
/**
 * Airport/country reference resolved from the public-domain OurAirports
 * dataset (https://ourairports.com/data/), built into
 * local_data/airports.json by scripts/build-airports.mjs.
 *
 * The route API behind the flight readout only returns an airport CODE plus a
 * municipality; this turns that code into the airport's full name and the
 * country it sits in, for both ends of the route.
 *
 * The directory is ~600 KB, so it is a dynamic import: nothing downloads it
 * until a route with codes actually needs resolving, and a failed load is not
 * memoized (the next lookup retries).
 */

let _directory = null;
let _loading = null;

/**
 * Normalize the built JSON into the shape the lookups read.
 * @param {object} raw Parsed airports.json.
 * @returns {{countries: object, records: Array, byCode: object}} Directory.
 */
export function indexAirportDirectory(raw) {
  return {
    countries: raw?.countries || {},
    records: Array.isArray(raw?.records) ? raw.records : [],
    byCode: raw?.byCode || {},
  };
}

/**
 * Look up a code in a given directory.
 * @param {object|null} directory Indexed directory.
 * @param {string} code Airport code (ICAO ident, ICAO, GPS or IATA).
 * @returns {{name: string, city: string, countryCode: string, country: string}|null}
 */
export function lookupAirportIn(directory, code) {
  const key = String(code || '').trim().toUpperCase();
  if (!key || !directory) return null;
  const index = directory.byCode[key];
  if (!Number.isInteger(index)) return null;
  const record = directory.records[index];
  if (!record) return null;
  const [name, city, countryCode] = record;
  return {
    name: name || '',
    city: city || '',
    countryCode: countryCode || '',
    country: directory.countries[countryCode] || '',
  };
}

/** Trailing words that say "this is an airport" and nothing else. Military
 *  bases keep their suffix — "Kadena" alone loses what the place is. */
const GENERIC_AIRPORT_SUFFIX = /\s+(?:International|Regional|Municipal|Domestic|National)?\s*(?:Airport|Aerodrome|Airfield|Airstrip|Airpark|Heliport)$/i;

/**
 * The airport's basic name — what a person calls it, without the
 * "International Airport" tail: "Austin Bergstrom International Airport"
 * → "Austin Bergstrom". Names that are nothing but the suffix are kept whole.
 * @param {string} name Full directory name.
 * @returns {string} Short name.
 */
export function shortAirportName(name) {
  const full = String(name || '').trim();
  const short = full.replace(GENERIC_AIRPORT_SUFFIX, '').trim();
  return short || full;
}

/** Compact route-endpoint tag for labels: code, basic airport name and ISO
 *  country as each resolves, e.g. "AUS · Austin Bergstrom (US)". */
export function routeEndpointTag(airport) {
  const code = String(airport?.code || '').trim();
  const name = shortAirportName(airport?.name);
  const country = String(airport?.countryCode || '').trim();
  const named = [code, name].filter(Boolean).join(' · ');
  return country ? `${named} (${country})` : named;
}

/** Spelled-out endpoint, e.g. "AUS · Austin-Bergstrom International Airport, United States". */
export function routeEndpointText(airport) {
  const code = String(airport?.code || '').trim();
  const place = [String(airport?.name || '').trim(), String(airport?.country || '').trim()]
    .filter(Boolean)
    .join(', ');
  return [code, place].filter(Boolean).join(' · ');
}

/**
 * Load (once) the airport directory.
 * @returns {Promise<object|null>} The directory, or null when it cannot load.
 */
export async function loadAirportDirectory() {
  if (_directory) return _directory;
  if (!_loading) {
    _loading = import('./local_data/airports.json')
      .then((mod) => {
        _directory = indexAirportDirectory(mod.default ?? mod);
        return _directory;
      })
      .catch((err) => {
        console.warn('[airports] directory unavailable:', err?.message || err);
        return null;
      })
      .finally(() => { _loading = null; });
  }
  return _loading;
}

/**
 * Look up an airport by any code it publishes (ICAO ident, ICAO, GPS or IATA).
 * @param {string} code Airport code.
 * @returns {{name: string, city: string, countryCode: string, country: string}|null}
 *   Null when the directory has not loaded yet or the code is unknown.
 */
export function lookupAirportSync(code) {
  return lookupAirportIn(_directory, code);
}

/**
 * Add the directory's airport name and country to a route endpoint, keeping
 * every field the caller already had (code, municipality name, lat/lon).
 * Unknown codes pass through untouched — a route is still worth showing.
 * @param {object|null} airport Route endpoint from the enrichment API.
 * @returns {Promise<object|null>} The endpoint, enriched where possible.
 */
export async function describeAirport(airport) {
  if (!airport?.code) return airport || null;
  await loadAirportDirectory();
  const found = lookupAirportSync(airport.code);
  if (!found) return airport;
  return {
    ...airport,
    // `name` from the route API is the municipality; the directory's is the
    // airport itself, which is what the FROM/TO plates want to read.
    name: found.name || airport.name || '',
    city: found.city || airport.name || '',
    country: found.country,
    countryCode: found.countryCode,
  };
}

/**
 * Enrich both ends of a route.
 * @param {{origin: object, destination: object}} route Route from the API.
 * @returns {Promise<object>} Route with described endpoints.
 */
export async function describeRoute(route) {
  if (!route?.origin || !route?.destination) return route;
  const [origin, destination] = await Promise.all([
    describeAirport(route.origin),
    describeAirport(route.destination),
  ]);
  return { ...route, origin, destination };
}
