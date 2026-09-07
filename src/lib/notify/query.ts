/**
 * Reading and dismissing your own notifications.
 *
 * EVERY STATEMENT HERE IS `WHERE user_id = $1`, and the id is always the
 * session's -- never a path segment, never a query parameter, never a field in
 * a body. There is no scope argument and no audience argument because there is
 * no second answer: a notification belongs to exactly one account, which is
 * simpler than a listing and must not be made to look harder. Acceptance N8
 * forges `?user_id=` and asserts nothing changes.
 *
 * A demo account is one shared row (`POST /api/auth/demo` hands every stranger
 * the same `users` row), so "the demo account's own notifications" means the
 * same thing here as "the demo account's own listings" does in
 * `src/lib/loads/query.ts`: they are the demo's, and nobody else's. The sweep is
 * what keeps a demo LISTING out of a real account's payload -- it runs every
 * subject under its own owner's audience. See sweep.ts.
 *
 * SPEC 12.3, 13.
 */
import { query, queryOne } from "@/lib/db";
import type { NotificationRow, NotifyPrefs } from "./types";

/** Newest first. Bounded, because a list page is a page. */
const PAGE = 50;

export async function listNotifications(
  userId: number,
  limit: number = PAGE,
): Promise<NotificationRow[]> {
  // ISO-8601 UTC, spelled out, and NOT `::text`.
  //
  // Postgres renders a timestamptz as "2026-09-07 23:18:46.661+04", whose
  // whole-hour offset has no minutes -- which is not ISO 8601, so `new Date()`
  // in the browser returns Invalid Date and the row prints the raw column. It
  // did exactly that on the first page ever rendered. The value is a timestamp
  // read by a person in their own timezone, so it leaves here unambiguous.
  const AS_ISO = `to_char(%s AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
  return query<NotificationRow>(
    `SELECT id, kind, subject_kind, subject_id, payload,
            ${AS_ISO.replace("%s", "created_at")} AS created_at,
            CASE WHEN read_at IS NULL THEN NULL
                 ELSE ${AS_ISO.replace("%s", "read_at")} END AS read_at
       FROM notifications
      WHERE user_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    [userId, Math.min(Math.max(1, limit), PAGE)],
  );
}

export async function unreadCount(userId: number): Promise<number> {
  const row = await queryOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL`,
    [userId],
  );
  return row?.n ?? 0;
}

/**
 * Whether this account gets a bell at all.
 *
 * SPEC 2: absent for a user who owns no listing. "A bell with a permanent zero
 * teaches people to ignore bells" -- and an anonymous visitor, who is most of
 * this board's traffic, has nothing that could ever be notified about.
 *
 * The third EXISTS is not in the specification and closes a hole it would
 * otherwise leave: a driver whose only truck has since been swept off the board
 * still has the notifications that truck earned, and without this line the bell
 * -- the only route to `/notifications` -- would vanish along with the listing,
 * taking the unread count with it.
 */
export async function ownsListingOrNotification(userId: number): Promise<boolean> {
  const row = await queryOne<{ ok: boolean }>(
    `SELECT (EXISTS (SELECT 1 FROM trucks        WHERE posted_by = $1)
          OR EXISTS (SELECT 1 FROM loads         WHERE posted_by = $1)
          OR EXISTS (SELECT 1 FROM notifications WHERE user_id   = $1)) AS ok`,
    [userId],
  );
  return row?.ok ?? false;
}

/**
 * Dismissal.
 *
 * `ids` names rows; `null` means all of them. Either way the WHERE clause is
 * the session's own id first, so a forged id in the body marks nothing: the
 * UPDATE simply matches no row and returns 0, which is the same answer a
 * caller gets for an id that was never issued. No 403, no oracle.
 *
 * Already-read rows are excluded, so the count returned is what actually
 * changed rather than what was asked for.
 */
export async function markRead(
  userId: number,
  ids: number[] | null,
  now: Date = new Date(),
): Promise<number> {
  const rows = ids
    ? await query<{ id: number }>(
        `UPDATE notifications SET read_at = $3
          WHERE user_id = $1 AND read_at IS NULL AND id = ANY($2::bigint[])
          RETURNING id`,
        [userId, ids, now.toISOString()],
      )
    : await query<{ id: number }>(
        `UPDATE notifications SET read_at = $2
          WHERE user_id = $1 AND read_at IS NULL
          RETURNING id`,
        [userId, now.toISOString()],
      );
  return rows.length;
}

/**
 * The preferences, and the one that is not a preference.
 *
 * `emailAvailable` is computed from the CHANNELS map rather than from a flag,
 * so the day `sendViaSes` is added the settings page stops calling itself
 * unavailable without anybody remembering to edit a boolean. `email` itself is
 * stored and returned honestly -- it is false on every row today and the PUT
 * refuses to set it, which is a different thing from pretending the column is
 * not there.
 */
export async function getPrefs(userId: number): Promise<NotifyPrefs> {
  const { CHANNELS } = await import("./dispatch");
  const row = await queryOne<{ notify_inapp: boolean; notify_email: boolean }>(
    `SELECT notify_inapp, notify_email FROM users WHERE id = $1`,
    [userId],
  );
  return {
    inapp: row?.notify_inapp ?? true,
    email: row?.notify_email ?? false,
    emailAvailable: CHANNELS.email != null,
  };
}

export async function setInAppPref(userId: number, inapp: boolean): Promise<NotifyPrefs> {
  await query(`UPDATE users SET notify_inapp = $2 WHERE id = $1`, [userId, inapp]);
  return getPrefs(userId);
}
