import { NextResponse } from "next/server";
import { handler, rateLimit } from "@/lib/api";
import { isAdminActor, requirePosting } from "@/lib/auth";
import {
  DEFAULT_TRUCK_CORRIDOR_MILES,
  TRUCK_CORRIDOR_OPTIONS,
} from "@/lib/loads/constants";
import { previewMatches } from "@/lib/match/run";
import type { MatchTruck } from "@/lib/match/types";

/**
 * "4 jobs on the board fit this" -- while the driver is still typing.
 *
 * A COUNT AND A HISTOGRAM, AND NOTHING ELSE. No rows, no labels, no contacts.
 * A driver who has not posted yet has no listing for anyone to have answered,
 * and handing them job rows here would turn the posting form into a second
 * board with no contact gate in front of it. The number is the honest part of
 * this screen: "4 fit this" is a reason to finish the form, and a list is a
 * reason not to.
 *
 * `requirePosting()`, the same capability a real post needs, and its own 20/min
 * bucket: this runs a full candidate scan per keystroke-group, and an
 * unauthenticated version would be a free corridor-scan API.
 *
 * NUMBERS IN, not the form body. The form has already resolved its places
 * through the place picker, so this takes coordinates rather than labels and
 * cannot disagree with `POST /api/trucks` about where "Newark" is. It is also
 * deliberately LENIENT where the real post is strict -- a half-filled form must
 * still answer, because the preview exists to be read before the form is
 * finished. Everything it cannot read, it treats as unstated, which is what the
 * matcher does with an unstated fact anyway.
 */

interface PreviewBody {
  originLat?: unknown;
  originLng?: unknown;
  destLat?: unknown;
  destLng?: unknown;
  corridorMiles?: unknown;
  freeCf?: unknown;
  availMode?: unknown;
  availFrom?: unknown;
  availTo?: unknown;
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

function isoDate(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/** Snapped to the list the form offers, exactly as `POST /api/trucks` snaps it. */
function corridor(v: unknown): number {
  const n = num(v);
  const rounded = n == null ? null : Math.round(n);
  return rounded != null && (TRUCK_CORRIDOR_OPTIONS as readonly number[]).includes(rounded)
    ? rounded
    : DEFAULT_TRUCK_CORRIDOR_MILES;
}

export const POST = handler(async (req: Request) => {
  const user = await requirePosting();
  rateLimit(req, "trucks-preview-matches", 20);

  const body = ((await req.json().catch(() => ({}))) ?? {}) as PreviewBody;

  const originLat = num(body.originLat);
  const originLng = num(body.originLng);

  // No coordinate, no preview -- and a zero rather than a refusal, because the
  // form asks for this before it asks for anything else and an error here would
  // read as "your truck does not match" rather than "you have not said where".
  if (originLat == null || originLng == null) {
    return NextResponse.json({
      strong: 0,
      possible: 0,
      total: 0,
      candidates: 0,
      truncated: false,
      refusals: {},
      gates: { service: "thin", deadline: "inert" },
    });
  }

  const availMode = typeof body.availMode === "string" ? body.availMode.trim() : "";
  const destLat = num(body.destLat);
  const destLng = num(body.destLng);

  const draft: MatchTruck = {
    id: 0,
    status: "available",
    visibility: "public",
    sender_key: null,
    // The draft belongs to the person filling the form in, so gate 3 keeps
    // their own jobs out of their own preview.
    posted_by: user.id,
    origin_lat: originLat,
    origin_lng: originLng,
    dest_lat: destLat != null && destLng != null ? destLat : null,
    dest_lng: destLat != null && destLng != null ? destLng : null,
    corridor_miles: corridor(body.corridorMiles),
    free_cf: num(body.freeCf),
    avail_now: availMode === "now",
    avail_from: availMode === "from" || availMode === "between" ? isoDate(body.availFrom) : null,
    avail_to: availMode === "between" ? isoDate(body.availTo) : null,
  };

  const preview = await previewMatches(draft, {
    userId: user.id,
    includeDemo: isAdminActor(user),
  });

  return NextResponse.json(preview);
});
