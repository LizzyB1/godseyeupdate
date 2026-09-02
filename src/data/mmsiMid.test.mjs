import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MID_TABLE, extractMid, getFlagState, describeMmsiPrefix } from './mmsiMid.js';

test('getFlagState resolves a well-known MID to its flag state', () => {
  assert.equal(getFlagState('366123456'), 'United States of America'); // 366 = USA
  assert.equal(getFlagState('235123456'), 'United Kingdom'); // 235 = UK
  assert.equal(getFlagState(235123456), 'United Kingdom'); // numeric input works too
  assert.equal(getFlagState('412123456'), 'China'); // 412 = China
});

test('getFlagState covers every region band spot-checked from the source table', () => {
  assert.equal(getFlagState('257123456'), 'Norway'); // 2xx Europe
  assert.equal(getFlagState('338123456'), 'United States of America'); // 3xx N. America/Caribbean
  assert.equal(getFlagState('431123456'), 'Japan'); // 4xx Asia
  assert.equal(getFlagState('503123456'), 'Australia'); // 5xx Oceania
  assert.equal(getFlagState('657123456'), 'Nigeria'); // 6xx Africa
  assert.equal(getFlagState('710123456'), 'Brazil'); // 7xx S. America
});

test('getFlagState returns null for a malformed MMSI', () => {
  assert.equal(getFlagState(null), null);
  assert.equal(getFlagState(undefined), null);
  assert.equal(getFlagState(''), null);
  assert.equal(getFlagState('12345'), null); // too short
  assert.equal(getFlagState('1234567890'), null); // too long
  assert.equal(getFlagState('36612345a'), null); // non-digit
});

test('getFlagState returns null for an unassigned MID', () => {
  assert.equal(getFlagState('299123456'), null); // 299 is not in the allocation table
  assert.equal(getFlagState('999123456'), null); // no 9xx MID exists
});

test('extractMid excludes coast-station (0-prefixed) and group-of-ships (8-prefixed) MMSIs', () => {
  // 0257xxxxx carries MID 257 one digit in, not at the start — a straight
  // 3-digit read must not misidentify these as a country MID.
  assert.equal(extractMid('025712345'), null);
  assert.equal(extractMid('836612345'), null);
});

test('describeMmsiPrefix classifies a plain country MMSI', () => {
  const result = describeMmsiPrefix('366123456');
  assert.equal(result.kind, 'country');
  assert.equal(result.flagState, 'United States of America');
  assert.equal(result.mid, '366');
});

test('describeMmsiPrefix classifies a coast station MMSI by its embedded MID', () => {
  const result = describeMmsiPrefix('025712345'); // 0 + MID 257 (Norway) + station id
  assert.equal(result.kind, 'coastStation');
  assert.equal(result.flagState, 'Norway');
});

test('describeMmsiPrefix classifies a group-of-ships MMSI by its embedded MID', () => {
  const result = describeMmsiPrefix('836612345'); // 8 + MID 366 (USA) + group id
  assert.equal(result.kind, 'groupOfShips');
  assert.equal(result.flagState, 'United States of America');
});

test('describeMmsiPrefix classifies SAR aircraft prefixes', () => {
  assert.equal(describeMmsiPrefix('970123456').kind, 'sarAircraft');
  assert.equal(describeMmsiPrefix('972123456').kind, 'sarAircraft');
});

test('describeMmsiPrefix classifies auxiliary-craft (98/99) prefixes', () => {
  assert.equal(describeMmsiPrefix('981234567').kind, 'auxiliaryCraft');
  assert.equal(describeMmsiPrefix('992345678').kind, 'auxiliaryCraft');
});

test('describeMmsiPrefix falls back to unknown for malformed or unassigned input', () => {
  assert.deepEqual(describeMmsiPrefix(null), { kind: 'unknown', flagState: null, mid: null });
  assert.deepEqual(describeMmsiPrefix('299123456'), { kind: 'unknown', flagState: null, mid: null });
});

test('MID_TABLE has no accidental duplicate-looking whitespace/casing issues in its keys', () => {
  for (const key of Object.keys(MID_TABLE)) {
    assert.match(key, /^\d{3}$/, `key "${key}" should be exactly 3 digits`);
  }
});
