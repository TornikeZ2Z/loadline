/**
 * Every sentence a notification says, composed once.
 *
 * Pure -- no database, no clock, no React -- so the sweep that WRITES a digest
 * and the page that READS one print the same words from the same function, and
 * `npm run eval:notify` can assert them without a browser.
 *
 * The register is `reasons.ts`'s: a count, the two band names, and a plain
 * statement of what "Possible" means. Never "8 great matches", never a score,
 * never an implied endorsement. A driver is about to spend a phone call on
 * this; the page owes them the arithmetic, not an opinion about it.
 *
 * SPEC 12.3.
 */
import type { NotificationKind, NotificationPayload } from "./types";

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * The headline.
 *
 * "loads" and not "jobs" for the truck direction, on purpose: this row links to
 * the match panel, whose heading is "Loads that fit this truck"
 * (`MatchPanel.tsx`, SPEC 11), and SPEC 12.3 writes the sentence out with that
 * word. The board's SUMMARY counts "98 jobs"; the panel's word is "loads"; a
 * notification that links to the panel uses the panel's.
 */
export function digestHeadline(kind: NotificationKind, payload: NotificationPayload): string {
  const n = payload.count;
  if (kind === "new_matches_for_truck") {
    return `${n} ${plural(n, "load", "loads")} now ${plural(n, "matches", "match")} your ${payload.subjectLane} truck`;
  }
  return `${n} ${plural(n, "truck", "trucks")} could take your ${payload.subjectLane} job`;
}

/**
 * The second line: the split by band, and what the weaker band means.
 *
 * The explanation is printed only when there is something possible to explain.
 * A digest of two strong matches followed by a sentence defining "Possible"
 * would be a paragraph about a word that does not appear above it.
 *
 * The two halves of "something about the job or your truck wasn't stated" swap
 * with the direction, because on a job's notification the unstated thing is on
 * the truck.
 */
export function digestDetail(kind: NotificationKind, payload: NotificationPayload): string {
  const { strong, possible } = payload.tiers;
  const bands = [strong > 0 ? `${strong} strong` : null, possible > 0 ? `${possible} possible` : null]
    .filter(Boolean)
    .join(" · ");
  if (possible === 0) return `${bands}.`;
  const unstated =
    kind === "new_matches_for_truck"
      ? "something about the job or your truck wasn't stated"
      : "something about the truck or your job wasn't stated";
  return `${bands}. "Possible" means ${unstated}.`;
}

/** Where the row links: the listing the reader owns, with its panel open. */
export function subjectHref(subjectKind: "truck" | "load", subjectId: number): string {
  return subjectKind === "truck" ? `/trucks/${subjectId}` : `/jobs/${subjectId}`;
}

/** Where one spelled-out match links: the OTHER kind of listing. */
export function itemHref(kind: NotificationKind, id: number): string {
  return kind === "new_matches_for_truck" ? `/jobs/${id}` : `/trucks/${id}`;
}

/**
 * The empty state.
 *
 * It says what will produce a notification rather than that there are none --
 * the bell only renders for someone who owns a listing, so a reader here has
 * already done the thing that earns alerts and is owed the next fact, which is
 * when they arrive.
 */
export const NOTIFICATIONS_EMPTY =
  "Nothing yet. When a load matches one of your trucks — or a truck could take one of your jobs — it lands here.";

/**
 * The one sentence the settings page must not get wrong.
 *
 * Same register as wave 2's "Nothing replies to you automatically." on the
 * report queue: state the absence, do not apologise for it, and do not promise
 * a date.
 */
export const EMAIL_UNAVAILABLE = "E-mail alerts aren't available yet";
export const EMAIL_UNAVAILABLE_WHY =
  "There is no mail sending set up behind this yet — no sender domain, no bounce handling. Turning the switch on would be a promise the product cannot keep, so it is off and it does nothing.";
