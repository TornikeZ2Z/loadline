import { NextResponse } from "next/server";
import { handler } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { listGroups, listMessages } from "@/lib/demo/chats";
import { resetDemoData } from "@/lib/demo/reset";

/**
 * Restore the demo corpus. Wipes messages, loads and the geocode cache, then
 * replays the sample WhatsApp traffic through the real pipeline.
 *
 * User accounts survive, so a reset mid-demo does not sign anyone out.
 */
export const POST = handler(async () => {
  await requireRole("admin");
  const summary = await resetDemoData();
  const [groups, messages] = await Promise.all([listGroups(), listMessages(null)]);
  return NextResponse.json({ summary, groups, messages });
});
