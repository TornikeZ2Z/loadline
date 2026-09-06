import { NextResponse } from "next/server";
import { handler } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { getLoad } from "@/lib/loads/query";
import { findCrossSenderTwins } from "@/lib/pipeline/dedup";

/** The same job forwarded by two senders -- the admin data-quality view. Never merged automatically. */
export const GET = handler(async () => {
  await requireRole("admin");
  const pairs = await findCrossSenderTwins();
  const twins = [];
  for (const p of pairs) {
    const [a, b] = await Promise.all([getLoad(p.a), getLoad(p.b)]);
    if (a && b) twins.push({ a, b, score: p.score });
  }
  return NextResponse.json({ twins });
});
