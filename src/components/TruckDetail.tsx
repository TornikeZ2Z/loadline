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
import { boardDay, maskPhones, requirementChips, TAG_LABELS } from "@/lib/loads/present";
import {
  departureLabel,
  driverLine,
  freeSpaceLabel,
  truckFreshness,
  truckPlaceLabel,
  truckStatusMeta,
  NO_DESTINATION_STATED,
} from "@/lib/loads/truckPresent";
import { TRUCK_CORRIDOR_OPTIONS } from "@/lib/loads/constants";
import { ContactGate } from "./ContactGate";
import {
  reviewTitle,
  APPROX_NOTE,
  EvidenceChip,
  NEEDS_REVIEW,
  ReadinessChip,
  RequirementBadge,
} from "./LoadViews";
import { MatchPanel } from "./MatchPanel";
import { Chip } from "./ui";

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
  /**
   * Bumped whenever the owner changes something, so the match list is refetched.
   *
   * Editing exists on a truck and not on a job precisely because a departure
   * slips, and a slipped departure changes which loads fit -- gate 12 is the
   * one that answers "have you already driven past". A panel still showing
   * yesterday's answer under today's dates would be the exact failure the edit
   * button exists to prevent.
   */
  const [matchKey, setMatchKey] = useState(0);

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
        setMatchKey((k) => k + 1);
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
      setMatchKey((k) => k + 1);
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
  const requirements = requirementChips(row.requirements);
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
          {/* The leg is the title, in the same city-and-state form the job
              drawer uses. The two-letter lane it replaced said less than the
              line under it (V05). */}
          <h1 className="big mt-[var(--sp-1)] text-(length:--fs-xl) md:mt-[var(--sp-2)] md:text-(length:--fs-2xl)">
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
          </h1>
          {/* V06 -- availability in plain text, our own doubts as outlined chips. */}
          <div
            className="mt-[var(--sp-1)] flex flex-wrap items-center gap-x-[var(--sp-2)] gap-y-[var(--sp-1)] text-(length:--fs-base) md:mt-[var(--sp-2)]"
            style={{ color: "var(--muted)" }}
          >
            <span>{fresh.text}</span>
            {fresh.detail && (
              <>
                <span aria-hidden>·</span>
                <span>{fresh.detail}</span>
              </>
            )}
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
              <EvidenceChip kind="review" title={reviewTitle(row.flags)}>
                {NEEDS_REVIEW}
              </EvidenceChip>
            )}
            {/* No "approximate" chip up here: each Stop below carries its own,
                beside the place it qualifies (V07). */}
          </div>
        </section>

        <div className="p-[var(--sp-4)]">
          {/* ============================================================ *
              V07 — the same four groups the job drawer uses: Leg and schedule ·
              Space and requirements · Contact · Original post. The 2x2 grid of
              bordered mini-cards is gone: it repeated the Listed value from the
              header three lines above it and the swing distance from the Stop
              directly above it, in a card inside a card inside a drawer.
              ============================================================ */}

          {/* A — LEG AND SCHEDULE. */}
          <Group title="Leg and schedule" first>
            <Stop label="Empty at" place={from.text} approx={from.approx} approxLabel="Approximate origin">
              <div className="mt-[var(--sp-1)]">
                <ReadinessChip text={depart.text} tone={depart.tone} title={depart.title} />
              </div>
            </Stop>
            <div
              className="my-[var(--sp-1)] ml-[5px] border-l border-dashed pl-[var(--sp-4)] text-(length:--fs-base)"
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
                approx={to.approx}
                approxLabel="Approximate destination"
              >
                <div className="text-(length:--fs-base)" style={{ color: "var(--muted)" }}>
                  Will swing up to {row.corridor_miles} mi off this line
                </div>
              </Stop>
            ) : (
              <div className="flex gap-[var(--sp-3)]">
                <span
                  aria-hidden
                  className="mt-[6px] h-[10px] w-[10px] shrink-0 rounded-full border"
                  style={{ borderColor: "var(--approx)" }}
                />
                <div className="min-w-0">
                  <div className="label mb-0">Headed for</div>
                  <div className="text-(length:--fs-md) font-semibold" style={{ color: "var(--approx)" }}>
                    {NO_DESTINATION_STATED}
                  </div>
                  <div className="text-(length:--fs-base)" style={{ color: "var(--muted)" }}>
                    The post did not say. We do not guess a direction, and no match on this truck
                    will claim one.
                  </div>
                </div>
              </div>
            )}

            <Field label="From you">
              {row.distance_miles != null ? (
                <span className="nums">
                  {from.approx ? "≈ " : ""}
                  {Math.round(row.distance_miles).toLocaleString()} mi straight line
                </span>
              ) : (
                <span style={{ color: "var(--muted)" }}>Set your location to see this</span>
              )}
            </Field>
          </Group>

          {/* B — SPACE AND REQUIREMENTS. */}
          <Group title="Space and requirements">
            <div className="label">Free space</div>
            {space.stated ? (
              <div className="big text-(length:--fs-3xl) nums" title={space.title}>
                {row.free_cf!.toLocaleString("en-US")}
                <span className="text-(length:--fs-md) font-medium" style={{ color: "var(--muted)" }}>
                  {" cf free"}
                </span>
              </div>
            ) : (
              <EvidenceChip kind="unknown" title={space.title}>
                {space.text}
              </EvidenceChip>
            )}
            {row.truck_cf != null && (
              <div className="text-(length:--fs-base)" style={{ color: "var(--muted)" }}>
                of a {row.truck_cf.toLocaleString("en-US")} cf truck
              </div>
            )}

            <Field label="Truck">{row.truck_text ? maskPhones(row.truck_text) : "Not described"}</Field>

            {((row.equipment?.length ?? 0) > 0 || (row.cannot?.length ?? 0) > 0 || row.equipment_notes) && (
              <div className="mt-[var(--sp-4)]">
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
              </div>
            )}

            {claims.length > 0 && (
              <div className="mt-[var(--sp-4)]">
                <div className="label">Self-reported — we do not verify any of this</div>
                <div className="flex flex-wrap gap-[var(--sp-1)]">
                  {claims.map((c) => (
                    <Chip key={c} tone="muted" title="The driver ticked this box. Nobody checked it.">
                      {c}
                    </Chip>
                  ))}
                </div>
              </div>
            )}

            {row.requirements && (
              <div className="mt-[var(--sp-4)]">
                <div className="label">Driver&apos;s requirements</div>
                <div className="flex flex-wrap gap-[var(--sp-1)]">
                  {requirements.map((req) => (
                    <RequirementBadge key={req.label} label={req.label} title={req.title} />
                  ))}
                </div>
                <p className="mt-[var(--sp-2)] text-(length:--fs-base)">{maskPhones(row.requirements)}</p>
              </div>
            )}

            {row.notes && (
              <div className="mt-[var(--sp-4)]">
                <div className="label">Notes</div>
                <p className="text-(length:--fs-base)">{maskPhones(row.notes)}</p>
              </div>
            )}
          </Group>

          {/* 6 — the only place a phone number reaches the page. */}
          {!mobile && <Group title="Contact the driver">{gate}</Group>}

          {/* 6b — what this truck could carry.
              Public, like the truck itself, and phone-free: every job in it is
              one the board would already have shown this reader. The panel is
              the driver's own answer to "was posting this worth it?", so it is
              above the WhatsApp text rather than at the bottom of the page. */}
          <MatchPanel
            side="truck"
            path={`/api/trucks/${row.id}/matches`}
            freeCf={row.free_cf}
            radius={row.dest_lat == null}
            refreshKey={matchKey}
          />

          {/* 7 — the post it came from, when there was one. */}
          {data?.source && (
            <Group title="Original post">
              <p className="text-(length:--fs-base)" style={{ color: "var(--muted)" }}>
                {data.source.author_name ?? "Unnamed sender"}
                {data.source.group_name ? ` · ${data.source.group_name}` : ""}
                {" · WhatsApp"}
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
              {/* Said in words next to the words it is about, not only in the
                  chip's tooltip up in the header (V06). */}
              {row.needs_review && (
                <p className="mt-[var(--sp-2)] text-(length:--fs-base)" style={{ color: "var(--warn)" }}>
                  {NEEDS_REVIEW}:{" "}
                  {row.flags?.filter(Boolean).join(" · ") ||
                    "the rules were not confident about this reading"}
                  . Check the message above before you call.
                </p>
              )}
            </Group>
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

/** One of V07's groups. The sibling of `LoadDetail`'s, and the same rule. */
function Group({
  title,
  first,
  children,
}: {
  title: string;
  first?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className={first ? "" : "mt-[var(--sp-5)] border-t border-border pt-[var(--sp-4)]"}>
      <h2 className="t-title mb-[var(--sp-3)]">{title}</h2>
      {children}
    </section>
  );
}

/** A labelled value inside a group. No card: see `Group`. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-[var(--sp-3)]">
      <div className="label">{label}</div>
      <div className="text-(length:--fs-base)">{children}</div>
    </div>
  );
}

/**
 * One end of the leg. The uncertainty chip names the end rather than reading a
 * bare "approximate location" (V06), and sits under the place it qualifies.
 */
function Stop({
  label,
  place,
  approx,
  approxLabel,
  children,
}: {
  label: string;
  place: string;
  approx: boolean;
  approxLabel: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex gap-[var(--sp-3)]">
      <span
        aria-hidden
        className="mt-[6px] h-[10px] w-[10px] shrink-0 rounded-full"
        style={{ background: label === "Empty at" ? "var(--pickup)" : "var(--delivery)" }}
      />
      <div className="min-w-0">
        <div className="label mb-0">{label}</div>
        <div className="text-(length:--fs-md) font-semibold">{place}</div>
        {approx && (
          <div className="mt-[var(--sp-1)]">
            <EvidenceChip kind="unknown" title={APPROX_NOTE}>
              {approxLabel}
            </EvidenceChip>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
