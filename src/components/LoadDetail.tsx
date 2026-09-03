"use client";

import { useEffect, useState } from "react";
import type { LoadRow } from "@/lib/loads/types";
import { formatMiles } from "@/lib/geo/math";
import { Chip, PrecisionNote, StatusChip, formatPickupDate, formatTime, formatWeight } from "./ui";
import { api } from "@/lib/basePath";

interface DetailResponse {
  load: LoadRow;
  duplicates: LoadRow[];
  source: {
    body: string;
    author_name: string | null;
    sent_at: string;
    group_name: string | null;
  } | null;
}

export function LoadDetail({
  load,
  onClose,
  canManage,
  onStatusChanged,
}: {
  load: LoadRow;
  onClose: () => void;
  canManage: boolean;
  onStatusChanged: () => void;
}) {
  const [data, setData] = useState<DetailResponse | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setData(null);
    fetch(api(`/api/loads/${load.id}`))
      .then((r) => r.json())
      .then((d: DetailResponse) => alive && setData(d))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [load.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const current = data?.load ?? load;
  const date = formatPickupDate(current.pickup_date);
  const time = formatTime(current.pickup_time, current.pickup_time_note);
  const weight = formatWeight(current);

  async function setStatus(status: string) {
    setBusy(true);
    await fetch(api(`/api/loads/${current.id}/status`), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    });
    setBusy(false);
    onStatusChanged();
    onClose();
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="flex-1 bg-black/25" onClick={onClose} />
      <div className="bg-surface flex w-full max-w-[520px] flex-col overflow-y-auto border-l border-border shadow-2xl">
        <header className="bg-surface sticky top-0 flex items-start gap-3 border-b border-border p-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[17px] font-bold">
                {current.pickup_state} → {current.delivery_state ?? "?"}
              </h2>
              <StatusChip status={current.status} />
              {current.load_type && <Chip tone="accent">{current.load_type}</Chip>}
            </div>
            {current.group_name && (
              <p className="mt-0.5 text-[12px] text-muted">Posted in {current.group_name}</p>
            )}
          </div>
          <button className="btn px-2 py-1" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="space-y-5 p-4">
          {/* ------- the lane ------- */}
          <section className="space-y-3">
            <Stop
              kind="Pickup"
              place={current.pickup_label}
              precision={current.pickup_precision}
              when={date.relative ? `${date.relative}, ${date.text}` : date.text}
              time={time}
            />
            <div className="ml-[7px] h-5 border-l-2 border-dotted border-border" />
            <Stop
              kind="Delivery"
              place={current.delivery_label}
              precision={current.delivery_precision}
              when={current.delivery_date ? formatPickupDate(current.delivery_date).text : null}
            />
          </section>

          {/* ------- facts ------- */}
          <section className="grid grid-cols-2 gap-3">
            <Fact label="Trip distance" value={current.trip_miles != null ? `${Math.round(current.trip_miles)} mi` : "—"} />
            <Fact
              label={current.detour_miles != null ? "Extra miles for you" : "Distance from you"}
              value={
                current.detour_miles != null
                  ? `+${current.detour_miles} mi`
                  : formatMiles(current.distance_miles)
              }
            />
            <Fact label="Freight" value={weight ?? "Not stated"} />
            <Fact
              label="Rate"
              value={current.rate_usd != null ? `$${current.rate_usd.toLocaleString()}` : "Not stated"}
            />
          </section>

          {current.notes && (
            <section>
              <div className="label">Notes</div>
              <p className="text-[13px]">{current.notes}</p>
            </section>
          )}

          {/* ------- contact ------- */}
          <section className="card p-3" style={{ background: "var(--accent-soft)", borderColor: "#c9d8ff" }}>
            <div className="label" style={{ color: "var(--accent)" }}>
              Contact
            </div>
            <div className="text-[15px] font-bold">{current.contact_name ?? "Not named"}</div>
            {current.contact_phone ? (
              <div className="mt-2 flex gap-2">
                <a className="btn btn-primary flex-1" href={`tel:${current.contact_phone}`}>
                  Call {current.contact_phone}
                </a>
                <a
                  className="btn"
                  href={`https://wa.me/${current.contact_phone.replace(/\D/g, "")}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  WhatsApp
                </a>
              </div>
            ) : (
              <p className="mt-1 text-[12px] text-muted">
                No phone number in the original message — check the source text below.
              </p>
            )}
          </section>

          {/* ------- provenance: the honest bit ------- */}
          {data?.source && (
            <section>
              <div className="label">Original WhatsApp message</div>
              <blockquote
                className="card p-3 text-[13px] whitespace-pre-wrap"
                style={{ background: "var(--surface-2)" }}
              >
                {data.source.body}
              </blockquote>
              <p className="mt-1.5 text-[11px] text-muted">
                {data.source.author_name ?? "Unknown"} ·{" "}
                {new Date(data.source.sent_at).toLocaleString()} ·{" "}
                {data.source.group_name ?? "unknown group"}
              </p>
              {current.confidence < 0.5 && (
                <p className="mt-1.5 text-[11px]" style={{ color: "var(--warn)" }}>
                  This load was read out of the message automatically with low confidence. Confirm
                  the details on the call.
                </p>
              )}
            </section>
          )}

          {data && data.duplicates.length > 0 && (
            <section>
              <div className="label">Also posted {data.duplicates.length}× elsewhere</div>
              <ul className="space-y-1 text-[12px] text-muted">
                {data.duplicates.map((d) => (
                  <li key={d.id} className="card px-2.5 py-1.5">
                    {d.group_name ?? "unknown group"} ·{" "}
                    {new Date(d.created_at).toLocaleString()}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {canManage && (
            <section className="border-t border-border pt-4">
              <div className="label">Update status</div>
              <div className="flex flex-wrap gap-2">
                {(["available", "pending", "taken", "cancelled"] as const).map((s) => (
                  <button
                    key={s}
                    className="btn capitalize"
                    disabled={busy || current.status === s}
                    onClick={() => setStatus(s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
              {data && data.duplicates.length > 0 && (
                <p className="mt-2 text-[11px] text-muted">
                  This also updates the {data.duplicates.length} duplicate
                  {data.duplicates.length === 1 ? "" : "s"} — it is the same freight.
                </p>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function Stop({
  kind,
  place,
  address,
  precision,
  when,
  time,
}: {
  kind: string;
  place: string;
  address?: string | null;
  precision: string | null;
  when?: string | null;
  time?: string | null;
}) {
  return (
    <div className="flex gap-3">
      <div
        className="mt-1.5 h-3.5 w-3.5 shrink-0 rounded-full border-[3px]"
        style={{ borderColor: kind === "Pickup" ? "var(--accent)" : "var(--ok)" }}
      />
      <div className="min-w-0">
        <div className="text-[11px] uppercase tracking-wide text-muted">{kind}</div>
        <div className="flex flex-wrap items-center gap-2 text-[15px] font-semibold">
          {place}
          <PrecisionNote precision={precision} />
        </div>
        {address && <div className="text-[13px] text-muted">{address}</div>}
        {when && (
          <div className="text-[13px]">
            {when}
            {time ? ` · ${time}` : ""}
          </div>
        )}
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="card p-2.5">
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div className="nums mt-0.5 text-[15px] font-semibold">{value}</div>
    </div>
  );
}
