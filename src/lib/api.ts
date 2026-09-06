import { NextResponse } from "next/server";
import { HttpError } from "@/lib/auth";

/** Wrap a route handler so thrown HttpErrors become proper JSON responses. */
export function handler<A extends unknown[]>(
  fn: (...args: A) => Promise<NextResponse | Response>,
): (...args: A) => Promise<NextResponse | Response> {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (err) {
      if (err instanceof HttpError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      console.error("[api]", err);
      const message = err instanceof Error ? err.message : "Unexpected error";
      return NextResponse.json({ error: message }, { status: 500 });
    }
  };
}

export function badRequest(message: string): never {
  throw new HttpError(400, message);
}

export function notFound(message = "Not found"): never {
  throw new HttpError(404, message);
}

/**
 * A job id out of a `[id]` path segment, or null when the segment is not one.
 *
 * `Number()` is the wrong tool for a URL segment: `Number("abc")` is NaN, which
 * the database rejects as a 500 instead of the 404 the caller deserves, and
 * `Number("0x10")` is 16, so a URL that is not a job's id would serve that job.
 * Digits only, and within bigint range so a 30-digit string 404s too.
 */
export function jobIdFrom(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

// --- rate limiting -----------------------------------------------------------

/**
 * A per-IP token bucket, in memory.
 *
 * The board is public now, so the endpoints that used to sit behind
 * `requireUser()` are open to anyone with curl: search, detail, place
 * suggestions and — the one that matters — the contact reveal. A session is no
 * longer the thing that makes scraping expensive, so a limiter is.
 *
 * In memory is the honest scope: one process, reset on restart, useless behind
 * several instances. It is not a security boundary, it is a speed bump in front
 * of the one endpoint that hands out phone numbers, and it costs no dependency
 * and no round trip. Every reveal is also logged with an actor id, which is the
 * part that actually deters bulk harvesting.
 */
const buckets = new Map<string, { count: number; resetAt: number }>();

/**
 * `x-forwarded-for` and `x-real-ip` are client-supplied unless a proxy the app
 * controls rewrites them, so trusting them by default lets any caller pick a
 * fresh bucket per request and delete the limiter entirely. They are read only
 * when `TRUST_PROXY=1` says a reverse proxy is in front -- and then the LAST
 * hop, because the documented nginx config appends the real peer address to
 * whatever the client sent, leaving the client's own value first.
 */
function clientIp(req: Request): string {
  if (process.env.TRUST_PROXY !== "1") return "local";
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const hops = fwd.split(",").map((h) => h.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1]!;
  }
  return req.headers.get("x-real-ip")?.trim() || "local";
}

/** Throws 429 past `perMinute` hits from one IP in a rolling minute. */
export function rateLimit(req: Request, bucket: string, perMinute: number): void {
  const now = Date.now();

  // Cheap sweep rather than a timer: the map only grows under real traffic, and
  // an expired entry costs nothing until the map is big enough to care about.
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
  }

  const key = `${bucket}:${clientIp(req)}`;
  const entry = buckets.get(key);

  if (!entry || entry.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + 60_000 });
    return;
  }

  entry.count += 1;
  if (entry.count > perMinute) {
    throw new HttpError(429, "Too many requests — try again in a minute");
  }
}

/** Bearer-token gate for /api/cron/*. */
export function requireCronSecret(req: Request): void {
  const expected = process.env.CRON_SECRET;
  if (!expected) throw new HttpError(500, "CRON_SECRET is not configured");
  const provided = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (provided !== expected) throw new HttpError(401, "Bad cron secret");
}
