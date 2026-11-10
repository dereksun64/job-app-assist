/**
 * Reading Posting locations and placing them in the Candidate's Location Tiers.
 * Sources write locations loosely ("SF", "NYC", "Remote in USA") and the Job Feed runs
 * multi-location lists together ("5 locationsBoston, MASeattle, WA..."), so locations are
 * parsed into places first, then matched against each Location Tier entry.
 */
import type { LocationTier } from "../contract/index.ts";

export interface Place {
  /** How the dashboard shows the place, for example "New York, NY". */
  label: string;
  city?: string;
  /** A US state or Canadian province code. */
  region?: string;
  /** "US" for the United States, otherwise the country's name as commonly written. */
  country?: string;
  remote: boolean;
}

const US_STATES: Record<string, string> = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  DC: "District of Columbia",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  PR: "Puerto Rico",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
};
const STATE_BY_NAME = new Map(
  Object.entries(US_STATES).map(([code, name]) => [name.toLowerCase(), code]),
);
const CANADIAN_PROVINCES = new Set([
  "AB",
  "BC",
  "MB",
  "NB",
  "NL",
  "NS",
  "NT",
  "NU",
  "ON",
  "PE",
  "QC",
  "SK",
  "YT",
]);

/** Country spellings mapped to the name a place records. */
const COUNTRIES: Record<string, string> = {
  "united states of america": "US",
  "united states": "US",
  usa: "US",
  us: "US",
  canada: "Canada",
  "united kingdom": "UK",
  uk: "UK",
  england: "UK",
  scotland: "UK",
  ireland: "Ireland",
  netherlands: "Netherlands",
  germany: "Germany",
  france: "France",
  switzerland: "Switzerland",
  spain: "Spain",
  poland: "Poland",
  israel: "Israel",
  india: "India",
  europe: "Europe",
  belgium: "Belgium",
  singapore: "Singapore",
  japan: "Japan",
  china: "China",
  "hong kong": "Hong Kong",
  taiwan: "Taiwan",
  australia: "Australia",
  mexico: "Mexico",
  brazil: "Brazil",
};

/** Shorthand the Job Feed uses for a few cities. */
const SHORTHAND: Record<string, { city: string; region: string }> = {
  "South SF": { city: "South San Francisco", region: "CA" },
  SF: { city: "San Francisco", region: "CA" },
  NYC: { city: "New York", region: "NY" },
  LA: { city: "Los Angeles", region: "CA" },
  DC: { city: "Washington", region: "DC" },
};
const CITY_ALIASES: Record<string, string> = {
  "new york city": "New York",
  manhattan: "New York",
  "san fransisco": "San Francisco",
};

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const longestFirst = (names: Iterable<string>) =>
  [...names]
    .sort((a, b) => b.length - a.length)
    .map(escape)
    .join("|");

const COUNTRY_NAMES = longestFirst(
  Object.keys(COUNTRIES).map((name) =>
    name.length <= 3 ? name.toUpperCase() : name.replace(/\b\w/g, (c) => c.toUpperCase()),
  ),
);
const STATE_NAMES = longestFirst(Object.values(US_STATES));
/** One place-name word, allowing McLean, O'Fallon and Winston-Salem. */
const WORD = "(?:Mc|Mac|O')?\\p{Lu}[\\p{Ll}.'\u2019]*(?:-(?:\\p{Lu}\\p{Ll}+|on|upon|by|le|sur))*";
/** Several words, allowing lowercase joiners and short capitals inside (Eglin AFB). */
const WORDS = `${WORD}(?: (?:${WORD}|[A-Z]{2,4}|upon|on|of|and|de|du|des|la|le|del|el))*`;
/** Region codes the City, ST pattern accepts: US states, Canadian provinces and UK. */
const REGION_CODES = longestFirst([...Object.keys(US_STATES), ...CANADIAN_PROVINCES, "UK"]);

const PATTERNS: { re: RegExp; read: (m: RegExpExecArray) => Place }[] = [
  {
    re: new RegExp(`Remote(?:(?: in | - |, | \\(| ?)(${COUNTRY_NAMES})\\)?)?(?!\\p{Ll})`, "uy"),
    read: (m) => remotePlace(m[1]),
  },
  {
    // City, ST or City, ST, Country, after any leading parts such as a county.
    re: new RegExp(
      `((?:${WORDS}, )*)(${WORDS}), (${REGION_CODES})(?:, (${COUNTRY_NAMES}))?(?!\\p{Ll})`,
      "uy",
    ),
    read: (m) => cityPlace(m[2] ?? "", m[3] ?? "", m[4]),
  },
  {
    re: new RegExp(`(${WORDS}), (${COUNTRY_NAMES})(?!\\p{Ll})`, "uy"),
    read: (m) => cityInCountry(m[1] ?? "", m[2] ?? ""),
  },
  {
    re: new RegExp(`(${longestFirst(Object.keys(SHORTHAND))})(?!\\p{Ll})`, "uy"),
    read: (m) => {
      const { city, region } = SHORTHAND[m[1] ?? ""] ?? { city: "", region: "" };
      return usCity(city, region);
    },
  },
  {
    re: new RegExp(`(${STATE_NAMES})(?!\\p{Ll})`, "uy"),
    read: (m) => {
      const name = m[1] ?? "";
      const code = STATE_BY_NAME.get(name.toLowerCase()) ?? "";
      return { label: name, region: code, country: "US", remote: false };
    },
  },
  {
    re: new RegExp(`(${COUNTRY_NAMES})(?!\\p{Ll})`, "uy"),
    read: (m) => ({ label: m[1] ?? "", country: countryOf(m[1]) ?? m[1] ?? "", remote: false }),
  },
  {
    // A lone place name, such as "Chicago" or "Montréal", with nothing after it.
    re: new RegExp(`(${WORDS})$`, "uy"),
    read: (m) => ({ label: m[1] ?? "", city: m[1] ?? "", remote: false }),
  },
];

function countryOf(written: string | undefined): string | undefined {
  return written === undefined ? undefined : COUNTRIES[written.toLowerCase()];
}

function remotePlace(country: string | undefined): Place {
  const place: Place = { label: country ? `Remote in ${country}` : "Remote", remote: true };
  const code = countryOf(country);
  if (code) place.country = code;
  return place;
}

function usCity(city: string, region: string): Place {
  const name = CITY_ALIASES[city.toLowerCase()] ?? city;
  return { label: `${name}, ${region}`, city: name, region, country: "US", remote: false };
}

function cityPlace(city: string, code: string, country: string | undefined): Place {
  const countryCode = countryOf(country);
  if (code in US_STATES && (countryCode === undefined || countryCode === "US")) {
    return usCity(city, code);
  }
  if (CANADIAN_PROVINCES.has(code) && (countryCode === undefined || countryCode === "Canada")) {
    return {
      label: `${city}, ${code}, Canada`,
      city,
      region: code,
      country: "Canada",
      remote: false,
    };
  }
  const written = countryCode === undefined ? code : (country ?? code);
  const place: Place = { label: `${city}, ${written}`, city, remote: false };
  const resolved = countryCode ?? countryOf(code);
  if (resolved) place.country = resolved;
  return place;
}

function cityInCountry(city: string, country: string): Place {
  const code = countryOf(country);
  const state = code === "US" ? STATE_BY_NAME.get(city.toLowerCase()) : undefined;
  if (state) return { label: city, region: state, country: "US", remote: false };
  const place: Place = { label: `${city}, ${country}`, city, remote: false };
  if (code) place.country = code;
  return place;
}

/** Reads one Source location string into the places it names, in order and without repeats. */
export function parseLocations(raw: string): Place[] {
  const text = raw
    .replace(/^\s*\d+\s+locations?/i, "")
    .replace(/\s*\+\d+\s*$/, "")
    .replace(/\bD\.C\./g, "DC")
    .replace(/\s+/g, " ")
    .trim();
  const places: Place[] = [];
  let at = 0;
  while (at < text.length) {
    if (" ;|/,-()".includes(text[at] ?? "")) {
      at += 1;
      continue;
    }
    let matched = false;
    for (const { re, read } of PATTERNS) {
      re.lastIndex = at;
      const m = re.exec(text);
      if (m && m[0].length > 0) {
        places.push(read(m));
        at += m[0].length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      // Unreadable text stays as written, so the Candidate still sees it.
      places.push({ label: text.slice(at).trim(), remote: false });
      break;
    }
  }
  const seen = new Set<string>();
  return places.filter((place) => {
    if (place.label === "" || seen.has(place.label)) return false;
    seen.add(place.label);
    return true;
  });
}

const BAY_AREA = [
  "San Francisco",
  "South San Francisco",
  "Oakland",
  "Berkeley",
  "Emeryville",
  "Alameda",
  "San Jose",
  "Santa Clara",
  "Sunnyvale",
  "Mountain View",
  "Palo Alto",
  "East Palo Alto",
  "Menlo Park",
  "Redwood City",
  "Redwood Shores",
  "San Mateo",
  "Foster City",
  "Burlingame",
  "San Bruno",
  "San Carlos",
  "Belmont",
  "Millbrae",
  "Daly City",
  "Brisbane",
  "Cupertino",
  "Los Gatos",
  "Campbell",
  "Milpitas",
  "Fremont",
  "Newark",
  "Union City",
  "Hayward",
  "San Leandro",
  "Pleasanton",
  "Dublin",
  "Livermore",
  "San Ramon",
  "Walnut Creek",
  "Concord",
  "Richmond",
  "Sausalito",
  "San Rafael",
  "Novato",
  "Los Altos",
  "Saratoga",
  "Morgan Hill",
];
const NORTHERN_CALIFORNIA_EXTRA = [
  "Sacramento",
  "Davis",
  "Roseville",
  "Folsom",
  "Rancho Cordova",
  "Rocklin",
  "Santa Cruz",
  "Scotts Valley",
  "Santa Rosa",
  "Petaluma",
  "Napa",
  "Vallejo",
  "Stockton",
  "Modesto",
  "Tracy",
  "Monterey",
  "Salinas",
  "Chico",
  "Redding",
  "Truckee",
  "Gilroy",
];
const LOS_ANGELES_AREA = [
  "Los Angeles",
  "Santa Monica",
  "Culver City",
  "Venice",
  "Playa Vista",
  "Marina del Rey",
  "El Segundo",
  "Hawthorne",
  "Manhattan Beach",
  "Redondo Beach",
  "Torrance",
  "Long Beach",
  "Pasadena",
  "Glendale",
  "Burbank",
  "Beverly Hills",
  "West Hollywood",
  "Hollywood",
  "Inglewood",
  "Carson",
  "Northridge",
  "Van Nuys",
  "Woodland Hills",
  "Calabasas",
  "Sherman Oaks",
  "Universal City",
  "Thousand Oaks",
  "Westlake Village",
  "Agoura Hills",
];
const SOUTHERN_CALIFORNIA_EXTRA = [
  "Irvine",
  "Costa Mesa",
  "Newport Beach",
  "Santa Ana",
  "Anaheim",
  "Orange",
  "Fullerton",
  "Huntington Beach",
  "Tustin",
  "Lake Forest",
  "Aliso Viejo",
  "Mission Viejo",
  "Laguna Hills",
  "San Diego",
  "La Jolla",
  "Carlsbad",
  "Oceanside",
  "Escondido",
  "Chula Vista",
  "Del Mar",
  "Riverside",
  "San Bernardino",
  "Ontario",
  "Rancho Cucamonga",
  "Corona",
  "Temecula",
  "Santa Barbara",
  "Goleta",
  "Ventura",
  "Oxnard",
  "Camarillo",
  "Simi Valley",
  "Moorpark",
  "Palmdale",
  "Lancaster",
  "Santa Clarita",
  "Valencia",
];
const NEW_YORK_CITY = [
  "New York",
  "Brooklyn",
  "Queens",
  "Bronx",
  "Staten Island",
  "Long Island City",
];
const BOSTON_AREA = [
  "Boston",
  "Cambridge",
  "Somerville",
  "Brookline",
  "Newton",
  "Watertown",
  "Waltham",
  "Lexington",
  "Burlington",
  "Bedford",
  "Woburn",
  "Medford",
  "Quincy",
  "Needham",
  "Wellesley",
  "Dedham",
  "Framingham",
  "Natick",
  "Marlborough",
  "Andover",
  "North Reading",
  "Wilmington",
  "Billerica",
  "Chelmsford",
  "Westford",
  "Westborough",
  "Dorchester",
  "Charlestown",
  "Revere",
];
const SEATTLE_AREA = [
  "Seattle",
  "Bellevue",
  "Redmond",
  "Kirkland",
  "Bothell",
  "Renton",
  "Issaquah",
  "Sammamish",
  "Woodinville",
  "Everett",
  "Lynnwood",
  "Tacoma",
  "Kent",
  "Tukwila",
  "Mercer Island",
];
const EAST_COAST = [
  "ME",
  "NH",
  "VT",
  "MA",
  "RI",
  "CT",
  "NY",
  "NJ",
  "PA",
  "DE",
  "MD",
  "DC",
  "VA",
  "NC",
  "SC",
  "GA",
  "FL",
];
const WEST_COAST = ["CA", "OR", "WA"];

type Matcher = (place: Place) => boolean;

const inCities = (state: string, cities: readonly string[]): Matcher => {
  const names = new Set(cities.map((c) => c.toLowerCase()));
  return (place) => place.region === state && names.has(place.city?.toLowerCase() ?? "");
};
const inStates = (states: readonly string[]): Matcher => {
  const codes = new Set(states);
  return (place) => place.country === "US" && codes.has(place.region ?? "");
};

const bayArea = inCities("CA", BAY_AREA);
const REGIONS: Record<string, Matcher> = {
  "san francisco bay area": bayArea,
  "sf bay area": bayArea,
  "bay area": bayArea,
  "silicon valley": bayArea,
  "northern california": inCities("CA", [...BAY_AREA, ...NORTHERN_CALIFORNIA_EXTRA]),
  norcal: inCities("CA", [...BAY_AREA, ...NORTHERN_CALIFORNIA_EXTRA]),
  "southern california": inCities("CA", [...LOS_ANGELES_AREA, ...SOUTHERN_CALIFORNIA_EXTRA]),
  socal: inCities("CA", [...LOS_ANGELES_AREA, ...SOUTHERN_CALIFORNIA_EXTRA]),
  "los angeles": inCities("CA", LOS_ANGELES_AREA),
  la: inCities("CA", LOS_ANGELES_AREA),
  "new york city": inCities("NY", NEW_YORK_CITY),
  nyc: inCities("NY", NEW_YORK_CITY),
  boston: inCities("MA", BOSTON_AREA),
  seattle: inCities("WA", SEATTLE_AREA),
  "east coast": inStates(EAST_COAST),
  "west coast": inStates(WEST_COAST),
  // Plain "Remote" means remote from the US or with no country given; "Remote in UK" is its own entry.
  remote: (place) => place.remote && (place.country === undefined || place.country === "US"),
};

/** Turns one Location Tier entry, as the Candidate wrote it, into a test for places. */
function matcherFor(entry: string): Matcher {
  const written = entry
    .toLowerCase()
    .replace(/^(the )?(rest of (the )?|greater |anywhere in (the )?)/, "")
    .trim();
  const key = REGIONS[written] ? written : written.replace(/ (area|metro|region)$/, "");
  const region = REGIONS[key];
  if (region) return region;
  const state =
    STATE_BY_NAME.get(key) ??
    (/^[a-z]{2}$/.test(key) && key.toUpperCase() in US_STATES ? key.toUpperCase() : undefined);
  if (state) return inStates([state]);
  const country = COUNTRIES[key];
  if (country) return (place) => place.country === country;

  const [parsed] = parseLocations(entry);
  if (parsed?.remote) {
    const within = parsed.country;
    return (place) => place.remote && place.country === within;
  }
  if (parsed?.city !== undefined) {
    const city = parsed.city.toLowerCase();
    const { region: within, country: inCountry } = parsed;
    return (place) =>
      place.city?.toLowerCase() === city &&
      (within === undefined || place.region === within) &&
      (inCountry === undefined || place.country === inCountry);
  }
  return (place) => place.city?.toLowerCase() === key || place.label.toLowerCase() === key;
}

const matcherCache = new Map<string, Matcher>();
function cachedMatcher(entry: string): Matcher {
  let matcher = matcherCache.get(entry);
  if (!matcher) {
    matcher = matcherFor(entry);
    matcherCache.set(entry, matcher);
  }
  return matcher;
}

/** The best (lowest-numbered) Location Tier any of the places falls in, counting from 1. */
export function locationTierOf(
  places: readonly Place[],
  tiers: readonly LocationTier[],
): number | undefined {
  const index = tiers.findIndex((tier) =>
    tier.locations.some((entry) => places.some(cachedMatcher(entry))),
  );
  return index === -1 ? undefined : index + 1;
}

/** Location Tier entries that matched none of the places, so Refresh can point them out. */
export function unmatchedTierLocations(
  places: readonly Place[],
  tiers: readonly LocationTier[],
): string[] {
  return tiers
    .flatMap((tier) => tier.locations)
    .filter((entry) => !places.some(cachedMatcher(entry)));
}
