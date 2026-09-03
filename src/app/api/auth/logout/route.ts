import { NextResponse } from "next/server";
import { handler } from "@/lib/api";
import { endSession } from "@/lib/auth";

export const POST = handler(async () => {
  await endSession();
  return NextResponse.json({ ok: true });
});
