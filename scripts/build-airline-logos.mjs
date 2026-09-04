#!/usr/bin/env node
/**
 * Build src/data/local_data/airlineLogos.json from the Soaring Symbols airline
 * branding collection — the logo the tracked-aircraft readout shows next to a
 * callsign.
 *
 * Source:    https://github.com/soaring-symbols/soaring-symbols
 * License:   MIT (the repository). The marks themselves remain the airlines'
 *            trademarks and are shown only to identify the operator of a
 *            tracked flight — attribution kept in DATA_SOURCES.md.
 *
 * Transform (deterministic):
 *   1. Prefer the square `icon.svg` — the wordmark `logo.svg` is three times
 *      the bytes and unreadable at readout size — then fall back through the
 *      monochrome icon to the wordmark, since a fifth of the airlines publish
 *      only one of the three.
 *   2. Strip <title>/comments/indentation from each SVG; they are inlined as
 *      data URIs, so every byte ships.
 *   3. Index by ICAO and IATA code, since a callsign gives ICAO ("RYR4XM") and
 *      most other feeds give IATA.
 *   4. Everything sorted for a stable diff.
 *
 * Usage:
 *   node scripts/build-airline-logos.mjs [path/to/soaring-symbols]
 * With no argument it downloads from the upstream default branch.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAW = 'https://raw.githubusercontent.com/soaring-symbols/soaring-symbols/main';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)),
  '..', 'src', 'data', 'local_data', 'airlineLogos.json');

async function readAsset(root, relative) {
  if (root) return fs.readFileSync(path.join(root, relative), 'utf8');
  const res = await fetch(`${RAW}/${relative}`);
  if (!res.ok) throw new Error(`${relative} → HTTP ${res.status}`);
  return res.text();
}

/** Drop everything a 20px inline icon does not render. */
function minifySvg(svg) {
  return svg
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<title>[\s\S]*?<\/title>/g, '')
    .replace(/>\s+</g, '><')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** The best available mark for one airline, in descending legibility. */
async function firstAsset(root, slug) {
  for (const file of ['icon.svg', 'icon-mono.svg', 'logo.svg', 'logo-mono.svg']) {
    try {
      return minifySvg(await readAsset(root, `assets/${slug}/${file}`));
    } catch {
      continue;
    }
  }
  return null;
}

async function main() {
  const [root] = process.argv.slice(2);
  const airlines = JSON.parse(await readAsset(root, 'airlines.json'));

  const records = [];
  const byCode = {};
  for (const airline of [...airlines].sort((a, b) => a.slug.localeCompare(b.slug))) {
    if (!airline?.slug) continue;
    const svg = await firstAsset(root, airline.slug);
    if (!svg) {
      console.warn(`skipping ${airline.slug}: no icon or logo asset`);
      continue;
    }
    const index = records.length;
    records.push([
      airline.name || airline.slug,
      airline.branding?.primary_color || '',
      svg,
    ]);
    for (const code of [airline.icao, airline.iata]) {
      const key = String(code || '').trim().toUpperCase();
      // First writer wins: an IATA code that collides with another airline's
      // ICAO code must not steal it — ICAO is what callsigns carry.
      if (key && !(key in byCode)) byCode[key] = index;
    }
  }

  const payload = {
    source: 'https://github.com/soaring-symbols/soaring-symbols (MIT; marks remain airline trademarks)',
    generated: new Date().toISOString().slice(0, 10),
    fields: ['name', 'color', 'svg'],
    records,
    byCode: Object.fromEntries(Object.entries(byCode).sort(([a], [b]) => a.localeCompare(b))),
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(payload)}\n`, 'utf8');
  console.log(`Wrote ${OUT}: ${records.length} airlines, ${Object.keys(byCode).length} codes`);
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
