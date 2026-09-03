/**
 * Informal place names, normalized.
 *
 * Load posts are written the way people talk -- "philly", "the city", "north
 * jersey", "socal". Normalizing these before geocoding is what turns a
 * WhatsApp message into something a radius query can actually match. Values
 * are either a canonical "City, ST" gazetteer key or a region key from
 * states.ts REGIONS.
 */

export interface Alias {
  /** canonical "City, ST" */
  city?: string;
  /** REGIONS key from states.ts */
  region?: string;
  /** two-letter state, when the alias means the whole state */
  state?: string;
}

export const ALIASES: Record<string, Alias> = {
  // --- metro nicknames ---
  philly: { city: "Philadelphia, PA" },
  philadelphia: { city: "Philadelphia, PA" },
  phila: { city: "Philadelphia, PA" },
  nyc: { city: "New York, NY" },
  "new york city": { city: "New York, NY" },
  "ny city": { city: "New York, NY" },
  manhattan: { city: "New York, NY" },
  "the city": { city: "New York, NY" },
  bk: { city: "Brooklyn, NY" },
  atl: { city: "Atlanta, GA" },
  chi: { city: "Chicago, IL" },
  "chi town": { city: "Chicago, IL" },
  chitown: { city: "Chicago, IL" },
  windy: { city: "Chicago, IL" },
  la: { city: "Los Angeles, CA" },
  "l a": { city: "Los Angeles, CA" },
  lax: { city: "Los Angeles, CA" },
  sf: { city: "San Francisco, CA" },
  "the bay": { city: "San Francisco, CA" },
  "bay area": { city: "San Francisco, CA" },
  vegas: { city: "Las Vegas, NV" },
  "sin city": { city: "Las Vegas, NV" },
  nola: { city: "New Orleans, LA" },
  htown: { city: "Houston, TX" },
  "h town": { city: "Houston, TX" },
  dfw: { city: "Dallas, TX" },
  "dallas fort worth": { city: "Dallas, TX" },
  "big d": { city: "Dallas, TX" },
  motown: { city: "Detroit, MI" },
  "the d": { city: "Detroit, MI" },
  beantown: { city: "Boston, MA" },
  bos: { city: "Boston, MA" },
  dmv: { city: "Washington, DC" },
  dc: { city: "Washington, DC" },
  "d c": { city: "Washington, DC" },
  balt: { city: "Baltimore, MD" },
  bmore: { city: "Baltimore, MD" },
  "b more": { city: "Baltimore, MD" },
  pitt: { city: "Pittsburgh, PA" },
  burgh: { city: "Pittsburgh, PA" },
  "the burgh" : { city: "Pittsburgh, PA" },
  cbus: { city: "Columbus, OH" },
  cincy: { city: "Cincinnati, OH" },
  cleve: { city: "Cleveland, OH" },
  indy: { city: "Indianapolis, IN" },
  nash: { city: "Nashville, TN" },
  "music city": { city: "Nashville, TN" },
  memph: { city: "Memphis, TN" },
  jax: { city: "Jacksonville, FL" },
  "ft lauderdale": { city: "Fort Lauderdale, FL" },
  "fort laud": { city: "Fort Lauderdale, FL" },
  lauderdale: { city: "Fort Lauderdale, FL" },
  "ft myers": { city: "Fort Myers, FL" },
  "west palm": { city: "West Palm Beach, FL" },
  wpb: { city: "West Palm Beach, FL" },
  "the 305": { city: "Miami, FL" },
  slc: { city: "Salt Lake City, UT" },
  abq: { city: "Albuquerque, NM" },
  phx: { city: "Phoenix, AZ" },
  "the valley": { city: "Phoenix, AZ" },
  pdx: { city: "Portland, OR" },
  sea: { city: "Seattle, WA" },
  "sea tac": { city: "Seattle, WA" },
  seatac: { city: "Seattle, WA" },
  msp: { city: "Minneapolis, MN" },
  "twin cities": { city: "Minneapolis, MN" },
  stl: { city: "Saint Louis, MO" },
  "st louis": { city: "Saint Louis, MO" },
  "st. louis": { city: "Saint Louis, MO" },
  kc: { city: "Kansas City, MO" },
  "kansas city mo": { city: "Kansas City, MO" },
  "st paul": { city: "Saint Paul, MN" },
  "st. paul": { city: "Saint Paul, MN" },
  charlotte: { city: "Charlotte, NC" },
  clt: { city: "Charlotte, NC" },
  rdu: { city: "Raleigh, NC" },
  "the triangle": { city: "Raleigh, NC" },
  denv: { city: "Denver, CO" },
  "mile high": { city: "Denver, CO" },
  "elizabeth port": { city: "Elizabeth, NJ" },
  "port elizabeth": { city: "Elizabeth, NJ" },
  "port newark": { city: "Newark, NJ" },
  ewr: { city: "Newark, NJ" },
  jfk: { city: "Queens, NY" },
  ord: { city: "Chicago, IL" },
  "jc": { city: "Jersey City, NJ" },

  // --- sub-state regions ---
  "north jersey": { region: "tristate", state: "NJ" },
  "northern nj": { region: "tristate", state: "NJ" },
  "northern new jersey": { region: "tristate", state: "NJ" },
  "south jersey": { city: "Camden, NJ", state: "NJ" },
  "southern nj": { city: "Camden, NJ", state: "NJ" },
  "central jersey": { city: "Edison, NJ", state: "NJ" },
  "central nj": { city: "Edison, NJ", state: "NJ" },
  jersey: { state: "NJ" },
  "the jerz": { state: "NJ" },
  upstate: { city: "Albany, NY", state: "NY" },
  "upstate ny": { city: "Albany, NY", state: "NY" },
  "long island": { city: "Hempstead, NY", state: "NY" },
  li: { city: "Hempstead, NY", state: "NY" },
  westchester: { city: "Yonkers, NY", state: "NY" },
  "south florida": { city: "Miami, FL", state: "FL" },
  "central florida": { city: "Orlando, FL", state: "FL" },
  "north florida": { city: "Jacksonville, FL", state: "FL" },
  "the panhandle": { city: "Tallahassee, FL", state: "FL" },
  socal: { city: "Los Angeles, CA", state: "CA" },
  "so cal": { city: "Los Angeles, CA", state: "CA" },
  "southern cal": { city: "Los Angeles, CA", state: "CA" },
  "southern california": { city: "Los Angeles, CA", state: "CA" },
  norcal: { city: "San Francisco, CA", state: "CA" },
  "nor cal": { city: "San Francisco, CA", state: "CA" },
  "northern california": { city: "San Francisco, CA", state: "CA" },
  "inland empire": { city: "Riverside, CA", state: "CA" },
  "central valley": { city: "Fresno, CA", state: "CA" },
  "west texas": { city: "Lubbock, TX", state: "TX" },
  "east texas": { city: "Dallas, TX", state: "TX" },
  "south texas": { city: "San Antonio, TX", state: "TX" },
  "rgv": { city: "McAllen, TX", state: "TX" },
  "the valley tx": { city: "McAllen, TX", state: "TX" },
  "lehigh valley": { city: "Allentown, PA", state: "PA" },
  poconos: { city: "Hazleton, PA", state: "PA" },
  "western pa": { city: "Pittsburgh, PA", state: "PA" },
  "eastern pa": { city: "Allentown, PA", state: "PA" },
  "central pa": { city: "Harrisburg, PA", state: "PA" },
  "the lv": { city: "Allentown, PA", state: "PA" },
  "new england": { region: "newengland" },
  northeast: { region: "northeast" },
  "the northeast": { region: "northeast" },
  "mid atlantic": { region: "midatlantic" },
  midatlantic: { region: "midatlantic" },
  southeast: { region: "southeast" },
  "the southeast": { region: "southeast" },
  midwest: { region: "midwest" },
  "the midwest": { region: "midwest" },
  southwest: { region: "southwest" },
  "west coast": { region: "westcoast" },
  "the west coast": { region: "westcoast" },
  pnw: { region: "northwest" },
  "pacific northwest": { region: "northwest" },
  "tri state": { region: "tristate" },
  tristate: { region: "tristate" },
  "tri state area": { region: "tristate" },
};

/** Strip filler so "the philly area" and "Philly" hit the same alias. */
export function normalizePlaceQuery(input: string): string {
  return input
    .toLowerCase()
    .replace(/[.’']/g, "")
    .replace(/\b(area|region|metro|surrounding|greater|downtown|outside of|outside|near|around)\b/g, " ")
    .replace(/[^a-z0-9,\- ]/g, " ")
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
}

export function lookupAlias(normalized: string): Alias | null {
  return ALIASES[normalized] ?? ALIASES[normalized.replace(/,/g, "")] ?? null;
}
