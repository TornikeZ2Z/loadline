/**
 * Values shared by client and server code.
 *
 * Kept apart from searchParams.ts on purpose: that module reaches the geocoder
 * and therefore the database driver, and importing it from a client component
 * would drag `pg` into the browser bundle.
 *
 * Size constants (TRUCK_CF, CF_PRESETS) live in @/lib/moving/cubicFeet; the UI
 * option tables (SORT_OPTIONS, READY_OPTIONS, SEEN_OPTIONS, TAG_LABELS) live in
 * @/lib/loads/present. Region tokens for the state pickers come from REGIONS in
 * @/lib/geo/states.
 */
export const RADIUS_OPTIONS = [10, 25, 50, 100, 250] as const;

export const CORRIDOR_OPTIONS = [25, 50, 75, 100, 150] as const;

/**
 * How far off their line a driver will swing for a job, as offered on the truck
 * posting form -- the only matcher knob a human sets (SPEC §9).
 *
 * A truck-specific list rather than `CORRIDOR_OPTIONS` itself, and the
 * difference is the 60. The specification asks for a select "over
 * CORRIDOR_OPTIONS (25/50/75/100/150)" and, in the same row of the same table,
 * for a default of 60 -- which is not in that list, and IS the default the
 * schema gives `trucks.corridor_miles`. Adding 60 to `CORRIDOR_OPTIONS` would
 * have changed the job board's shipped corridor control to fix a truck form;
 * defaulting to 50 or 75 instead would have made the schema's default a number
 * no posting could produce. So the truck form gets its own list, which is that
 * one plus its own default.
 */
export const DEFAULT_TRUCK_CORRIDOR_MILES = 60;

export const TRUCK_CORRIDOR_OPTIONS = [25, 50, DEFAULT_TRUCK_CORRIDOR_MILES, 75, 100, 150] as const;
