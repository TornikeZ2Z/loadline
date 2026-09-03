import { NextResponse } from "next/server";
import { handler } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { reprocessMessage } from "@/lib/pipeline/process";

/**
 * Re-run one message through extraction. Because raw_messages is the source of
 * truth and loads are derived, a prompt change or a new alias can be replayed
 * over historical traffic without re-ingesting anything.
 */
export const POST = handler(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  await requireRole("admin");
  const { id } = await ctx.params;
  return NextResponse.json(await reprocessMessage(Number(id)));
});
