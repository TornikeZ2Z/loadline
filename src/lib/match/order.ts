/**
 * How matches are ordered inside a result. Pure, so it can be tested without a
 * database and so both directions demonstrably sort the same way.
 *
 * tier, then score, then the least extra driving, then the soonest deadline,
 * then the freshest. SPEC 11.7.
 *
 * `score` is the only term a reader never sees, which is exactly why the terms
 * after it matter: two matches inside a point of each other are ordered by
 * things a driver can check.
 */
import type { MatchOk } from "./types";

/**
 * The two tiebreak keys, read off whichever kind of row is being ordered.
 *
 * `deadline` on a job is `deliver_by` -- the day the freight stops being worth
 * calling about. A truck has no delivery deadline, so its mirror is `avail_to`,
 * the day the offer stops being true. The spec writes the ordering from the
 * truck's page only; this is the same sentence said from the other side rather
 * than a second rule.
 */
export interface OrderKeys {
  deadline: string | null;
  lastSeen: string | null;
}

const nullsLastAsc = (a: string | null, b: string | null): number => {
  if (a === b) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a < b ? -1 : 1;
};

const nullsLastDesc = (a: string | null, b: string | null): number => {
  if (a === b) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a > b ? -1 : 1;
};

export function compareMatches<T>(
  a: { item: T; verdict: MatchOk },
  b: { item: T; verdict: MatchOk },
  keys: (item: T) => OrderKeys,
): number {
  if (a.verdict.tier !== b.verdict.tier) return a.verdict.tier === "strong" ? -1 : 1;
  if (a.verdict.score !== b.verdict.score) return b.verdict.score - a.verdict.score;

  const ad = a.verdict.facts.detour_miles;
  const bd = b.verdict.facts.detour_miles;
  if (ad !== bd) {
    if (ad == null) return 1;
    if (bd == null) return -1;
    return ad - bd;
  }

  const ka = keys(a.item);
  const kb = keys(b.item);
  const byDeadline = nullsLastAsc(ka.deadline, kb.deadline);
  if (byDeadline !== 0) return byDeadline;
  return nullsLastDesc(ka.lastSeen, kb.lastSeen);
}
