import { NextResponse } from "next/server";
import { badRequest, handler, notFound } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { query, queryOne } from "@/lib/db";

const ALLOWED = ["available", "pending", "taken", "expired", "cancelled"];

/**
 * Update a load's status. Marking one "taken" is what stops the board from
 * drifting back toward WhatsApp, where nobody ever says a load is gone.
 * Duplicates move together -- they are the same physical freight, so covering
 * it in one group must not leave the repost sitting on the board as available.
 */
export const PATCH = handler(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const user = await requireRole("broker", "admin");
  const { id } = await ctx.params;
  const { status } = (await req.json()) as { status?: string };

  if (!status || !ALLOWED.includes(status)) {
    badRequest(`Status must be one of: ${ALLOWED.join(", ")}`);
  }

  const load = await queryOne<{ id: number; dup_group_id: string | null; status: string }>(
    `SELECT id, dup_group_id, status FROM loads WHERE id = $1`,
    [id],
  );
  if (!load) notFound("Load not found");

  const ids = load.dup_group_id
    ? (
        await query<{ id: number }>(`SELECT id FROM loads WHERE dup_group_id = $1`, [
          load.dup_group_id,
        ])
      ).map((r) => r.id)
    : [load.id];

  await query(`UPDATE loads SET status = $1, updated_at = now() WHERE id = ANY($2::bigint[])`, [
    status,
    ids,
  ]);
  await query(
    `INSERT INTO load_events (load_id, actor_id, kind, detail) VALUES ($1,$2,'status_changed',$3)`,
    [load.id, user.id, JSON.stringify({ from: load.status, to: status, applied_to: ids.length })],
  );

  return NextResponse.json({ id: load.id, status, updated: ids.length });
});
