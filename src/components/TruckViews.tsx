"use client";

/**
 * The truck card and the list it lives in.
 *
 * A sibling of `LoadViews.tsx`, laid out to the same four regions so a driver
 * switching tabs is not re-learning where to look -- and carrying different
 * facts in every one of them, because a truck is not a shipment:
 *
 *   route      where it comes free and where it is headed, and the FREE SPACE.
 *              Never "700 cf": always "700 cf free", or "Space not stated".
 *              Two quantities never share a unit word;
 *   decision   when it leaves, how far it will swing, and how alive the listing
 *              is -- where a job card puts readiness, freshness and a price.
 *              There is no price slot at all: the column does not exist on this
 *              table, so a "cheapest truck" sort cannot be built out of nothing;
 *   evidence   who is driving, how sure we are of the place, what they require
 *              and what they can carry;
 *   action     View details, and Show contact BESIDE it -- one link covering
 *              the card and every control its sibling, exactly as the job card
 *              does it (V05/V15).
 */

import { useRef, useState } from "react";
import { api } from "@/lib/basePath";
import type { PublicTruckRow } from "@/lib/loads/publicView";
import { boardDay, requirementChips, TAG_LABELS } from "@/lib/loads/present";
import {
  departureLabel,
  driverLine,
  freeSpaceLabel,
  truckFreshness,
  truckPlaceLabel,
  truckStatusMeta,
  NO_DESTINATION_STATED,
} from "@/lib/loads/truckPresent";
import {
  approxEndsLabel,
  reviewTitle,
  APPROX_NOTE,
  EvidenceChip,
  NEEDS_REVIEW,
  ReadinessChip,
  RequirementBadge,
} from "./LoadViews";
import { Chip } from "./ui";

export interface TruckCardProps {
  truck: PublicTruckRow;
  selected: boolean;
  hovered: boolean;
  now: Date;
  onSelect(truck: PublicTruckRow, opts?: { contact?: boolean }): void;
  onHover(id: number | null): void;
}

export interface TruckListProps {
  trucks: PublicTruckRow[];
  selectedId: number | null;
  hoveredId: number | null;
  now: Date;
  onSelect: TruckCardProps["onSelect"];
  onHover: TruckCardProps["onHover"];
}

/**
 * At most three equipment chips before the row stops being scannable.
 *
 * The cap is on the DESCRIPTIVE chips only. What a driver cannot take, what
 * they require, and anything MoverMesh is unsure of are never folded behind a
 * "+2" -- a caveat behind a counter is a caveat nobody reads.
 */
const MAX_TAGS = 3;

export function TruckList({ trucks, selectedId, hoveredId, now, onSelect, onHover }: TruckListProps) {
  const list = useRef<HTMLUListElement>(null);

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
      {trucks.map((truck) => (
        <li key={truck.id}>
          <TruckCard
            truck={truck}
            now={now}
            selected={selectedId === truck.id}
            hovered={hoveredId === truck.id}
            onSelect={onSelect}
            onHover={onHover}
          />
        </li>
      ))}
    </ul>
  );
}

export function TruckListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <ul className="flex flex-col gap-[var(--sp-2)]" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="card p-[var(--sp-3)]" style={{ opacity: 1 - i * 0.15 }}>
          <span className="skeleton h-[22px] w-[74%]" />
          <span className="skeleton mt-[var(--sp-1)] h-[26px] w-[132px]" />
          <div className="mt-[var(--sp-2)] flex gap-[var(--sp-2)]">
            <span className="skeleton h-[22px] w-[104px] rounded-[var(--radius-pill)]" />
            <span className="skeleton h-[22px] w-[72px] rounded-[var(--radius-pill)]" />
          </div>
          <span className="skeleton mt-[var(--sp-2)] h-[20px] w-[58%]" />
          <span className="skeleton mt-[var(--sp-3)] h-[32px] w-full" />
        </li>
      ))}
    </ul>
  );
}

export function TruckCard({ truck, selected, hovered, now, onSelect, onHover }: TruckCardProps) {
  const today = boardDay(now);
  const from = truckPlaceLabel(truck, "origin");
  const to = truckPlaceLabel(truck, "dest");
  const space = freeSpaceLabel(truck);
  const depart = departureLabel(truck, today);
  const fresh = truckFreshness(truck, now);
  const inactive = truck.status !== "available";
  const requirements = requirementChips(truck.requirements);
  const approx = approxEndsLabel(from.approx, to.stated && to.approx, ["origin", "destination"]);
  const equipment = truck.equipment ?? [];
  const shownEquipment = equipment.slice(0, MAX_TAGS);
  const hiddenEquipment = equipment.length - shownEquipment.length;

  const open = (opts?: { contact?: boolean }) => onSelect(truck, opts);
  const status = truckStatusMeta(truck.status);
  const [keyboardFocus, setKeyboardFocus] = useState(false);

  return (
    <article
      data-truck-card
      data-truck-id={truck.id}
      onMouseEnter={() => onHover(truck.id)}
      /* The keyboard's mark, and the map highlight, exactly as `JobCard` does
         them -- and for the reasons written out there: a CSS
         `:has(a:focus-visible)` loses to globals.css's unlayered `.card`, and
         Chrome does not re-evaluate it when the arrow keys move focus. */
      onFocus={(e) => {
        onHover(truck.id);
        setKeyboardFocus(e.target.matches(":focus-visible"));
      }}
      onBlur={() => setKeyboardFocus(false)}
      className={`card card-hover link-parent p-[var(--sp-3)]${selected ? " card-selected" : ""}`}
      data-hovered={hovered && !selected ? "" : undefined}
      style={{
        opacity: inactive ? 0.7 : 1,
        borderColor: keyboardFocus ? "var(--accent)" : undefined,
      }}
    >
      {/* REGION 1 — the leg and the space, the two things a dispatcher scans.
          Where the truck comes free, in the same city-and-state form the job
          card leads with; the unit word is "free", carried a size down so the
          two columns line up while never reading alike. */}
      <h3 className="t-title" style={{ overflowWrap: "anywhere" }}>
        {from.text}
        {to.stated ? (
          <>
            {" "}
            <span aria-hidden>→</span>
            <span className="sr-only">to</span> {to.text}
          </>
        ) : (
          <span style={{ color: "var(--approx)" }}> · {NO_DESTINATION_STATED}</span>
        )}
      </h3>
      <div className="mt-[2px] flex items-baseline gap-[var(--sp-2)]">
        {space.stated ? (
          <span className="t-quantity" title={space.title}>
            {truck.free_cf!.toLocaleString("en-US")}
            <span className="t-label font-medium" style={{ color: "var(--muted)" }}>
              {" cf free"}
            </span>
          </span>
        ) : (
          <EvidenceChip kind="unknown" title={space.title}>
            {space.text}
          </EvidenceChip>
        )}
      </div>

      {/* REGION 2 — when it leaves, and how far off its line it will come. No
          price slot: the column does not exist on this table. */}
      <div className="mt-[var(--sp-2)] flex items-center gap-x-[var(--sp-2)]">
        <span className="flex min-w-0 flex-wrap items-center gap-x-[var(--sp-2)] gap-y-[var(--sp-1)]">
          <ReadinessChip text={depart.text} tone={depart.tone} title={depart.title} />
          {truck.truck_text && (
            <span className="truncate" style={{ color: "var(--muted)" }}>
              {truck.truck_text}
            </span>
          )}
        </span>
        <span
          className="nums ml-auto shrink-0 whitespace-nowrap"
          style={{ color: "var(--muted)" }}
          title="How far off their line this driver will swing for a job. The only matcher setting a human sets."
        >
          ±{truck.corridor_miles} mi swing
        </span>
      </div>

      {/* Listing availability: plain text, never a pill. The lifecycle's own
          chip joins it only once the listing has left the board. */}
      <div
        className="mt-[var(--sp-1)] flex flex-wrap items-center gap-x-[var(--sp-2)] gap-y-[var(--sp-1)]"
        style={{ color: "var(--muted)" }}
      >
        {inactive && (
          <Chip tone={status.tone} title={status.title}>
            {status.label}
          </Chip>
        )}
        <span
          className="whitespace-nowrap"
          title={fresh.detail ?? undefined}
          style={fresh.tone === "fresh" ? { color: "var(--text-2)", fontWeight: 500 } : undefined}
        >
          {fresh.text}
        </span>
        {truck.distance_miles != null && (
          <>
            <span aria-hidden>·</span>
            <span
              className="nums whitespace-nowrap"
              title="Straight line from where you are to where this truck comes free"
            >
              {from.approx ? "≈ " : ""}
              {Math.round(truck.distance_miles)} mi away
            </span>
          </>
        )}
        {truck.detour_miles != null && (
          <>
            <span aria-hidden>·</span>
            <span
              className="nums whitespace-nowrap"
              title="Extra straight-line miles this truck's leg adds to your own route. Not road miles."
            >
              {truck.detour_miles === 0
                ? "no detour"
                : `+${truck.detour_miles.toLocaleString()} mi detour`}
            </span>
          </>
        )}
      </div>

      {/* REGION 3 — who is driving, and everything qualifying it. */}
      <div className="mt-[var(--sp-2)] flex flex-wrap items-center gap-x-[var(--sp-2)] gap-y-[var(--sp-1)]">
        <span className="min-w-0 truncate" style={{ color: "var(--muted)" }}>
          {driverLine(truck)}
        </span>
        {/* The poster's own copy only: nobody else is served a demo row at all.
            It is here because "See it →" lands on this card, and a listing that
            looked like the ones around it would leave the driver believing they
            had published. */}
        {truck.is_demo && (
          <Chip
            tone="warn"
            title="Posted from a demo account. Only this account can see it — it is not on the public board."
          >
            Demo · only you
          </Chip>
        )}
        {approx && (
          <EvidenceChip kind="unknown" title={APPROX_NOTE}>
            {approx}
          </EvidenceChip>
        )}
        {truck.needs_review && (
          <EvidenceChip kind="review" title={reviewTitle(truck.flags)}>
            {NEEDS_REVIEW}
          </EvidenceChip>
        )}
        {requirements.map((req) => (
          <RequirementBadge key={`req-${req.label}`} label={req.label} title={req.title} />
        ))}
        {/* Never capped: what a driver says they CANNOT take is the fact that
            stops a dispatcher wasting a call. */}
        {(truck.cannot ?? []).map((tag) => (
          <Chip key={`no-${tag}`} tone="danger" title="The driver says they cannot take this">
            no {(TAG_LABELS[tag]?.label ?? tag).toLowerCase()}
          </Chip>
        ))}
        {shownEquipment.map((tag) => (
          <Chip
            key={`eq-${tag}`}
            tone={TAG_LABELS[tag]?.tone ?? "default"}
            title="The driver says they can take this"
          >
            {TAG_LABELS[tag]?.label ?? tag}
          </Chip>
        ))}
        {hiddenEquipment > 0 && (
          <Chip
            tone="muted"
            title={equipment.slice(MAX_TAGS).map((t) => TAG_LABELS[t]?.label ?? t).join(" · ")}
          >
            +{hiddenEquipment}
          </Chip>
        )}
      </div>

      {/* REGION 4 — two SIBLING controls, the same pattern as the job card. */}
      <div className="mt-[var(--sp-2)] flex items-center gap-[var(--sp-2)] border-t border-border pt-[var(--sp-2)]">
        <a
          data-card-link
          className="btn btn-link btn-sm link-cover -ml-[10px]"
          href={api(`/trucks/${truck.id}`)}
          aria-current={selected ? "true" : undefined}
          onClick={(e) => {
            if (e.defaultPrevented || e.button !== 0) return;
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            open();
          }}
        >
          View details
          <span className="sr-only">
            {": "}
            {from.text}
            {to.stated ? ` to ${to.text}` : ""}
          </span>
        </a>
        {truck.has_phone && (
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
