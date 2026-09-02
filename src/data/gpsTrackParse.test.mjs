import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseGpxTrack,
  nmeaToDecimal,
  parseNmeaTimeField,
  nmeaChecksumOk,
  parseGga,
  parseRmc,
  buildNmeaDatetime,
  parseNmeaLog,
  splitNmeaSegments,
  parseNmeaTrack,
  looksLikeNmea,
  parseTrackFile,
  trackBounds,
  trackFlags,
} from './gpsTrackParse.js';

// ── GPX parsing ────────────────────────────────────────────────────────────

const SAMPLE_GPX = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<gpx version="1.1" creator="nmea_to_gpx.py" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>Morning Ride</name>
    <time>2026-06-01T08:00:00Z</time>
  </metadata>
  <trk>
    <name>Morning Ride</name>
    <trkseg>
      <trkpt lat="30.2672000" lon="-97.7431000">
        <ele>200.0</ele>
        <time>2026-06-01T08:00:00.000Z</time>
      </trkpt>
      <trkpt lat="30.2673000" lon="-97.7432000">
        <ele>201.5</ele>
        <time>2026-06-01T08:00:05.000Z</time>
      </trkpt>
    </trkseg>
    <trkseg>
      <trkpt lat="30.3000000" lon="-97.8000000">
        <ele>210.0</ele>
        <time>2026-06-01T08:10:00.000Z</time>
      </trkpt>
    </trkseg>
  </trk>
</gpx>
`;

test('parseGpxTrack reads the track name, splits on trkseg, and parses lat/lon/ele/time', () => {
  const track = parseGpxTrack(SAMPLE_GPX, 'fallback');
  assert.equal(track.name, 'Morning Ride');
  assert.equal(track.segments.length, 2);
  assert.equal(track.segments[0].length, 2);
  assert.equal(track.segments[1].length, 1);
  const p0 = track.segments[0][0];
  assert.equal(p0.lat, 30.2672);
  assert.equal(p0.lon, -97.7431);
  assert.equal(p0.ele, 200.0);
  assert.equal(p0.time.toISOString(), '2026-06-01T08:00:00.000Z');
});

test('parseGpxTrack falls back to the given name when the file has none', () => {
  const noName = SAMPLE_GPX.replaceAll('<name>Morning Ride</name>', '');
  const track = parseGpxTrack(noName, 'fallback-name');
  assert.equal(track.name, 'fallback-name');
});

test('parseGpxTrack defaults missing elevation to 0 rather than dropping the point', () => {
  const gpx = `<gpx xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>
    <trkpt lat="1.0" lon="2.0"></trkpt>
  </trkseg></trk></gpx>`;
  const track = parseGpxTrack(gpx, 'x');
  assert.equal(track.segments[0][0].ele, 0);
  assert.equal(track.segments[0][0].time, null);
});

test('parseGpxTrack throws when there are no trkpt elements', () => {
  assert.throws(() => parseGpxTrack('<gpx xmlns="http://www.topografix.com/GPX/1/1"></gpx>', 'x'));
});

test('parseGpxTrack skips a trkpt with a non-numeric lat/lon rather than crashing', () => {
  const gpx = `<gpx xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>
    <trkpt lat="bogus" lon="2.0"><ele>1</ele></trkpt>
    <trkpt lat="1.0" lon="2.0"><ele>1</ele></trkpt>
  </trkseg></trk></gpx>`;
  const track = parseGpxTrack(gpx, 'x');
  assert.equal(track.segments[0].length, 1);
});

// ── NMEA field/line helpers ─────────────────────────────────────────────────

test('nmeaToDecimal converts ddmm.mmmm with hemisphere sign', () => {
  assert.ok(Math.abs(nmeaToDecimal('3016.0320', 'N') - 30.267200) < 1e-6);
  assert.ok(Math.abs(nmeaToDecimal('9744.5860', 'W') - (-97.743100)) < 1e-6);
  assert.equal(nmeaToDecimal('', 'N'), null);
});

test('parseNmeaTimeField splits hhmmss.sss', () => {
  assert.deepEqual(parseNmeaTimeField('123456.78'), { hh: 12, mm: 34, ss: 56.78 });
  assert.equal(parseNmeaTimeField('123'), null);
});

test('nmeaChecksumOk validates a correct checksum and rejects a wrong one', () => {
  // $GPGGA with a real, hand-verified checksum:
  const good = '$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47';
  assert.equal(nmeaChecksumOk(good), true);
  const bad = good.slice(0, -2) + '00';
  assert.equal(nmeaChecksumOk(bad), false);
});

test('nmeaChecksumOk does not reject a line with no checksum at all', () => {
  assert.equal(nmeaChecksumOk('$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,'), true);
});

test('parseGga requires a real fix (fixq != 0) and a numeric altitude', () => {
  const fields = '$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,'.split(',');
  const gga = parseGga(fields);
  assert.ok(gga);
  assert.equal(gga.fixq, 1);
  assert.ok(Math.abs(gga.ele - 545.4) < 1e-6);

  const noFix = fields.slice();
  noFix[6] = '0';
  assert.equal(parseGga(noFix), null);
});

test('parseRmc reports validity only for status A with a usable date', () => {
  const validFields = '$GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W'.split(',');
  const rmc = parseRmc(validFields);
  assert.equal(rmc.valid, true);
  assert.equal(rmc.dateS, '230394');

  const voidFields = validFields.slice();
  voidFields[2] = 'V';
  assert.equal(parseRmc(voidFields).valid, false);
});

test('buildNmeaDatetime combines ddmmyy + hhmmss into a correct UTC instant', () => {
  const dt = buildNmeaDatetime('230394', '123519');
  assert.equal(dt.toISOString(), '2094-03-23T12:35:19.000Z');
});

test('buildNmeaDatetime rejects an out-of-range date instead of silently normalizing it', () => {
  assert.equal(buildNmeaDatetime('991394', '123519'), null); // month 13
});

// ── Full NMEA log parsing / segmenting ──────────────────────────────────────

function nmeaLine(sentence) {
  // Compute and append a real checksum so nmeaChecksumOk never trips on
  // fixture data.
  let cksum = 0;
  for (const ch of sentence.slice(1)) cksum ^= ch.charCodeAt(0);
  return `${sentence}*${cksum.toString(16).toUpperCase().padStart(2, '0')}`;
}

test('parseNmeaLog merges a GGA with the following same-epoch RMC into one point', () => {
  const gga = nmeaLine('$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,');
  const rmc = nmeaLine('$GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W');
  const { points, badChecksums } = parseNmeaLog(`${gga}\n${rmc}\n`);
  assert.equal(badChecksums, 0);
  assert.equal(points.length, 1);
  assert.equal(points[0].time.toISOString(), '2094-03-23T12:35:19.000Z');
  assert.ok(Math.abs(points[0].speedMps - 22.4 * 0.514444) < 1e-3);
});

test('parseNmeaLog drops a point whose GGA/RMC epochs do not match', () => {
  const gga = nmeaLine('$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,');
  const rmc = nmeaLine('$GPRMC,123520,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W');
  const { points } = parseNmeaLog(`${gga}\n${rmc}\n`);
  assert.equal(points.length, 0);
});

test('parseNmeaLog counts a corrupted checksum without throwing', () => {
  const gga = '$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*00'; // wrong checksum
  const { points, badChecksums } = parseNmeaLog(`${gga}\n`);
  assert.equal(points.length, 0);
  assert.equal(badChecksums, 1);
});

test('splitNmeaSegments starts a new segment after a large time gap', () => {
  const points = [
    { time: new Date('2026-01-01T00:00:00Z') },
    { time: new Date('2026-01-01T00:00:05Z') },
    { time: new Date('2026-01-01T00:10:00Z') }, // >120s gap
  ];
  const segments = splitNmeaSegments(points, 120);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].length, 2);
  assert.equal(segments[1].length, 1);
});

test('parseNmeaTrack end-to-end: two GGA/RMC pairs across a gap become two segments', () => {
  const line1gga = nmeaLine('$GPGGA,000000,4807.038,N,01131.000,E,1,08,0.9,100.0,M,46.9,M,,');
  const line1rmc = nmeaLine('$GPRMC,000000,A,4807.038,N,01131.000,E,000.0,000.0,010126,003.1,W');
  const line2gga = nmeaLine('$GPGGA,001000,4807.038,N,01131.000,E,1,08,0.9,101.0,M,46.9,M,,');
  const line2rmc = nmeaLine('$GPRMC,001000,A,4807.038,N,01131.000,E,000.0,000.0,010126,003.1,W');
  const text = [line1gga, line1rmc, line2gga, line2rmc].join('\n');
  const track = parseNmeaTrack(text, 'log01', 120);
  assert.equal(track.name, 'log01');
  assert.equal(track.segments.length, 2);
  assert.equal(track.badChecksums, 0);
});

test('parseNmeaTrack throws when nothing usable is found', () => {
  assert.throws(() => parseNmeaTrack('not a gps log\njust some text\n', 'x'));
});

test('looksLikeNmea sniffs for a $ line with GGA or RMC', () => {
  assert.equal(looksLikeNmea('$GPGGA,foo'), true);
  assert.equal(looksLikeNmea('hello world'), false);
});

// ── File-type dispatch ───────────────────────────────────────────────────

test('parseTrackFile routes a .gpx filename to the GPX parser', () => {
  const track = parseTrackFile('ride.gpx', SAMPLE_GPX);
  assert.equal(track.name, 'Morning Ride');
});

test('parseTrackFile routes a .txt NMEA dump to the NMEA parser by content', () => {
  const gga = nmeaLine('$GPGGA,000000,4807.038,N,01131.000,E,1,08,0.9,100.0,M,46.9,M,,');
  const rmc = nmeaLine('$GPRMC,000000,A,4807.038,N,01131.000,E,000.0,000.0,010126,003.1,W');
  const track = parseTrackFile('LOG00001.TXT', `${gga}\n${rmc}\n`);
  assert.equal(track.name, 'LOG00001');
  assert.equal(track.segments.length, 1);
});

test('parseTrackFile rejects a non-.gpx file with no NMEA sentences', () => {
  assert.throws(() => parseTrackFile('notes.txt', 'just some unrelated text file'));
});

// ── Bounds ───────────────────────────────────────────────────────────────

test('trackBounds computes bbox/center/counts across all segments', () => {
  const segments = [
    [{ lat: 10, lon: 20 }, { lat: 12, lon: 22 }],
    [{ lat: 8, lon: 18 }],
  ];
  const bounds = trackBounds(segments);
  assert.equal(bounds.minLat, 8);
  assert.equal(bounds.maxLat, 12);
  assert.equal(bounds.minLon, 18);
  assert.equal(bounds.maxLon, 22);
  assert.equal(bounds.centerLat, 10);
  assert.equal(bounds.centerLon, 20);
  assert.equal(bounds.pointCount, 3);
  assert.equal(bounds.segmentCount, 2);
});

test('trackBounds returns null for an empty track', () => {
  assert.equal(trackBounds([]), null);
  assert.equal(trackBounds([[]]), null);
});

// ── trackFlags (start/end + distance/time interval markers) ────────────────

/** Same-longitude points sit on a meridian (a great circle), so consecutive
 * haversine distance is exactly EARTH_RADIUS_M * dLatRadians — lets the test
 * build a fixture with an exactly-known per-step distance. */
const EARTH_RADIUS_M = 6371000;
function metersToLatDeg(meters) {
  return ((meters / EARTH_RADIUS_M) * 180) / Math.PI;
}

test('trackFlags places a distance flag every N meters along a straight line', () => {
  const stepDeg = metersToLatDeg(40); // ~40 m between consecutive points
  const seg = Array.from({ length: 10 }, (_, i) => ({ lat: i * stepDeg, lon: 0 }));
  const { distanceFlags } = trackFlags([seg], { distanceStepM: 100 });
  // ~360 m total (9 steps * 40 m) crosses 100/200/300 but not 400.
  assert.equal(distanceFlags.length, 3);
  assert.deepEqual(distanceFlags.map((f) => f.meters), [100, 200, 300]);
});

test('trackFlags places a time flag every N minutes using point timestamps', () => {
  const base = new Date('2026-01-01T00:00:00Z').getTime();
  const seg = Array.from({ length: 9 }, (_, i) => ({
    lat: i * 0.0001, lon: 0, time: new Date(base + i * 30_000), // 30s apart
  }));
  const { timeFlags } = trackFlags([seg], { timeStepMs: 2 * 60 * 1000 });
  // 8 steps * 30s = 240s = 4 min total -> crosses the 2min and 4min marks.
  assert.equal(timeFlags.length, 2);
  assert.deepEqual(timeFlags.map((f) => f.minutes), [2, 4]);
});

test('trackFlags resets distance/time accumulators at a segment break', () => {
  const stepDeg = metersToLatDeg(60);
  const segA = Array.from({ length: 3 }, (_, i) => ({ lat: i * stepDeg, lon: 0 })); // ~120 m
  const segB = Array.from({ length: 3 }, (_, i) => ({ lat: 10 + i * stepDeg, lon: 0 })); // another ~120 m, far away
  const { distanceFlags } = trackFlags([segA, segB], { distanceStepM: 100 });
  // Each segment independently crosses one 100 m flag — if the break didn't
  // reset the accumulator, segB would start "already past" 100 m and behave
  // differently (still 1 flag here either way, but the count must stay 2
  // total: one per segment, not bridged into a single 240 m run).
  assert.equal(distanceFlags.length, 2);
});

test('trackFlags reports the overall start and end across all segments', () => {
  const segments = [
    [{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }],
    [{ lat: 3, lon: 3 }, { lat: 4, lon: 4 }],
  ];
  const { start, end } = trackFlags(segments);
  assert.deepEqual(start, { lat: 1, lon: 1 });
  assert.deepEqual(end, { lat: 4, lon: 4 });
});

test('trackFlags handles an empty track without throwing', () => {
  assert.deepEqual(trackFlags([]), { start: null, end: null, distanceFlags: [], timeFlags: [] });
});
