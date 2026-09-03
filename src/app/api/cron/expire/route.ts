import { NextResponse } from "next/server";
import { handler, requireCronSecret } from "@/lib/api";
import { expireStaleLoads } from "@/lib/pipeline/expire";

export const POST = handler(async (req: Request) => {
  requireCronSecret(req);
  return NextResponse.json(await expireStaleLoads());
});
