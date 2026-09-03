import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toDMS, formatLatLonDMS, formatLatLonDecimal, googleMapsLink, formatHeight } from './coordFormat.js';

test('toDMS formats latitude with 2-digit degrees and hemisphere letter', () => {
  assert.equal(toDMS(38.9072, true), '38°54\'26"N');
  assert.equal(toDMS(-38.9072, true), '38°54\'26"S');
});

test('toDMS formats longitude with 3-digit degrees', () => {
  assert.equal(toDMS(-77.0369, false), '077°02\'13"W');
  assert.equal(toDMS(2.3522, false), '002°21\'08"E');
});

test('toDMS carries seconds/minutes overflow into the next unit', () => {
  // 59.9999 minutes worth of seconds should round up cleanly, not print "60".
  const dms = toDMS(0.999999999, true);
  assert.match(dms, /^01°00'00"N$/);
});

test('toDMS handles the zero case and non-finite input', () => {
  assert.equal(toDMS(0, true), '00°00\'00"N');
  assert.equal(toDMS(NaN, true), '—');
});

test('formatLatLonDMS joins both components with a space', () => {
  assert.equal(formatLatLonDMS(38.9072, -77.0369), '38°54\'26"N 077°02\'13"W');
});

test('formatLatLonDecimal fixes to 6 places', () => {
  assert.equal(formatLatLonDecimal(38.9072, -77.0369), '38.907200, -77.036900');
  assert.equal(formatLatLonDecimal(NaN, 1), '—');
});

test('googleMapsLink builds a q= link, empty string when not finite', () => {
  assert.equal(googleMapsLink(38.9072, -77.0369), 'https://www.google.com/maps?q=38.907200,-77.036900');
  assert.equal(googleMapsLink(NaN, NaN), '');
});

test('formatHeight rounds meters, metric only', () => {
  assert.equal(formatHeight(100), '100 m');
  assert.equal(formatHeight(12345), '12,345 m');
  assert.equal(formatHeight(NaN), '—');
});
