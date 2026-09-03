import { NextResponse } from "next/server";
import { handler } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { listGroups } from "@/lib/demo/chats";

export const GET = handler(async () => {
  await requireUser();
  return NextResponse.json({ groups: await listGroups() });
});
