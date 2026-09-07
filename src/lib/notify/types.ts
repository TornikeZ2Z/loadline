/**
 * What a notification is, on the wire and in the row.
 *
 * The payload is written once by the sweep and read for ever afterwards, so it
 * is DENORMALISED ON PURPOSE: SPEC 3.3 says "enough to render the row without a
 * join, because the subject may be gone by the time it is read". A truck lives
 * 48 hours at the outside. A notification about it is still in the list a week
 * later, and a row that rendered "your — → — truck" because the join came back
 * empty would be worse than no row.
 *
 * It carries no phone, no sender key and no free text off either listing --
 * only ids, a two-letter lane, a tier and the reason clauses, which are numbers
 * and explicit statements of absence. `npm run check:redact` reads every row of
 * every payload the sweep writes and asserts exactly that.
 *
 * SPEC 12.
 */

/** Which way round the pairing was found. */
export type NotificationKind = "new_matches_for_truck" | "new_matches_for_job";

/** The listing the notification is ABOUT: the reader's own. */
export type SubjectKind = "truck" | "load";

export type NotifyTier = "strong" | "possible";

/** One of the (up to three) matches spelled out inside a digest. */
export interface NotificationTopItem {
  /** The counterpart listing: a load id when the subject is a truck, and back. */
  id: number;
  tier: NotifyTier;
  /** "NJ → FL", from `laneLabel` / `truckLaneLabel`. Two-letter states only. */
  lane: string;
  /**
   * The SAME strings `reasons.ts` composes for the board's match panel, byte
   * for byte. A notification that describes a match differently from the page
   * it links to is untrusted twice: once for the mismatch, and once more for
   * whichever of the two the reader decides was the lie.
   */
  reasons: string[];
}

export interface NotificationPayload {
  /** How many pairings were new in the run that wrote this. */
  count: number;
  tiers: { strong: number; possible: number };
  /** `new.slice(0, 3)` in the board's own order (tier, score, detour, …). */
  top: NotificationTopItem[];
  /**
   * The subject's own lane, frozen at write time. Not in SPEC 12.2's payload
   * sketch, and required by SPEC 3.3's sentence one line above it: the digest
   * headline names the subject ("your NJ → FL truck") and the subject is the
   * row most likely to have expired before the notification is read.
   */
  subjectLane: string;
}

/** A row as `/notifications` renders it. */
export interface NotificationRow {
  id: number;
  kind: NotificationKind;
  subject_kind: SubjectKind;
  subject_id: number;
  payload: NotificationPayload;
  created_at: string;
  read_at: string | null;
}

/**
 * The settings page, and the shape `GET`/`PUT /api/notification-prefs` speak.
 *
 * `email` is on the wire and is always false today. It is here rather than
 * absent so the page can render the third control DISABLED and say why -- a
 * control that is missing looks like a product that never thought about mail;
 * one that is present and off looks like a product that will silently start
 * sending. Disabled and labelled is the only honest third state, and there is
 * no SES, no verified domain and no bounce handling behind it. SPEC 12.4.
 */
export interface NotifyPrefs {
  inapp: boolean;
  email: boolean;
  /** Always false in v1. The settings page reads this, never a build flag. */
  emailAvailable: boolean;
}

/** What one sweep did, for the cron response and for `match_runs`. */
export interface MatchRunSummary {
  /** The instant the next run will read back as its watermark. */
  watermark: string;
  trucksScanned: number;
  jobsScanned: number;
  pairsWritten: number;
  pairsUnmatched: number;
  notificationsWritten: number;
  /** Subjects skipped because their owner had just edited them (12.1.3). */
  quieted: number;
  /**
   * Subjects that had news but were inside the 12-hour cap. They are NOT
   * stamped, so the news is still pending and goes out on a later run.
   */
  capped: number;
  /** One entry per subject that threw. The run continues past it. */
  errors: string[];
}
