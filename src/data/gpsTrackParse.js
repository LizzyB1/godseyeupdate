/**
 * @file Pure GPS-track parsing — GPX 1.1 XML and raw NMEA-0183 logger text
 * into a common `{ name, segments }` shape (segments = array of point
 * arrays, one `<trkseg>`/continuous-fix run each; a dropout or big time
 * gap starts a new segment rather than drawing a straight-line teleport,
 * matching how gps_manager.py's own toolkit treats one).
 *
 * This is a faithful port of the parsing/segmenting logic in the uploaded
 * nmea_to_gpx.py and gpx_to_3d.py scripts, so the same raw NMEA .TXT logs
 * or already-converted .gpx files those scripts work with can be dropped
 * straight into the browser — no Python, no server round-trip. Left out on
 * purpose: gpx_to_3d.py's DEM-fetch / textured-terrain-mesh / OBJ+STL export
 * pipeline. That produces an offline 3D file for other apps/printing; this
 * module only needs points-on-a-map, and the live globe already supplies
 * real photorealistic terrain to drape the track over.
 *
 * Cesium-free by design so every code path here is unit-testable without a
 * DOM/WebGL context; src/data/gpsTracks.js turns the output into Cesium
 * entities.
 *
 * @module data/gpsTrackParse
 */

/** @typedef {{lat:number, lon:number, ele:number, time:?Date}} TrackPoint */
/** @typedef {{name:string, segments:TrackPoint[][]}} ParsedTrack */

const TRKSEG_RE = /<trkseg\b[^>]*>([\s\S]*?)<\/trkseg>/g;
// Real trkpt elements always carry children (ele/time/etc.) in files this
// toolkit reads or writes, so only the open/close form is handled — a
// childless self-closing `<trkpt .../>` carries no elevation or time and
// doesn't occur in practice here.
const TRKPT_RE = /<trkpt\b([^>]*)>([\s\S]*?)<\/trkpt>/g;
const LAT_ATTR_RE = /\blat\s*=\s*"([^"]*)"/i;
const LON_ATTR_RE = /\blon\s*=\s*"([^"]*)"/i;
const ELE_TAG_RE = /<ele\b[^>]*>([\s\S]*?)<\/ele>/i;
const TIME_TAG_RE = /<time\b[^>]*>([\s\S]*?)<\/time>/i;
const TRK_NAME_RE = /<trk\b[^>]*>[\s\S]*?<name\b[^>]*>([\s\S]*?)<\/name>/i;

function decodeXmlEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function parseTrkptAttrs(attrsText) {
  const lat = Number(LAT_ATTR_RE.exec(attrsText)?.[1]);
  const lon = Number(LON_ATTR_RE.exec(attrsText)?.[1]);
  return { lat, lon };
}

function parseTrkptBody(bodyText) {
  const eleText = ELE_TAG_RE.exec(bodyText)?.[1]?.trim();
  const ele = eleText ? Number(eleText) : 0;
  const timeText = TIME_TAG_RE.exec(bodyText)?.[1]?.trim();
  const time = timeText ? new Date(timeText) : null;
  return {
    ele: Number.isFinite(ele) ? ele : 0,
    time: time && !Number.isNaN(time.getTime()) ? time : null,
  };
}

/**
 * Parse a GPX 1.1 document's track point(s) into segments, mirroring
 * gpx_to_3d.py's `parse_gpx`: one output segment per `<trkseg>`, so a
 * logger gap already encoded as separate segments in the file stays a gap.
 *
 * Deliberately a lightweight tag scan rather than a full XML parse (no
 * `DOMParser`, so this stays usable from plain Node — including this
 * module's own unit tests — as well as the browser). GPX 1.1 track data is
 * simple/regular enough (flat trkseg/trkpt/ele/time, no namespace prefixes
 * in files this toolkit produces) that this is safe; it is not a general
 * XML parser and does not need to be one for this use.
 * @param {string} xmlText - Raw GPX file contents.
 * @param {string} fallbackName - Name to use if the file has no `<trk><name>`.
 * @returns {ParsedTrack}
 * @throws {Error} If no `<trkpt>` elements are found.
 */
export function parseGpxTrack(xmlText, fallbackName = 'track') {
  const trkName = decodeXmlEntities(TRK_NAME_RE.exec(xmlText)?.[1]?.trim() || '');
  const segments = [];

  let segMatch;
  TRKSEG_RE.lastIndex = 0;
  while ((segMatch = TRKSEG_RE.exec(xmlText))) {
    const segBody = segMatch[1];
    const points = [];

    TRKPT_RE.lastIndex = 0;
    let ptMatch;
    while ((ptMatch = TRKPT_RE.exec(segBody))) {
      const { lat, lon } = parseTrkptAttrs(ptMatch[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      points.push({ lat, lon, ...parseTrkptBody(ptMatch[2]) });
    }

    if (points.length) segments.push(points);
  }

  if (!segments.length) throw new Error('No <trkpt> elements found in GPX file');
  return { name: trkName || fallbackName, segments };
}

// ---------------------------------------------------------------------------
// NMEA-0183 parsing — port of nmea_to_gpx.py
// ---------------------------------------------------------------------------

/** NMEA ddmm.mmmm / dddmm.mmmm → signed decimal degrees. */
export function nmeaToDecimal(value, hemisphere) {
  if (!value) return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const degrees = Math.trunc(num / 100);
  const minutes = num - degrees * 100;
  let dec = degrees + minutes / 60;
  if (hemisphere === 'S' || hemisphere === 'W') dec = -dec;
  return dec;
}

/** hhmmss[.sss] → { hh, mm, ss } (ss may be fractional), or null if malformed. */
export function parseNmeaTimeField(t) {
  if (!t || t.length < 6) return null;
  const hh = Number(t.slice(0, 2));
  const mm = Number(t.slice(2, 4));
  const ss = Number(t.slice(4));
  if (![hh, mm, ss].every(Number.isFinite)) return null;
  return { hh, mm, ss };
}

/** Validate the trailing `*hh` checksum if present; absent/unparseable checksum is not rejected. */
export function nmeaChecksumOk(line) {
  const starIdx = line.lastIndexOf('*');
  if (starIdx === -1) return true;
  let body = line.slice(0, starIdx);
  const cksumText = line.slice(starIdx + 1).trim().slice(0, 2);
  if (body.startsWith('$')) body = body.slice(1);
  const expected = Number.parseInt(cksumText, 16);
  if (!Number.isFinite(expected)) return true; // can't validate, don't reject
  let actual = 0;
  for (let i = 0; i < body.length; i += 1) actual ^= body.charCodeAt(i);
  return actual === expected;
}

/** Parse a $GxGGA sentence's fields (already split on comma, sentence id included at [0]). */
export function parseGga(fields) {
  if (fields.length < 10) return null;
  const timeS = fields[1];
  const lat = nmeaToDecimal(fields[2], fields[3]);
  const lon = nmeaToDecimal(fields[4], fields[5]);
  const fixq = fields[6] ? Number.parseInt(fields[6], 10) : 0;
  const numsat = fields[7] ? Number.parseInt(fields[7], 10) : null;
  const hdop = fields[8] ? Number(fields[8]) : null;
  const ele = fields[9] ? Number(fields[9]) : null;
  if (lat == null || lon == null || ele == null || !Number.isFinite(ele) || !fixq) return null;
  return {
    timeS,
    lat,
    lon,
    fixq,
    numsat: Number.isFinite(numsat) ? numsat : null,
    hdop: Number.isFinite(hdop) ? hdop : null,
    ele,
  };
}

/** Parse a $GxRMC sentence's fields. */
export function parseRmc(fields) {
  if (fields.length < 10) return null;
  const timeS = fields[1];
  const status = fields[2];
  const dateS = fields[9];
  const speedKn = fields[7] ? Number(fields[7]) : null;
  const course = fields[8] ? Number(fields[8]) : null;
  const valid = status === 'A' && !!dateS && dateS.length === 6;
  return {
    timeS,
    dateS: valid ? dateS : null,
    speedKn: Number.isFinite(speedKn) ? speedKn : null,
    course: Number.isFinite(course) ? course : null,
    valid,
  };
}

/** Combine an RMC ddmmyy date with an hhmmss[.sss] time into a UTC Date, or null. */
export function buildNmeaDatetime(dateS, timeS) {
  if (!dateS || dateS.length !== 6) return null;
  const dd = Number(dateS.slice(0, 2));
  const mo = Number(dateS.slice(2, 4));
  const yy = Number(dateS.slice(4, 6)) + 2000;
  const hms = parseNmeaTimeField(timeS);
  if (!hms || ![dd, mo].every(Number.isFinite)) return null;
  const wholeS = Math.trunc(hms.ss);
  const millis = Math.round((hms.ss - wholeS) * 1000);
  const date = new Date(Date.UTC(yy, mo - 1, dd, hms.hh, hms.mm, wholeS, millis));
  // Date.UTC silently normalizes out-of-range fields (e.g. month 13) instead
  // of failing, so cross-check the parts actually landed where asked.
  if (date.getUTCFullYear() !== yy || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== dd) return null;
  return date;
}

/**
 * Parse raw NMEA-0183 logger text into a flat list of merged points, mirroring
 * nmea_to_gpx.py's `parse_nmea_log`: a GGA supplies position/altitude/fix
 * quality, the following RMC (same reported time) supplies the date and
 * confirms an active fix, and only the merged pair becomes a point — this
 * avoids ever fabricating an elevation for a bare RMC-only epoch.
 * @param {string} text - Raw file contents.
 * @returns {{points: Array<object>, badChecksums: number}}
 */
export function parseNmeaLog(text) {
  let lastGga = null;
  let currentDate = null;
  let badChecksums = 0;
  const points = [];

  const lines = text.split(/\r\n|\r|\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith('$') || !line.includes(',')) continue;
    if (!nmeaChecksumOk(line)) { badChecksums += 1; continue; }

    const body = line.split('*')[0];
    const fields = body.split(',');
    const sentence = fields[0].slice(-3); // GGA/RMC regardless of talker id (GP/GN/GL/GA/GB)

    if (sentence === 'GGA') {
      lastGga = parseGga(fields); // null (no fix) clears any pending point too
      continue;
    }

    if (sentence === 'RMC') {
      const rmc = parseRmc(fields);
      if (!rmc) continue;
      if (rmc.dateS) currentDate = rmc.dateS;
      if (!rmc.valid) { lastGga = null; continue; }
      if (!lastGga || lastGga.timeS !== rmc.timeS) continue; // no matching fix for this exact epoch
      if (!currentDate) continue;
      const time = buildNmeaDatetime(currentDate, rmc.timeS);
      if (!time) continue;
      points.push({
        lat: lastGga.lat,
        lon: lastGga.lon,
        ele: lastGga.ele,
        time,
        fixq: lastGga.fixq,
        numsat: lastGga.numsat,
        hdop: lastGga.hdop,
        speedMps: rmc.speedKn != null ? rmc.speedKn * 0.514444 : null,
        course: rmc.course,
      });
      lastGga = null;
    }
  }

  return { points, badChecksums };
}

/** Split merged points into segments, starting a new one after a time gap. */
export function splitNmeaSegments(points, gapSeconds = 120) {
  const segments = [];
  let seg = [];
  let prevT = null;
  for (const p of points) {
    if (prevT != null && (p.time.getTime() - prevT) / 1000 > gapSeconds) {
      if (seg.length) segments.push(seg);
      seg = [];
    }
    seg.push(p);
    prevT = p.time.getTime();
  }
  if (seg.length) segments.push(seg);
  return segments;
}

/**
 * Parse raw NMEA-0183 logger text into the same `{ name, segments }` shape
 * `parseGpxTrack` returns.
 * @param {string} text - Raw file contents.
 * @param {string} fallbackName - Name to use for the parsed track.
 * @param {number} gapSeconds - Gap (seconds) that starts a new segment (default 120, matching nmea_to_gpx.py).
 * @returns {ParsedTrack & {badChecksums:number}}
 * @throws {Error} If no usable trackpoints were found.
 */
export function parseNmeaTrack(text, fallbackName = 'track', gapSeconds = 120) {
  const { points, badChecksums } = parseNmeaLog(text);
  if (!points.length) throw new Error('No usable NMEA GGA/RMC trackpoints found');
  const segments = splitNmeaSegments(points, gapSeconds).map(
    (seg) => seg.map((p) => ({ lat: p.lat, lon: p.lon, ele: p.ele, time: p.time })),
  );
  return { name: fallbackName, segments, badChecksums };
}

/** Quick sniff: does the start of the text look like an NMEA log (GGA/RMC + '$')? */
export function looksLikeNmea(text) {
  const head = text.slice(0, 8192);
  return head.includes('$') && (head.includes('GGA') || head.includes('RMC'));
}

/**
 * Parse a file's contents by extension/content sniff: `.gpx` → GPX XML,
 * otherwise treated as raw NMEA text.
 * @param {string} filename
 * @param {string} text
 * @returns {ParsedTrack}
 */
export function parseTrackFile(filename, text) {
  const name = filename.replace(/\.[^./\\]+$/, '') || 'track';
  const isGpx = /\.gpx$/i.test(filename) || /^\s*<\?xml/.test(text) || /<gpx[\s>]/i.test(text.slice(0, 1024));
  if (isGpx) return parseGpxTrack(text, name);
  if (!looksLikeNmea(text)) {
    throw new Error(`${filename}: not a .gpx file and doesn't look like an NMEA log (no GGA/RMC sentences found)`);
  }
  return parseNmeaTrack(text, name);
}

/**
 * Bounding box + centroid + point/segment counts for a parsed track — used
 * to fly the camera to a loaded track.
 * @param {TrackPoint[][]} segments
 * @returns {?{minLat:number,maxLat:number,minLon:number,maxLon:number,centerLat:number,centerLon:number,pointCount:number,segmentCount:number}}
 */
export function trackBounds(segments) {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  let pointCount = 0;
  for (const seg of segments) {
    for (const p of seg) {
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lon < minLon) minLon = p.lon;
      if (p.lon > maxLon) maxLon = p.lon;
      pointCount += 1;
    }
  }
  if (pointCount === 0) return null;
  return {
    minLat, maxLat, minLon, maxLon,
    centerLat: (minLat + maxLat) / 2,
    centerLon: (minLon + maxLon) / 2,
    pointCount,
    segmentCount: segments.length,
  };
}

const EARTH_RADIUS_M = 6371000;

/** Great-circle distance in meters between two `{lat,lon}` points (haversine). */
function haversineMeters(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Start/end points plus regularly-spaced distance and time interval flags
 * along a track's segments — pure haversine geometry and timestamp deltas,
 * no Cesium needed (the Cesium entity layer is `data/gpsTracks.js`). A
 * segment break (logger dropout / big time gap — see `splitNmeaSegments`)
 * resets both accumulators rather than bridging across the gap, matching
 * how the rest of this module already treats a break as a real one.
 * @param {TrackPoint[][]} segments
 * @param {{distanceStepM?:number, timeStepMs?:number}} [opts]
 * @returns {{
 *   start: ?TrackPoint,
 *   end: ?TrackPoint,
 *   distanceFlags: Array<{point:TrackPoint, meters:number}>,
 *   timeFlags: Array<{point:TrackPoint, minutes:number}>,
 * }}
 */
export function trackFlags(segments, opts = {}) {
  const distanceStepM = opts.distanceStepM ?? 100;
  const timeStepMs = opts.timeStepMs ?? 2 * 60 * 1000;
  const distanceFlags = [];
  const timeFlags = [];
  let start = null;
  let end = null;

  for (const seg of segments) {
    if (!seg.length) continue;
    if (!start) start = seg[0];
    end = seg[seg.length - 1];
    if (seg.length < 2) continue;

    let cumDist = 0;
    let nextDist = distanceStepM;
    const baseTime = seg[0].time instanceof Date ? seg[0].time.getTime() : null;
    let nextTimeMs = timeStepMs;

    for (let i = 1; i < seg.length; i += 1) {
      cumDist += haversineMeters(seg[i - 1], seg[i]);
      while (cumDist >= nextDist) {
        distanceFlags.push({ point: seg[i], meters: nextDist });
        nextDist += distanceStepM;
      }
      if (baseTime != null && seg[i].time instanceof Date) {
        const elapsed = seg[i].time.getTime() - baseTime;
        while (elapsed >= nextTimeMs) {
          timeFlags.push({ point: seg[i], minutes: nextTimeMs / 60000 });
          nextTimeMs += timeStepMs;
        }
      }
    }
  }

  return { start, end, distanceFlags, timeFlags };
}
