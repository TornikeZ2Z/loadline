/**
 * Channels: the one that exists, and the shape the next one plugs into.
 *
 * A NOTIFICATION always exists; a DELIVERY is an attempt against it. That split
 * is the whole of why e-mail is a switch rather than a rebuild -- the row is
 * already written, the settings page already has its control, and turning mail
 * on is:
 *
 *   1. implement `sendViaSes` below;
 *   2. add one line to CHANNELS;
 *   3. enable the third control on /settings/notifications, which stamps
 *      `users.notify_email_since = now()`;
 *   4. select notifications WHERE created_at > users.notify_email_since with no
 *      `notification_deliveries` row for channel='email'.
 *
 * STEP 4 IS THE IMPORTANT ONE AND IT IS WHY THERE IS NO `sent_at` COLUMN. A
 * nullable "was it mailed" timestamp means both "never mail this" and "mail
 * this", so its first run mails every in-app notification accumulated since
 * launch -- months of them, for listings long since expired.
 * `notify_email_since` makes that backlog unreachable by construction.
 *
 * NOTHING UNDER src/ IMPORTS A MAIL CLIENT, and acceptance N9 asserts it by
 * scanning the tree rather than by trusting this comment.
 *
 * SPEC 12.4.
 */
import { query } from "@/lib/db";

export type Channel = "inapp" | "email";

/**
 * One attempt to deliver one notification. Returns what to record, never
 * throws: a channel that fails is a `failed` delivery row, not a dead cron run.
 */
export type ChannelSender = (
  notificationId: number,
  now: Date,
) => Promise<{ status: "sent" | "failed" | "skipped"; detail: string | null }>;

/**
 * In-app delivery is the notification being visible, so there is nothing to
 * attempt: the row is written and the bell counts it. The delivery row exists
 * anyway, because "which channels did this go out on?" has to be answerable
 * about every notification, not only about the ones a future channel touched.
 */
const sendInApp: ChannelSender = async () => ({ status: "sent", detail: null });

/**
 * The map. One line long today. `email` is ABSENT rather than mapped to a stub
 * that returns `skipped`: a stub would write `notification_deliveries` rows for
 * a channel that does not exist, and step 4 above reads exactly that table to
 * decide what still needs mailing.
 */
export const CHANNELS: Partial<Record<Channel, ChannelSender>> = {
  inapp: sendInApp,
};

/** Run every enabled channel against one notification and record each attempt. */
export async function deliver(
  notificationId: number,
  channels: Channel[],
  now: Date,
): Promise<void> {
  for (const channel of channels) {
    const send = CHANNELS[channel];
    if (!send) continue;
    const result = await send(notificationId, now);
    await query(
      `INSERT INTO notification_deliveries (notification_id, channel, status, detail, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [notificationId, channel, result.status, result.detail, now.toISOString()],
    );
  }
}
