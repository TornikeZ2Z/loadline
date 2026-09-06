import { NextResponse } from "next/server";
import { badRequest, handler } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { queryOne } from "@/lib/db";
import { listGroups, listMessages, loadsForMessage } from "@/lib/demo/chats";
import { ingestMessage } from "@/lib/pipeline/ingest";
import { reprocessMessage } from "@/lib/pipeline/process";

/** The chat transcript for one group, or everything when no group is given. */
export const GET = handler(async (req: Request) => {
  await requireRole("admin");
  const raw = new URL(req.url).searchParams.get("groupId");
  const groupId = raw ? Number(raw) : null;
  if (raw && !Number.isFinite(groupId)) badRequest("groupId must be a number");

  const messages = await listMessages(groupId);
  return NextResponse.json({ messages });
});

/**
 * Post a new message into a group, exactly as if it had arrived by webhook.
 * Runs synchronously because in test mode the whole point is seeing the result.
 */
export const POST = handler(async (req: Request) => {
  await requireRole("admin");
  const body = (await req.json()) as {
    groupId?: number;
    text?: string;
    author?: string;
    phone?: string;
  };

  const text = (body.text ?? "").trim();
  if (!text) badRequest("Message text is required");

  const group = body.groupId
    ? await queryOne<{ id: number; wa_group_id: string | null; name: string }>(
        `SELECT id, wa_group_id, name FROM whatsapp_groups WHERE id = $1`,
        [body.groupId],
      )
    : null;

  const { messageId } = await ingestMessage({
    waMessageId: `test.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`,
    body: text,
    sentAt: new Date(),
    authorName: body.author?.trim() || "Test User",
    authorPhone: body.phone?.trim() || null,
    groupWaId: group?.wa_group_id ?? "test",
    groupName: group?.name ?? "Test messages",
    payload: { source: "test-console" },
  });

  const result = await reprocessMessage(messageId);
  const [messages, loads, groups] = await Promise.all([
    listMessages(group?.id ?? null),
    loadsForMessage(messageId),
    listGroups(),
  ]);

  return NextResponse.json({ messageId, result, loads, messages, groups }, { status: 201 });
});
