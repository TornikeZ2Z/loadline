import { NextResponse } from "next/server";
import { badRequest, handler } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { geocode } from "@/lib/geo/geocode";

/** Resolve typed place text for the filter panel ("philly" -> a coordinate). */
export const GET = handler(async (req: Request) => {
  await requireUser();
  const q = new URL(req.url).searchParams.get("q")?.trim();
  if (!q) badRequest("Missing q");
  const hit = await geocode(q);
  if (!hit) return NextResponse.json({ found: false });
  return NextResponse.json({ found: true, ...hit });
});
