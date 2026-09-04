import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  indexAirportDirectory,
  lookupAirportIn,
  routeEndpointTag,
  routeEndpointText,
  shortAirportName,
} from './airportLookup.js';

const directory = indexAirportDirectory(JSON.parse(
  readFileSync(new URL('./local_data/airports.json', import.meta.url), 'utf8'),
));

test('the built directory resolves a route code to its airport and country', () => {
  const austin = lookupAirportIn(directory, 'AUS');
  assert.match(austin.name, /Austin/);
  assert.equal(austin.city, 'Austin');
  assert.equal(austin.countryCode, 'US');
  assert.equal(austin.country, 'United States');
});

test('ICAO, IATA and lower-case codes reach the same airport', () => {
  const iata = lookupAirportIn(directory, 'LHR');
  const icao = lookupAirportIn(directory, 'EGLL');
  assert.deepEqual(icao, iata);
  assert.deepEqual(lookupAirportIn(directory, ' eGlL '), iata);
  assert.equal(iata.country, 'United Kingdom');
});

test('unknown, empty and unloaded lookups return null rather than a guess', () => {
  assert.equal(lookupAirportIn(directory, 'ZZZZ9'), null);
  assert.equal(lookupAirportIn(directory, ''), null);
  assert.equal(lookupAirportIn(null, 'AUS'), null);
});

test('every indexed code points at a real record with a known country', () => {
  const codes = Object.keys(directory.byCode);
  assert.ok(codes.length > 5000, `expected a full directory, got ${codes.length} codes`);
  for (const code of codes) {
    const found = lookupAirportIn(directory, code);
    assert.ok(found?.name, `${code} has no airport name`);
    assert.ok(found.country, `${code} (${found.countryCode}) has no country name`);
  }
});

test('the flight route readout is wired to the directory end to end', () => {
  const flights = readFileSync(new URL('./flights.js', import.meta.url), 'utf8');
  assert.match(flights, /describeRoute\(route\)/, 'route enrichment must resolve airports');
  assert.match(flights, /routeFrom: routeOk \? routeEndpointText/);
  assert.match(flights, /routeTo: routeOk \? routeEndpointText/);

  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  assert.match(html, /id="cockpit-route-from-country"/);
  assert.match(html, /id="cockpit-route-to-country"/);

  const ui = readFileSync(new URL('../ui.js', import.meta.url), 'utf8');
  assert.match(ui, /routeFromCountry.*textContent = routeCountry\(origin\)/s);
  assert.match(ui, /routeToCountry.*textContent = routeCountry\(destination\)/s);
});

test('the basic airport name drops only the generic airport tail', () => {
  assert.equal(shortAirportName('Austin Bergstrom International Airport'), 'Austin Bergstrom');
  assert.equal(shortAirportName('London Heathrow Airport'), 'London Heathrow');
  assert.equal(shortAirportName('Sitka Rocky Gutierrez Airport'), 'Sitka Rocky Gutierrez');
  // A base is not "an airport with a name" — the suffix is part of the identity.
  assert.equal(shortAirportName('Kadena Air Base'), 'Kadena Air Base');
  // Nothing left to keep, so keep it all.
  assert.equal(shortAirportName('Airport'), 'Airport');
  assert.equal(shortAirportName(''), '');
});

test('every directory airport keeps a basic name', () => {
  for (const record of directory.records) {
    assert.ok(shortAirportName(record[0]).length > 0, `${record[0]} shortened to nothing`);
  }
});

test('endpoint formatters degrade with whatever the route API gave us', () => {
  const resolved = {
    code: 'AUS', name: 'Austin-Bergstrom International Airport', countryCode: 'US', country: 'United States',
  };
  assert.equal(routeEndpointTag(resolved), 'AUS · Austin-Bergstrom (US)');
  assert.equal(routeEndpointText(resolved), 'AUS · Austin-Bergstrom International Airport, United States');
  // Directory still loading: the code alone, never a placeholder country.
  assert.equal(routeEndpointTag({ code: 'AUS' }), 'AUS');
  assert.equal(routeEndpointText({ code: 'AUS' }), 'AUS');
  assert.equal(routeEndpointTag(null), '');
  assert.equal(routeEndpointText(undefined), '');
});
