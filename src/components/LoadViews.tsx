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
 * The card is a `div role="button"` rather than a `<button>` because it
 * contains a real button (Show contact), and a button inside a button is
 * invalid and unreachable by keyboard.
 */

import { useRef } from "react";
import type { PublicLoadRow } from "@/lib/loads/publicView";
import {
  boardDay,
  deliverByLabel,
  distanceCaveat,
  formatPrice,
  freshnessLabel,
  laneLabel,
  placeLabel,
  readyLabel,
  requirementChip,
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

/** At most four chips fit before the row wraps and stops being scannable. */
const MAX_CHIPS = 4;

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

  /** Up/down walk the cards; Enter on a focused card opens it. */
  const onKeyDown = (e: React.KeyboardEvent<HTMLUListElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const cards = Array.from(
      list.current?.querySelectorAll<HTMLElement>("[data-job-card]") ?? [],
    );
    if (!cards.length) return;
    const at = cards.findIndex((c) => c.contains(document.activeElement));
    const next = e.key === "ArrowDown" ? at + 1 : at - 1;
    const target = cards[Math.max(0, Math.min(cards.length - 1, next))];
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
 * the real card -- 16 px lane, 13 px places, 22 px chips -- so nothing moves
 * when the skeleton is replaced.
 */
export function JobListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <ul className="flex flex-col gap-[var(--sp-2)]" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="card p-[var(--sp-3)]" style={{ opacity: 1 - i * 0.13 }}>
          <div className="flex items-baseline justify-between gap-[var(--sp-2)]">
            <span className="skeleton h-[16px] w-[96px]" />
            <span className="skeleton h-[16px] w-[54px]" />
          </div>
          <span className="skeleton mt-[var(--sp-2)] h-[13px] w-[72%]" />
          <div className="mt-[var(--sp-2)] flex gap-[var(--sp-2)]">
            <span className="skeleton h-[22px] w-[80px] rounded-[var(--radius-pill)]" />
            <span className="skeleton h-[22px] w-[64px] rounded-[var(--radius-pill)]" />
          </div>
          <span className="skeleton mt-[var(--sp-3)] h-[12px] w-[58%]" />
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

  // Twins first, ahead of even the requirements, and this is the one place the
  // chip order is not "what stops you taking the job". A driver who misreads two
  // postings as two jobs has mis-costed the trip and may ring two brokers about
  // one truckload; requirements they will read again on the detail before they
  // call. It is also the chip most likely to be pushed into "+N" otherwise,
  // because it arrives on rows that already carry tags.
  const twin = twinLabel(job.dup_count);
  const requirement = requirementChip(job.requirements);
  const chips: React.ReactNode[] = [];
  if (twin) {
    chips.push(
      <Chip key="twin" tone="approx" title={twin.title}>
        {twin.label}
      </Chip>,
    );
  }
  // Requirements next: they decide whether a driver can take the job at all.
  if (requirement) {
    chips.push(
      <Chip key="req" title={requirement.title}>
        {requirement.label}
      </Chip>,
    );
  }
  for (const tag of job.tags ?? []) {
    const meta = TAG_LABELS[tag] ?? { label: titleCase(tag), tone: "default" as const };
    chips.push(
      <Chip key={`tag-${tag}`} tone={meta.tone}>
        {meta.label}
      </Chip>,
    );
  }
  if (job.needs_review) {
    chips.push(
      <Chip key="review" tone="review" title={job.flags?.join(" · ") || "Read out of the post automatically"}>
        Unverified
      </Chip>,
    );
  }
  if (from.approx || to.approx) {
    chips.push(
      <Chip key="approx" tone="approx" title="The post did not give a specific city">
        approximate
      </Chip>,
    );
  }
  const visibleChips = chips.slice(0, MAX_CHIPS);
  const hiddenChips = chips.length - visibleChips.length;

  const open = (opts?: { contact?: boolean }) => onSelect(job, opts);

  return (
    <div
      data-job-card
      data-job-id={job.id}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={() => open()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
      onMouseEnter={() => onHover(job.id)}
      onFocus={() => onHover(job.id)}
      className={`card card-hover cursor-pointer p-[var(--sp-3)]${selected ? " card-selected" : ""}`}
      /* An attribute rather than an inline borderColor. `hovered` is also set
         by the MAP -- hovering a marker lights its card without the pointer
         ever being over it -- so it cannot just be :hover; but as an inline
         style it also beat the focus ring's border, and a card you had tabbed
         to looked hovered instead of focused. */
      data-hovered={hovered && !selected ? "" : undefined}
      style={{ opacity: inactive ? 0.7 : 1 }}
    >
      {/* Band 1 — what a driver scans. The lane and the size are the only two
          things at full ink; everything below them steps down in size, weight
          or colour so this row wins the first glance. */}
      <div className="flex items-baseline justify-between gap-[var(--sp-2)]">
        <span className="big text-(length:--fs-lg) truncate">{laneLabel(job)}</span>
        {job.cubic_feet != null ? (
          <span
            className="big text-(length:--fs-lg) shrink-0"
            title={
              job.cubic_feet < 100 ? `Small job as posted (${job.cubic_feet} cf)` : undefined
            }
          >
            {job.cubic_feet.toLocaleString("en-US")}
            {/* The unit is not a number. Dropping it a size and a shade lets the
                figure itself carry the comparison down a column of cards. */}
            <span className="text-(length:--fs-sm) font-medium" style={{ color: "var(--muted)" }}>
              {" cf"}
            </span>
          </span>
        ) : (
          <Chip tone="approx" className="shrink-0" title="The post never stated a size">
            size not stated
          </Chip>
        )}
      </div>

      <div className="mt-[1px] truncate text-(length:--fs-base)" style={{ color: "var(--muted)" }}>
        {from.text} → {to.text}
      </div>

      {/* Band 2 — the terms, in the order a backhaul is decided: can I load it
          (ready), must it be there by a date (deliver by), what does it pay.
          The two dates are adjacent because they are one question -- the window
          -- and the price sits apart from them on the right.

          THE PRICE HAS ITS OWN SLOT, and it is the same slot the cubic feet
          occupy in band 1: right-aligned, `shrink-0`, never wrapped. Nearly
          every job on this board is unpriced, so "Price not provided" is the
          string on almost every card -- eighteen characters where the old
          wording was sixteen and a bare "$3.50/cf" is eight. Left in the flow it
          was the item that wrapped, which pushed the card taller by a line and,
          on a phone, put the price under the dates it is not part of. Giving it
          a column instead costs nothing at any width and lines the two figures a
          driver compares -- size, then pay -- up the right edge of the column of
          cards. The window keeps `min-w-0` so it is the half that wraps when the
          card is narrow: a delivery date can break over two lines and still
          read; a price cannot. */}
      <div className="mt-[var(--sp-2)] flex items-center gap-x-[var(--sp-2)]">
        <span className="flex min-w-0 flex-wrap items-center gap-x-[var(--sp-2)] gap-y-[var(--sp-1)]">
          {inactive ? (
            <StatusChip status={job.status} />
          ) : (
            <Chip tone={ready.tone} title={ready.title ?? undefined}>
              {ready.text}
            </Chip>
          )}
          {deliverBy && (
            <span
              className="text-(length:--fs-sm)"
              style={{ color: deliverBy.tone === "warn" ? "var(--warn)" : "var(--muted)" }}
            >
              {deliverBy.text}
            </span>
          )}
        </span>
        {price.tone === "muted" ? (
          <span
            className="ml-auto shrink-0 whitespace-nowrap text-(length:--fs-sm)"
            style={{ color: "var(--muted)" }}
            title="The post did not state a price"
          >
            {price.headline}
          </span>
        ) : (
          <span
            className="nums ml-auto shrink-0 whitespace-nowrap text-(length:--fs-base) font-semibold"
            style={{ color: "var(--ok)" }}
          >
            {price.headline}
            {price.sub && (
              <span className="font-normal" style={{ color: "var(--muted)" }}>
                {" · "}
                {price.sub}
              </span>
            )}
          </span>
        )}
      </div>

      {visibleChips.length > 0 && (
        <div className="mt-[var(--sp-1)] flex flex-wrap gap-[var(--sp-1)]">
          {visibleChips}
          {hiddenChips > 0 && <Chip tone="muted">+{hiddenChips}</Chip>}
        </div>
      )}

      {/* Band 3 — provenance and the way out of the card. Ruled off, because
          none of it is about the freight: it is about the listing. */}
      <div
        className="mt-[var(--sp-2)] flex items-center gap-x-[var(--sp-2)] border-t border-border pt-[var(--sp-2)] text-(length:--fs-sm)"
        style={{ color: "var(--muted)" }}
      >
        {/* Source before freshness: "who posted this" is the fact, "when they
            last said it" is the qualifier on that fact, and reading them the
            other way round put a date in front of the name it belonged to. */}
        <span className="flex min-w-0 flex-wrap items-center gap-x-[var(--sp-1)]">
          <span className="truncate">{senderLine(job)}</span>
          <span aria-hidden>·</span>
          {/* Emphasis by ink, not by colour. Freshness used to be accent blue
              and bold, which put a second blue on the same line as the only
              button and, since most of the board is listed today, painted the
              whole column. Colour on a card now means one thing: you can act
              on it. */}
          <span
            className="whitespace-nowrap"
            title={fresh.detail ?? undefined}
            style={
              fresh.tone === "fresh" ? { color: "var(--text-2)", fontWeight: 500 } : undefined
            }
          >
            {fresh.text}
          </span>
          {job.distance_miles != null && (
            <>
              <span aria-hidden>·</span>
              {/* "≈" when the pickup is a state centroid: the number is real
                  arithmetic on a fabricated point, and 12 px grey "184 mi away"
                  is exactly the kind of false precision this board exists not to
                  print. The chip above says the location is approximate; this
                  says the distance inherited it. */}
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
              anyway. It is straight-line geometry, never a road route, and it
              is prefixed with "≈" when an end of this job was placed no more
              precisely than a state centre — a detour measured to a point the
              post never gave is an estimate, and is labelled as one. */}
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
        </span>
        {job.has_phone && (
          <button
            type="button"
            className="btn btn-ghost btn-sm ml-auto shrink-0"
            style={{ color: "var(--accent)", padding: "0 6px", marginRight: -6 }}
            onClick={(e) => {
              e.stopPropagation();
              open({ contact: true });
            }}
          >
            Show contact
          </button>
        )}
      </div>
    </div>
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
