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

/** Bearer-token gate for /api/cron/*. */
export function requireCronSecret(req: Request): void {
  const expected = process.env.CRON_SECRET;
  if (!expected) throw new HttpError(500, "CRON_SECRET is not configured");
  const provided = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (provided !== expected) throw new HttpError(401, "Bad cron secret");
}
