/**
 * Values shared by client and server code.
 *
 * Kept apart from searchParams.ts on purpose: that module reaches the geocoder
 * and therefore the database driver, and importing it from a client component
 * would drag `pg` into the browser bundle.
 */
export const RADIUS_OPTIONS = [10, 25, 50, 100, 250] as const;

export const CORRIDOR_OPTIONS = [25, 50, 75, 100, 150] as const;

export const LOAD_TYPES = [
  "dry van",
  "reefer",
  "flatbed",
  "step deck",
  "box truck",
  "sprinter",
  "hotshot",
  "power only",
  "container",
] as const;
