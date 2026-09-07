/**
 * The three sweeps, as functions.
 *
 * THE SCHEDULER CALLS THESE, NOT ITS OWN HTTP ROUTES, and that is a decision
 * rather than a shortcut. A process that fetches `http://localhost:3000/api/...`
 * to talk to itself has invented four new ways to fail -- it has to know its own
 * port and base path, it has to hold `CRON_SECRET` as a client as well as a
 * server, it goes out through the ALB's timeouts if the URL is external, and it
 * blocks one of its own request-handling slots for the length of the sweep. The
 * routes and this module call the SAME functions; neither is built on the other.
 *
 * The routes stay exactly as they were, still bearer-guarded, so an EventBridge
 * rule can drive them the day `CRON_IN_PROCESS=off` turns this off.
 */
import { runMatchSweep } from "@/lib/notify/sweep";
import { expireStaleLoads } from "@/lib/pipeline/expire";
import { processPending } from "@/lib/pipeline/process";
import { expireTrucks } from "@/lib/pipeline/trucks";
import {
  EXPIRE_EVERY_MS,
  EXPIRE_FIRST_DELAY_MS,
  MATCH_EVERY_MS,
  MATCH_FIRST_DELAY_MS,
  PROCESS_EVERY_MS,
  PROCESS_FIRST_DELAY_MS,
  type SweepName,
} from "./config";
import { pruneCronRuns, type SweepCounts } from "./runs";

export interface Sweep {
  name: SweepName;
  /** The identifier an operator greps for after reading the startup line. */
  intervalConstant: string;
  intervalMs: number;
  firstDelayMs: number;
  /** What an admin should understand this sweep to be for, in one clause. */
  what: string;
  run(now: Date): Promise<SweepCounts>;
}

/**
 * How many pending messages one tick drains.
 *
 * The HTTP route defaults to the same 25. A tick that emptied an unbounded
 * queue would hold the advisory lock -- and one database connection -- for as
 * long as the backlog took; 25 bounds the tick, and a backlog simply takes
 * several minutes to clear, which is what a queue is for.
 */
export const PROCESS_BATCH = 25;

export const SWEEPS: Record<SweepName, Sweep> = {
  process: {
    name: "process",
    intervalConstant: "PROCESS_EVERY_MS",
    intervalMs: PROCESS_EVERY_MS,
    firstDelayMs: PROCESS_FIRST_DELAY_MS,
    what: "drains pending WhatsApp messages through the extractor",
    async run(): Promise<SweepCounts> {
      const results = await processPending(PROCESS_BATCH);
      return {
        processed: results.length,
        loadsCreated: results.reduce((n, r) => n + r.loadsCreated, 0),
        duplicates: results.reduce((n, r) => n + r.duplicates, 0),
      };
    },
  },

  expire: {
    name: "expire",
    intervalConstant: "EXPIRE_EVERY_MS",
    intervalMs: EXPIRE_EVERY_MS,
    firstDelayMs: EXPIRE_FIRST_DELAY_MS,
    what: "retires jobs whose sender went silent and trucks that departed",
    async run(now: Date): Promise<SweepCounts> {
      // THREE SEPARATE NUMBERS, never a total -- the same rule the HTTP route
      // states at length. `expired` is a job whose sender went quiet,
      // `trucksDeparted` a truck whose stated day has passed, `trucksExpired` a
      // truck that never stated one. A sum of them is a figure nobody can act on.
      const { expired } = await expireStaleLoads(now);
      const { trucksDeparted, trucksExpired } = await expireTrucks(now);
      // The ledger's own housekeeping rides along on the hourly sweep rather
      // than on a fourth timer of its own.
      const runsPruned = await pruneCronRuns(now);
      return { expired, trucksDeparted, trucksExpired, runsPruned };
    },
  },

  match: {
    name: "match",
    intervalConstant: "MATCH_EVERY_MS",
    intervalMs: MATCH_EVERY_MS,
    firstDelayMs: MATCH_FIRST_DELAY_MS,
    what: "pairs trucks with jobs and writes the digests behind the bell",
    async run(now: Date): Promise<SweepCounts> {
      const s = await runMatchSweep(now);
      return {
        trucksScanned: s.trucksScanned,
        jobsScanned: s.jobsScanned,
        pairsWritten: s.pairsWritten,
        pairsUnmatched: s.pairsUnmatched,
        notificationsWritten: s.notificationsWritten,
        quieted: s.quieted,
        capped: s.capped,
        // The sweep already survives a bad subject internally and returns the
        // reasons. Counting them keeps a run that half-failed from reading as a
        // clean 'ok' -- the count lands in `cron_runs.counts` beside the rest.
        subjectErrors: s.errors.length,
      };
    },
  },
};

/** In the order they first fire, which is the order the log line prints them. */
export const SWEEP_LIST: Sweep[] = [SWEEPS.process, SWEEPS.match, SWEEPS.expire];
