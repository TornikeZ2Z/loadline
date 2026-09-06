"use client";

/**
 * One job, opened inside the list column.
 *
 * A drawer rather than a page, and inside the column rather than over the map,
 * for one reason: a mover comparing three routes should never lose the map or
 * the search that produced them. The MapLibre instance is untouched while this
 * mounts and unmounts.
 *
 * The section that matters most is the last one: the original WhatsApp message,
 * with this job's own line highlighted. Everything above it is our reading of
 * the post, and a driver about to spend a phone call deserves to check that
 * reading against the words the sender actually wrote. Phones in that text are
 * masked -- always, by the server first and by `maskPhones` here again -- until
 * the contact gate hands back the unmasked body.
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/basePath";
import { formatDuration } from "@/lib/geo/here";
import type { PublicDetailResponse, PublicLoadRow, ContactResponse } from "@/lib/loads/publicView";
import type { StoredLocation } from "@/lib/location";
import { OPEN_LOCATION_EVENT } from "@/lib/location";
import type { Role } from "@/lib/session";
import {
  boardDay,
  deliverByLabel,
  formatCf,
  formatPrice,
  freshnessLabel,
  laneLabel,
  maskPhones,
  placeLabel,
  readyLabel,
  requirementChip,
  senderLine,
  TAG_LABELS,
} from "@/lib/loads/present";
import { ContactGate } from "./ContactGate";
import { Chip, PrecisionNote, StatusChip } from "./ui";

export interface LoadDetailProps {
  /** Null while a deep link is still loading: the detail fetches by `jobId`. */
  job: PublicLoadRow | null;
  jobId: number;
  totalInList: number;
  signedIn: boolean;
  demoMode: boolean;
  role: Role | null;
  userId: number | null;
  viewer: StoredLocation | null;
  /** The card's Show contact button was used. */
  autoContact?: boolean;
  mobile?: boolean;
  onClose(): void;
  onStatusChanged(): void;
}

/**
 * The four a person may set. `delisted` and `expired` are derived by the
 * lifecycle and the server rejects them, so they are not offered.
 */
type ManualStatus = "available" | "pending" | "taken" | "cancelled";
const MANAGE_STATUSES: ManualStatus[] = ["available", "pending", "taken", "cancelled"];

/** How many lines of the original post to show around the job's own line. */
const CONTEXT_LINES = 3;

export function LoadDetail({
  job,
  jobId,
  totalInList,
  signedIn,
  demoMode,
  role,
  userId,
  viewer,
  autoContact,
  mobile,
  onClose,
  onStatusChanged,
}: LoadDetailProps) {
  const [data, setData] = useState<PublicDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<ContactResponse | null>(null);
  const [fullMessage, setFullMessage] = useState(false);
  const [busy, setBusy] = useState(false);
  const contactSection = useRef<HTMLElement>(null);

  const load = useCallback(async () => {
    const sp = new URLSearchParams();
    if (viewer) {
      sp.set("viewerLat", viewer.lat.toFixed(5));
      sp.set("viewerLng", viewer.lng.toFixed(5));
    }
    const qs = sp.toString();
    const res = await fetch(api(`/api/loads/${jobId}${qs ? `?${qs}` : ""}`));
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error ?? "Could not open this job");
    return body as PublicDetailResponse;
  }, [jobId, viewer]);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    setRevealed(null);
    setFullMessage(false);
    load()
      .then((d) => alive && setData(d))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : "Could not open this job"));
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

  // The row from the list is shown immediately so the drawer never flashes
  // empty; the fetched row replaces it and adds the source message.
  const row = data?.load ?? job;
  const now = new Date();
  const today = boardDay(now);

  const excerpt = useMemo(
    () => buildExcerpt(data?.source?.body ?? null, row?.line_text ?? null, row?.pickup_city ?? null),
    [data?.source?.body, row?.line_text, row?.pickup_city],
  );

  const canManage =
    row != null &&
    (role === "admin" || (role === "poster" && userId != null && row.posted_by === userId));

  // The card's Show contact button opens the drawer scrolled to the top, and
  // the gate is the sixth section down -- below the fold on a laptop, two
  // screens down on a phone -- so without this the one CTA on the card looks
  // like it did nothing. On a phone the gate is pinned to the bottom of the
  // sheet instead (see section 6), where it is already in view.
  const gateShown = row != null;
  useEffect(() => {
    if (!autoContact || mobile || !gateShown) return;
    // Next frame, not this one: ContactGate's own autoOpen effect runs first
    // (children before parents) and swaps its button for the taller sign-in
    // step, so centring before that commit centres the collapsed version. And
    // again on `data`, because the sections above the gate are still growing
    // until the detail fetch lands and would push it back off the fold.
    const frame = requestAnimationFrame(() =>
      contactSection.current?.scrollIntoView({ block: "center" }),
    );
    return () => cancelAnimationFrame(frame);
  }, [autoContact, mobile, gateShown, jobId, data]);

  async function setStatus(status: ManualStatus) {
    if (!row) return;
    setBusy(true);
    try {
      const res = await fetch(api(`/api/loads/${row.id}/status`), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (res.ok) {
        onStatusChanged();
        setData(await load().catch(() => data));
      }
    } finally {
      setBusy(false);
    }
  }

  if (!row) {
    return (
      <div className="drawer-enter flex h-full flex-col p-[var(--sp-4)]">
        <BackButton total={totalInList} onClose={onClose} />
        <p className="mt-[var(--sp-4)] text-(length:--fs-base)" style={{ color: "var(--muted)" }}>
          {error ?? "Opening job…"}
        </p>
      </div>
    );
  }

  const from = placeLabel(row, "pickup");
  const to = placeLabel(row, "delivery");
  const price = formatPrice(row);
  const ready = readyLabel(row, today);
  const deliverBy = deliverByLabel(row, today);
  const fresh = freshnessLabel(row, now);
  const requirement = requirementChip(row.requirements);
  const trip = data?.distances?.trip ?? null;
  const toPickup = data?.distances?.toPickup ?? null;
  // The public copy of the post is masked by the server and masked again below;
  // the revealed copy is the original the gate just handed back, so it is shown
  // as written. Masking that a second time would redact the very number the
  // reveal granted. `redactPhones` preserves the line count (check:redact
  // asserts it), so the excerpt's line numbers index the original unchanged.
  const revealedBody = revealed?.sourceBody ?? null;
  const revealedLines = revealedBody?.split("\n") ?? null;
  const sourceBody = revealedBody ?? data?.source?.body ?? null;

  return (
    <div className="drawer-enter flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-[var(--sp-4)]">
        {/* 1 — header */}
        <section>
          <BackButton total={totalInList} onClose={onClose} />
          <h1 className="big mt-[var(--sp-3)] text-(length:--fs-2xl)">{laneLabel(row)}</h1>
          <p className="text-(length:--fs-md)" style={{ color: "var(--text-2)" }}>
            {from.text} → {to.text}
          </p>
          <div className="mt-[var(--sp-2)] flex flex-wrap gap-[var(--sp-1)]">
            <Chip tone={fresh.tone} title={fresh.detail ?? undefined}>
              {fresh.text}
            </Chip>
            {row.status !== "available" && <StatusChip status={row.status} />}
            {row.needs_review && (
              <Chip tone="review" title={row.flags?.join(" · ") || undefined}>
                Unverified
              </Chip>
            )}
            <PrecisionNote precision={row.pickup_precision} />
            {row.pickup_precision !== row.delivery_precision && (
              <PrecisionNote precision={row.delivery_precision} />
            )}
          </div>
        </section>

        {/* 2 — size and price */}
        <section className="mt-[var(--sp-4)] grid grid-cols-2 gap-[var(--sp-3)]">
          <div>
            <div className="label">Size</div>
            <div
              className="big text-(length:--fs-3xl)"
              style={row.cubic_feet == null ? { color: "var(--approx)", fontSize: "var(--fs-lg)" } : undefined}
            >
              {row.cubic_feet != null ? formatCf(row.cubic_feet) : "Size not stated"}
            </div>
          </div>
          <div>
            <div className="label">Price</div>
            <div
              className="big text-(length:--fs-xl)"
              style={{ color: price.tone === "muted" ? "var(--muted)" : "var(--ok)" }}
            >
              {price.tone === "muted" ? "Price not stated — ask" : price.headline}
            </div>
            {price.sub && price.tone !== "muted" && (
              <div className="text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
                {price.sub}
              </div>
            )}
          </div>
        </section>

        {/* 3 — timeline */}
        <section className="mt-[var(--sp-4)]">
          <Stop
            label="Pickup"
            place={from.text}
            precision={row.pickup_precision}
            note={ready.text}
            noteTitle={ready.title}
          />
          <div
            className="my-[var(--sp-1)] ml-[5px] border-l border-dashed pl-[var(--sp-4)] text-(length:--fs-sm)"
            style={{ borderColor: "var(--border-strong)", color: "var(--muted)", minHeight: 28 }}
          >
            {trip
              ? `${Math.round(trip.miles).toLocaleString()} mi by road · ${formatDuration(trip.minutes)} driving`
              : data == null
                ? "checking road distance…"
                : row.trip_miles != null
                  ? `${Math.round(row.trip_miles).toLocaleString()} mi straight line`
                  : "Distance not available"}
          </div>
          <Stop
            label="Delivery"
            place={to.text}
            precision={row.delivery_precision}
            note={deliverBy?.text ?? "No deadline given"}
          />
        </section>

        {/* 4 — facts */}
        <section className="mt-[var(--sp-4)] grid grid-cols-2 gap-[var(--sp-2)]">
          <Fact label="From you">
            {toPickup ? (
              <span className="nums">
                {Math.round(toPickup.miles).toLocaleString()} mi · {formatDuration(toPickup.minutes)} to pickup
              </span>
            ) : row.distance_miles != null ? (
              <span className="nums">{Math.round(row.distance_miles).toLocaleString()} mi straight line</span>
            ) : (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                style={{ color: "var(--accent)", padding: 0 }}
                onClick={() =>
                  window.dispatchEvent(
                    new CustomEvent(OPEN_LOCATION_EVENT, { detail: { slot: "current" } }),
                  )
                }
              >
                Set your location to see this
              </button>
            )}
          </Fact>

          <Fact label="Ready">
            <span title={ready.title ?? undefined}>{ready.text}</span>
            <div className="text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
              {row.ready_source === "assumed"
                ? "assumed — no marker in the post"
                : row.ready_source
                  ? `as posted (${row.ready_source})`
                  : ""}
            </div>
          </Fact>

          <Fact label="Deliver by">{deliverBy?.text ?? "Not given"}</Fact>

          <Fact label="Listed">
            <span>{listedRange(row)}</span>
          </Fact>
        </section>

        {/* 5 — the sender's own words about the work */}
        {row.requirements && (
          <section className="mt-[var(--sp-4)]">
            <div className="label">Sender&apos;s requirements</div>
            {requirement && <Chip title={requirement.title}>{requirement.label}</Chip>}
            <p className="mt-[var(--sp-1)] text-(length:--fs-base)">{maskPhones(row.requirements)}</p>
          </section>
        )}

        {(row.job_notes || (row.tags?.length ?? 0) > 0) && (
          <section className="mt-[var(--sp-4)]">
            <div className="label">Notes on this job</div>
            {(row.tags?.length ?? 0) > 0 && (
              <div className="mb-[var(--sp-1)] flex flex-wrap gap-[var(--sp-1)]">
                {row.tags.map((tag) => {
                  const meta = TAG_LABELS[tag];
                  return (
                    <Chip key={tag} tone={meta?.tone ?? "default"}>
                      {meta?.label ?? tag}
                    </Chip>
                  );
                })}
              </div>
            )}
            {row.job_notes && <p className="text-(length:--fs-base)">{maskPhones(row.job_notes)}</p>}
          </section>
        )}

        {/* 6 — the only place a phone number reaches the page */}
        {/* On a phone this is the sticky bar at the bottom of the sheet (C
            §1.3): the sheet's half snap shows ~390 px of a ~1,200 px drawer,
            so a contact block that scrolled with the rest would be two screens
            below the tap that asked for it. */}
        <section
          ref={contactSection}
          className="mt-[var(--sp-4)]"
          style={
            mobile
              ? {
                  position: "sticky",
                  bottom: 0,
                  marginLeft: "calc(var(--sp-4) * -1)",
                  marginRight: "calc(var(--sp-4) * -1)",
                  padding: "var(--sp-3) var(--sp-4)",
                  background: "var(--surface-glass)",
                  backdropFilter: "blur(6px)",
                  borderTop: "1px solid var(--border)",
                }
              : undefined
          }
        >
          <ContactGate
            loadId={row.id}
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
        </section>

        {/* 7 — the post it came from */}
        {data?.source && (
          <section className="mt-[var(--sp-4)]">
            <div className="label">Original WhatsApp message</div>
            <p className="text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
              {data.source.author_name ?? "Unnamed sender"}
              {data.source.group_name ? ` · ${data.source.group_name}` : ""}
              {" · "}
              {new Date(data.source.sent_at).toLocaleString([], {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </p>

            <div
              className="card mt-[var(--sp-2)] whitespace-pre-wrap p-[var(--sp-3)] text-(length:--fs-sm)"
              style={{ background: "var(--surface-2)", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
            >
              {fullMessage || !excerpt
                ? (revealedBody ?? maskPhones(sourceBody)) || ""
                : excerpt.lines.map((line) => (
                    <div
                      key={line.n}
                      style={
                        line.hit
                          ? { background: "var(--accent-soft)", fontWeight: 600 }
                          : undefined
                      }
                    >
                      {(revealedLines?.[line.n] ?? maskPhones(line.text)) || " "}
                    </div>
                  ))}
            </div>

            {excerpt && excerpt.total > excerpt.lines.length && (
              <button
                type="button"
                className="btn btn-ghost btn-sm mt-[var(--sp-1)]"
                onClick={() => setFullMessage((f) => !f)}
              >
                {fullMessage ? "Show just this job's line" : `Show full message (${excerpt.total} lines)`}
              </button>
            )}

            {row.confidence < 0.5 && (
              <p className="mt-[var(--sp-1)] text-(length:--fs-sm)" style={{ color: "var(--warn)" }}>
                Read out of the message automatically with low confidence — confirm the details on the call.
              </p>
            )}
          </section>
        )}

        {(data?.duplicates?.length ?? 0) > 0 && (
          <p className="mt-[var(--sp-2)] text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
            Also posted by another sender
          </p>
        )}

        {/* 8 — manage */}
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
            </div>
            <p className="mt-[var(--sp-1)] text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
              Marking Taken sticks even if the sender re-posts it.
            </p>
          </section>
        )}

        {role === "admin" && row.source_message_id != null && (
          <section className="mt-[var(--sp-3)] flex flex-col gap-[var(--sp-1)] text-(length:--fs-sm)">
            <Link href={`/admin/test?message=${row.source_message_id}`} style={{ color: "var(--accent)" }}>
              Open in WhatsApp console →
            </Link>
            {row.needs_review && (
              <Link
                href={`/admin?tab=attention&message=${row.source_message_id}`}
                style={{ color: "var(--accent)" }}
              >
                Review in admin queue →
              </Link>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

function BackButton({ total, onClose }: { total: number; onClose(): void }) {
  return (
    <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
      ← Back to {total} {total === 1 ? "job" : "jobs"}
    </button>
  );
}

function Stop({
  label,
  place,
  precision,
  note,
  noteTitle,
}: {
  label: string;
  place: string;
  precision: string | null;
  note: string;
  noteTitle?: string | null;
}) {
  return (
    <div className="flex gap-[var(--sp-3)]">
      <span
        aria-hidden
        className="mt-[6px] h-[10px] w-[10px] shrink-0 rounded-full"
        style={{ background: label === "Pickup" ? "var(--pickup)" : "var(--delivery)" }}
      />
      <div className="min-w-0">
        <div className="text-(length:--fs-xs) font-semibold uppercase tracking-wide" style={{ color: "var(--muted)" }}>
          {label}
        </div>
        <div className="text-(length:--fs-md) font-semibold">{place}</div>
        <div className="text-(length:--fs-sm)" style={{ color: "var(--muted)" }} title={noteTitle ?? undefined}>
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

/** "Sep 1 – Sep 6 · posted 4×" / "Today" — how long this job has been around. */
function listedRange(row: PublicLoadRow): string {
  const fmt = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" })
      : null;
  const first = fmt(row.first_seen_at ?? row.created_at);
  const last = fmt(row.last_seen_at ?? row.created_at);
  const times = row.seen_count > 1 ? ` · posted ${row.seen_count}×` : "";
  if (!first || !last) return "Today";
  if (first === last) return `${first}${times}`;
  return `${first} – ${last}${times}`;
}

/**
 * The job's own line in the post, with a few lines of context and the origin
 * header that governs it.
 *
 * Matched on the exact text of `line_text` rather than a line number: the row
 * does not carry one, and an exact match is the honest test -- if the message
 * was edited since extraction, no line highlights rather than the wrong one.
 */
function buildExcerpt(
  body: string | null,
  lineText: string | null,
  pickupCity: string | null,
): { lines: Array<{ n: number; text: string; hit: boolean }>; total: number } | null {
  if (!body) return null;
  const all = body.split("\n");
  const total = all.length;
  if (!lineText) return null;

  const needle = lineText.trim();
  const at = all.findIndex((l) => l.trim() === needle);
  if (at < 0) return null;

  const from = Math.max(0, at - CONTEXT_LINES);
  const to = Math.min(total - 1, at + CONTEXT_LINES);
  const picked: Array<{ n: number; text: string; hit: boolean }> = [];

  // A batch post's destination lines are meaningless without the origin header
  // above them, which is often further up than the context window reaches.
  if (pickupCity) {
    const city = pickupCity.toLowerCase();
    for (let i = from - 1; i >= 0; i--) {
      if (all[i].toLowerCase().includes(city)) {
        picked.push({ n: i, text: all[i], hit: false });
        if (i < from - 1) picked.push({ n: -1, text: "…", hit: false });
        break;
      }
    }
  }

  for (let i = from; i <= to; i++) picked.push({ n: i, text: all[i], hit: i === at });
  return { lines: picked, total };
}
