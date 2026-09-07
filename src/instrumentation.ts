/**
 * Next's server-startup hook, and the only thing that starts the cron.
 *
 * `register()` is called ONCE when a new Next.js server instance is initiated
 * and MUST COMPLETE BEFORE THE SERVER IS READY TO HANDLE REQUESTS
 * (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation.md`).
 * So it awaits one dynamic import and arms three timers; it opens no database
 * connection, runs no migration and runs no sweep. Anything awaited here is
 * added to every cold start, and a sweep awaited here would be added to the
 * ALB's first health check.
 *
 * TWO GUARDS BEFORE ANYTHING IS IMPORTED, and they are the difference between a
 * scheduler and a build failure:
 *
 *   NEXT_RUNTIME. Next calls `register` in every environment, and the docs say
 *   to branch on this variable for anything a runtime does not support. The
 *   sweeps import `pg` and PGlite -- node built-ins, a wasm bundle, the
 *   filesystem -- none of which exist in the edge runtime. The import is inside
 *   the guard, not at the top of the file, so the edge bundle never even
 *   contains it.
 *
 *   NEXT_PHASE. `next build` starts server instances to prerender pages, and
 *   they run `register` too. Without this a `docker build` would start a cron
 *   that expires jobs in whatever database the build machine can see, and the
 *   timers would be armed inside a process that exits mid-tick. `next build`
 *   sets NEXT_PHASE=phase-production-build (see the constant of the same name
 *   in `next/dist/shared/lib/constants.js`).
 *
 * The third guard -- "is this process meant to schedule at all?" -- is
 * `cronEnabled()` in `src/lib/cron/config.ts`, and it lives there because the
 * answer has to be readable from the admin console as well as from here.
 */
import type { CronScheduler } from "@/lib/cron/scheduler";

/**
 * `register` can be called more than once in one process -- a hot reload in
 * development re-evaluates this module and calls it again -- and a second call
 * would arm a second set of timers on top of the first. A module-level flag
 * would be re-created by that same reload, so the flag lives on `globalThis`,
 * for the same reason `src/lib/db.ts` memoizes its backend there.
 */
const globalForCron = globalThis as unknown as { __loadlineCron?: CronScheduler | null };

export async function register(): Promise<void> {
  // WRITTEN AS A POSITIVE BRANCH, not as `if (... !== "nodejs") return`, and
  // the difference is not style. Next compiles this file once per runtime and
  // substitutes NEXT_RUNTIME as a literal while doing it, so in the EDGE bundle
  // this condition is `"edge" === "nodejs"` and the whole block -- including the
  // dynamic import inside it -- is dead code the bundler drops. An early return
  // leaves the import at the top level of a function body, where nothing can be
  // proved dead: the edge build then follows it into `pg`, which requires `fs`,
  // and fails with "Module not found: Can't resolve 'fs'". Verified by writing
  // it the other way round first.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (process.env.NEXT_PHASE === "phase-production-build") return;
    if (globalForCron.__loadlineCron) return;

    const { startCronScheduler } = await import("@/lib/cron/scheduler");
    globalForCron.__loadlineCron = startCronScheduler();
  }
}
