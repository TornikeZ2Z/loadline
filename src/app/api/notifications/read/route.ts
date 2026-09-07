import { NextResponse } from "next/server";
import { badRequest, handler } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { markRead, unreadCount } from "@/lib/notify/query";

interface Body {
  /** Rows to dismiss. Omitted or null means every unread row this account has. */
  ids?: unknown;
}

/**
 * Dismissal.
 *
 * One endpoint for "this one" and "all of them", because they are the same
 * statement with a different WHERE, and two routes would be two places to get
 * the ownership clause wrong. The session's id leads that clause either way, so
 * an id belonging to somebody else matches no row and changes nothing: the
 * answer is `0 dismissed`, which is exactly what an id that was never issued
 * returns. No 403, because a 403 would confirm the row exists.
 *
 * `read_at` and not a delete: a dismissed notification is still the record that
 * this account was told about this pairing on this day, and the pairing's own
 * `notified_at` in `truck_matches` is written against it. Deleting the row would
 * leave the sweep certain it had told somebody something they can no longer see.
 */
export const POST = handler(async (req: Request) => {
  const user = await requireUser();
  const body = (await req.json().catch(() => ({}))) as Body;

  let ids: number[] | null = null;
  if (body.ids != null) {
    if (!Array.isArray(body.ids)) badRequest("ids must be an array of notification ids");
    ids = body.ids.map((v) => Number(v));
    if (ids.some((n) => !Number.isSafeInteger(n) || n <= 0)) {
      badRequest("ids must be positive whole numbers");
    }
    if (ids.length > 200) badRequest("too many ids in one call");
  }

  const dismissed = await markRead(user.id, ids);
  return NextResponse.json({ dismissed, unread: await unreadCount(user.id) });
});
