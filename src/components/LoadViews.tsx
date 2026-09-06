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
  formatCf,
  formatPrice,
  freshnessLabel,
  laneLabel,
  placeLabel,
  readyLabel,
  requirementChip,
  senderLine,
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

export function JobCard({ job, selected, hovered, now, onSelect, onHover }: JobCardProps) {
  const today = boardDay(now);
  const from = placeLabel(job, "pickup");
  const to = placeLabel(job, "delivery");
  const price = formatPrice(job);
  const ready = readyLabel(job, today);
  const deliverBy = deliverByLabel(job, today);
  const fresh = freshnessLabel(job, now);
  const inactive = job.status !== "available";

  // Requirements first: they decide whether a driver can take the job at all.
  const requirement = requirementChip(job.requirements);
  const chips: React.ReactNode[] = [];
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
      style={{
        opacity: inactive ? 0.7 : 1,
        ...(hovered && !selected ? { borderColor: "var(--border-strong)" } : null),
      }}
    >
      <div className="flex items-baseline justify-between gap-[var(--sp-2)]">
        <span className="big text-(length:--fs-lg)">{laneLabel(job)}</span>
        <span
          className="big text-(length:--fs-lg)"
          style={job.cubic_feet == null ? { color: "var(--approx)", fontSize: "var(--fs-sm)" } : undefined}
          title={
            job.cubic_feet != null && job.cubic_feet < 100
              ? `Small job as posted (${job.cubic_feet} cf)`
              : undefined
          }
        >
          {job.cubic_feet != null ? formatCf(job.cubic_feet) : "Size not stated"}
        </span>
      </div>

      <div className="mt-[2px] text-(length:--fs-base)" style={{ color: "var(--text-2)" }}>
        {from.text} → {to.text}
      </div>

      <div className="mt-[var(--sp-2)] flex flex-wrap items-center gap-[var(--sp-2)]">
        {inactive ? (
          <StatusChip status={job.status} />
        ) : (
          <Chip tone={ready.tone} title={ready.title ?? undefined}>
            {ready.text}
          </Chip>
        )}
        <span
          className="nums text-(length:--fs-base) font-semibold"
          style={{ color: price.tone === "muted" ? "var(--muted)" : "var(--ok)" }}
        >
          {price.headline}
          {price.sub && (
            <span className="font-normal" style={{ color: "var(--muted)" }}>
              {" · "}
              {price.sub}
            </span>
          )}
        </span>
        {deliverBy && (
          <span
            className="text-(length:--fs-sm)"
            style={{ color: deliverBy.tone === "warn" ? "var(--warn)" : "var(--muted)" }}
          >
            {deliverBy.text}
          </span>
        )}
      </div>

      {visibleChips.length > 0 && (
        <div className="mt-[var(--sp-2)] flex flex-wrap gap-[var(--sp-1)]">
          {visibleChips}
          {hiddenChips > 0 && <Chip tone="muted">+{hiddenChips}</Chip>}
        </div>
      )}

      <div
        className="mt-[var(--sp-2)] flex flex-wrap items-center gap-x-[var(--sp-2)] gap-y-[var(--sp-1)] text-(length:--fs-sm)"
        style={{ color: "var(--muted)" }}
      >
        <span
          title={fresh.detail ?? undefined}
          style={fresh.tone === "fresh" ? { color: "var(--fresh)", fontWeight: 600 } : undefined}
        >
          {fresh.text}
        </span>
        <span>·</span>
        <span className="truncate">{senderLine(job)}</span>
        {job.distance_miles != null && (
          <>
            <span>·</span>
            <span className="nums" title="Straight line from where you are">
              {Math.round(job.distance_miles)} mi from you
            </span>
          </>
        )}
        {job.has_phone && (
          <button
            type="button"
            className="btn btn-ghost btn-sm ml-auto"
            style={{ color: "var(--accent)" }}
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

/** "pool_table" -> "Pool table", for a tag the vocabulary has not met yet. */
function titleCase(tag: string): string {
  const words = tag.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
