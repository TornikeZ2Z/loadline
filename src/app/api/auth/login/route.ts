import { NextResponse } from "next/server";
import { handler } from "@/lib/api";
import { HttpError, startSession, verifyPassword } from "@/lib/auth";
import { queryOne } from "@/lib/db";

export const POST = handler(async (req: Request) => {
  const body = (await req.json()) as Record<string, string>;
  const email = (body.email ?? "").trim().toLowerCase();

  const user = await queryOne<{ id: number; password_hash: string; name: string; role: string }>(
    `SELECT id, password_hash, name, role FROM users WHERE email = $1`,
    [email],
  );

  // Same message either way -- do not reveal which accounts exist.
  if (!user || !verifyPassword(body.password ?? "", user.password_hash)) {
    throw new HttpError(401, "Email or password is incorrect");
  }

  await startSession(user.id);
  return NextResponse.json({ id: user.id, name: user.name, role: user.role });
});
