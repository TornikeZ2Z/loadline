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
  if (
    mac.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))
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
    `SELECT id, email, name, role, phone, company FROM users WHERE id = $1`,
    [id],
  );
}

/** Throws a 401-shaped error for API routes. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) throw new HttpError(401, "Sign in to continue");
  return user;
}

export async function requireRole(...roles: Role[]): Promise<SessionUser> {
  const user = await requireUser();
  if (!roles.includes(user.role)) throw new HttpError(403, "Not allowed for this account type");
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
