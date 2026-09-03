import { NextResponse } from "next/server";
import { badRequest, handler } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { query, queryOne } from "@/lib/db";

export const GET = handler(async () => {
  const user = await requireUser();
  const rows = await query(
    `SELECT id, name, params, notify, created_at::text AS created_at
       FROM saved_searches WHERE user_id = $1 ORDER BY created_at DESC`,
    [user.id],
  );
  return NextResponse.json({ searches: rows });
});

export const POST = handler(async (req: Request) => {
  const user = await requireUser();
  const body = (await req.json()) as { name?: string; query?: string; notify?: boolean };
  const name = (body.name ?? "").trim();
  if (!name) badRequest("Give the search a name");

  // A saved search is just the board's query string. Same format the URL uses,
  // so restoring one is a navigation rather than a filter-rebuilding exercise.
  const row = await queryOne<{ id: number }>(
    `INSERT INTO saved_searches (user_id, name, params, notify)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id, name) DO UPDATE SET params = EXCLUDED.params, notify = EXCLUDED.notify
     RETURNING id`,
    [user.id, name, JSON.stringify({ query: body.query ?? "" }), Boolean(body.notify)],
  );
  return NextResponse.json({ id: row!.id, name });
});
