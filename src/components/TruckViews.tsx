"use client";

/**
 * The truck card and the list it lives in.
 *
 * A sibling of `LoadViews.tsx`, laid out to the same three-band rhythm so a
 * driver switching tabs is not re-learning where to look -- and carrying
 * different facts in every band, because a truck is not a shipment:
 *
 *   band 1  the lane, and the FREE SPACE. Never "700 cf": always "700 cf free",
 *           or "Space not stated". Two quantities never share a unit word;
 *   band 2  when it leaves and how far it will swing, where a job card puts
 *           when it is ready and what it pays. There is no price slot at all --
 *           the column does not exist;
 *   band 3  who is driving, how fresh the listing is, and the way out of the
 *           card -- "Show contact", the same words, the same gate.
 *
 * The card is a `div role="button"` for the same reason the job card is: it
 * contains a real button, and a button inside a button is invalid and
 * unreachable by keyboard.
 */

import { useRef } from "react";
import type { PublicTruckRow } from "@/lib/loads/publicView";
import { boardDay, requirementChip, TAG_LABELS } from "@/lib/loads/present";
import {
  departureLabel,
  driverLine,
  freeSpaceLabel,
  truckFreshness,
  truckLaneLabel,
  truckPlaceLabel,
  truckStatusMeta,
  NO_DESTINATION_STATED,
} from "@/lib/loads/truckPresent";
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

/** At most four chips before the row wraps and stops being scannable. */
const MAX_CHIPS = 4;

export function TruckList({ trucks, selectedId, hoveredId, now, onSelect, onHover }: TruckListProps) {
  const list = useRef<HTMLUListElement>(null);

  const onKeyDown = (e: React.KeyboardEvent<HTMLUListElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const cards = Array.from(list.current?.querySelectorAll<HTMLElement>("[data-truck-card]") ?? []);
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
          <div className="flex items-baseline justify-between gap-[var(--sp-2)]">
            <span className="skeleton h-[16px] w-[96px]" />
            <span className="skeleton h-[16px] w-[76px]" />
          </div>
          <span className="skeleton mt-[var(--sp-2)] h-[13px] w-[72%]" />
          <div className="mt-[var(--sp-2)] flex gap-[var(--sp-2)]">
            <span className="skeleton h-[22px] w-[88px] rounded-[var(--radius-pill)]" />
            <span className="skeleton h-[22px] w-[64px] rounded-[var(--radius-pill)]" />
          </div>
          <span className="skeleton mt-[var(--sp-3)] h-[12px] w-[58%]" />
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
  const requirement = requirementChip(truck.requirements);

  const chips: React.ReactNode[] = [];
  // The poster's own copy only: nobody else is served a demo row at all. It is
  // here because "See it →" lands on this card, and a listing that looked like
  // the ones around it would leave the driver believing they had published.
  if (truck.is_demo) {
    chips.push(
      <Chip
        key="demo"
        tone="warn"
        title="Posted from a demo account. Only this account can see it — it is not on the public board."
      >
        Demo · only you
      </Chip>,
    );
  }
  if (requirement) {
    chips.push(
      <Chip key="req" title={requirement.title}>
        {requirement.label}
      </Chip>,
    );
  }
  for (const tag of truck.equipment ?? []) {
    const meta = TAG_LABELS[tag];
    chips.push(
      <Chip key={`eq-${tag}`} tone={meta?.tone ?? "default"} title="The driver says they can take this">
        {meta?.label ?? tag}
      </Chip>,
    );
  }
  for (const tag of truck.cannot ?? []) {
    const meta = TAG_LABELS[tag];
    chips.push(
      <Chip key={`no-${tag}`} tone="danger" title="The driver says they cannot take this">
        no {(meta?.label ?? tag).toLowerCase()}
      </Chip>,
    );
  }
  if (truck.needs_review) {
    chips.push(
      <Chip key="review" tone="review" title={truck.flags?.join(" · ") || "Read out of a post automatically"}>
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

  const open = (opts?: { contact?: boolean }) => onSelect(truck, opts);
  const status = truckStatusMeta(truck.status);

  return (
    <div
      data-truck-card
      data-truck-id={truck.id}
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
      onMouseEnter={() => onHover(truck.id)}
      onFocus={() => onHover(truck.id)}
      className={`card card-hover cursor-pointer p-[var(--sp-3)]${selected ? " card-selected" : ""}`}
      data-hovered={hovered && !selected ? "" : undefined}
      style={{ opacity: inactive ? 0.7 : 1 }}
    >
      {/* Band 1 — the lane and the space, the two things a dispatcher scans.
          The unit word is "free", carried at the same size and weight as the
          job card's "cf" so the two columns line up while never reading alike. */}
      <div className="flex items-baseline justify-between gap-[var(--sp-2)]">
        <span className="big text-(length:--fs-lg) truncate">{truckLaneLabel(truck)}</span>
        {space.stated ? (
          <span className="big text-(length:--fs-lg) shrink-0 nums" title={space.title}>
            {truck.free_cf!.toLocaleString("en-US")}
            <span className="text-(length:--fs-sm) font-medium" style={{ color: "var(--muted)" }}>
              {" cf free"}
            </span>
          </span>
        ) : (
          <Chip tone="approx" className="shrink-0" title={space.title}>
            {space.text}
          </Chip>
        )}
      </div>

      <div className="mt-[1px] truncate text-(length:--fs-base)" style={{ color: "var(--muted)" }}>
        {from.text}
        {to.stated ? (
          <> → {to.text}</>
        ) : (
          <span style={{ color: "var(--approx)" }}> · {NO_DESTINATION_STATED}</span>
        )}
      </div>

      {/* Band 2 — when it leaves, and how far off its line it will come. No
          price slot: the column does not exist on this table, so a "cheapest
          truck" sort cannot be built out of nothing. */}
      <div className="mt-[var(--sp-2)] flex items-center gap-x-[var(--sp-2)]">
        <span className="flex min-w-0 flex-wrap items-center gap-x-[var(--sp-2)] gap-y-[var(--sp-1)]">
          {inactive ? (
            <Chip tone={status.tone} title={status.title}>
              {status.label}
            </Chip>
          ) : (
            <Chip tone={depart.tone} title={depart.title ?? undefined}>
              {depart.text}
            </Chip>
          )}
          {truck.truck_text && (
            <span className="truncate text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
              {truck.truck_text}
            </span>
          )}
        </span>
        <span
          className="nums ml-auto shrink-0 whitespace-nowrap text-(length:--fs-sm)"
          style={{ color: "var(--muted)" }}
          title="How far off their line this driver will swing for a job. The only matcher setting a human sets."
        >
          ±{truck.corridor_miles} mi swing
        </span>
      </div>

      {visibleChips.length > 0 && (
        <div className="mt-[var(--sp-1)] flex flex-wrap gap-[var(--sp-1)]">
          {visibleChips}
          {hiddenChips > 0 && <Chip tone="muted">+{hiddenChips}</Chip>}
        </div>
      )}

      {/* Band 3 — the listing rather than the truck. */}
      <div
        className="mt-[var(--sp-2)] flex items-center gap-x-[var(--sp-2)] border-t border-border pt-[var(--sp-2)] text-(length:--fs-sm)"
        style={{ color: "var(--muted)" }}
      >
        <span className="flex min-w-0 flex-wrap items-center gap-x-[var(--sp-1)]">
          <span className="truncate">{driverLine(truck)}</span>
          <span aria-hidden>·</span>
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
        </span>
        {truck.has_phone && (
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
