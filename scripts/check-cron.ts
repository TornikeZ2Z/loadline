/**
 * The scheduler gate. npm run check:cron
 *
 * WHAT THIS EXISTS TO CATCH is a scheduler that looks armed and does nothing —
 * the failure the whole change is a fix for. Three bearer-guarded routes sat in
 * this repo for weeks with nothing calling them, and no suite noticed, because
 * every suite tested the SWEEPS and none tested whether anything ran them. So
 * this one starts the real scheduler, with the real sweeps, against a real
 * (throwaway) database, and reads the evidence out of `cron_runs` afterwards.
 *
 * FOUR CLAIMS, and each one is a thing that has to keep being true:
 *
 *   1. EVERY SWEEP RUNS AND LEAVES A ROW. Start the scheduler on 200 ms
 *      cadences and wait; each of the three must have an 'ok' row with a
 *      finished_at and a counts object. A sweep that threw on import, or one
 *      that was left out of SWEEP_LIST, fails here.
 *   2. A SECOND SCHEDULER SKIPS. Two schedulers in one process, both awake at
 *      once, and the second must write 'skipped' rows rather than run the sweep
 *      twice. This is the `desired_count > 1` behaviour, tested on the only
 *      backend a laptop has.
 *   3. A THROWING SWEEP IS CONTAINED. One sweep is replaced with one that
 *      always throws; it must record 'error' rows AND the other two must keep
 *      recording 'ok' rows on their own cadences. A scheduler where one bad
 *      sweep silences the others is worse than no scheduler, because the log
 *      still says it started.
 *   4. THE READOUT AGREES WITH THE LEDGER. `cronStatus()` — what /admin renders
 *      — must call a sweep stale exactly when its last completed run is older
 *      than twice its interval, and not stale when it is not.
 *
 * WHAT IT CANNOT PROVE, said plainly rather than left implied: PGlite has
 * `pg_try_advisory_lock` and this gate exercises it, but PGlite holds ONE
 * session per data directory and a second process cannot open that directory at
 * all — so the lock here can never be refused, and claim 2 passes on the
 * in-process Set in `src/lib/cron/lock.ts`. The cross-TASK exclusion is the
 * `pg.Client` path, and it is only ever exercised against real Postgres. See
 * `.design/impl/cron-in-process.md`.
 *
 * Runs against its own PGlite directory, never `./.pgdata`: PGlite is
 * single-writer and a gate that fought a running `npm run dev` for the lock
 * would fail for a reason that has nothing to do with cron.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = path.join(os.tmpdir(), `loadline-cron-gate-${process.pid}`);
fs.rmSync(DIR, { recursive: true, force: true });
process.env.PGLITE_DIR = DIR;
// The gate is not production and must not be mistaken for it: `force` starts
// the scheduler explicitly rather than by pretending NODE_ENV is something it
// is not, which would change how src/lib/db.ts memoizes its backend.
delete process.env.DATABASE_URL;

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

let checks = 0;
const failures: string[] = [];
function assert(ok: boolean, what: string): void {
  checks++;
  if (!ok) failures.push(what);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Short enough that the whole gate is seconds, staggered like the real ones. */
const TICK = 200;
const OVERRIDES = {
  process: { intervalMs: TICK, firstDelayMs: 20 },
  match: { intervalMs: TICK, firstDelayMs: 60 },
  expire: { intervalMs: TICK, firstDelayMs: 100 },
} as const;

interface RunRow {
  id: number;
  sweep: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  detail: string | null;
  counts: Record<string, number>;
  runner: string | null;
}

async function rows(): Promise<RunRow[]> {
  const { query } = await import("../src/lib/db");
  return query<RunRow>(
    `SELECT id, sweep, status, started_at::text AS started_at, finished_at::text AS finished_at,
            duration_ms, detail, counts, runner
       FROM cron_runs ORDER BY id`,
  );
}

async function main(): Promise<void> {
  const { SWEEPS, SWEEP_LIST } = await import("../src/lib/cron/sweeps");
  const { runSweepOnce, startCronScheduler } = await import("../src/lib/cron/scheduler");
  const { cronStatus } = await import("../src/lib/cron/runs");
  const { acquireSweepLock, closeLockConnection } = await import("../src/lib/cron/lock");
  const { query } = await import("../src/lib/db");

  // Touch the database once up front so the schema is migrated before the first
  // tick, and the gate measures the scheduler rather than a cold migration.
  await query(`SELECT 1`);

  console.log(`${DIM}cron gate on ${DIR} (pglite)${RESET}`);

  // --- 1. every sweep runs and leaves a row ---------------------------------

  const a = startCronScheduler({ force: true, overrides: OVERRIDES, label: "A" });
  assert(a !== null, "startCronScheduler({force:true}) returned null — nothing was armed");
  await sleep(1400);

  {
    const all = await rows();
    for (const sweep of SWEEP_LIST) {
      const ok = all.filter((r) => r.sweep === sweep.name && r.status === "ok");
      assert(ok.length > 0, `${sweep.name} never completed a run (rows: ${JSON.stringify(all.filter((r) => r.sweep === sweep.name))})`);
      const last = ok[ok.length - 1];
      assert(!!last?.finished_at, `${sweep.name} has an 'ok' row with no finished_at`);
      assert(typeof last?.duration_ms === "number", `${sweep.name} recorded no duration`);
      assert(!!last && typeof last.counts === "object" && last.counts !== null, `${sweep.name} recorded no counts object`);
      assert(!!last?.runner, `${sweep.name} recorded no runner`);
    }
    // The expiry sweep prunes the ledger; the key has to be there even at zero,
    // or the readout's "nothing to do" is hiding a pruner that never ran.
    const expire = all.find((r) => r.sweep === "expire" && r.status === "ok");
    assert(expire != null && "runsPruned" in expire.counts, "the expiry sweep did not report runsPruned");
    console.log(`${DIM}  ${all.length} rows after 1.4 s of three 200 ms sweeps${RESET}`);
  }

  a?.stop();

  // --- 2. a second scheduler skips ------------------------------------------

  // First the mechanism, deterministically: hold the lock by hand and let a
  // scheduler tick land on it. No timing, no sleep, no chance of a green run
  // that raced past the thing it was meant to test.
  {
    const before = (await rows()).length;
    const held = await acquireSweepLock("process");
    assert(held.ok, "the lock was refused on an idle process");
    await runSweepOnce(SWEEPS.process, TICK, " gate");
    if (held.ok) await held.release();

    const written = (await rows()).slice(before).filter((r) => r.sweep === "process");
    assert(written.length === 1, `one tick against a held lock wrote ${written.length} rows`);
    assert(
      written[0]?.status === "skipped",
      `a tick against a held lock recorded '${written[0]?.status}' instead of 'skipped'`,
    );
    assert(
      (written[0]?.detail ?? "").length > 0,
      "a skipped run recorded no reason, so an admin cannot tell a lock from a fault",
    );
    console.log(`${DIM}  held lock → ${written[0]?.detail}${RESET}`);

    const after = await acquireSweepLock("process");
    assert(after.ok, "the lock was not released — that sweep would be wedged for the life of the process");
    if (after.ok) await after.release();
  }

  // Then the behaviour, through two real schedulers. The sweep is slowed to
  // three ticks' worth of work so the overlap is arithmetic rather than luck: a
  // run that takes 600 ms on a 200 ms interval is still going when the next two
  // ticks fire, from either scheduler.
  {
    const before = (await rows()).length;
    const good = SWEEPS.process.run;
    SWEEPS.process.run = async () => {
      await sleep(600);
      return { processed: 0, loadsCreated: 0, duplicates: 0 };
    };

    const one = startCronScheduler({ force: true, overrides: OVERRIDES, label: "A" });
    const two = startCronScheduler({ force: true, overrides: OVERRIDES, label: "B" });
    assert(two !== null, "the second scheduler refused to start, so nothing was proved about the lock");
    await sleep(1600);
    one?.stop();
    two?.stop();
    // Let whatever was mid-flight finish before reading the ledger.
    await sleep(700);
    SWEEPS.process.run = good;

    const mine = (await rows()).slice(before).filter((r) => r.sweep === "process");
    const skipped = mine.filter((r) => r.status === "skipped");
    assert(
      skipped.length > 0,
      "two schedulers ran a 600 ms sweep on a 200 ms interval and NOT ONE run was skipped — the lock is excluding nothing",
    );

    // The claim the lock actually makes: the work never happened twice at once.
    // Checked against the ledger rather than against the log, because this is
    // the property that matters when the two runners are two Fargate tasks.
    const done = mine
      .filter((r) => r.status === "ok" && r.finished_at)
      .map((r) => ({ from: new Date(r.started_at).getTime(), to: new Date(r.finished_at!).getTime() }))
      .sort((x, y) => x.from - y.from);
    const overlap = done.findIndex((r, i) => i > 0 && r.from < done[i - 1]!.to);
    assert(
      overlap === -1,
      `two completed 'process' runs overlapped in time (${JSON.stringify(done.slice(Math.max(0, overlap - 1), overlap + 1))})`,
    );
    console.log(
      `${DIM}  ${done.length} runs completed, ${skipped.length} skipped, none overlapping${RESET}`,
    );
  }

  // --- 3. a throwing sweep is contained -------------------------------------

  {
    const good = SWEEPS.match.run;
    SWEEPS.match.run = async () => {
      throw new Error("gate: deliberate sweep failure");
    };
    const before = (await rows()).length;
    const c = startCronScheduler({ force: true, overrides: OVERRIDES, label: "C" });
    await sleep(1200);
    c?.stop();
    SWEEPS.match.run = good;

    const all = (await rows()).slice(before);
    const errors = all.filter((r) => r.sweep === "match" && r.status === "error");
    assert(errors.length > 0, "a sweep that throws on every tick recorded no 'error' row");
    assert(
      errors.every((r) => (r.detail ?? "").includes("deliberate sweep failure")),
      `the error row does not carry the message: ${JSON.stringify(errors[0]?.detail)}`,
    );
    assert(
      errors.length > 1,
      "the throwing sweep ran once and stopped — an error must not cancel the interval",
    );
    for (const name of ["process", "expire"]) {
      assert(
        all.some((r) => r.sweep === name && r.status === "ok"),
        `${name} stopped completing while the match sweep was throwing — one sweep took another down`,
      );
    }
    console.log(
      `${DIM}  match threw ${errors.length}× and process/expire kept completing${RESET}`,
    );
  }

  // --- 4. the readout agrees with the ledger --------------------------------

  {
    const fresh = await cronStatus({ enabled: true, reason: "gate" });
    assert(fresh.sweeps.length === 3, `cronStatus returned ${fresh.sweeps.length} sweeps, expected 3`);
    for (const s of fresh.sweeps) {
      assert(s.lastOk != null, `${s.sweep} has no completed run in the readout`);
      assert(
        s.intervalMs > 0,
        `${s.sweep} reports no interval, so "twice its interval" is not computable`,
      );
    }
    assert(
      fresh.sweeps.every((s) => !s.stale),
      `a sweep that completed seconds ago is reported stale: ${JSON.stringify(fresh.sweeps.filter((s) => s.stale).map((s) => s.sweep))}`,
    );

    // Now ask the same question from far enough in the future that everything
    // must be stale. The threshold is the claim; a readout that never goes red
    // is decoration.
    const later = new Date(Date.now() + 3 * 3_600_000);
    const aged = await cronStatus({ enabled: true, reason: "gate", now: later });
    assert(
      aged.sweeps.every((s) => s.stale),
      `three hours on, some sweep is still reported fresh: ${JSON.stringify(aged.sweeps.filter((s) => !s.stale).map((s) => s.sweep))}`,
    );

    // A sweep with no run at all is stale, not "no data": that is the state on
    // the morning after a deploy where the scheduler never started.
    await query(`DELETE FROM cron_runs WHERE sweep = 'expire'`);
    const gone = await cronStatus({ enabled: true, reason: "gate" });
    const expire = gone.sweeps.find((s) => s.sweep === "expire");
    assert(expire?.last == null && expire?.stale === true, "a sweep that never ran is not reported stale");
  }

  await closeLockConnection();

  const kinds = await query<{ status: string; n: number }>(
    `SELECT status, count(*)::int AS n FROM cron_runs GROUP BY status ORDER BY status`,
  );
  console.log(
    `${DIM}cron_runs: ${kinds.map((k) => `${k.n} ${k.status}`).join(", ")}${RESET}`,
  );
}

main()
  .then(() => {
    if (failures.length) {
      console.log(`\n${RED}${failures.length} of ${checks} scheduler checks failed${RESET}`);
      for (const f of failures) console.log(`  ${RED}✗${RESET} ${f}`);
      process.exit(1);
    }
    console.log(`\n${GREEN}✓${RESET} ${checks} scheduler checks passed\n`);
    process.exit(0);
  })
  .catch((err: unknown) => {
    console.error(`${RED}cron gate crashed${RESET}`, err);
    process.exit(1);
  })
  .finally(() => {
    fs.rmSync(DIR, { recursive: true, force: true });
  });
