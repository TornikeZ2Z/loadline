import { NextResponse } from "next/server";
import { badRequest, handler, jobIdFrom, notFound } from "@/lib/api";
import { requireWriteRole } from "@/lib/auth";
import { queryOne } from "@/lib/db";
import { parseGroupLink } from "@/lib/loads/groupLink";

/**
 * Set (or clear) a group's WhatsApp link.
 *
 * There are exactly two links WhatsApp honours -- a group invite
 * (`https://chat.whatsapp.com/<code>`, which only a group admin can produce)
 * and a 1:1 line (`https://wa.me/<digits>`, for a "group" that is really a
 * dispatcher's DM). Anything else is rejected here rather than stored, because
 * a link that does not open is worse than no link: it puts a button in front of
 * a driver that quietly fails.
 *
 * Sending `invite_url: null` or "" removes it.
 */
export const PATCH = handler(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  await requireWriteRole("admin");
  const { id: raw } = await ctx.params;
  const id = jobIdFrom(raw);
  if (id == null) notFound("Group not found");

  const body = (await req.json().catch(() => null)) as { invite_url?: string | null } | null;
  if (!body || !("invite_url" in body)) badRequest("invite_url is required");

  const input = (body.invite_url ?? "").trim();
  let url: string | null = null;
  if (input) {
    const parsed = parseGroupLink(input);
    if (!parsed) {
      badRequest(
        "Use a group invite link (https://chat.whatsapp.com/…) or a wa.me number. WhatsApp has no link to a single message.",
      );
    }
    url = parsed.url;
  }

  const group = await queryOne(
    `UPDATE whatsapp_groups SET invite_url = $2 WHERE id = $1
     RETURNING id, name, description, invite_url`,
    [id, url],
  );
  if (!group) notFound("Group not found");

  return NextResponse.json({ group });
});
