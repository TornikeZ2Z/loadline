import { NextResponse } from "next/server";
import { badRequest, handler } from "@/lib/api";
import { requireUser, requireRole } from "@/lib/auth";
import { queryOne, query } from "@/lib/db";
import { geocode } from "@/lib/geo/geocode";
import { haversineMiles } from "@/lib/geo/math";
import { computeExpiry } from "@/lib/extract/dates";
import { normalizePhone } from "@/lib/extract/phone";
import { searchLoads } from "@/lib/loads/query";
import { parseSearchParams } from "@/lib/loads/searchParams";

/** Search. Every filter in the UI maps to a query parameter here. */
export const GET = handler(async (req: Request) => {
  const user = await requireUser();
  const url = new URL(req.url);
  const viewer =
    user.home_lat != null && user.home_lng != null
      ? { lat: user.home_lat, lng: user.home_lng, label: user.home_label ?? undefined }
      : null;
  const params = await parseSearchParams(url.searchParams, viewer);
  const result = await searchLoads(params);
  return NextResponse.json(result);
});

/** Brokers and dispatchers publishing a load directly, without WhatsApp. */
export const POST = handler(async (req: Request) => {
  const user = await requireRole("broker", "admin");
  const body = (await req.json()) as Record<string, string | number | null>;

  const pickupText = String(body.pickup ?? "").trim();
  const deliveryText = String(body.delivery ?? "").trim();
  if (!pickupText || !deliveryText) badRequest("Pickup and delivery are both required");

  const pickup = await geocode(pickupText);
  if (!pickup) badRequest(`Could not place ${pickupText} on the map`);
  const delivery = await geocode(deliveryText);
  if (!delivery) badRequest(`Could not place ${deliveryText} on the map`);

  const pickupDate = body.pickupDate ? String(body.pickupDate) : null;
  const phone = normalizePhone(body.contactPhone ? String(body.contactPhone) : user.phone);

  const row = await queryOne<{ id: number }>(
    `INSERT INTO loads (
       posted_by, status,
       pickup_label, pickup_city, pickup_state, pickup_zip, pickup_lat, pickup_lng, pickup_precision,
       delivery_label, delivery_city, delivery_state, delivery_zip, delivery_lat, delivery_lng, delivery_precision,
       trip_miles, pickup_date, delivery_date,
       load_type, weight_lbs, pallets, rate_usd,
       contact_name, contact_phone, notes,
       confidence, needs_review, expires_at
     ) VALUES ($1,'available',
       $2,$3,$4,$5,$6,$7,$8,
       $9,$10,$11,$12,$13,$14,$15,
       $16,$17,$18,
       $19,$20,$21,$22,
       $23,$24,$25,
       1.0,false,$26) RETURNING id`,
    [
      user.id,
      pickup.label, pickup.city, pickup.state, pickup.zip, pickup.lat, pickup.lng, pickup.precision,
      delivery.label, delivery.city, delivery.state, delivery.zip, delivery.lat, delivery.lng, delivery.precision,
      haversineMiles(pickup, delivery),
      pickupDate,
      body.deliveryDate ? String(body.deliveryDate) : null,
      body.loadType || null,
      body.weightLbs ? Number(body.weightLbs) : null,
      body.pallets ? Number(body.pallets) : null,
      body.rateUsd ? Number(body.rateUsd) : null,
      body.contactName ? String(body.contactName) : user.name,
      phone.e164 ?? phone.display,
      body.notes ? String(body.notes) : null,
      computeExpiry(pickupDate, new Date()),
    ],
  );

  await query(
    `INSERT INTO load_events (load_id, actor_id, kind, detail) VALUES ($1,$2,'created',$3)`,
    [row!.id, user.id, JSON.stringify({ source: "web" })],
  );

  return NextResponse.json({ id: row!.id }, { status: 201 });
});
