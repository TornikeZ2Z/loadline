/**
 * The `cron_runs` ledger, and the question the admin console actually asks of
 * it: "is anything not running?"
 *
 * A log line in CloudWatch is not observability for the person who needs this.
 * The people who look after this board reach it through `/admin` and a browser;
 * getting to a container log means an AWS console, a role and knowing the log
 * group exists. So every run writes a row, and the console reads the last one
 * per sweep.
 *
 * THE ROW IS OPENED BEFORE THE WORK AND CLOSED AFTER IT. That ordering is the
 * only way a hung sweep is distinguishable from a sweep that never started: the
 * first leaves a 'running' row that stops moving, the second leaves nothing.
 */
import os from "node:os";
import { query, queryOne } from "@/lib/db";
import {
  EXPIRE_EVERY_MS,
  MATCH_EVERY_MS,
  PROCESS_EVERY_MS,
  SWEEP_NAMES,
  type SweepName,
} from "./config";

export type CronRunStatus = "running" | "ok" | "error" | "skipped";

/** Whatever this sweep counts. Never summed across sweeps -- see db/schema.sql. */
export type SweepCounts = Record<string, number>;

export interface CronRunRow {
  id: number;
  sweep: string;
  status: CronRunStatus;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  detail: string | null;
  counts: SweepCounts;
  runner: string | null;
}

export interface CronSweepStatus {
  sweep: SweepName;
  /** The cadence this sweep is configured for, so the reader can judge the gap. */
  intervalMs: number;
  /** The most recent run of any outcome, including a skip. */
  last: CronRunRow | null;
  /** The most recent run that actually completed. What staleness is measured on. */
  lastOk: CronRunRow | null;
  /** No completed run within twice the interval. The red line. */
  stale: boolean;
}

export interface CronStatus {
  /** Whether THIS process schedules the sweeps. See src/lib/cron/config.ts. */
  enabled: boolean;
  /** Which of the three switch states produced that, in words. */
  reason: string;
  /** Server time, so a browser in another zone renders the gaps correctly. */
  now: string;
  sweeps: CronSweepStatus[];
}

export const SWEEP_INTERVAL_MS: Record<SweepName, number> = {
  process: PROCESS_EVERY_MS,
  expire: EXPIRE_EVERY_MS,
  match: MATCH_EVERY_MS,
};

/**
 * Who ran it. Hostname plus pid, because on Fargate the hostname IS the
 * container id: two 'skipped, lock held' rows with two different runners is the
 * multi-task story told by the data rather than inferred from it.
 */
let runnerId: string | null = null;
export function runner(): string {
  runnerId ??= `${os.hostname()}/${process.pid}`;
  return runnerId;
}

const ROW_COLUMNS = `
  id, sweep, status,
  started_at::text  AS started_at,
  finished_at::text AS finished_at,
  duration_ms, detail, counts, runner`;

/** Open a run. Returns the row id the finisher closes. */
export async function startRun(sweep: SweepName, startedAt: Date): Promise<number | null> {
  const row = await queryOne<{ id: number }>(
    `INSERT INTO cron_runs (sweep, status, started_at, runner)
     VALUES ($1, 'running', $2::timestamptz, $3)
     RETURNING id`,
    [sweep, startedAt.toISOString(), runner()],
  );
  return row?.id ?? null;
}

/**
 * Close a run.
 *
 * `id` is nullable on purpose: if the INSERT itself failed -- the database was
 * unreachable for the second the sweep began -- the sweep must still run and
 * still be logged. Bookkeeping that can prevent the work is worse than no
 * bookkeeping.
 */
export async function finishRun(
  id: number | null,
  outcome: { status: Exclude<CronRunStatus, "running">; detail?: string | null; counts?: SweepCounts },
  finishedAt: Date,
  durationMs: number,
): Promise<void> {
  if (id == null) return;
  await query(
    `UPDATE cron_runs
        SET status = $2, finished_at = $3::timestamptz, duration_ms = $4,
            detail = $5, counts = $6::jsonb
      WHERE id = $1`,
    [
      id,
      outcome.status,
      finishedAt.toISOString(),
      Math.round(durationMs),
      outcome.detail ?? null,
      JSON.stringify(outcome.counts ?? {}),
    ],
  );
}

/**
 * How long the ledger is kept.
 *
 * Two weeks is longer than any question anyone asks of it ("did it run last
 * night?", "when did that job expire?") and short enough that the table never
 * becomes a thing to think about: the process sweep alone writes 1 440 rows a
 * day, so this caps it near 20 000 rows.
 */
export const CRON_RUN_RETENTION_DAYS = 14;

/**
 * Drop what has aged out. Called from inside the hourly expiry sweep rather
 * than on a fourth timer -- it is the same kind of work, on the same cadence,
 * and a timer whose only job is a DELETE is a timer that gets forgotten.
 */
export async function pruneCronRuns(now: Date, days = CRON_RUN_RETENTION_DAYS): Promise<number> {
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  const rows = await query<{ id: number }>(
    `DELETE FROM cron_runs WHERE started_at < $1::timestamptz RETURNING id`,
    [cutoff],
  );
  return rows.length;
}

/**
 * Postgres `::text` renders a timestamptz as `2026-09-08 00:43:49.975+04`: a
 * space instead of a `T` and a two-digit offset with no minutes. V8 parses it,
 * which is why the rest of this codebase gets away with it on the SERVER --
 * but this row is JSON on its way to a browser, and JavaScriptCore returns NaN
 * for that shape. So it is normalized here, in Node, where the parse is known
 * to work, and the wire carries ISO 8601.
 */
function iso(stamp: string | null): string | null {
  if (!stamp) return null;
  const ms = new Date(stamp).getTime();
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function wire(row: CronRunRow): CronRunRow {
  return { ...row, started_at: iso(row.started_at) ?? row.started_at, finished_at: iso(row.finished_at) };
}

/**
 * The readout, in two indexed queries rather than six.
 *
 * `DISTINCT ON (sweep)` twice: once over everything for "what happened last",
 * once over the completed runs for "when did it last WORK". Those are different
 * rows the moment a sweep starts skipping or failing, and showing only the
 * first is how a board that has not expired anything for a day still looks
 * green.
 */
export async function cronStatus(opts?: { enabled: boolean; reason: string; now?: Date }): Promise<CronStatus> {
  const now = opts?.now ?? new Date();

  const last = await query<CronRunRow>(
    `SELECT DISTINCT ON (sweep) ${ROW_COLUMNS}
       FROM cron_runs ORDER BY sweep, started_at DESC, id DESC`,
  );
  const done = await query<CronRunRow>(
    `SELECT DISTINCT ON (sweep) ${ROW_COLUMNS}
       FROM cron_runs WHERE status = 'ok'
      ORDER BY sweep, finished_at DESC, id DESC`,
  );

  const lastBy = new Map(last.map((r) => [r.sweep, wire(r)]));
  const okBy = new Map(done.map((r) => [r.sweep, wire(r)]));

  return {
    enabled: opts?.enabled ?? false,
    reason: opts?.reason ?? "",
    now: now.toISOString(),
    sweeps: SWEEP_NAMES.map((sweep) => {
      const intervalMs = SWEEP_INTERVAL_MS[sweep];
      const lastOk = okBy.get(sweep) ?? null;
      const at = lastOk?.finished_at ? new Date(lastOk.finished_at).getTime() : null;
      return {
        sweep,
        intervalMs,
        last: lastBy.get(sweep) ?? null,
        lastOk,
        // Never completed counts as stale. A sweep that has produced nothing
        // since the container started is the exact case this readout exists to
        // surface, and "no data yet" would hide it behind a shrug.
        stale: at == null || now.getTime() - at > 2 * intervalMs,
      };
    }),
  };
}
