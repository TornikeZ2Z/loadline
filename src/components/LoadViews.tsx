"use client";

/**
 * The job card and the list it lives in.
 *
 * The card shows only what a real post contained. There is no bedroom count,
 * no floor, no packing, no weight and no pallet -- those were freight-board
 * fields, and inventing them here would mean inventing data. What is left is
 * exactly the five things a mover decides on: the lane, the size, the price,
 * when it is ready, and how alive the listing is.
 *
 * ---------------------------------------------------------------------------
 * V05 -- FOUR REGIONS, IN THE ORDER A BACKHAUL IS DECIDED.
 *
 *   route      where it goes, city and state to city and state, and how big it
 *              is. The two strongest things on the card: 16/22 semibold for the
 *              route, 20/26 semibold for the cubic feet.
 *   decision   can I load it (readiness), when must it be there, when was it
 *              last posted, what does it pay. Readiness and freshness are
 *              adjacent because they are one question: is this still real, and
 *              can I take it.
 *   evidence   who says so, how sure we are of the place, and what the sender
 *              requires. None of it is the freight; all of it is how much to
 *              trust the four lines above.
 *   action     View details, and Show contact BESIDE it rather than inside it.
 *
 * The lane ("NJ -> FL") used to lead and the cities were a grey second line.
 * That is backwards: a driver in Kearny cannot use "NJ", and the review's first
 * acceptance line is that a route can be read without opening the card. The
 * two-letter lane is gone from the card entirely rather than printed twice.
 *
 * ---------------------------------------------------------------------------
 * V15/V05 -- ONE LINK, AND EVERY CONTROL IS ITS SIBLING.
 *
 * The card was a `div role="button"` with a real `<button>` inside it: a
 * control inside a control, which a screen reader cannot reach the inner half
 * of and which swallowed text selection. It is now the `.link-parent` /
 * `.link-cover` / `.link-sibling` pattern from globals.css -- ONE anchor, whose
 * ::after covers the card, and Show contact lifted above it as a sibling.
 *
 * The anchor is a real href to `/jobs/<id>`, which is a real page that restores
 * the board with this drawer open, so middle-click and copy-link work. A plain
 * left click is intercepted and handed to `onSelect`, because opening the
 * drawer in place is what keeps the map and the search alive. The href carries
 * no query string: the filters live in the parent's state, and reading
 * `window.location.search` during render would differ between the server and
 * the client and break hydration.
 */

import { useRef, useState } from "react";
import { api } from "@/lib/basePath";
import type { PublicLoadRow } from "@/lib/loads/publicView";
import {
  boardDay,
  deliverByLabel,
  distanceCaveat,
  formatPrice,
  freshnessLabel,
  placeLabel,
  readyLabel,
  requirementChips,
  senderLine,
  twinLabel,
  TAG_LABELS,
} from "@/lib/loads/present";
import { Chip, StatusChip } from "./ui";

export interface JobCardProps {
  job: PublicLoadRow;
  selected: boolean;
  hovered: boolean;
  now: Date;
  /** `contact` opens the detail with the contact gate already triggered. */
  onSelect(job: PublicLoadRow, opts?: { contact?: boolean }): void;
  onHover(id: number | null): void;
}

export interface JobListProps {
  jobs: PublicLoadRow[];
  selectedId: number | null;
  hoveredId: number | null;
  now: Date;
  onSelect: JobCardProps["onSelect"];
  onHover: JobCardProps["onHover"];
}

/* ------------------------------------------------------------------------- *
 * V06 -- FOUR KINDS OF STATUS, FOUR TREATMENTS.
 *
 * Readiness, listing availability, evidence quality and the sender's
 * requirements are four different claims and they used to share one chip
 * vocabulary -- a row of identically-shaped lozenges in which "Ready now",
 * "Delisted", "Unverified" and "DOT & MC" all looked like the same kind of
 * fact. They are separated three ways at once now, so colour, icon and text
 * agree:
 *
 *   READINESS      a FILLED chip with a CLOCK, in the decision region. Green
 *                  when the sender stated ready, blue for a stated future date,
 *                  grey when the post said nothing. It is about the freight's
 *                  schedule and it is the only chip in that region.
 *   AVAILABILITY   PLAIN TEXT, not a chip, in the decision region -- "Listed
 *                  today", "Delisted Sep 3", "Sender silent since Sep 1" -- with
 *                  the lifecycle's own StatusChip beside it when the listing is
 *                  no longer available. It is about the LISTING, not the load.
 *   EVIDENCE       an OUTLINED chip with a warning or a dashed ring, in the
 *                  evidence region. This is MoverMesh's own doubt: a reading we
 *                  are not confident in, a place we had to guess, a size the
 *                  post never gave, two senders posting what may be one load.
 *   REQUIREMENTS   a FILLED neutral chip with a SHIELD, in the evidence region.
 *                  The sender's conditions, in their words. Never a tick and
 *                  never "verified" -- MoverMesh has checked none of it.
 *
 * The glyphs are 12 px inside a 22 px pill. The branding review's "one outline
 * family at 20 or 24 pixels" is about icons that stand for ACTIONS; a chip's
 * glyph is set with its word and is never the only thing carrying the meaning.
 * ------------------------------------------------------------------------- */

const ICON: React.SVGProps<SVGSVGElement> = {
  width: 12,
  height: 12,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2.4,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
  focusable: false,
};

/** Readiness: the sender's schedule for the freight. */
export function IconClock() {
  return (
    <svg {...ICON} className="shrink-0">
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 7.2v5.1l3.2 1.9" />
    </svg>
  );
}

/** Evidence: a reading of the post that a human should check. */
export function IconAlert() {
  return (
    <svg {...ICON} className="shrink-0">
      <path d="M12 4.2 21 19.6H3z" />
      <path d="M12 10.2v3.4" />
      <path d="M12 16.6h.01" />
    </svg>
  );
}

/**
 * Evidence: a value the post never gave, or a place we could only guess.
 *
 * A broken ring rather than a question mark -- it is the same "out of focus"
 * idea the map draws an approximate coordinate with, and a "?" at 12 px is a
 * smudge.
 */
export function IconUnknown() {
  return (
    <svg {...ICON} className="shrink-0">
      <circle cx="12" cy="12" r="8.6" strokeDasharray="3.4 3.6" />
    </svg>
  );
}

/** A condition the sender set. A shield, never a tick: nobody checked it. */
export function IconRequirement() {
  return (
    <svg {...ICON} className="shrink-0">
      <path d="M12 3.4 19 6.2v5c0 4.1-2.9 7.1-7 8.4-4.1-1.3-7-4.3-7-8.4v-5z" />
    </svg>
  );
}

/**
 * V06 -- the badge formerly known as "Unverified".
 *
 * "Unverified" was read as a claim about the COMPANY that posted the job: an
 * unverified mover, on a board whose own pages promise it does not verify
 * operating authority or insurance for anybody. It has never meant that. It
 * means MoverMesh's rules read this listing out of a WhatsApp message and are
 * not confident in the reading, which is a statement about US.
 *
 * The word is the disclosure; the tooltip only adds which rule flagged it.
 */
export const NEEDS_REVIEW = "Needs review";
export const NEEDS_REVIEW_NOTE =
  "MoverMesh read this listing out of the original post automatically and is not confident in the reading. It says nothing about the company that posted it — check the original message before you call.";

export function reviewTitle(flags?: string[] | null): string {
  const found = flags?.filter(Boolean).join(" · ");
  return found ? `${NEEDS_REVIEW_NOTE} (flagged: ${found})` : NEEDS_REVIEW_NOTE;
}

/** Readiness — filled, clocked, and the only chip in the decision region. */
export function ReadinessChip({
  text,
  tone,
  title,
}: {
  text: string;
  tone: React.ComponentProps<typeof Chip>["tone"];
  title?: string | null;
}) {
  return (
    <Chip tone={tone} title={title ?? undefined}>
      <IconClock />
      {text}
    </Chip>
  );
}

/** Evidence — outlined, and the word says what we are unsure of. */
export function EvidenceChip({
  kind,
  title,
  children,
}: {
  /** `review` is doubt about the READING; `unknown` is a value or place the post never gave. */
  kind: "review" | "unknown";
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <Chip tone={kind === "review" ? "review" : "approx"} title={title}>
      {kind === "review" ? <IconAlert /> : <IconUnknown />}
      {children}
    </Chip>
  );
}

/** A sender's condition, in their words, shielded and never ticked. */
export function RequirementBadge({ label, title }: { label: string; title: string }) {
  return (
    <Chip title={title}>
      <IconRequirement />
      {label}
    </Chip>
  );
}

/**
 * "Approximate pickup" / "Approximate delivery" / "Approximate pickup & delivery".
 *
 * The chip used to read a bare lowercase "approximate", which end unnamed and
 * the meaning only in a tooltip -- and V06's acceptance line is that a tooltip
 * may supplement disclosure and never be the only place it happens. The
 * branding review's own vocabulary for this state names the end.
 */
export function approxEndsLabel(
  start: boolean,
  end: boolean,
  /** A truck's ends are not a job's: it comes free somewhere and is headed somewhere. */
  names: [string, string] = ["pickup", "delivery"],
): string | null {
  if (start && end) return `Approximate ${names[0]} & ${names[1]}`;
  if (start) return `Approximate ${names[0]}`;
  if (end) return `Approximate ${names[1]}`;
  return null;
}

export const APPROX_NOTE =
  "The post did not name a city for this end, so it sits on a state centroid rather than an address.";

/**
 * A plain left click on a card link opens the drawer; anything else is left to
 * the browser, so middle-click, ctrl/cmd-click and "copy link address" all
 * reach the real `/jobs/<id>` page.
 */
function isPlainClick(e: React.MouseEvent): boolean {
  return !e.defaultPrevented && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

/** At most three tags before the row stops being scannable. */
const MAX_TAGS = 3;

/**
 * Verified jobs first, everything else in the server's order.
 *
 * A stable partition rather than a sort: the server already ordered by whatever
 * the viewer asked for, and this only says that between two jobs the sort
 * cannot separate, the one a human has not had to second-guess goes first.
 */
export function partitionUnverified(jobs: PublicLoadRow[]): PublicLoadRow[] {
  const clean: PublicLoadRow[] = [];
  const review: PublicLoadRow[] = [];
  for (const job of jobs) (job.needs_review ? review : clean).push(job);
  return review.length ? [...clean, ...review] : jobs;
}

export function JobList({ jobs, selectedId, hoveredId, now, onSelect, onHover }: JobListProps) {
  const list = useRef<HTMLUListElement>(null);

  /** Up/down walk the cards; the card's own link is what takes focus. */
  const onKeyDown = (e: React.KeyboardEvent<HTMLUListElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const links = Array.from(list.current?.querySelectorAll<HTMLElement>("a[data-card-link]") ?? []);
    if (!links.length) return;
    const at = links.findIndex((c) => c === document.activeElement);
    const next = e.key === "ArrowDown" ? at + 1 : at - 1;
    const target = links[Math.max(0, Math.min(links.length - 1, next))];
    if (target) {
      e.preventDefault();
      target.focus();
      target.scrollIntoView({ block: "nearest" });
    }
  };

  return (
    <ul
      ref={list}
      className="flex flex-col gap-[var(--sp-2)]"
      onKeyDown={onKeyDown}
      onMouseLeave={() => onHover(null)}
    >
      {jobs.map((job) => (
        <li key={job.id}>
          <JobCard
            job={job}
            now={now}
            selected={selectedId === job.id}
            hovered={hoveredId === job.id}
            onSelect={onSelect}
            onHover={onHover}
          />
        </li>
      ))}
    </ul>
  );
}

/**
 * The list while the first request is in flight.
 *
 * Deliberately the card's own silhouette rather than a spinner or a line of
 * "Loading jobs…": the list column is 420 px of empty grey otherwise, and the
 * page then jumps a full screen when the rows land. The bars are sized from
 * the real card -- 22 px route, 26 px quantity, 22 px chips, a 32 px action row
 * -- so nothing moves when the skeleton is replaced.
 */
export function JobListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <ul className="flex flex-col gap-[var(--sp-2)]" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="card p-[var(--sp-3)]" style={{ opacity: 1 - i * 0.15 }}>
          <span className="skeleton h-[22px] w-[76%]" />
          <span className="skeleton mt-[var(--sp-1)] h-[26px] w-[104px]" />
          <div className="mt-[var(--sp-2)] flex gap-[var(--sp-2)]">
            <span className="skeleton h-[22px] w-[112px] rounded-[var(--radius-pill)]" />
            <span className="skeleton h-[22px] w-[72px] rounded-[var(--radius-pill)]" />
          </div>
          <span className="skeleton mt-[var(--sp-2)] h-[20px] w-[62%]" />
          <span className="skeleton mt-[var(--sp-3)] h-[32px] w-full" />
        </li>
      ))}
    </ul>
  );
}

export function JobCard({ job, selected, hovered, now, onSelect, onHover }: JobCardProps) {
  const today = boardDay(now);
  const from = placeLabel(job, "pickup");
  const to = placeLabel(job, "delivery");
  const price = formatPrice(job);
  const ready = readyLabel(job, today);
  const deliverBy = deliverByLabel(job, today);
  const fresh = freshnessLabel(job, now);
  const inactive = job.status !== "available";
  // The card's distance is viewer → pickup, so only the PICKUP end can make it
  // approximate. 97 of 98 live jobs have a vague delivery and an exact pickup;
  // qualifying those would be wrong in the opposite direction.
  const nearCaveat = distanceCaveat(job, "toPickup");

  const twin = twinLabel(job.dup_count);
  const requirements = requirementChips(job.requirements);
  const approx = approxEndsLabel(from.approx, to.approx);
  const tags = job.tags ?? [];
  const shownTags = tags.slice(0, MAX_TAGS);
  const hiddenTags = tags.length - shownTags.length;

  const open = (opts?: { contact?: boolean }) => onSelect(job, opts);
  const [keyboardFocus, setKeyboardFocus] = useState(false);

  return (
    <article
      data-job-card
      data-job-id={job.id}
      onMouseEnter={() => onHover(job.id)}
      /* THE KEYBOARD'S MARK ON THE CARD, in React rather than in CSS -- and the
         CSS was tried first. `.card:has(a:focus-visible)` is the natural way to
         write this and it failed twice over: globals.css is UNLAYERED, so
         `.card`'s own border-color beats a Tailwind utility unless the utility
         is `!important`; and even with it, Chrome does not re-evaluate the
         `:has()` when focus is moved PROGRAMMATICALLY, which is exactly what
         the arrow keys in `JobList` do -- the selector matched and the border
         stayed grey. A flag set from the focus event has neither problem.

         Focus also lights the card's marker on the MAP, exactly as hover does:
         walking the list with the arrow keys is the keyboard's version of
         running a pointer down it. React's onFocus is focusin, so the card
         sees the link inside it take focus. */
      onFocus={(e) => {
        onHover(job.id);
        // Only a KEYBOARD focus gets the mark: a mouse click on the card
        // focuses the link too, and outlining a card somebody has just clicked
        // is noise. `:focus-visible` is the browser's own answer to that.
        setKeyboardFocus(e.target.matches(":focus-visible"));
      }}
      onBlur={() => setKeyboardFocus(false)}
      className={`card card-hover link-parent p-[var(--sp-3)]${selected ? " card-selected" : ""}`}
      /* An attribute rather than an inline borderColor. `hovered` is also set
         by the MAP -- hovering a marker lights its card without the pointer
         ever being over it -- so it cannot just be :hover. */
      data-hovered={hovered && !selected ? "" : undefined}
      style={{
        opacity: inactive ? 0.7 : 1,
        // Inline, so it beats `.card` and `[data-hovered]` without !important.
        borderColor: keyboardFocus ? "var(--accent)" : undefined,
      }}
    >
      {/* REGION 1 — the route, then the size. The two strongest things on the
          card and the only two at full ink. City and state to city and state,
          because that is the thing a driver is matching against their own
          empty leg; the state-only fallback is `placeLabel`'s, which prints
          what the post gave and never composes a city it did not. */}
      <h3 className="t-title" style={{ overflowWrap: "anywhere" }}>
        {from.text} <span aria-hidden>→</span>
        <span className="sr-only">to</span> {to.text}
      </h3>
      <div className="mt-[2px] flex items-baseline gap-[var(--sp-2)]">
        {job.cubic_feet != null ? (
          <span
            className="t-quantity"
            title={job.cubic_feet < 100 ? `Small job as posted (${job.cubic_feet} cf)` : undefined}
          >
            {job.cubic_feet.toLocaleString("en-US")}
            {/* The unit is not a number. Dropping it two sizes and a shade lets
                the figure carry the comparison down a column of cards. */}
            <span className="t-label font-medium" style={{ color: "var(--muted)" }}>
              {" cf"}
            </span>
          </span>
        ) : (
          <EvidenceChip kind="unknown" title="The post never stated a size, and MoverMesh does not estimate one.">
            Size not stated
          </EvidenceChip>
        )}
      </div>

      {/* REGION 2 — the decision. Readiness and freshness sit together because
          they are one question: can I load it, and is this listing still real.

          THE PRICE HAS ITS OWN SLOT: right-aligned, `shrink-0`, never wrapped.
          Nearly every job on this board is unpriced, so "Price not provided" is
          the string on almost every card, and left in the flow it was the item
          that wrapped. It is set in muted 14 px rather than the green 16 px a
          real rate gets -- V05's line is that a price the post never gave must
          not carry the emphasis of operational data. */}
      <div className="mt-[var(--sp-2)] flex items-center gap-x-[var(--sp-2)]">
        <span className="flex min-w-0 flex-wrap items-center gap-x-[var(--sp-2)] gap-y-[var(--sp-1)]">
          <ReadinessChip text={ready.text} tone={ready.tone} title={ready.title} />
          {deliverBy && (
            <span style={{ color: deliverBy.tone === "warn" ? "var(--warn)" : "var(--muted)" }}>
              {deliverBy.text}
            </span>
          )}
        </span>
        {price.tone === "muted" ? (
          <span
            className="ml-auto shrink-0 whitespace-nowrap"
            style={{ color: "var(--muted)" }}
            title="The post did not state a price"
          >
            {price.headline}
          </span>
        ) : (
          <span
            className="nums ml-auto shrink-0 whitespace-nowrap text-(length:--fs-lg) font-semibold"
            style={{ color: "var(--ok)" }}
          >
            {price.headline}
            {price.sub && (
              <span className="text-(length:--fs-base) font-normal" style={{ color: "var(--muted)" }}>
                {" · "}
                {price.sub}
              </span>
            )}
          </span>
        )}
      </div>

      {/* Listing availability: plain text, never a pill -- it is about the
          LISTING, and the one pill in this region belongs to the freight's own
          schedule. The lifecycle's chip joins it only when the listing has left
          the sender's latest post. */}
      <div
        className="mt-[var(--sp-1)] flex flex-wrap items-center gap-x-[var(--sp-2)] gap-y-[var(--sp-1)]"
        style={{ color: "var(--muted)" }}
      >
        {inactive && <StatusChip status={job.status} />}
        <span
          className="whitespace-nowrap"
          title={fresh.detail ?? undefined}
          style={fresh.tone === "fresh" ? { color: "var(--text-2)", fontWeight: 500 } : undefined}
        >
          {fresh.text}
        </span>
        {job.distance_miles != null && (
          <>
            <span aria-hidden>·</span>
            {/* "≈" when the pickup is a state centroid: the number is real
                arithmetic on a fabricated point, and a flat "184 mi away" is
                exactly the kind of false precision this board exists not to
                print. */}
            <span
              className="nums whitespace-nowrap"
              title={nearCaveat?.title ?? "Straight line from where you are"}
            >
              {nearCaveat ? "≈ " : ""}
              {Math.round(job.distance_miles)} mi away
            </span>
          </>
        )}
        {/* Corridor searches only, and the one number a plain board cannot
            produce: what taking this job adds to the run you were making
            anyway. Straight-line geometry, never a road route. */}
        {job.detour_miles != null && (
          <>
            <span aria-hidden>·</span>
            <span className="nums whitespace-nowrap" title={detourTitle(job)}>
              {detourApproximate(job)
                ? `≈ ${job.detour_miles.toLocaleString()} mi detour`
                : job.detour_miles === 0
                  ? "no detour"
                  : `+${job.detour_miles.toLocaleString()} mi detour`}
            </span>
          </>
        )}
      </div>

      {/* REGION 3 — the evidence. Who said it, how sure we are of the place,
          and what the sender requires. The uncertainty chips are NEVER folded
          into a "+N": a caveat behind a counter is a caveat nobody reads, and
          the requirements decide whether a driver is eligible at all. Only the
          descriptive tags -- piano, stairs, packing -- are capped. */}
      <div className="mt-[var(--sp-2)] flex flex-wrap items-center gap-x-[var(--sp-2)] gap-y-[var(--sp-1)]">
        <span className="min-w-0 truncate" style={{ color: "var(--muted)" }}>
          {senderLine(job)}
        </span>
        {twin && (
          <EvidenceChip kind="unknown" title={twin.title}>
            {twin.label}
          </EvidenceChip>
        )}
        {approx && (
          <EvidenceChip kind="unknown" title={APPROX_NOTE}>
            {approx}
          </EvidenceChip>
        )}
        {job.needs_review && (
          <EvidenceChip kind="review" title={reviewTitle(job.flags)}>
            {NEEDS_REVIEW}
          </EvidenceChip>
        )}
        {requirements.map((req) => (
          <RequirementBadge key={`req-${req.label}`} label={req.label} title={req.title} />
        ))}
        {shownTags.map((tag) => {
          const meta = TAG_LABELS[tag] ?? { label: titleCase(tag), tone: "default" as const };
          return (
            <Chip key={`tag-${tag}`} tone={meta.tone}>
              {meta.label}
            </Chip>
          );
        })}
        {hiddenTags > 0 && (
          <Chip tone="muted" title={tags.slice(MAX_TAGS).map((t) => TAG_LABELS[t]?.label ?? titleCase(t)).join(" · ")}>
            +{hiddenTags}
          </Chip>
        )}
      </div>

      {/* REGION 4 — the way out of the card, ruled off from the listing above
          it. Two SIBLING controls: the link that covers the card, and a real
          button beside it. Both are 32 px on a mouse and 44 on a touch screen
          (`.btn-sm`, globals.css), against the 28 px the review measured. */}
      <div className="mt-[var(--sp-2)] flex items-center gap-[var(--sp-2)] border-t border-border pt-[var(--sp-2)]">
        <a
          data-card-link
          /* `-ml-[10px]` cancels .btn-sm's own left padding so the label starts
             on the card's text column rather than ten pixels inside it. */
          className="btn btn-link btn-sm link-cover -ml-[10px]"
          href={api(`/jobs/${job.id}`)}
          aria-current={selected ? "true" : undefined}
          onClick={(e) => {
            if (!isPlainClick(e)) return;
            e.preventDefault();
            open();
          }}
        >
          View details
          {/* 98 links reading "View details" are 98 identical entries in a
              screen reader's link list. The route makes each one its own. */}
          <span className="sr-only">
            {": "}
            {from.text} to {to.text}
          </span>
        </a>
        {job.has_phone && (
          <button
            type="button"
            className="btn btn-sm link-sibling ml-auto shrink-0"
            onClick={() => open({ contact: true })}
          >
            Show contact
          </button>
        )}
      </div>
    </article>
  );
}

/** Either end of this job was placed only to a state or region centroid. */
function detourApproximate(job: PublicLoadRow): boolean {
  return (
    job.pickup_precision === "state" ||
    job.pickup_precision === "region" ||
    job.delivery_precision === "state" ||
    job.delivery_precision === "region"
  );
}

function detourTitle(job: PublicLoadRow): string {
  const off =
    job.off_route_miles != null
      ? ` The pickup sits about ${job.off_route_miles.toLocaleString()} mi off the line.`
      : "";
  const approx = detourApproximate(job)
    ? " One end of this job was only placed to a state centre, so treat this as a rough estimate."
    : "";
  return (
    "Extra straight-line miles on top of your own route, going out to this pickup and delivery " +
    `and back to your line. Not road miles.${off}${approx}`
  );
}

/** "pool_table" -> "Pool table", for a tag the vocabulary has not met yet. */
function titleCase(tag: string): string {
  const words = tag.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
