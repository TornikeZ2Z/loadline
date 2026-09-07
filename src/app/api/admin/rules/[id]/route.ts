import { NextResponse } from "next/server";
import { handler, notFound } from "@/lib/api";
import { requireWriteRole } from "@/lib/auth";
import { reprocessMessages } from "@/lib/pipeline/process";
import { deleteRule, getRule, messagesAffectedBy, updateRule } from "@/lib/pipeline/rules";

interface Ctx {
  params: Promise<{ id: string }>;
}

/** Deactivate / edit a rule, then re-run the messages it touched. */
export const PATCH = handler(async (req: Request, ctx: Ctx) => {
  await requireWriteRole("admin");
  const { id } = await ctx.params;
  const body = (await req.json()) as { active?: boolean; value?: unknown; note?: string | null };
  const before = await getRule(Number(id));
  if (!before) notFound("Rule not found");
  const rule = await updateRule(Number(id), body);
  const ids = await messagesAffectedBy(before, 30);
  const results = await reprocessMessages(ids);
  return NextResponse.json({ rule, reprocessed: results.length });
});

export const DELETE = handler(async (_req: Request, ctx: Ctx) => {
  await requireWriteRole("admin");
  const { id } = await ctx.params;
  const before = await getRule(Number(id));
  if (!before) notFound("Rule not found");
  await deleteRule(Number(id));
  const ids = await messagesAffectedBy(before, 30);
  const results = await reprocessMessages(ids);
  return NextResponse.json({ deleted: true, reprocessed: results.length });
});
