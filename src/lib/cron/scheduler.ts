/**
 * The scheduler: three timers, one process, nothing else.
 *
 * WHAT IT MUST NEVER DO IS TAKE THE SERVER DOWN. This code runs inside the
 * container that serves the board, so an unhandled rejection in a sweep is not
 * "the cron failed", it is the site going away. Every layer is therefore
 * closed:
 *
 *   - each run is wrapped in its own try/catch, and the catch records and
 *     returns rather than rethrowing;
 *   - the timer callback consumes the promise with `void ... .catch()`, so even
 *     a throw from the bookkeeping cannot escape into an unhandled rejection;
 *   - a failed run does not clear its interval. The next tick still happens,
 *     because the overwhelming majority of sweep failures are transient (a
 *     database failover, a HERE budget refusal) and a scheduler that stopped on
 *     the first one would need a deploy to restart.
 *
 * A sweep also cannot take DOWN ANOTHER: they are three independent timers with
 * three independent locks and three separate try/catch blocks, staggered so
 * they do not even overlap in time. `npm run check:cron` proves that by making
 * one of them throw on every tick and watching the other two keep writing rows.
 *
 * `register()` in `src/instrumentation.ts` "must complete before the server is
 * ready to handle requests", so this function is synchronous and does no I/O:
 * it arms three timers and returns. Nothing touches the database until the
 * first timer fires, fifteen seconds later, by which time the app is serving
 * and `src/lib/db.ts` has migrated on the first real request.
 */
import { cronEnabled, cronModeReason, type SweepName } from "./config";
import { acquireSweepLock } from "./lock";
import { finishRun, runner, startRun, type SweepCounts } from "./runs";
import { SWEEP_LIST, type Sweep } from "./sweeps";

export interface SweepOverride {
  intervalMs?: number;
  firstDelayMs?: number;
}

export interface StartOptions {
  /**
   * Shorter cadences, for `npm run check:cron` only. A gate that had to wait a
   * real minute to see the process sweep fire would be a gate nobody runs.
   */
  overrides?: Partial<Record<SweepName, SweepOverride>>;
  /** Run even when `cronEnabled()` says no. The gate; never a deployment. */
  force?: boolean;
  /** Distinguishes two schedulers in one process in the log. The gate uses it. */
  label?: string;
}

export interface CronScheduler {
  stop(): void;
}

/**
 * "Only one scheduler per process" is `register()`'s problem, not this
 * function's -- the guard lives in `src/instrumentation.ts`, which is the thing
 * that can be called twice. Keeping it out of here means the gate can start a
 * genuine second scheduler and watch it skip on the lock, which is the only
 * honest way to test the behaviour that matters under `desired_count > 1`.
 */

/** "processed=3 loadsCreated=7 duplicates=0" -- the whole of what a run did. */
function formatCounts(counts: SweepCounts): string {
  const pairs = Object.entries(counts).map(([k, v]) => `${k}=${v}`);
  return pairs.length ? pairs.join(" ") : "nothing to report";
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Bookkeeping must never be the reason a sweep does not run. */
async function safeStart(sweep: SweepName, at: Date): Promise<number | null> {
  try {
    return await startRun(sweep, at);
  } catch (err) {
    console.error(`[cron] ${sweep} could not open its cron_runs row: ${message(err)}`);
    return null;
  }
}

async function safeFinish(
  id: number | null,
  sweep: SweepName,
  outcome: { status: "ok" | "error" | "skipped"; detail?: string | null; counts?: SweepCounts },
  at: Date,
  ms: number,
): Promise<void> {
  try {
    await finishRun(id, outcome, at, ms);
  } catch (err) {
    console.error(`[cron] ${sweep} could not close its cron_runs row: ${message(err)}`);
  }
}

/**
 * One tick of one sweep. This function does not throw; that is its contract.
 *
 * The row is opened before the lock is attempted, so a task that skips still
 * leaves a record saying it was awake and why it did nothing. Under
 * `desired_count > 1` that record is the only evidence the other tasks are
 * alive at all.
 */
export async function runSweepOnce(sweep: Sweep, intervalMs: number, label: string): Promise<void> {
  const startedAt = new Date();
  const t0 = Date.now();
  const runId = await safeStart(sweep.name, startedAt);
  const tail = `${sweep.intervalConstant}=${intervalMs}ms runner=${runner()}${label}`;

  const lock = await acquireSweepLock(sweep.name);
  if (!lock.ok) {
    const ms = Date.now() - t0;
    console.log(
      `[cron] ${sweep.name} skipped started=${startedAt.toISOString()} in ${ms}ms — ${lock.reason} — ${tail}`,
    );
    await safeFinish(runId, sweep.name, { status: "skipped", detail: lock.reason }, new Date(), ms);
    return;
  }

  try {
    const counts = await sweep.run(startedAt);
    const ms = Date.now() - t0;
    console.log(
      `[cron] ${sweep.name} ok started=${startedAt.toISOString()} in ${ms}ms — ` +
        `${formatCounts(counts)} — lock=${lock.via} ${tail}`,
    );
    await safeFinish(runId, sweep.name, { status: "ok", counts }, new Date(), ms);
  } catch (err) {
    const ms = Date.now() - t0;
    const detail = message(err);
    // The stack goes to the log, the sentence goes to the row: an admin reading
    // /admin needs to know WHICH sweep is broken, not where in the file.
    console.error(
      `[cron] ${sweep.name} error started=${startedAt.toISOString()} in ${ms}ms — ${detail} — ${tail}`,
      err,
    );
    await safeFinish(runId, sweep.name, { status: "error", detail }, new Date(), ms);
  } finally {
    await lock.release();
  }
}

/**
 * Arm the timers. Returns null when this process is not the one that schedules.
 *
 * Synchronous by contract -- see the header. The one thing it does before
 * returning is print what it armed, naming each interval by its constant, so
 * "is the cron on in production?" is answerable from the first page of the
 * container's log rather than by adding an endpoint and redeploying.
 */
export function startCronScheduler(options: StartOptions = {}): CronScheduler | null {
  const enabled = options.force || cronEnabled();
  if (!enabled) {
    console.log(`[cron] in-process scheduler OFF (${cronModeReason()})`);
    return null;
  }

  const label = options.label ? ` scheduler=${options.label}` : "";
  const timers: NodeJS.Timeout[] = [];
  let stopped = false;

  const armed: string[] = [];
  for (const sweep of SWEEP_LIST) {
    const override = options.overrides?.[sweep.name];
    const intervalMs = override?.intervalMs ?? sweep.intervalMs;
    const firstDelayMs = override?.firstDelayMs ?? sweep.firstDelayMs;
    armed.push(`${sweep.name} every ${sweep.intervalConstant}=${intervalMs}ms first at +${firstDelayMs}ms`);

    const tick = () => {
      if (stopped) return;
      // `void ... .catch()` and not `await`: a timer callback that returns a
      // rejected promise is an unhandled rejection, and Node's default for
      // those is to kill the process.
      void runSweepOnce(sweep, intervalMs, label).catch((err: unknown) => {
        console.error(`[cron] ${sweep.name} tick failed outside its own guard: ${message(err)}`);
      });
    };

    timers.push(
      setTimeout(() => {
        tick();
        if (!stopped) timers.push(setInterval(tick, intervalMs));
      }, firstDelayMs),
    );
  }

  // The reason is printed rather than just the answer, and `force` is never
  // allowed to masquerade as the environment having asked for this: an operator
  // reading "ON (CRON_IN_PROCESS unset, NODE_ENV=production)" in CloudWatch has
  // learned something, and "ON" on its own has not.
  const why = options.force && !cronEnabled() ? `forced by the caller; ${cronModeReason()}` : cronModeReason();
  console.log(
    `[cron] in-process scheduler ON (${why}) runner=${runner()}${label} ` +
      `db=${process.env.DATABASE_URL ? "postgres" : "pglite"} — ${armed.join("; ")}`,
  );

  return {
    stop() {
      stopped = true;
      for (const t of timers) {
        clearTimeout(t);
        clearInterval(t);
      }
      timers.length = 0;
    },
  };
}
