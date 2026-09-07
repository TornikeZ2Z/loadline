import { NextResponse } from "next/server";
import { handler } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { listNotifications, unreadCount } from "@/lib/notify/query";

/**
 * Your own notifications, newest first.
 *
 * THE CALLER'S ID COMES FROM THE SESSION AND FROM NOWHERE ELSE. There is no
 * `user_id` parameter to forge, no path segment to increment and no body to
 * read: `requireUser()` returns the row the signed cookie names, and
 * `listNotifications` is `WHERE user_id = $1` with that id. Acceptance N8 calls
 * this route with `?user_id=` set to somebody else's and asserts the answer does
 * not change.
 *
 * No redaction pass, because there is nothing to redact: a notification payload
 * is a count, two band totals, a two-letter lane and the reason clauses --
 * numbers and explicit statements of absence, composed by `reasons.ts`. It
 * carries no phone, no sender key and no free text off either listing, and
 * `npm run check:redact` reads every payload the sweep writes to prove it rather
 * than trusting this paragraph.
 */
export const GET = handler(async () => {
  const user = await requireUser();
  const [rows, unread] = await Promise.all([listNotifications(user.id), unreadCount(user.id)]);
  return NextResponse.json({ notifications: rows, unread });
});
