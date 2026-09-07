/**
 * The two directions, and the draft preview. Where the pure decision meets the
 * database.
 *
 * The shape is the same three steps every time, and the ORDER of them is the
 * point: a cheap prefilter, then `evaluateMatch` over every candidate with
 * nothing skipped, then the full public rows for the survivors only. Every
 * refusal is counted on the way past, so the empty screen -- the likeliest one
 * on a board with 98 jobs and a handful of trucks -- can say which gate said no
 * and how often.
 *
 * NO NETWORK. `loads.road_miles` is read when the column already holds it and
 * is never fetched to find out: a match query must not make a billable HERE
 * call, ever, and there are up to 2,000 of them behind one page view.
 *
 * SPEC 11.9, 11.10.
 */
import { DEFAULT_TZ, toLocalDate } from "@/lib/extract/dates";
import { loadsByIds } from "@/lib/loads/query";
import { trucksByIds, type TruckScope } from "@/lib/loads/truckQuery";
import type { LoadAudience, LoadRow } from "@/lib/loads/types";
import type { TruckAudience, TruckRow } from "@/lib/loads/truckTypes";
import {
  candidateJobsForTruck,
  candidateTrucksForJob,
  matchJobById,
  matchTruckById,
} from "./candidates";
import { MATCH_CANDIDATE_CAP } from "./constants";
import { evaluateMatch } from "./evaluate";
import { compareMatches } from "./order";
import type {
  MatchJob,
  MatchOk,
  MatchPreview,
  MatchResult,
  MatchTruck,
  RefusalCode,
} from "./types";

/** `now` is a parameter everywhere below it, so a test can hold time still. */
function boardToday(now: Date) {
  return toLocalDate(now, DEFAULT_TZ);
}

function tally(refusals: Partial<Record<RefusalCode, number>>, code: RefusalCode): void {
  refusals[code] = (refusals[code] ?? 0) + 1;
}

/**
 * "Loads that fit this truck."
 *
 * Null when the truck does not exist FOR THIS CALLER -- a pending row, or
 * somebody else's demo listing -- so the route answers the same 404 the detail
 * route answers rather than an empty list that admits the id is real.
 */
export async function matchesForTruck(
  truckId: number,
  scope: TruckScope,
  audience?: TruckAudience | null,
  now: Date = new Date(),
): Promise<MatchResult<LoadRow> | null> {
  const truck = await matchTruckById(truckId, scope, audience);
  if (!truck) return null;

  const candidates = await candidateJobsForTruck(truck, audience);
  const today = boardToday(now);

  const refusals: Partial<Record<RefusalCode, number>> = {};
  const ok = new Map<number, MatchOk>();
  let deadlineSeen = false;

  for (const job of candidates) {
    if (job.deliver_by != null) deadlineSeen = true;
    const verdict = evaluateMatch({ truck, job, today });
    if (verdict.ok) ok.set(job.id, verdict);
    else tally(refusals, verdict.refusal);
  }

  const rows = await loadsByIds([...ok.keys()], audience);
  const matches = rows
    .flatMap((item) => {
      const v = ok.get(item.id);
      return v ? [{ item, verdict: v }] : [];
    })
    .sort((a, b) =>
      compareMatches(a, b, (job) => ({
        deadline: job.deliver_by,
        lastSeen: job.last_seen_at,
      })),
    );

  return {
    matches,
    refusals,
    candidates: candidates.length,
    truncated: candidates.length >= MATCH_CANDIDATE_CAP,
    gates: { service: "thin", deadline: deadlineSeen ? "live" : "inert" },
  };
}

/**
 * "Trucks that could take this." The mirror, and public: a match is a pointer,
 * not an introduction, and no phone leaves through either direction.
 */
export async function matchesForJob(
  jobId: number,
  scope: TruckScope,
  audience?: LoadAudience | null,
  now: Date = new Date(),
): Promise<MatchResult<TruckRow> | null> {
  const job = await matchJobById(jobId, audience);
  if (!job) return null;

  const candidates = await candidateTrucksForJob(job, scope, audience);
  const today = boardToday(now);

  const refusals: Partial<Record<RefusalCode, number>> = {};
  const ok = new Map<number, MatchOk>();

  for (const truck of candidates) {
    const verdict = evaluateMatch({ truck, job, today });
    if (verdict.ok) ok.set(truck.id, verdict);
    else tally(refusals, verdict.refusal);
  }

  const rows = await trucksByIds([...ok.keys()], scope, audience);
  const matches = rows
    .flatMap((item) => {
      const v = ok.get(item.id);
      return v ? [{ item, verdict: v }] : [];
    })
    .sort((a, b) =>
      compareMatches(a, b, (truck) => ({
        // A truck has no delivery deadline; the day its offer stops being true
        // is the same question asked of the other kind of listing.
        deadline: truck.avail_to,
        lastSeen: truck.last_seen_at,
      })),
    );

  return {
    matches,
    refusals,
    candidates: candidates.length,
    truncated: candidates.length >= MATCH_CANDIDATE_CAP,
    // This direction's deadline gate is about the ANCHOR job's own deadline: it
    // is live for this page exactly when this job states one.
    gates: { service: "thin", deadline: job.deliver_by != null ? "live" : "inert" },
  };
}

/**
 * The live preview over an UNSAVED draft.
 *
 * A count and a histogram, and deliberately nothing else: a driver who has not
 * posted yet has no listing for anyone to have answered, and handing them job
 * rows here would make the posting form a second board with no contact gate in
 * front of it. The number is the honest part -- "4 jobs fit this" is a reason
 * to finish the form; a list is a reason not to.
 */
export async function previewMatches(
  draft: MatchTruck,
  audience?: LoadAudience | null,
  now: Date = new Date(),
): Promise<MatchPreview> {
  const candidates = await candidateJobsForTruck(draft, audience);
  const today = boardToday(now);

  const refusals: Partial<Record<RefusalCode, number>> = {};
  let strong = 0;
  let possible = 0;
  let deadlineSeen = false;

  for (const job of candidates) {
    if (job.deliver_by != null) deadlineSeen = true;
    const verdict = evaluateMatch({ truck: draft, job, today });
    if (!verdict.ok) tally(refusals, verdict.refusal);
    else if (verdict.tier === "strong") strong += 1;
    else possible += 1;
  }

  return {
    strong,
    possible,
    total: strong + possible,
    candidates: candidates.length,
    truncated: candidates.length >= MATCH_CANDIDATE_CAP,
    refusals,
    gates: { service: "thin", deadline: deadlineSeen ? "live" : "inert" },
  };
}

export type { MatchJob, MatchPreview, MatchTruck };
