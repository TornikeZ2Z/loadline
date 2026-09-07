/**
 * Authentication: scrypt password hashing plus a signed, stateless session
 * cookie. No dependencies beyond node:crypto -- there is no session table to
 * keep, and nothing to leak if the cookie is stolen beyond the session itself.
 */
import { cookies } from "next/headers";
import crypto from "node:crypto";
import { queryOne } from "@/lib/db";
import type { Role, SessionUser } from "./session";

export { hashPassword, verifyPassword } from "@/lib/password";
// `Role` and `SessionUser` live in the client-safe `./session`; re-exported here
// so server code keeps importing them from `@/lib/auth`.
export type { Role, SessionUser } from "./session";
export { isAdminActor } from "./session";

const COOKIE = "lb_session";
const SESSION_DAYS = 30;

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("SESSION_SECRET must be set to 32+ random bytes in production");
    }
    return "insecure-development-secret-do-not-ship";
  }
  return s;
}

// --- sessions ----------------------------------------------------------------

function sign(payload: string): string {
  return crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
}

function encode(userId: number): string {
  const expires = Date.now() + SESSION_DAYS * 86_400_000;
  const payload = `${userId}.${expires}`;
  return `${payload}.${sign(payload)}`;
}

function decode(token: string | undefined): number | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [idPart, expiresPart, mac] = parts;
  const payload = `${idPart}.${expiresPart}`;
  const expected = sign(payload);
  // Compare BYTE lengths, not UTF-16 code units: timingSafeEqual throws when the
  // buffers differ in byte length, and a 43-character MAC carrying a multi-byte
  // character is 43 code units but more than 43 bytes. A cookie is untrusted
  // input, so that throw would 500 every page instead of returning null.
  const actualBytes = Buffer.from(mac);
  const expectedBytes = Buffer.from(expected);
  if (
    actualBytes.length !== expectedBytes.length ||
    !crypto.timingSafeEqual(actualBytes, expectedBytes)
  ) {
    return null;
  }
  if (Number(expiresPart) < Date.now()) return null;
  const id = Number(idPart);
  return Number.isFinite(id) ? id : null;
}

export async function startSession(userId: number): Promise<void> {
  const jar = await cookies();
  jar.set(COOKIE, encode(userId), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_DAYS * 86_400,
  });
}

export async function endSession(): Promise<void> {
  const jar = await cookies();
  jar.delete(COOKIE);
}

export async function getCurrentUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  const id = decode(jar.get(COOKIE)?.value);
  if (id == null) return null;
  return queryOne<SessionUser>(
    `SELECT id, email, name, role, phone, company,
            can_post AS "canPost", is_demo AS "isDemo"
       FROM users WHERE id = $1`,
    [id],
  );
}

/** Throws a 401-shaped error for API routes. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) throw new HttpError(401, "Sign in to continue");
  return user;
}

/**
 * Reading a surface this role owns. A demo account passes.
 *
 * The three guards below are the whole authorization vocabulary, and each one
 * answers a different question. `requireRole` asks "may this person LOOK at
 * this?" -- keep it on GET handlers. `requireWriteRole` asks "may this person
 * CHANGE what everyone else sees?". `requirePosting` asks "may this person
 * publish a job?", which is a capability and not a role at all.
 *
 * scripts/check-routes.ts enumerates every handler under src/app/api and fails
 * the build if one of them ships with no guard, with a guard other than the one
 * its entry declares, or -- for a mutation on an admin console -- with the
 * reading guard where the writing one belongs.
 */
export async function requireRole(...roles: Role[]): Promise<SessionUser> {
  const user = await requireUser();
  if (!roles.includes(user.role)) throw new HttpError(403, "Not allowed for this account type");
  return user;
}

/**
 * Changing state that outlives this session and belongs to everybody: the
 * corpus, the rules, the geocode cache, another person's rows.
 *
 * The role test is `requireRole`'s, plus one more: a demo account is refused.
 * One click on the public sign-in page hands a stranger an admin session, so
 * "admin" alone cannot be the whole answer for an operation that destroys
 * something -- POST /api/test/reset TRUNCATEs ten tables and takes the warmed
 * geocode cache (95 of 98 exact ZIPs, and a bill at HERE to rebuild) with it.
 *
 * A real admin -- a `users` row with `is_demo` false, which only database
 * access or scripts/grant-admin.ts creates -- is not affected by any of this.
 */
export async function requireWriteRole(...roles: Role[]): Promise<SessionUser> {
  const user = await requireRole(...roles);
  if (user.isDemo) {
    // The audit trail the demo did not have. One line per refusal, with who and
    // what, so a wave of them is visible in the task logs.
    console.warn(`[authz] refused a write to demo account ${user.email} (${user.role})`);
    throw new HttpError(
      403,
      "The demo can open every console but cannot change data. Sign in with a real admin account.",
    );
  }
  return user;
}

/**
 * Publishing a job from the website.
 *
 * Not a role test: see `users.can_post`. Every account may post unless an admin
 * has taken the capability away, which is what stops a company that both hauls
 * and posts from needing two accounts. A demo account is NOT excluded here --
 * posting is something any visitor can do by registering, so refusing it would
 * cost the demo its poster walkthrough and buy no protection.
 */
export async function requirePosting(): Promise<SessionUser> {
  const user = await requireUser();
  if (!user.canPost) {
    throw new HttpError(403, "Posting is turned off for this account");
  }
  return user;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
