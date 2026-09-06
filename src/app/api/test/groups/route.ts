import { NextResponse } from "next/server";
import { handler } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { listGroups } from "@/lib/demo/chats";

export const GET = handler(async () => {
  await requireRole("admin");
  return NextResponse.json({ groups: await listGroups() });
});
