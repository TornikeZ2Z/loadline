/**
 * When the in-process scheduler runs, and how often each sweep fires.
 *
 * WHY IN-PROCESS AT ALL. `docs/superpowers/specs/2026-09-06-aws-deployment-design.md`
 * line 28 deferred this -- "An EventBridge Scheduler is a later addition" -- and
 * the later addition never arrived, because `infra/` cannot be applied from the
 * machine this project is developed on. Three bearer-guarded routes existed and
 * nothing called them: jobs never expired, trucks never departed, and the bell
 * rendered a permanent zero. A scheduler that ships inside the container needs
 * no AWS step and is live the moment the next image deploys.
 *
 * THE THREE STATES, and the middle one is the reason the switch exists:
 *
 *   CRON_IN_PROCESS unset  -> on in production, off everywhere else
 *   CRON_IN_PROCESS=off    -> off, so an external scheduler can take over
 *   CRON_IN_PROCESS=on     -> on, for testing it locally
 *
 * `off` is what makes this reversible without a code change. The day EventBridge
 * does get created, set `CRON_IN_PROCESS=off` on the task definition and point
 * the rule at the three HTTP routes, which are still there and still bearer-
 * guarded; nothing is deleted and nothing is rebuilt. See `infra/README.md`.
 */

/** The three sweeps, in the order they first fire. */
export type SweepName = "process" | "expire" | "match";

export const SWEEP_NAMES: readonly SweepName[] = ["process", "expire", "match"] as const;

/**
 * How often each sweep fires. Named constants because they are printed by name
 * in the startup log line -- an operator reading `MATCH_EVERY_MS=180000` in
 * CloudWatch can grep this file for the reasoning and does not have to infer
 * the cadence from timestamps.
 */

/**
 * Every minute, which is what `src/app/api/cron/process/route.ts` asks for:
 * "Meta retries deliveries that do not get a fast 200", so the webhook enqueues
 * and this drains. There is no WhatsApp number connected yet, so today every
 * tick is one indexed UPDATE ... WHERE status = 'pending' that claims nothing.
 * That is the correct thing to pay: the cadence has to already be right on the
 * day a number is connected, because the failure it prevents -- a queue quietly
 * filling while the board looks fine -- is invisible until someone reads the
 * table.
 */
export const PROCESS_EVERY_MS = 60_000;

/**
 * "Point the scheduler here every few minutes" -- the match route's own comment.
 * Three minutes is inside "a few" and comfortably inside the 12-hour digest cap,
 * so the cadence never decides how much mail a person gets; `DIGEST_COOLDOWN_HOURS`
 * does.
 */
export const MATCH_EVERY_MS = 180_000;

/**
 * Hourly. Both halves of the expiry sweep are day-grained -- a job expires four
 * days after its sender went quiet, a truck a day after its stated departure --
 * so the finest resolution that means anything is a day, and an hour is already
 * sixty times finer than the thing being measured. A minute would be a wasted
 * pair of UPDATEs fifty-nine times an hour.
 */
export const EXPIRE_EVERY_MS = 3_600_000;

/**
 * How long after boot each sweep first fires.
 *
 * TWO JOBS, and the first is `register()`'s contract: Next calls it once per
 * server instance and "must complete before the server is ready to handle
 * requests", so nothing may be awaited in it. The first tick is a timer, which
 * means the schema migration in `src/lib/db.ts` runs when the first REQUEST
 * asks for it, not in a race with the sweep -- and even if a sweep did get there
 * first, `backendPromise ??= connect()` memoizes the whole connect-and-migrate,
 * so both callers await the same one. Fifteen seconds is comfortably past the
 * ALB's first health check either way.
 *
 * The second is the stagger, and it is arithmetic rather than a hope. The
 * offsets are 15 s, 30 s and 45 s and every interval is a multiple of 60 s, so
 * the ticks sit at 15, 30 and 45 seconds past the minute FOR EVER: three
 * distinct residues mod 60 000 ms, which cannot coincide however many times
 * they repeat. Three sweeps landing in the same second would contend for the
 * same pool of ten connections at the moment a request needs one.
 */
export const PROCESS_FIRST_DELAY_MS = 15_000;
export const MATCH_FIRST_DELAY_MS = 30_000;
export const EXPIRE_FIRST_DELAY_MS = 45_000;

/** How the switch reads, verbatim, for the log line and the admin readout. */
export type CronMode = "on" | "off" | "default";

export function cronMode(): CronMode {
  const raw = (process.env.CRON_IN_PROCESS ?? "").trim().toLowerCase();
  if (raw === "on" || raw === "1" || raw === "true") return "on";
  if (raw === "off" || raw === "0" || raw === "false") return "off";
  return "default";
}

/** The one decision: does this process run the sweeps? */
export function cronEnabled(): boolean {
  const mode = cronMode();
  if (mode === "on") return true;
  if (mode === "off") return false;
  return process.env.NODE_ENV === "production";
}

/** A sentence saying which of the three states produced that answer. */
export function cronModeReason(): string {
  const mode = cronMode();
  if (mode === "on") return "CRON_IN_PROCESS=on";
  if (mode === "off") return "CRON_IN_PROCESS=off";
  return `CRON_IN_PROCESS unset, NODE_ENV=${process.env.NODE_ENV ?? "undefined"}`;
}
