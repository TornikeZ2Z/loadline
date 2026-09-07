"use client";

/**
 * One truck, opened inside the list column.
 *
 * The sibling of `LoadDetail`, and a drawer for the same reason: a dispatcher
 * comparing three empty legs should never lose the map or the search that
 * produced them.
 *
 * Two sections exist here that have no equivalent on a job:
 *
 *   EDIT. A departure slips, and a truck advertising last Tuesday is worse than
 *   no truck -- it costs a dispatcher the one call they were going to make. The
 *   owner can change the dates and the space in place. The lane is deliberately
 *   NOT editable, and the panel says why: going somewhere else is a second
 *   truck, not an edit to this one.
 *
 *   SELF-REPORTED. DOT & MC, HHG authority and a COI are printed under a
 *   heading that says we do not verify any of it, and the matcher never reads
 *   them. A badge nobody checked, shown without that sentence, is the exact
 *   thing a broker board would do.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/basePath";
import type { ContactResponse, PublicTruckDetailResponse, PublicTruckRow } from "@/lib/loads/publicView";
import type { StoredLocation } from "@/lib/location";
import type { Role } from "@/lib/session";
import { boardDay, maskPhones, requirementChip, TAG_LABELS } from "@/lib/loads/present";
import {
  departureLabel,
  driverLine,
  freeSpaceLabel,
  truckFreshness,
  truckLaneLabel,
  truckPlaceLabel,
  truckStatusMeta,
  DEPARTURE_NOT_STATED,
  NO_DESTINATION_STATED,
} from "@/lib/loads/truckPresent";
import { TRUCK_CORRIDOR_OPTIONS } from "@/lib/loads/constants";
import { ContactGate } from "./ContactGate";
import { Chip, PrecisionNote } from "./ui";

export interface TruckDetailProps {
  /** Null while a deep link is still loading: the detail fetches by `truckId`. */
  truck: PublicTruckRow | null;
  truckId: number;
  totalInList: number;
  signedIn: boolean;
  demoMode: boolean;
  role: Role | null;
  userId: number | null;
  viewer: StoredLocation | null;
  autoContact?: boolean;
  mobile?: boolean;
  onClose(): void;
  onChanged(): void;
}

/** What a person may set. `departed` and `expired` are the sweep's conclusions. */
const MANAGE_STATUSES = ["available", "booked", "cancelled"] as const;
type ManageStatus = (typeof MANAGE_STATUSES)[number];

type AvailMode = "now" | "from" | "between" | "unknown";

export function TruckDetail({
  truck,
  truckId,
  totalInList,
  signedIn,
  demoMode,
  role,
  userId,
  viewer,
  autoContact,
  mobile,
  onClose,
  onChanged,
}: TruckDetailProps) {
  const [data, setData] = useState<PublicTruckDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<ContactResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(api(`/api/trucks/${truckId}`));
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error ?? "Could not open this truck");
    return body as PublicTruckDetailResponse;
  }, [truckId]);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    setRevealed(null);
    setEditing(false);
    load()
      .then((d) => alive && setData(d))
      .catch(
        (e: unknown) =>
          alive && setError(e instanceof Error ? e.message : "Could not open this truck"),
      );
    return () => {
      alive = false;
    };
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // The row from the list shows immediately so the drawer never flashes empty.
  const row = data?.truck ?? truck;
  const now = useMemo(() => new Date(), [data]);
  const today = boardDay(now);

  const canManage =
    row != null && (role === "admin" || (userId != null && row.posted_by === userId));

  async function setStatus(status: ManageStatus) {
    if (!row) return;
    setBusy(true);
    try {
      const res = await fetch(api(`/api/trucks/${row.id}/status`), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (res.ok) {
        onChanged();
        setData(await load().catch(() => data));
      }
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit(patch: Record<string, string>) {
    if (!row) return;
    setBusy(true);
    setEditError(null);
    try {
      const res = await fetch(api(`/api/trucks/${row.id}`), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setEditError(body?.error ?? "Could not save the change");
        return;
      }
      setEditing(false);
      onChanged();
      setData(await load().catch(() => data));
    } finally {
      setBusy(false);
    }
  }

  if (!row) {
    return (
      <div className="drawer-enter flex h-full flex-col p-[var(--sp-4)]">
        <BackButton total={totalInList} onClose={onClose} />
        <p className="mt-[var(--sp-4)] text-(length:--fs-base)" style={{ color: "var(--muted)" }}>
          {error ?? "Opening truck…"}
        </p>
      </div>
    );
  }

  const from = truckPlaceLabel(row, "origin");
  const to = truckPlaceLabel(row, "dest");
  const space = freeSpaceLabel(row);
  const depart = departureLabel(row, today);
  const fresh = truckFreshness(row, now);
  const status = truckStatusMeta(row.status);
  const requirement = requirementChip(row.requirements);
  const claims = [
    row.has_dot_mc ? "DOT & MC" : null,
    row.has_hhg_authority ? "HHG authority" : null,
    row.has_coi ? "COI available" : null,
  ].filter(Boolean) as string[];

  const gate = (
    <ContactGate
      kind="truck"
      listingId={row.id}
      contactName={row.contact_name}
      hasPhone={row.has_phone}
      groupName={row.group_name}
      contactMode={row.contact_mode}
      signedIn={signedIn}
      demoMode={demoMode}
      autoOpen={autoContact}
      variant={mobile ? "sticky" : "card"}
      onRevealed={setRevealed}
    />
  );

  return (
    <div className="drawer-enter flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <section
          className="sticky top-0 z-10 border-b border-border px-[var(--sp-4)] pb-[var(--sp-2)] pt-[var(--sp-2)] md:pb-[var(--sp-3)] md:pt-[var(--sp-3)]"
          style={{ background: "var(--surface-glass)", backdropFilter: "blur(8px)" }}
        >
          <BackButton total={totalInList} onClose={onClose} />
          <h1 className="big mt-[var(--sp-1)] text-(length:--fs-xl) md:mt-[var(--sp-2)] md:text-(length:--fs-2xl)">
            {truckLaneLabel(row)}
          </h1>
          <p
            className="text-(length:--fs-base) md:text-(length:--fs-md)"
            style={{ color: "var(--muted)" }}
          >
            {from.text}
            {to.stated ? (
              <> → {to.text}</>
            ) : (
              <span style={{ color: "var(--approx)" }}> · {NO_DESTINATION_STATED}</span>
            )}
          </p>
          <div className="mt-[var(--sp-1)] flex flex-wrap gap-[var(--sp-1)] md:mt-[var(--sp-2)]">
            <Chip tone={fresh.tone} title={fresh.detail ?? undefined}>
              {fresh.text}
            </Chip>
            {row.status !== "available" && (
              <Chip tone={status.tone} title={status.title}>
                {status.label}
              </Chip>
            )}
            {row.is_demo && (
              <Chip
                tone="warn"
                title="Posted from a demo account. Only this account can see it — it is not on the public board."
              >
                Demo · only you
              </Chip>
            )}
            {row.needs_review && (
              <Chip tone="review" title={row.flags?.join(" · ") || undefined}>
                Unverified
              </Chip>
            )}
            <PrecisionNote precision={row.origin_precision} />
            {to.stated && row.origin_precision !== row.dest_precision && (
              <PrecisionNote precision={row.dest_precision} />
            )}
          </div>
        </section>

        <div className="p-[var(--sp-4)]">
          {/* 1 — the two numbers a dispatcher decides on. NOT size and price:
              a truck has no price, and the second number is when it moves. */}
          <section className="grid grid-cols-2 gap-[var(--sp-3)]">
            <div>
              <div className="label">Free space</div>
              {space.stated ? (
                <div className="big text-(length:--fs-3xl) nums" title={space.title}>
                  {row.free_cf!.toLocaleString("en-US")}
                  <span
                    className="text-(length:--fs-md) font-medium"
                    style={{ color: "var(--muted)" }}
                  >
                    {" cf free"}
                  </span>
                </div>
              ) : (
                <div className="text-(length:--fs-md)" style={{ color: "var(--approx)" }} title={space.title}>
                  {space.text}
                </div>
              )}
              {row.truck_cf != null && (
                <div className="text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
                  of a {row.truck_cf.toLocaleString("en-US")} cf truck
                </div>
              )}
            </div>
            <div>
              <div className="label">Departs</div>
              {depart.stated ? (
                <div className="big text-(length:--fs-xl)" title={depart.title ?? undefined}>
                  {depart.text}
                </div>
              ) : (
                <div className="text-(length:--fs-md)" style={{ color: "var(--approx)" }} title={depart.title ?? undefined}>
                  {DEPARTURE_NOT_STATED}
                </div>
              )}
            </div>
          </section>

          {/* 2 — the leg */}
          <section className="mt-[var(--sp-5)] border-t border-border pt-[var(--sp-4)]">
            <Stop label="Empty at" place={from.text} precision={row.origin_precision} note={depart.text} />
            <div
              className="my-[var(--sp-1)] ml-[5px] border-l border-dashed pl-[var(--sp-4)] text-(length:--fs-sm)"
              style={{ borderColor: "var(--border-strong)", color: "var(--muted)", minHeight: 28 }}
            >
              {row.leg_miles != null
                ? `${Math.round(row.leg_miles).toLocaleString()} mi straight line`
                : "No destination stated, so there is no leg to measure"}
            </div>
            {to.stated ? (
              <Stop
                label="Headed for"
                place={to.text}
                precision={row.dest_precision}
                note={`Will swing up to ${row.corridor_miles} mi off this line`}
              />
            ) : (
              <div className="flex gap-[var(--sp-3)]">
                <span
                  aria-hidden
                  className="mt-[6px] h-[10px] w-[10px] shrink-0 rounded-full border"
                  style={{ borderColor: "var(--approx)" }}
                />
                <div className="min-w-0">
                  <div
                    className="text-(length:--fs-xs) font-semibold uppercase tracking-wide"
                    style={{ color: "var(--muted)" }}
                  >
                    Headed for
                  </div>
                  <div className="text-(length:--fs-md) font-semibold" style={{ color: "var(--approx)" }}>
                    {NO_DESTINATION_STATED}
                  </div>
                  <div className="text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
                    The post did not say. We do not guess a direction, and no match on this truck
                    will claim one.
                  </div>
                </div>
              </div>
            )}
          </section>

          {/* 3 — facts */}
          <section className="mt-[var(--sp-5)] grid grid-cols-2 gap-[var(--sp-2)]">
            <Fact label="From you">
              {row.distance_miles != null ? (
                <span className="nums">
                  {from.approx ? "≈ " : ""}
                  {Math.round(row.distance_miles).toLocaleString()} mi straight line
                </span>
              ) : (
                <span style={{ color: "var(--muted)" }}>Set your location to see this</span>
              )}
            </Fact>
            <Fact label="Truck">{row.truck_text ? maskPhones(row.truck_text) : "Not described"}</Fact>
            <Fact label="Will swing">
              <span className="nums">{row.corridor_miles} mi off its line</span>
            </Fact>
            <Fact label="Listed">{listedRange(row)}</Fact>
          </section>

          {/* 4 — what it can and cannot take */}
          {((row.equipment?.length ?? 0) > 0 || (row.cannot?.length ?? 0) > 0 || row.equipment_notes) && (
            <section className="mt-[var(--sp-4)]">
              <div className="label">What it can take</div>
              <div className="flex flex-wrap gap-[var(--sp-1)]">
                {row.equipment?.map((tag) => (
                  <Chip key={`eq-${tag}`} tone={TAG_LABELS[tag]?.tone ?? "default"}>
                    {TAG_LABELS[tag]?.label ?? tag}
                  </Chip>
                ))}
                {row.cannot?.map((tag) => (
                  <Chip key={`no-${tag}`} tone="danger">
                    no {(TAG_LABELS[tag]?.label ?? tag).toLowerCase()}
                  </Chip>
                ))}
              </div>
              {row.equipment_notes && (
                <p className="mt-[var(--sp-1)] text-(length:--fs-base)">
                  {maskPhones(row.equipment_notes)}
                </p>
              )}
              <p className="mt-[var(--sp-1)] text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
                The driver&apos;s own list. A job that never stated a requirement is still shown to
                this truck.
              </p>
            </section>
          )}

          {/* 5 — self-reported, and said so */}
          {claims.length > 0 && (
            <section className="mt-[var(--sp-4)]">
              <div className="label">Self-reported — we do not verify any of this</div>
              <div className="flex flex-wrap gap-[var(--sp-1)]">
                {claims.map((c) => (
                  <Chip key={c} tone="muted" title="The driver ticked this box. Nobody checked it.">
                    {c}
                  </Chip>
                ))}
              </div>
            </section>
          )}

          {row.requirements && (
            <section className="mt-[var(--sp-4)]">
              <div className="label">Driver&apos;s requirements</div>
              {requirement && <Chip title={requirement.title}>{requirement.label}</Chip>}
              <p className="mt-[var(--sp-1)] text-(length:--fs-base)">{maskPhones(row.requirements)}</p>
            </section>
          )}

          {row.notes && (
            <section className="mt-[var(--sp-4)]">
              <div className="label">Notes</div>
              <p className="text-(length:--fs-base)">{maskPhones(row.notes)}</p>
            </section>
          )}

          {/* 6 — the only place a phone number reaches the page. */}
          {!mobile && <section className="mt-[var(--sp-5)]">{gate}</section>}

          {/* 7 — the post it came from, when there was one. */}
          {data?.source && (
            <section className="mt-[var(--sp-5)] border-t border-border pt-[var(--sp-4)]">
              <div className="label">Original WhatsApp message</div>
              <p className="text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
                {data.source.author_name ?? "Unnamed sender"}
                {data.source.group_name ? ` · ${data.source.group_name}` : ""}
              </p>
              <div
                className="card mt-[var(--sp-2)] whitespace-pre-wrap p-[var(--sp-3)] text-(length:--fs-sm)"
                style={{
                  background: "var(--surface-2)",
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                }}
              >
                {revealed?.sourceBody ?? maskPhones(data.source.body) ?? ""}
              </div>
            </section>
          )}

          {/* 8 — edit and manage. Trucks only; jobs have no equivalent. */}
          {canManage && (
            <section className="mt-[var(--sp-5)] border-t border-border pt-[var(--sp-3)]">
              <div className="label">Manage</div>
              <div className="flex flex-wrap gap-[var(--sp-1)]">
                {MANAGE_STATUSES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="btn btn-sm"
                    disabled={busy || row.status === s}
                    onClick={() => setStatus(s)}
                  >
                    {s}
                  </button>
                ))}
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() => setEditing((e) => !e)}
                >
                  {editing ? "Cancel edit" : "Edit dates & space"}
                </button>
              </div>

              {editing && (
                <EditPanel
                  truck={row}
                  busy={busy}
                  error={editError}
                  onSave={saveEdit}
                />
              )}

              <p className="mt-[var(--sp-2)] text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
                Going somewhere else? Post that as a second truck — changing the lane would make this
                a different listing.
              </p>
            </section>
          )}
        </div>
      </div>

      {mobile && (
        <section
          className="min-h-0 overflow-y-auto overscroll-contain scroll-py-[var(--sp-4)] border-t border-border px-[var(--sp-4)] py-[var(--sp-3)]"
          style={{ background: "var(--surface)" }}
        >
          {gate}
        </section>
      )}
    </div>
  );
}

/**
 * The edit panel: the fields that go stale, and nothing else.
 *
 * Departure first, because it is the reason editing exists. Free space second,
 * because a driver who picked up half a load on the way still has a truck worth
 * listing and a number that is now wrong. Everything else on the listing is
 * either fixed (the lane) or does not decay.
 */
function EditPanel({
  truck,
  busy,
  error,
  onSave,
}: {
  truck: PublicTruckRow;
  busy: boolean;
  error: string | null;
  onSave(patch: Record<string, string>): void;
}) {
  const initialMode: AvailMode = truck.avail_now
    ? "now"
    : truck.avail_from && truck.avail_to && truck.avail_from !== truck.avail_to
      ? "between"
      : truck.avail_from || truck.avail_to
        ? "from"
        : "unknown";

  const [mode, setMode] = useState<AvailMode>(initialMode);
  const [from, setFrom] = useState(truck.avail_from ?? "");
  const [to, setTo] = useState(truck.avail_to ?? "");
  const [freeCf, setFreeCf] = useState(truck.free_cf != null ? String(truck.free_cf) : "");
  const [corridor, setCorridor] = useState(String(truck.corridor_miles));

  return (
    <div className="card mt-[var(--sp-2)] flex flex-col gap-[var(--sp-3)] p-[var(--sp-3)]">
      <div>
        <div className="label">Empty</div>
        <div className="flex flex-col gap-[var(--sp-1)]">
          {(
            [
              ["now", "Now"],
              ["from", "From a date"],
              ["between", "Between two dates"],
              ["unknown", "Not decided"],
            ] as Array<[AvailMode, string]>
          ).map(([m, text]) => (
            <label key={m} className="check-row flex-wrap">
              <input type="radio" name="editAvail" checked={mode === m} onChange={() => setMode(m)} />
              {text}
              {m === "from" && mode === "from" && (
                <input
                  className="field"
                  style={{ width: "auto" }}
                  type="date"
                  aria-label="Empty from"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
              )}
              {m === "between" && mode === "between" && (
                <>
                  <input
                    className="field"
                    style={{ width: "auto" }}
                    type="date"
                    aria-label="Empty from"
                    value={from}
                    onChange={(e) => setFrom(e.target.value)}
                  />
                  <span style={{ color: "var(--muted)" }}>to</span>
                  <input
                    className="field"
                    style={{ width: "auto" }}
                    type="date"
                    aria-label="Empty until"
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                  />
                </>
              )}
            </label>
          ))}
        </div>
      </div>

      <div>
        <div className="label">Free space (cf)</div>
        <input
          className="field nums"
          style={{ width: "auto" }}
          type="number"
          min={10}
          max={20000}
          step="any"
          placeholder="leave blank if you are not sure"
          value={freeCf}
          onChange={(e) => setFreeCf(e.target.value)}
        />
        <p className="mt-[2px] text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
          Blank means “Space not stated”, which is a fact. It is never posted as 0 cf.
        </p>
      </div>

      <div>
        <div className="label">Will swing</div>
        <select
          className="field"
          style={{ width: "auto" }}
          value={corridor}
          onChange={(e) => setCorridor(e.target.value)}
        >
          {TRUCK_CORRIDOR_OPTIONS.map((m) => (
            <option key={m} value={m}>
              {m} miles
            </option>
          ))}
        </select>
      </div>

      {error && (
        <p className="text-(length:--fs-sm)" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      )}

      <button
        type="button"
        className="btn btn-primary btn-sm self-start"
        disabled={busy}
        onClick={() =>
          onSave({
            availMode: mode,
            availFrom: mode === "from" || mode === "between" ? from : "",
            availTo: mode === "between" ? to : "",
            freeCf,
            corridorMiles: corridor,
          })
        }
      >
        {busy ? "Saving…" : "Save"}
      </button>
    </div>
  );
}

function BackButton({ total, onClose }: { total: number; onClose(): void }) {
  return (
    <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
      ← Back to {total} {total === 1 ? "truck" : "trucks"}
    </button>
  );
}

function Stop({
  label,
  place,
  precision,
  note,
}: {
  label: string;
  place: string;
  precision: string | null;
  note: string;
}) {
  return (
    <div className="flex gap-[var(--sp-3)]">
      <span
        aria-hidden
        className="mt-[6px] h-[10px] w-[10px] shrink-0 rounded-full"
        style={{ background: label === "Empty at" ? "var(--pickup)" : "var(--delivery)" }}
      />
      <div className="min-w-0">
        <div
          className="text-(length:--fs-xs) font-semibold uppercase tracking-wide"
          style={{ color: "var(--muted)" }}
        >
          {label}
        </div>
        <div className="text-(length:--fs-md) font-semibold">{place}</div>
        <div className="text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
          {note}
        </div>
        <PrecisionNote precision={precision} />
      </div>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="card p-[var(--sp-3)]">
      <div className="label">{label}</div>
      <div className="text-(length:--fs-base)">{children}</div>
    </div>
  );
}

/** "Sep 1 – Sep 6" / "Today" — how long this listing has been up. */
function listedRange(row: PublicTruckRow): string {
  const fmt = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" }) : null;
  const first = fmt(row.first_seen_at ?? row.created_at);
  const last = fmt(row.last_seen_at ?? row.created_at);
  if (!first || !last) return "Today";
  return first === last ? first : `${first} – ${last}`;
}
