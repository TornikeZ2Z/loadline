"use client";

import type { LoadRow } from "@/lib/loads/types";
import { formatMiles } from "@/lib/geo/math";
import { Chip, PrecisionNote, StatusChip, formatPickupDate, formatTime, formatWeight } from "./ui";

/* ------------------------------- list view ------------------------------- */

export function LoadList({
  loads,
  onSelect,
  selectedId,
}: {
  loads: LoadRow[];
  onSelect: (load: LoadRow) => void;
  selectedId?: number | null;
}) {
  return (
    <div className="space-y-2 p-4">
      {loads.map((load) => (
        <LoadCard
          key={load.id}
          load={load}
          onSelect={onSelect}
          selected={selectedId === load.id}
        />
      ))}
    </div>
  );
}

function LoadCard({
  load,
  onSelect,
  selected,
}: {
  load: LoadRow;
  onSelect: (l: LoadRow) => void;
  selected: boolean;
}) {
  const date = formatPickupDate(load.pickup_date);
  const time = formatTime(load.pickup_time, load.pickup_time_note);
  const weight = formatWeight(load);

  return (
    <button
      onClick={() => onSelect(load)}
      className="card w-full cursor-pointer p-3 text-left transition-shadow hover:shadow-sm"
      style={selected ? { borderColor: "var(--accent)", boxShadow: "0 0 0 1px var(--accent)" } : undefined}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">
              {load.pickup_state} → {load.delivery_state ?? "?"}
            </span>
            <StatusChip status={load.status} />
            {load.dup_count > 1 && (
              <Chip title={`Posted ${load.dup_count} times across your groups`}>
                {load.dup_count}× posted
              </Chip>
            )}
            {load.load_type && <Chip tone="accent">{load.load_type}</Chip>}
          </div>

          <div className="mt-1.5 grid gap-0.5 text-[13px]">
            <Leg label="Pick up" place={load.pickup_label} precision={load.pickup_precision} />
            <Leg label="Deliver" place={load.delivery_label} precision={load.delivery_precision} />
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
            <span className={date.relative ? "font-semibold text-ink" : undefined}>
              {date.relative ? `${date.relative}, ${date.text}` : date.text}
              {time ? ` · ${time}` : ""}
            </span>
            {weight && <span className="nums">{weight}</span>}
            {load.trip_miles != null && (
              <span className="nums">{Math.round(load.trip_miles)} mi trip</span>
            )}
            {load.rate_usd != null && (
              <span className="nums font-semibold" style={{ color: "var(--ok)" }}>
                ${load.rate_usd.toLocaleString()}
              </span>
            )}
            {load.contact_name && <span>{load.contact_name}</span>}
            {load.group_name && <span className="truncate">via {load.group_name}</span>}
          </div>
        </div>

        <div className="shrink-0 text-right">
          {load.distance_miles != null && (
            <>
              <div className="nums text-[15px] font-bold">{formatMiles(load.distance_miles)}</div>
              <div className="text-[11px] text-muted">away</div>
            </>
          )}
          {load.detour_miles != null && (
            <div className="mt-1">
              <div className="nums text-[15px] font-bold" style={{ color: "var(--accent)" }}>
                +{load.detour_miles}
              </div>
              <div className="text-[11px] text-muted">extra mi</div>
            </div>
          )}
        </div>
      </div>
    </button>
  );
}

function Leg({
  label,
  place,
  precision,
}: {
  label: string;
  place: string;
  precision: string | null;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="w-[52px] shrink-0 text-[11px] uppercase tracking-wide text-muted">
        {label}
      </span>
      <span className="truncate">{place}</span>
      <PrecisionNote precision={precision} />
    </div>
  );
}

/* ------------------------------- table view ------------------------------ */

export function LoadTable({
  loads,
  onSelect,
  showDetour,
}: {
  loads: LoadRow[];
  onSelect: (l: LoadRow) => void;
  showDetour: boolean;
}) {
  return (
    <div className="overflow-x-auto p-4">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted">
            <Th>Pickup</Th>
            <Th>Delivery</Th>
            <Th>Date</Th>
            <Th right>Trip</Th>
            <Th right>{showDetour ? "Extra" : "Away"}</Th>
            <Th>Equipment</Th>
            <Th right>Weight</Th>
            <Th right>Rate</Th>
            <Th>Contact</Th>
            <Th>Status</Th>
          </tr>
        </thead>
        <tbody>
          {loads.map((load) => {
            const date = formatPickupDate(load.pickup_date);
            return (
              <tr
                key={load.id}
                onClick={() => onSelect(load)}
                className="cursor-pointer border-b border-border hover:bg-surface-2"
              >
                <Td>
                  <div className="font-medium">{load.pickup_label}</div>
                </Td>
                <Td>{load.delivery_label}</Td>
                <Td>
                  {date.relative ? (
                    <span className="font-semibold">{date.relative}</span>
                  ) : (
                    date.text
                  )}
                </Td>
                <Td right>{load.trip_miles != null ? Math.round(load.trip_miles) : "—"}</Td>
                <Td right>
                  {showDetour
                    ? load.detour_miles != null
                      ? `+${load.detour_miles}`
                      : "—"
                    : load.distance_miles != null
                      ? Math.round(load.distance_miles)
                      : "—"}
                </Td>
                <Td>{load.load_type ?? "—"}</Td>
                <Td right>{load.weight_lbs ? load.weight_lbs.toLocaleString() : "—"}</Td>
                <Td right>{load.rate_usd != null ? `$${load.rate_usd.toLocaleString()}` : "—"}</Td>
                <Td>{load.contact_name ?? "—"}</Td>
                <Td>
                  <StatusChip status={load.status} />
                </Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return <th className={`px-2 py-2 font-semibold ${right ? "text-right" : ""}`}>{children}</th>;
}

function Td({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return <td className={`px-2 py-2 ${right ? "nums text-right" : ""}`}>{children}</td>;
}
