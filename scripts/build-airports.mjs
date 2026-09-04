#!/usr/bin/env node
/**
 * Build src/data/local_data/airports.json from the public-domain OurAirports
 * dataset — the airport/country reference the flight-route readout resolves
 * origin and destination codes against.
 *
 * Source:    https://ourairports.com/data/
 * Fetched:   https://davidmegginson.github.io/ourairports-data/airports.csv
 *            https://davidmegginson.github.io/ourairports-data/countries.csv
 * License:   public domain (OurAirports places its data in the public domain,
 *            https://ourairports.com/data/ — attribution kept in DATA_SOURCES.md).
 *
 * Transform (deterministic):
 *   1. Keep only airports a scheduled flight can plausibly be routed to/from:
 *      an IATA code, or `scheduled_service=yes`. That is ~9k of the ~86k rows
 *      (the rest are heliports, seaplane bases and private strips), which is
 *      what keeps the shipped JSON a few hundred KB instead of ~15 MB.
 *   2. Index by EVERY code the upstream route API might hand us — ICAO ident,
 *      `icao_code`, `gps_code` and `iata_code` — since adsbdb returns
 *      `iata_code || icao_code` and either can be blank per airport.
 *   3. Records are positional arrays `[name, municipality, isoCountry]`
 *      shared by all of an airport's codes; countries are a separate
 *      `iso -> name` map. Both cut the file roughly in half versus objects.
 *   4. Everything sorted for a stable diff.
 *
 * Usage:
 *   node scripts/build-airports.mjs [airports.csv] [countries.csv]
 * With no arguments it downloads both live files; with paths it reads them.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AIRPORTS_URL = 'https://davidmegginson.github.io/ourairports-data/airports.csv';
const COUNTRIES_URL = 'https://davidmegginson.github.io/ourairports-data/countries.csv';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)),
  '..', 'src', 'data', 'local_data', 'airports.json');

/** Minimal RFC4180 CSV parse — OurAirports quotes any field containing a comma or quote. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    if (ch !== '\r') field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift();
  return rows
    .filter((r) => r.length === header.length)
    .map((r) => Object.fromEntries(header.map((key, index) => [key, r[index]])));
}

async function read(source, url) {
  if (source) return fs.readFileSync(source, 'utf8');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.text();
}

async function main() {
  const [airportsPath, countriesPath] = process.argv.slice(2);
  const airportRows = parseCsv(await read(airportsPath, AIRPORTS_URL));
  const countryRows = parseCsv(await read(countriesPath, COUNTRIES_URL));

  const countries = {};
  for (const row of countryRows.sort((a, b) => a.code.localeCompare(b.code))) {
    if (row.code && row.name) countries[row.code] = row.name;
  }

  const routable = airportRows
    .filter((row) => row.iata_code || row.scheduled_service === 'yes')
    .sort((a, b) => (a.ident || '').localeCompare(b.ident || ''));

  const records = [];
  const byCode = {};
  for (const row of routable) {
    const index = records.length;
    records.push([row.name || '', row.municipality || '', row.iso_country || '']);
    for (const code of [row.ident, row.icao_code, row.gps_code, row.iata_code]) {
      const key = String(code || '').trim().toUpperCase();
      // First writer wins: `ident` is the canonical row, and a duplicate
      // gps_code/iata_code elsewhere must not steal an established code.
      if (key && !(key in byCode)) byCode[key] = index;
    }
  }

  const payload = {
    source: 'https://ourairports.com/data/ (public domain)',
    generated: new Date().toISOString().slice(0, 10),
    fields: ['name', 'municipality', 'isoCountry'],
    countries,
    records,
    byCode: Object.fromEntries(Object.entries(byCode).sort(([a], [b]) => a.localeCompare(b))),
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(payload)}\n`, 'utf8');
  console.log(`Wrote ${OUT}: ${records.length} airports, ${Object.keys(byCode).length} codes, ${Object.keys(countries).length} countries`);
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
