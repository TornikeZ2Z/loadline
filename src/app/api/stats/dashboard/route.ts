import { NextResponse } from "next/server";
import { handler } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { dashboardStats } from "@/lib/loads/stats";

export const GET = handler(async () => {
  const user = await requireUser();
  const viewer =
    user.home_lat != null && user.home_lng != null
      ? { lat: user.home_lat, lng: user.home_lng, label: user.home_label ?? undefined }
      : null;
  return NextResponse.json(await dashboardStats(viewer));
});
