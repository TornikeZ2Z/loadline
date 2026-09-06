/**
 * US state reference data: names, geographic centers, and ZIP prefix ranges.
 *
 * The ZIP ranges let us answer "which state is 07102 in?" and "roughly where
 * is 33101?" with no network call, which is what makes the offline geocoder
 * usable as the default. They are the published USPS prefix allocations --
 * good enough to place a ZIP in a state and near a metro, and always replaced
 * by exact coordinates when a real geocoder is configured.
 */

export interface StateInfo {
  abbr: string;
  name: string;
  lat: number;
  lng: number;
  /** Inclusive first-3-digit ZIP ranges belonging to this state. */
  zip3: Array<[number, number]>;
}

export const STATES: StateInfo[] = [
  { abbr: "AL", name: "Alabama", lat: 32.806, lng: -86.791, zip3: [[350, 369]] },
  { abbr: "AK", name: "Alaska", lat: 61.37, lng: -152.404, zip3: [[995, 999]] },
  { abbr: "AZ", name: "Arizona", lat: 33.729, lng: -111.431, zip3: [[850, 865]] },
  { abbr: "AR", name: "Arkansas", lat: 34.97, lng: -92.373, zip3: [[716, 729]] },
  { abbr: "CA", name: "California", lat: 36.116, lng: -119.682, zip3: [[900, 961]] },
  { abbr: "CO", name: "Colorado", lat: 39.059, lng: -105.311, zip3: [[800, 816]] },
  { abbr: "CT", name: "Connecticut", lat: 41.598, lng: -72.755, zip3: [[60, 69]] },
  { abbr: "DE", name: "Delaware", lat: 39.319, lng: -75.507, zip3: [[197, 199]] },
  { abbr: "DC", name: "District of Columbia", lat: 38.897, lng: -77.026, zip3: [[200, 205], [569, 569]] },
  { abbr: "FL", name: "Florida", lat: 27.766, lng: -81.686, zip3: [[320, 349]] },
  { abbr: "GA", name: "Georgia", lat: 33.04, lng: -83.643, zip3: [[300, 319], [398, 399]] },
  { abbr: "HI", name: "Hawaii", lat: 21.094, lng: -157.498, zip3: [[967, 968]] },
  { abbr: "ID", name: "Idaho", lat: 44.24, lng: -114.478, zip3: [[832, 838]] },
  { abbr: "IL", name: "Illinois", lat: 40.349, lng: -88.986, zip3: [[600, 629]] },
  { abbr: "IN", name: "Indiana", lat: 39.849, lng: -86.258, zip3: [[460, 479]] },
  { abbr: "IA", name: "Iowa", lat: 42.011, lng: -93.21, zip3: [[500, 528]] },
  { abbr: "KS", name: "Kansas", lat: 38.526, lng: -96.726, zip3: [[660, 679]] },
  { abbr: "KY", name: "Kentucky", lat: 37.668, lng: -84.67, zip3: [[400, 427]] },
  { abbr: "LA", name: "Louisiana", lat: 31.169, lng: -91.868, zip3: [[700, 714]] },
  { abbr: "ME", name: "Maine", lat: 44.694, lng: -69.381, zip3: [[39, 49]] },
  { abbr: "MD", name: "Maryland", lat: 39.064, lng: -76.802, zip3: [[206, 219]] },
  { abbr: "MA", name: "Massachusetts", lat: 42.23, lng: -71.53, zip3: [[10, 27], [55, 55]] },
  { abbr: "MI", name: "Michigan", lat: 43.326, lng: -84.536, zip3: [[480, 499]] },
  { abbr: "MN", name: "Minnesota", lat: 45.694, lng: -93.9, zip3: [[550, 567]] },
  { abbr: "MS", name: "Mississippi", lat: 32.741, lng: -89.678, zip3: [[386, 397]] },
  { abbr: "MO", name: "Missouri", lat: 38.456, lng: -92.288, zip3: [[630, 658]] },
  { abbr: "MT", name: "Montana", lat: 46.921, lng: -110.454, zip3: [[590, 599]] },
  { abbr: "NE", name: "Nebraska", lat: 41.125, lng: -98.268, zip3: [[680, 693]] },
  { abbr: "NV", name: "Nevada", lat: 38.313, lng: -117.055, zip3: [[889, 898]] },
  { abbr: "NH", name: "New Hampshire", lat: 43.452, lng: -71.564, zip3: [[30, 38]] },
  { abbr: "NJ", name: "New Jersey", lat: 40.298, lng: -74.521, zip3: [[70, 89]] },
  { abbr: "NM", name: "New Mexico", lat: 34.841, lng: -106.249, zip3: [[870, 884]] },
  // 005 (Holtsville) is New York; 006-009 are Puerto Rico.
  { abbr: "NY", name: "New York", lat: 42.166, lng: -74.948, zip3: [[100, 149], [5, 5]] },
  { abbr: "NC", name: "North Carolina", lat: 35.63, lng: -79.807, zip3: [[270, 289]] },
  { abbr: "ND", name: "North Dakota", lat: 47.529, lng: -99.784, zip3: [[580, 588]] },
  { abbr: "OH", name: "Ohio", lat: 40.389, lng: -82.765, zip3: [[430, 459]] },
  { abbr: "OK", name: "Oklahoma", lat: 35.565, lng: -96.929, zip3: [[730, 749]] },
  { abbr: "OR", name: "Oregon", lat: 44.572, lng: -122.071, zip3: [[970, 979]] },
  { abbr: "PA", name: "Pennsylvania", lat: 40.59, lng: -77.209, zip3: [[150, 196]] },
  { abbr: "RI", name: "Rhode Island", lat: 41.68, lng: -71.512, zip3: [[28, 29]] },
  { abbr: "SC", name: "South Carolina", lat: 33.856, lng: -80.945, zip3: [[290, 299]] },
  { abbr: "SD", name: "South Dakota", lat: 44.299, lng: -99.439, zip3: [[570, 577]] },
  { abbr: "TN", name: "Tennessee", lat: 35.747, lng: -86.692, zip3: [[370, 385]] },
  { abbr: "TX", name: "Texas", lat: 31.054, lng: -97.563, zip3: [[750, 799], [885, 885]] },
  { abbr: "UT", name: "Utah", lat: 40.15, lng: -111.862, zip3: [[840, 847]] },
  { abbr: "VT", name: "Vermont", lat: 44.045, lng: -72.71, zip3: [[50, 54], [56, 59]] },
  { abbr: "VA", name: "Virginia", lat: 37.769, lng: -78.17, zip3: [[220, 246], [201, 201]] },
  { abbr: "WA", name: "Washington", lat: 47.4, lng: -121.49, zip3: [[980, 994]] },
  { abbr: "WV", name: "West Virginia", lat: 38.492, lng: -80.954, zip3: [[247, 268]] },
  { abbr: "WI", name: "Wisconsin", lat: 44.268, lng: -89.616, zip3: [[530, 549]] },
  { abbr: "WY", name: "Wyoming", lat: 42.756, lng: -107.302, zip3: [[820, 831]] },
  { abbr: "PR", name: "Puerto Rico", lat: 18.22, lng: -66.59, zip3: [[6, 9]] },
];

export const STATE_BY_ABBR = new Map(STATES.map((s) => [s.abbr, s]));
export const STATE_BY_NAME = new Map(STATES.map((s) => [s.name.toLowerCase(), s]));

/**
 * Which state owns a ZIP code. Returns null for malformed input.
 *
 * The NARROWEST matching zip3 range wins. The published allocations overlap:
 * DC is 200-205 while northern Virginia's 201 sits inside it, so a first-match
 * walk in table order read every 201xx ZIP (Ashburn, Sterling, Purcellville)
 * as Washington. The width-0 VA range beats the width-5 DC one.
 */
export function stateForZip(zip: string): StateInfo | null {
  const digits = zip.replace(/\D/g, "");
  if (digits.length < 5) return null;
  const prefix = Number(digits.slice(0, 3));
  let best: StateInfo | null = null;
  let bestWidth = Infinity;
  for (const state of STATES) {
    for (const [lo, hi] of state.zip3) {
      if (prefix >= lo && prefix <= hi && hi - lo < bestWidth) {
        best = state;
        bestWidth = hi - lo;
      }
    }
  }
  return best;
}

/** "new jersey" | "nj" | "N.J." -> StateInfo */
export function resolveState(text: string): StateInfo | null {
  const t = text.trim().toLowerCase().replace(/\./g, "");
  if (t.length === 2) return STATE_BY_ABBR.get(t.toUpperCase()) ?? null;
  return STATE_BY_NAME.get(t) ?? null;
}

/**
 * Multi-state regions freight people actually say. Radius searches against
 * these use the centroid; state filters expand to the member list.
 */
export const REGIONS: Record<string, { label: string; states: string[]; lat: number; lng: number }> = {
  northeast: { label: "Northeast", states: ["ME", "NH", "VT", "MA", "RI", "CT", "NY", "NJ", "PA"], lat: 41.5, lng: -73.5 },
  midatlantic: { label: "Mid-Atlantic", states: ["NY", "NJ", "PA", "DE", "MD", "DC", "VA"], lat: 39.5, lng: -76.5 },
  southeast: { label: "Southeast", states: ["VA", "NC", "SC", "GA", "FL", "AL", "MS", "TN", "KY"], lat: 33.0, lng: -82.5 },
  midwest: { label: "Midwest", states: ["OH", "MI", "IN", "IL", "WI", "MN", "IA", "MO", "KS", "NE", "ND", "SD"], lat: 41.5, lng: -89.0 },
  southwest: { label: "Southwest", states: ["TX", "OK", "NM", "AZ", "NV"], lat: 33.0, lng: -103.0 },
  westcoast: { label: "West Coast", states: ["CA", "OR", "WA"], lat: 40.0, lng: -121.0 },
  northwest: { label: "Pacific Northwest", states: ["WA", "OR", "ID"], lat: 45.5, lng: -120.5 },
  newengland: { label: "New England", states: ["ME", "NH", "VT", "MA", "RI", "CT"], lat: 43.5, lng: -71.0 },
  tristate: { label: "Tri-State Area", states: ["NY", "NJ", "CT"], lat: 40.9, lng: -74.0 },
};
