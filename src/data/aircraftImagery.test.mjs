// src/data/aircraftImagery.test.mjs
/**
 * Aircraft imagery: airline resolution from a callsign, the Planespotters
 * photo cache (whose TTL and never-store-the-image rules are licence terms, not
 * preferences), and the identity model the HUD paints from.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  airlineCodeFromCallsign,
  indexAirlinePack,
  lookupAirlineIn,
} from './airlineLogos.js';
import {
  cachedPhoto,
  fetchAircraftPhoto,
  photoKey,
  resetAircraftPhotoCache,
  selectPhoto,
  PHOTO_CACHE_TTL_MS,
} from './aircraftPhotos.js';
import { aircraftIdentity, identitySignature } from './aircraftIdentity.js';
import { vesselIconSvg, vesselShapeId } from './vesselIcons.js';

const PACK = indexAirlinePack({
  records: [['Ryanair', '#f1c931', '<svg id="ryr"></svg>']],
  byCode: { RYR: 0, FR: 0 },
});

function photoResponse(link = 'https://planespotters.net/photo/1') {
  return {
    ok: true,
    json: async () => ({
      photos: [{
        thumbnail: { src: 'https://cdn.planespotters.net/small.jpg' },
        thumbnail_large: { src: 'https://cdn.planespotters.net/large.jpg' },
        link,
        photographer: 'A. Spotter',
      }],
    }),
  };
}

test('a callsign yields an airline code only when it is airline-formatted', () => {
  assert.equal(airlineCodeFromCallsign('RYR4XM'), 'RYR');
  assert.equal(airlineCodeFromCallsign(' ryr4xm '), 'RYR');
  // Registrations and private tails are not operators.
  assert.equal(airlineCodeFromCallsign('N914DL'), '');
  assert.equal(airlineCodeFromCallsign('G-EUUU'), '');
  assert.equal(airlineCodeFromCallsign(''), '');
  assert.equal(airlineCodeFromCallsign(null), '');
});

test('an airline resolves by ICAO or IATA into a usable inline logo', () => {
  const airline = lookupAirlineIn(PACK, 'RYR');
  assert.equal(airline.name, 'Ryanair');
  assert.equal(airline.color, '#f1c931');
  assert.match(airline.logo, /^data:image\/svg\+xml;utf8,/);
  assert.equal(lookupAirlineIn(PACK, 'fr').name, 'Ryanair');
  assert.equal(lookupAirlineIn(PACK, 'ZZZ'), null);
  assert.equal(lookupAirlineIn(null, 'RYR'), null);
});

test('a photo is only usable with a photographer and a link back', () => {
  assert.equal(selectPhoto({ photos: [] }), null);
  assert.equal(selectPhoto({
    photos: [{ thumbnail: { src: 'x' }, link: 'y' }],
  }), null, 'no photographer, no display');
  assert.equal(selectPhoto({
    photos: [{ thumbnail: { src: 'x' }, photographer: 'p' }],
  }), null, 'no link back, no display');
  const photo = selectPhoto({
    photos: [{ thumbnail: { src: 'x' }, link: 'y', photographer: 'p' }],
  });
  assert.deepEqual(photo, { thumbnail: 'x', large: 'x', link: 'y', photographer: 'p' });
});

test('an airframe is keyed by hex, falling back to registration', () => {
  assert.equal(photoKey({ icao24: '4CA1FB' }), 'hex:4ca1fb');
  assert.equal(photoKey({ registration: 'ei-dwf' }), 'reg:EI-DWF');
  assert.equal(photoKey({}), '');
});

test('a fetched photo is cached, deduped and never refetched inside the TTL', async () => {
  resetAircraftPhotoCache();
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return photoResponse(); };
  const [a, b] = await Promise.all([
    fetchAircraftPhoto({ icao24: '4CA1FB' }, { fetchImpl }),
    fetchAircraftPhoto({ icao24: '4CA1FB' }, { fetchImpl }),
  ]);
  assert.equal(calls, 1, 'concurrent lookups share one request');
  assert.equal(a.link, b.link);
  await fetchAircraftPhoto({ icao24: '4CA1FB' }, { fetchImpl });
  assert.equal(calls, 1, 'served from cache');
  assert.equal(cachedPhoto({ icao24: '4CA1FB' }).photo.photographer, 'A. Spotter');
});

test('the cache expires at the terms\u2019 24-hour ceiling', async () => {
  resetAircraftPhotoCache();
  let now = 1_000_000;
  let calls = 0;
  const deps = { now: () => now, fetchImpl: async () => { calls += 1; return photoResponse(); } };
  await fetchAircraftPhoto({ icao24: 'abc123' }, deps);
  now += PHOTO_CACHE_TTL_MS - 1;
  await fetchAircraftPhoto({ icao24: 'abc123' }, deps);
  assert.equal(calls, 1);
  now += 2;
  await fetchAircraftPhoto({ icao24: 'abc123' }, deps);
  assert.equal(calls, 2, 'expired entries are refetched, not served stale');
});

test('an airframe with no photo is remembered as having none', async () => {
  resetAircraftPhotoCache();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, json: async () => ({ photos: [] }) };
  };
  assert.equal(await fetchAircraftPhoto({ icao24: 'dead01' }, { fetchImpl }), null);
  assert.equal(await fetchAircraftPhoto({ icao24: 'dead01' }, { fetchImpl }), null);
  assert.equal(calls, 1);
  assert.deepEqual(cachedPhoto({ icao24: 'dead01' }), { photo: null });
});

test('a failed lookup is not cached, so it retries', async () => {
  resetAircraftPhotoCache();
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error('offline'); };
  assert.equal(await fetchAircraftPhoto({ icao24: 'beef02' }, { fetchImpl }), null);
  assert.equal(cachedPhoto({ icao24: 'beef02' }), null);
  await fetchAircraftPhoto({ icao24: 'beef02' }, { fetchImpl });
  assert.equal(calls, 2);
});

test('identity always yields a silhouette, and upgrades as sources resolve', () => {
  const info = { icao24: '4ca1fb', callsign: 'RYR4XM', typeCode: 'B738' };
  const bare = aircraftIdentity(info, { airline: null, photo: null });
  assert.equal(bare.operator, '');
  assert.equal(bare.logo, '');
  assert.equal(bare.photo, null);
  assert.match(bare.silhouette, /^data:image\/svg\+xml;base64,/);
  assert.equal(bare.klass, 'airliner');

  const airline = lookupAirlineIn(PACK, 'RYR');
  const branded = aircraftIdentity(info, { airline, photo: null });
  assert.equal(branded.operator, 'Ryanair');
  assert.equal(branded.color, '#f1c931');
  assert.notEqual(branded.silhouette, bare.silhouette, 'silhouette takes the brand colour');

  const photo = { thumbnail: 't', large: 't', link: 'l', photographer: 'p' };
  const full = aircraftIdentity(info, { airline, photo });
  assert.deepEqual(full.photo, photo);
  assert.notEqual(identitySignature(full), identitySignature(branded));
  assert.equal(identitySignature(branded), identitySignature(aircraftIdentity(info, { airline, photo: null })));
});

test('an uncreditable photo is dropped by the identity model too', () => {
  const identity = aircraftIdentity({ callsign: 'RYR4XM' }, {
    airline: null,
    photo: { thumbnail: 't', link: 'l', photographer: '' },
  });
  assert.equal(identity.photo, null);
});

test('every AIS family gets its own hull, and unknown types still get one', () => {
  const shapes = ['TANKER', 'CARGO', 'CONTAINER SHIP', 'PASSENGER', 'HIGH-SPEED',
    'FISHING', 'TUG', 'MILITARY', 'SAILING', 'PLEASURE'].map(vesselShapeId);
  assert.equal(new Set(shapes).size, shapes.length, 'no two families share a hull');
  assert.equal(vesselShapeId(''), 'cargo');
  assert.equal(vesselShapeId('80'), 'tanker', 'numeric AIS codes resolve through the family map');
  assert.equal(vesselShapeId('52'), 'tug');

  const svg = vesselIconSvg('TANKER', '#ffb347', { stroke: '#000', strokeWidth: 0.7 });
  assert.match(svg, /viewBox="0 0 32 32"/);
  assert.match(svg, /#ffb347/);
  assert.notEqual(svg, vesselIconSvg('TUG', '#ffb347', { stroke: '#000', strokeWidth: 0.7 }));
});
