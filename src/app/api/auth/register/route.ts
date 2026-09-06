import { NextResponse } from "next/server";
import { badRequest, handler, rateLimit } from "@/lib/api";
import { hashPassword, startSession } from "@/lib/auth";
import { queryOne } from "@/lib/db";
import type { Role } from "@/lib/session";

/**
 * Self-serve accounts, for the day `DEMO_MODE=off`.
 *
 * Two kinds, and only two: a **driver**, who wants the contact on a job, and a
 * **poster**, who wants to publish one. Admin is not on the menu -- an admin
 * comes from the seed or from someone with database access, never from a form
 * field a stranger can set.
 *
 * No home base is asked for. A location lives in the browser (localStorage) and
 * is set from the header in one click, so making it a registration field would
 * both slow the sign-up down and put a person's whereabouts in our database for
 * no reason.
 */
export const POST = handler(async (req: Request) => {
  // The one open door that writes a row and hands back a session, and every
  // call spends a synchronous scrypt on the event loop. A person needs one
  // account, so ten a minute from one address is already generous -- the same
  // in-memory speed bump the public read routes sit behind.
  rateLimit(req, "register", 10);

  const body = (await req.json()) as Record<string, string>;
  const email = (body.email ?? "").trim().toLowerCase();
  const password = body.password ?? "";
  const name = (body.name ?? "").trim();
  const role: Role = body.role === "poster" ? "poster" : "driver";

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) badRequest("Enter a valid email address");
  if (password.length < 8) badRequest("Password must be at least 8 characters");
  if (!name) badRequest("Name is required");

  const existing = await queryOne(`SELECT id FROM users WHERE email = $1`, [email]);
  if (existing) badRequest("An account with that email already exists");

  const row = await queryOne<{ id: number }>(
    `INSERT INTO users (email, password_hash, name, role, phone, company)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [email, hashPassword(password), name, role, body.phone || null, body.company || null],
  );

  await startSession(row!.id);
  return NextResponse.json({ id: row!.id, email, name, role });
});
