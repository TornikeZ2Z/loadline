/**
 * One sweep at a time, across every task in the service.
 *
 * `desired_count` is 1 today. It will not stay 1, and the failure that arrives
 * on the day it becomes 2 is silent: two tasks drain `raw_messages` at the same
 * minute, two tasks run the match sweep against the same watermark, and the
 * board looks fine while the notification cap is decided by a race. So the
 * exclusion is built now, while it costs one query, rather than diagnosed later.
 *
 * TWO GATES, IN THIS ORDER, and both are load-bearing.
 *
 *   1. AN IN-PROCESS SET. Postgres advisory locks are re-entrant per SESSION:
 *      the same connection asking twice is granted twice. So a second scheduler
 *      inside one process -- a stray second `register()`, a hot reload, the gate
 *      script starting two -- would sail straight through the advisory lock and
 *      run the sweep twice. The Set is what refuses it, and it is checked first
 *      because it is the cheaper of the two and the only one that can catch it.
 *
 *   2. `pg_try_advisory_lock`, which is the cross-TASK gate and the only one
 *      that matters in production. It is `try`, never the blocking form: a task
 *      that cannot get the lock has nothing to wait for -- whoever holds it is
 *      doing the identical work -- so it writes a 'skipped' row saying why and
 *      goes back to sleep until its next tick. A blocking wait would pile up a
 *      queue of processes each about to do work that is already done.
 *
 * WHY THE LOCK GETS ITS OWN CONNECTION. `src/lib/db.ts` serves production from
 * a `pg.Pool` of ten, and an advisory lock belongs to the SESSION that took it:
 * `pg_try_advisory_lock` on one pooled connection and `pg_advisory_unlock` on
 * another does not unlock anything, it fails with a warning and leaks the lock
 * until the process dies. So the lock lives on one dedicated `pg.Client` that
 * takes and releases on itself. That is also why the lock is self-healing: if
 * the task is killed mid-sweep, the connection dies with it and Postgres drops
 * the lock. No lease, no expiry column, nothing to clean up.
 *
 * WHAT PGLITE CAN AND CANNOT PROVE. PGlite has `pg_try_advisory_lock` and it
 * works -- it is real Postgres -- so the same statement runs on both backends
 * and neither path is untested SQL. What PGlite cannot do is ever REFUSE one:
 * there is exactly one session per data directory (a second process cannot even
 * open `./.pgdata`, PGlite is single-writer), so the lock is always available
 * and always re-entrant. Locally, gate 1 is the whole of the exclusion; in
 * production, gate 2 is. `npm run check:cron` proves each on the backend that
 * can actually demonstrate it, and says so rather than implying the local pass
 * covers the deployed path.
 */
import { dbKind, query } from "@/lib/db";
import type { SweepName } from "./config";

type PgClient = import("pg").Client;

/**
 * The high half of the lock key: "load" as four ASCII bytes, big-endian.
 *
 * The two-int form of `pg_try_advisory_lock` rather than the one-bigint form,
 * so the namespace is visible in `pg_locks.classid` when somebody is staring at
 * a stuck lock. Nothing else in this database takes an advisory lock, but a
 * shared RDS instance one day might.
 */
export const ADVISORY_NAMESPACE = 0x6c6f6164; // 1_819_238_756, and inside int4

/** A stable key per sweep. These are written down, never derived from a hash. */
export const SWEEP_LOCK_KEYS: Record<SweepName, number> = {
  process: 1,
  expire: 2,
  match: 3,
};

export interface LockHeld {
  ok: true;
  /** Which gate is doing the real work here, for the run's log line. */
  via: "advisory-pg" | "advisory-pglite";
  release(): Promise<void>;
}

export interface LockRefused {
  ok: false;
  /** A sentence for the log line and the `cron_runs.detail` column. */
  reason: string;
}

export type LockResult = LockHeld | LockRefused;

/** Gate 1. Module scope, so two schedulers in one process share it. */
const runningHere = new Set<SweepName>();

let clientPromise: Promise<PgClient> | null = null;

/**
 * The dedicated lock connection, made once and kept.
 *
 * `client.on("error")` is not optional: an idle `pg.Client` whose connection is
 * dropped by RDS emits an error event, and an unhandled `error` on an
 * EventEmitter takes the whole server down. Handling it by forgetting the
 * client means the next sweep reconnects instead.
 */
async function lockClient(url: string): Promise<PgClient> {
  clientPromise ??= (async () => {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: url });
    client.on("error", (err: Error) => {
      console.error(`[cron] lock connection dropped (${err.message}); reconnecting on the next tick`);
      clientPromise = null;
    });
    await client.connect();
    return client;
  })().catch((err: unknown) => {
    clientPromise = null;
    throw err;
  });
  return clientPromise;
}

async function pgTryLock(url: string, key: number): Promise<boolean> {
  const client = await lockClient(url);
  const res = await client.query<{ ok: boolean }>(
    `SELECT pg_try_advisory_lock($1::int, $2::int) AS ok`,
    [ADVISORY_NAMESPACE, key],
  );
  return res.rows[0]?.ok === true;
}

async function pgUnlock(url: string, key: number): Promise<void> {
  const client = await lockClient(url);
  await client.query(`SELECT pg_advisory_unlock($1::int, $2::int)`, [ADVISORY_NAMESPACE, key]);
}

/**
 * Take the lock for one sweep, or say why not.
 *
 * Every refusal path removes the sweep from the in-process Set before it
 * returns. A refusal that forgot to would wedge that sweep for the life of the
 * process -- which is the failure mode a lock is supposed to prevent, arriving
 * through the lock.
 */
export async function acquireSweepLock(sweep: SweepName): Promise<LockResult> {
  if (runningHere.has(sweep)) {
    return { ok: false, reason: `the previous ${sweep} run in this process has not finished` };
  }
  runningHere.add(sweep);

  const key = SWEEP_LOCK_KEYS[sweep];
  const url = process.env.DATABASE_URL;

  try {
    if (url) {
      if (!(await pgTryLock(url, key))) {
        runningHere.delete(sweep);
        return {
          ok: false,
          reason: `advisory lock ${ADVISORY_NAMESPACE}/${key} is held by another task`,
        };
      }
      return {
        ok: true,
        via: "advisory-pg",
        async release() {
          try {
            await pgUnlock(url, key);
          } catch (err) {
            // A failed unlock is not the sweep's failure, and it is not fatal:
            // the lock dies with the connection. Say so and carry on.
            console.error(
              `[cron] could not release advisory lock ${ADVISORY_NAMESPACE}/${key}: ` +
                `${err instanceof Error ? err.message : String(err)}`,
            );
          } finally {
            runningHere.delete(sweep);
          }
        },
      };
    }

    // PGlite: one session, so this is a formality that keeps the statement
    // exercised on both backends. It cannot refuse; gate 1 above is what did.
    const rows = await query<{ ok: boolean }>(
      `SELECT pg_try_advisory_lock($1::int, $2::int) AS ok`,
      [ADVISORY_NAMESPACE, key],
    );
    if (rows[0]?.ok !== true) {
      runningHere.delete(sweep);
      return { ok: false, reason: `advisory lock ${ADVISORY_NAMESPACE}/${key} was refused` };
    }
    return {
      ok: true,
      via: "advisory-pglite",
      async release() {
        try {
          await query(`SELECT pg_advisory_unlock($1::int, $2::int)`, [ADVISORY_NAMESPACE, key]);
        } catch (err) {
          console.error(
            `[cron] could not release advisory lock ${ADVISORY_NAMESPACE}/${key}: ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
        } finally {
          runningHere.delete(sweep);
        }
      },
    };
  } catch (err) {
    runningHere.delete(sweep);
    return {
      ok: false,
      reason: `could not reach the lock: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Which backend the locks are actually running on, for the startup log line.
 *
 * Printed because the two sentences an operator needs are different: on `pg`
 * the lock excludes other TASKS, on `pglite` it excludes nothing and the
 * process Set is the exclusion. A log line that said only "locking enabled"
 * would let someone believe the local run had proved the deployed behaviour.
 */
export async function lockBackend(): Promise<"pg" | "pglite"> {
  return dbKind();
}

/** Close the dedicated lock connection. Used by the gate; a server never does. */
export async function closeLockConnection(): Promise<void> {
  const pending = clientPromise;
  clientPromise = null;
  if (!pending) return;
  try {
    const client = await pending;
    await client.end();
  } catch {
    // Nothing to do about a connection that was already gone.
  }
}
