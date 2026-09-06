/**
 * Values shared by client and server code.
 *
 * Kept apart from searchParams.ts on purpose: that module reaches the geocoder
 * and therefore the database driver, and importing it from a client component
 * would drag `pg` into the browser bundle.
 *
 * Only the two radius tables live here. `TRUCK_CF` / `CF_PRESETS` are in
 * `@/lib/moving/cubicFeet`; every UI option table (sort, ready, seen-days,
 * tag labels) is C's, in `@/lib/loads/present`.
 */
export const RADIUS_OPTIONS = [10, 25, 50, 100, 250] as const;

export const CORRIDOR_OPTIONS = [25, 50, 75, 100, 150] as const;
