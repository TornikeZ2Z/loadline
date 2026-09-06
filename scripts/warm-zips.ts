/**
 * Pre-fetch a point for every ZIP the board has seen, and move the jobs that
 * were waiting on it. `npm run zips:warm`
 *
 * Each ZIP costs one HERE call ever (the answer is cached in `places` as
 * zip:<5>). With no HERE_API_KEY the pipeline stores an honest approximation
 * (source 'zip-approx', the nearest gazetteer city in the ZIP's state); this
 * upgrades those rows once a key is configured, and warms any ZIP that is not
 * cached at all.
 *
 * The work itself lives in src/lib/geo/zips.ts, because production cannot run
 * a script: RDS is inside the VPC and only the app can reach it. The same
 * sweep is exposed at POST /api/admin/geocode for that case — this file is the
 * local, no-auth way in, and both share one implementation so they cannot
 * drift.
 *
 * Note: tsx does not load .env.local -- pass the key explicitly:
 *   HERE_API_KEY=... npm run zips:warm
 */
import { surveyBoardZips, warmBoardZips, WARM_BATCH_MAX } from "../src/lib/geo/zips";
import { hereConfigured } from "../src/lib/geo/here";

async function main() {
  const survey = await surveyBoardZips();
  console.log(
    `${survey.boardZips} distinct ZIPs on the board; ${survey.precise} precise, ` +
      `${survey.approximate} approximate, ${survey.uncached} never geocoded; ` +
      `${survey.coarsePickups + survey.coarseDeliveries} job endpoints still drawn approximate; ` +
      `HERE ${hereConfigured() ? "configured" : "NOT configured (offline approximations only)"}`,
  );

  let after: string | null = null;
  let fetched = 0;
  let upgraded = 0;
  let skipped = 0;
  let unresolved = 0;
  let loads = 0;

  // The API hands out one batch per request so a button never hangs; a script
  // has no such constraint, so it just runs the sweep to the end.
  for (;;) {
    const r = await warmBoardZips({ limit: WARM_BATCH_MAX, after });
    fetched += r.fetched;
    upgraded += r.upgraded;
    skipped += r.skipped;
    unresolved += r.unresolved;
    loads += r.loadsUpdated;
    if (r.done) break;
    after = r.nextAfter;
  }

  console.log(
    `fetched ${fetched}, upgraded ${upgraded} approximations, skipped ${skipped}, ` +
      `${unresolved} still unresolved; ${loads} jobs re-placed`,
  );
}

/**
 * PGlite holds the loop open, so the exit has to be explicit — but calling
 * `process.exit(0)` the instant the last await resolves races libuv's teardown
 * of the sockets the concurrent HERE fetches just finished with. On Windows
 * that race aborts the process (`Assertion failed:
 * !(handle->flags & UV_HANDLE_CLOSING)`) and turns a run that did all its work
 * correctly into a non-zero exit. One turn of the timer queue is enough.
 */
main().then(
  async () => {
    await new Promise((r) => setTimeout(r, 100));
    process.exit(0);
  },
  (e) => { console.error(e); process.exit(1); },
);
