/**
 * Session types and sign-in URL helpers that are safe to import from client
 * components: no database, no `next/headers`, no node built-ins.
 *
 * `src/lib/auth.ts` re-exports `Role` and `SessionUser` from here for the
 * server side; client code (Board, ContactGate, AuthForm) imports from
 * `@/lib/session` directly.
 */

/**
 * driver exists only to pass the contact gate (see the phone number on a job);
 * poster posts jobs from the website; admin runs the consoles.
 */
export type Role = "driver" | "poster" | "admin";

export interface SessionUser {
  id: number;
  email: string;
  name: string;
  role: Role;
  phone: string | null;
  company: string | null;
}

export const ROLE_LABEL: Record<Role, string> = {
  driver: "Driver",
  poster: "Poster",
  admin: "Admin",
};

/** Any origin will do -- it only has to be one no real destination can match. */
const SAME_ORIGIN = "http://loadline.invalid";

/**
 * Only same-origin app paths may be used as a post-login destination.
 *
 * A leading "//" is not the only way to write a scheme-relative URL, so a
 * prefix test is not enough: URL parsers fold a backslash into a slash for
 * http(s) and strip C0 controls before parsing, which makes "/\evil.com" and
 * "/<TAB>/evil.com" resolve off-origin exactly like "//evil.com". Resolving the
 * value the way the browser will is the only check that covers all three.
 */
export function isSafeNext(next: string | null | undefined): next is string {
  if (typeof next !== "string") return false;
  if (!next.startsWith("/") || next.startsWith("/api") || next.length > 2000) return false;
  try {
    return new URL(next, SAME_ORIGIN).origin === SAME_ORIGIN;
  } catch {
    return false;
  }
}

/** `"/login"` or `"/login?next=%2Fjobs%2F42%3FpickupState%3DFL"`. */
export function loginHref(next?: string | null): string {
  return isSafeNext(next) ? `/login?next=${encodeURIComponent(next)}` : "/login";
}

/** `"/register?as=driver"` or `"/register?as=driver&next=%2Fjobs%2F42"`. */
export function registerHref(as: "driver" | "poster", next?: string | null): string {
  const base = `/register?as=${as}`;
  return isSafeNext(next) ? `${base}&next=${encodeURIComponent(next)}` : base;
}
