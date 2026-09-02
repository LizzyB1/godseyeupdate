/**
 * @file MMSI MID (Maritime Identification Digits) → flag state/country
 * lookup. The MID is the first three digits of a vessel's 9-digit MMSI and
 * is assigned per-country by the ITU, so it's the standard way to derive an
 * AIS contact's flag state from its MMSI alone, with no extra API call.
 * Table sourced from https://www.vtexplorer.com/mmsi-mid-codes-en/ (the
 * ITU's own published MID allocation table).
 *
 * A few MMSI prefixes are reserved for non-ship-station uses rather than a
 * country's merchant/fishing fleet (e.g. `0` + MID for a coast station,
 * `8` + MID for a group of ships, `98`/`99` + MID for a craft associated
 * with a parent ship, `111` + MID for SAR aircraft) — see
 * `describeMmsiPrefix`, which reports those separately from a straight flag
 * lookup so callers can label them accurately instead of guessing they're a
 * MID they aren't.
 *
 * @module data/mmsiMid
 */

/** MID (3-digit string) → flag state name, per the ITU allocation table. */
export const MID_TABLE = Object.freeze({
  '201': 'Albania', '202': 'Andorra', '203': 'Austria', '204': 'Azores',
  '205': 'Belgium', '206': 'Belarus', '207': 'Bulgaria', '208': 'Vatican City State',
  '209': 'Cyprus', '210': 'Cyprus', '211': 'Germany', '212': 'Cyprus',
  '213': 'Georgia', '214': 'Moldova', '215': 'Malta', '216': 'Armenia',
  '218': 'Germany', '219': 'Denmark', '220': 'Denmark', '224': 'Spain',
  '225': 'Spain', '226': 'France', '227': 'France', '228': 'France',
  '230': 'Finland', '231': 'Faroe Islands', '232': 'United Kingdom', '233': 'United Kingdom',
  '234': 'United Kingdom', '235': 'United Kingdom', '236': 'Gibraltar', '237': 'Greece',
  '238': 'Croatia', '239': 'Greece', '240': 'Greece', '241': 'Greece',
  '242': 'Morocco', '243': 'Hungary', '244': 'Netherlands', '245': 'Netherlands',
  '246': 'Netherlands', '247': 'Italy', '248': 'Malta', '249': 'Malta',
  '250': 'Ireland', '251': 'Iceland', '252': 'Liechtenstein', '253': 'Luxembourg',
  '254': 'Monaco', '255': 'Madeira', '256': 'Malta', '257': 'Norway',
  '258': 'Norway', '259': 'Norway', '261': 'Poland', '262': 'Montenegro',
  '263': 'Portugal', '264': 'Romania', '265': 'Sweden', '266': 'Sweden',
  '267': 'Slovak Republic', '268': 'San Marino', '269': 'Switzerland', '270': 'Czech Republic',
  '271': 'Turkey', '272': 'Ukraine', '273': 'Russian Federation', '274': 'North Macedonia',
  '275': 'Latvia', '276': 'Estonia', '277': 'Lithuania', '278': 'Slovenia',
  '279': 'Serbia',
  '301': 'Anguilla', '303': 'Alaska (USA)', '304': 'Antigua and Barbuda', '305': 'Antigua and Barbuda',
  '306': 'Netherlands Antilles', '307': 'Aruba', '308': 'Bahamas', '309': 'Bahamas',
  '310': 'Bermuda', '311': 'Bahamas', '312': 'Belize', '314': 'Barbados',
  '316': 'Canada', '319': 'Cayman Islands', '321': 'Costa Rica', '323': 'Cuba',
  '325': 'Dominica', '327': 'Dominican Republic', '329': 'Guadeloupe', '330': 'Grenada',
  '331': 'Greenland', '332': 'Guatemala', '334': 'Honduras', '336': 'Haiti',
  '338': 'United States of America', '339': 'Jamaica', '341': 'Saint Kitts and Nevis', '343': 'Saint Lucia',
  '345': 'Mexico', '347': 'Martinique', '348': 'Montserrat', '350': 'Nicaragua',
  '351': 'Panama', '352': 'Panama', '353': 'Panama', '354': 'Panama',
  '358': 'Puerto Rico', '359': 'El Salvador', '361': 'Saint Pierre and Miquelon', '362': 'Trinidad and Tobago',
  '364': 'Turks and Caicos Islands', '366': 'United States of America', '367': 'United States of America', '368': 'United States of America',
  '369': 'United States of America', '370': 'Panama', '371': 'Panama', '372': 'Panama',
  '375': 'Saint Vincent and the Grenadines', '376': 'Saint Vincent and the Grenadines', '377': 'Saint Vincent and the Grenadines', '378': 'British Virgin Islands',
  '379': 'United States Virgin Islands',
  '401': 'Afghanistan', '403': 'Saudi Arabia', '405': 'Bangladesh', '408': 'Bahrain',
  '410': 'Bhutan', '412': 'China', '413': 'China', '416': 'Taiwan',
  '417': 'Sri Lanka', '419': 'India', '422': 'Iran', '423': 'Azerbaijan',
  '425': 'Iraq', '428': 'Israel', '431': 'Japan', '432': 'Japan',
  '434': 'Turkmenistan', '436': 'Kazakhstan', '437': 'Uzbekistan', '438': 'Jordan',
  '440': 'Korea (Republic of)', '441': 'Korea (Republic of)', '443': 'Palestine', '445': 'North Korea',
  '447': 'Kuwait', '450': 'Lebanon', '451': 'Kyrgyz Republic', '453': 'Macao',
  '455': 'Maldives', '457': 'Mongolia', '459': 'Nepal', '461': 'Oman',
  '463': 'Pakistan', '466': 'Qatar', '468': 'Syrian Arab Republic', '470': 'United Arab Emirates',
  '473': 'Yemen', '475': 'Yemen', '477': 'Hong Kong', '478': 'Bosnia and Herzegovina',
  '501': 'Adelie Land', '503': 'Australia', '506': 'Myanmar', '508': 'Brunei Darussalam',
  '510': 'Micronesia', '511': 'Palau', '512': 'New Zealand', '514': 'Cambodia',
  '515': 'Cambodia', '516': 'Christmas Island', '518': 'Cook Islands', '520': 'Fiji',
  '523': 'Cocos (Keeling) Islands', '525': 'Indonesia', '529': 'Kiribati', '531': 'Lao People’s Democratic Republic',
  '533': 'Malaysia', '536': 'Northern Mariana Islands', '538': 'Marshall Islands', '540': 'New Caledonia',
  '542': 'Niue', '544': 'Nauru', '546': 'French Polynesia', '548': 'Philippines',
  '553': 'Papua New Guinea', '555': 'Pitcairn Island', '557': 'Solomon Islands', '559': 'American Samoa',
  '561': 'Samoa', '563': 'Singapore', '564': 'Singapore', '565': 'Singapore',
  '567': 'Thailand', '570': 'Tonga', '572': 'Tuvalu', '574': 'Viet Nam',
  '576': 'Vanuatu', '578': 'Wallis and Futuna Islands',
  '601': 'South Africa', '603': 'Angola', '605': 'Algeria', '607': 'Saint Paul and Amsterdam Islands',
  '608': 'Ascension Island', '609': 'Burundi', '610': 'Benin', '611': 'Botswana',
  '612': 'Central African Republic', '613': 'Cameroon', '615': 'Congo (Republic of the)', '616': 'Comoros',
  '617': 'Cape Verde', '618': 'Crozet Archipelago', '619': 'Côte d’Ivoire', '621': 'Djibouti',
  '622': 'Egypt', '624': 'Ethiopia', '625': 'Eritrea', '626': 'Gabonese Republic',
  '627': 'Ghana', '629': 'Gambia', '630': 'Guinea-Bissau', '631': 'Equatorial Guinea',
  '632': 'Guinea', '633': 'Burkina Faso', '634': 'Kenya', '635': 'Kerguelen Islands',
  '636': 'Liberia', '637': 'Liberia', '642': 'Libya', '644': 'Lesotho',
  '645': 'Mauritius', '647': 'Madagascar', '649': 'Mali', '650': 'Mozambique',
  '654': 'Mauritania', '655': 'Malawi', '656': 'Niger', '657': 'Nigeria',
  '659': 'Namibia', '660': 'Reunion', '661': 'Rwanda', '662': 'Sudan',
  '663': 'Senegal', '664': 'Seychelles', '665': 'Saint Helena', '666': 'Somalia',
  '667': 'Sierra Leone', '668': 'Sao Tome and Principe', '669': 'Eswatini', '670': 'Chad',
  '671': 'Togolese Republic', '672': 'Tunisia', '674': 'Tanzania', '675': 'Uganda',
  '676': 'Democratic Republic of the Congo', '677': 'Tanzania', '678': 'Zambia', '679': 'Zimbabwe',
  '701': 'Argentina', '710': 'Brazil', '720': 'Bolivia', '725': 'Chile',
  '730': 'Colombia', '735': 'Ecuador', '740': 'Falkland Islands', '745': 'French Guiana',
  '750': 'Guyana', '755': 'Paraguay', '760': 'Peru', '765': 'Suriname',
  '770': 'Uruguay', '775': 'Venezuela',
});

/**
 * Extracts a valid 3-digit MID from the start of an MMSI, or null if `mmsi`
 * isn't a plausible 9-digit MMSI (wrong length, non-digits) or its first
 * digit indicates a non-MID prefix form — see `describeMmsiPrefix` for those.
 * @param {string|number} mmsi
 * @returns {?string}
 */
export function extractMid(mmsi) {
  if (mmsi === null || mmsi === undefined) return null;
  const digits = String(mmsi).trim();
  if (!/^\d{9}$/.test(digits)) return null;
  const first = digits[0];
  // 0xxxxxxxx = coast station and 8xxxxxxxx = group of ships carry their
  // MID one digit in, not at the start, so a straight first-three-digits
  // read would silently return the wrong (or no) country — excluded here;
  // see `describeMmsiPrefix` for those. (98/99xxxxxxx auxiliary craft and
  // 970/972xxxxxx SAR aircraft/devices need no such exclusion: no MID in
  // the table starts with 9, so the plain lookup below already misses them.)
  if (first === '0' || first === '8') return null;
  const mid = digits.slice(0, 3);
  return MID_TABLE[mid] ? mid : null;
}

/**
 * Resolves an MMSI to its flag state's name, or null if the MMSI is
 * malformed or its MID isn't in the allocation table (unassigned/reserved).
 * @param {string|number} mmsi
 * @returns {?string}
 */
export function getFlagState(mmsi) {
  const mid = extractMid(mmsi);
  return mid ? MID_TABLE[mid] : null;
}

/**
 * Full classification of an MMSI's structural prefix, covering both the
 * ordinary country-MID case and the reserved non-ship-station forms a raw
 * `getFlagState` lookup would otherwise just report as unknown. Useful for
 * a vessel info panel that wants to say *why* no flag applies (e.g. "AIS-SART
 * device", "coast station") instead of leaving a blank.
 * @param {string|number} mmsi
 * @returns {{kind: 'country'|'coastStation'|'groupOfShips'|'auxiliaryCraft'|'sarAircraft'|'unknown', flagState: ?string, mid: ?string}}
 */
export function describeMmsiPrefix(mmsi) {
  const digits = mmsi === null || mmsi === undefined ? '' : String(mmsi).trim();
  if (!/^\d{9}$/.test(digits)) return { kind: 'unknown', flagState: null, mid: null };
  const first = digits[0];
  const first3 = digits.slice(0, 3);
  if (first3 === '970' || first3 === '972') return { kind: 'sarAircraft', flagState: null, mid: null };
  if (first === '0') {
    const mid = digits.slice(1, 4);
    return { kind: 'coastStation', flagState: MID_TABLE[mid] || null, mid: MID_TABLE[mid] ? mid : null };
  }
  if (first === '8') {
    const mid = digits.slice(1, 4);
    return { kind: 'groupOfShips', flagState: MID_TABLE[mid] || null, mid: MID_TABLE[mid] ? mid : null };
  }
  if (first3.startsWith('98') || first3.startsWith('99')) {
    const mid = digits.slice(2, 5);
    return { kind: 'auxiliaryCraft', flagState: MID_TABLE[mid] || null, mid: MID_TABLE[mid] ? mid : null };
  }
  const mid = extractMid(digits);
  return mid ? { kind: 'country', flagState: MID_TABLE[mid], mid } : { kind: 'unknown', flagState: null, mid: null };
}
