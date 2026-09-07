/**
 * A truck's own lifecycle.
 *
 * DO NOT call rebuildSender() from this file, and do not add a truck branch to
 * it. A job list is a sender's CURRENT INVENTORY republished, so a job the
 * newest full post omits has been taken. A truck is not inventory: a driver
 * posting a Friday truck on Tuesday and a Saturday truck on Wednesday has two
 * trucks, and Wednesday's post omitting Friday's truck proves nothing at all.
 * Applying job supersession here would delist live capacity every time a driver
 * posted anything. `rebuildSender` is `UPDATE loads ... WHERE sender_key = $1`
 * and cannot reach this table, which is the strongest form of that rule --
 * an invariant rather than a note somebody has to read. Lifecycle test T3
 * exists to fail loudly if anyone ever wires it up.
 *
 * `now` is always a parameter, never SQL now(), so eval:lifecycle can move the
 * clock. Run the sweep from a scheduler: POST /api/cron/expire.
 */
import { query } from "@/lib/db";
import { DEFAULT_TZ, computeExpiry, isoOf, toLocalDate } from "@/lib/extract/dates";

/**
 * How long a truck with no stated date stays on the board.
 *
 * 48 hours, not the jobs' four days, and this is the number most likely to be
 * wrong. A job sitting in a warehouse is still there on Friday; "I have room"
 * posted on Monday is not a fact about Friday. A stale truck is worse than no
 * truck -- it wastes the one phone call a dispatcher was going to make -- so
 * capacity expires fast and the card prints the deadline it will expire on.
 */
export const CAPACITY_TTL_HOURS = 48;

/**
 * Grace after a stated departure day before the listing stops being shown.
 *
 * Applied to the END of the stated day (see `truckExpiresAt`), so a truck
 * leaving on the 12th is still reachable through the 13th for the dispatcher
 * who calls late.
 */
export const DEPART_GRACE_HOURS = 24;

export interface TruckExpiryResult {
  /** Its stated departure day has passed: a physical fact, not an inference. */
  trucksDeparted: number;
  /** No date was ever stated and the TTL ran out. */
  trucksExpired: number;
}

/**
 * When a truck stops being shown.
 *
 *   avail_to   -> end of that day + 24 h
 *   avail_from -> end of that day + 24 h
 *   neither    -> last sighting + 48 h
 *
 * `computeExpiry` is the job board's end-of-day helper, reused rather than
 * re-derived: "the end of the 12th, generously" is the same moment for both
 * kinds of listing, and two implementations of it would drift by an hour in
 * one season.
 */
export function truckExpiresAt(input: {
  availFrom?: string | null;
  availTo?: string | null;
  lastSeenAt: Date;
}): Date {
  const day = input.availTo ?? input.availFrom ?? null;
  if (day) return computeExpiry(day, input.lastSeenAt, DEPART_GRACE_HOURS);
  return new Date(input.lastSeenAt.getTime() + CAPACITY_TTL_HOURS * 3600_000);
}

/**
 * The sweep.
 *
 * NOTE WHAT IS MISSING, AND NOTE IT ON PURPOSE: there is no
 * `status_source = 'derived'` predicate. The job sweep has one because a manual
 * job status is a human overriding an INFERENCE ABOUT SENDER SILENCE. A truck's
 * departure date is a physical fact, not an inference. Without this deviation
 * an owner who marks a truck booked and then back to available leaves it
 * `available` + `status_source = 'manual'` and it sits on the public board for
 * ever, past its stated departure -- exactly the stale truck this whole clock
 * exists to prevent.
 *
 * Sticky statuses stay sticky all the same, because the sweep only ever touches
 * `status = 'available'`: `booked`, `departed` and `cancelled` are never
 * revisited.
 *
 * The two passes run in this order so a truck whose day has passed is recorded
 * as `departed` -- what actually happened -- rather than as `expired`, and can
 * only be counted once.
 */
export async function expireTrucks(now: Date = new Date()): Promise<TruckExpiryResult> {
  const nowIso = now.toISOString();

  // The departure day has passed, measured in the BOARD's calendar.
  //
  // The specification writes this as `$1 > (avail_to + interval '24 hours')`,
  // which is the same rule -- 24 hours of grace from the start of the departure
  // day is the rest of that day -- but `date + interval` is evaluated in the
  // DATABASE PROCESS's zone: PGlite here reports Etc/GMT-4 (whatever zone Node
  // happens to run in) and RDS reports UTC, and neither is the board's. Binding
  // the day instead is the same lesson query.ts already learned about
  // CURRENT_DATE, and it keeps the boundary at local midnight everywhere.
  const boardToday = isoOf(toLocalDate(now, DEFAULT_TZ));

  const departed = await query<{ id: number }>(
    `UPDATE trucks
        SET status = 'departed', updated_at = $1::timestamptz
      WHERE status = 'available'
        AND avail_to IS NOT NULL
        AND avail_to < $2::date
      RETURNING id`,
    [nowIso, boardToday],
  );

  const expired = await query<{ id: number }>(
    `UPDATE trucks
        SET status = 'expired', updated_at = $1::timestamptz
      WHERE status = 'available'
        AND expires_at IS NOT NULL
        AND expires_at < $1::timestamptz
      RETURNING id`,
    [nowIso],
  );

  // One event per swept truck, with the truck's OWN reason. Never
  // "sender_silent": a driver who said Tuesday and drove away on Tuesday was
  // not silent, and the admin data-quality view must not say they were.
  await stamp(departed.map((r) => r.id), "departed", "departure_passed");
  await stamp(expired.map((r) => r.id), "expired", "capacity_ttl");

  return { trucksDeparted: departed.length, trucksExpired: expired.length };
}

async function stamp(ids: number[], to: string, reason: string): Promise<void> {
  if (!ids.length) return;
  await query(
    `INSERT INTO truck_events (truck_id, kind, detail)
     SELECT id, 'status_changed',
            jsonb_build_object('to', $2::text, 'by', 'expiry_sweep', 'reason', $3::text)
       FROM trucks WHERE id = ANY($1::bigint[])`,
    [ids, to, reason],
  );
}
