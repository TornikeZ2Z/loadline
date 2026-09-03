import { NextResponse } from "next/server";
import { badRequest, handler } from "@/lib/api";
import { hashPassword, startSession } from "@/lib/auth";
import { query, queryOne } from "@/lib/db";
import { geocode } from "@/lib/geo/geocode";

export const POST = handler(async (req: Request) => {
  const body = (await req.json()) as Record<string, string>;
  const email = (body.email ?? "").trim().toLowerCase();
  const password = body.password ?? "";
  const name = (body.name ?? "").trim();
  const role = ["carrier", "broker"].includes(body.role) ? body.role : "carrier";

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) badRequest("Enter a valid email address");
  if (password.length < 8) badRequest("Password must be at least 8 characters");
  if (!name) badRequest("Name is required");

  const existing = await queryOne(`SELECT id FROM users WHERE email = $1`, [email]);
  if (existing) badRequest("An account with that email already exists");

  // A home base makes "loads near me" work on first login without asking the
  // browser for geolocation.
  const home = body.homeLocation ? await geocode(body.homeLocation) : null;

  const row = await queryOne<{ id: number }>(
    `INSERT INTO users (email, password_hash, name, role, phone, company, home_label, home_lat, home_lng)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [email, hashPassword(password), name, role, body.phone || null, body.company || null,
     home?.label ?? null, home?.lat ?? null, home?.lng ?? null],
  );

  await startSession(row!.id);
  return NextResponse.json({ id: row!.id, email, name, role });
});
