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
