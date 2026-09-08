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
  distanceCaveat,
  formatCf,
  formatPrice,
  freshnessLabel,
  maskPhones,
  placeLabel,
  readyEvidence,
  readyLabel,
  requirementChips,
  senderLine,
  twinLabel,
  PRICE_NOT_PROVIDED,
  TAG_LABELS,
} from "@/lib/loads/present";
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
import { ReportProblem } from "./ReportProblem";
import { Chip, StatusChip } from "./ui";

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
  const requirements = requirementChips(row.requirements);
  const trip = data?.distances?.trip ?? null;
  const toPickup = data?.distances?.toPickup ?? null;
  // Two caveats, two spans. The pickup→delivery leg can be blurred by either
  // end; the viewer→pickup leg only by the pickup. Both are independent of
  // whether a road route came back — see `distanceCaveat`.
  const tripCaveat = distanceCaveat(row, "trip");
  const nearCaveat = distanceCaveat(row, "toPickup");
  // The public copy of the post is masked by the server and masked again below;
  // the revealed copy is the original the gate just handed back, so it is shown
  // as written. Masking that a second time would redact the very number the
  // reveal granted. `redactPhones` preserves the line count (check:redact
  // asserts it), so the excerpt's line numbers index the original unchanged.
  const revealedBody = revealed?.sourceBody ?? null;
  const revealedLines = revealedBody?.split("\n") ?? null;
  const sourceBody = revealedBody ?? data?.source?.body ?? null;

  // Cross-sender twins. The chip counts postings INCLUDING this one
  // (`dup_count`, computed by the server from `dup_group_id`); the list further
  // down is the OTHER rows in that group, so it is one shorter. The two can
  // disagree for a moment while the detail fetch is in flight, because the chip
  // comes from the list row and the rows come from the response.
  const twin = twinLabel(row.dup_count);
  const twins = data?.duplicates ?? [];

  /**
   * The gate. On a phone it is NOT rendered here — see the bar below the
   * scroller — so this is the desktop copy and the mobile one is the same
   * element in a different place.
   */
  const gate = (
    <ContactGate
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
        {/* 1 — header.
            Sticky, because this drawer is ~1,200 px long and the lane is the
            one thing you need to still know when you are eight sections down
            reading the original post. The way back out travels with it. */}
        {/* On a phone this header and the contact bar together are 361 px of a
            464 px sheet, so the drawer's own body gets a hundred. It keeps
            everything it says and one size step less of saying it. */}
        <section
          className="sticky top-0 z-10 border-b border-border px-[var(--sp-4)] pb-[var(--sp-2)] pt-[var(--sp-2)] md:pb-[var(--sp-3)] md:pt-[var(--sp-3)]"
          style={{ background: "var(--surface-glass)", backdropFilter: "blur(8px)" }}
        >
          <BackButton total={totalInList} onClose={onClose} />
          {/* The route, city and state to city and state, is the title -- the
              two-letter lane that used to be the h1 said less than the line
              under it and is gone rather than printed twice (V05). */}
          <h1 className="big mt-[var(--sp-1)] text-(length:--fs-xl) md:mt-[var(--sp-2)] md:text-(length:--fs-2xl)">
            {from.text} <span aria-hidden>→</span>
            <span className="sr-only">to</span> {to.text}
          </h1>
          {/* V06 -- availability in plain text, our own doubts as outlined
              chips. The freshness line is about the LISTING; the chips beside
              it are MoverMesh saying how much to trust the reading. */}
          <div
            className="mt-[var(--sp-1)] flex flex-wrap items-center gap-x-[var(--sp-2)] gap-y-[var(--sp-1)] text-(length:--fs-base) md:mt-[var(--sp-2)]"
            style={{ color: "var(--muted)" }}
          >
            <span>{fresh.text}</span>
            {/* Said out loud rather than left in the freshness tooltip, which
                was the only place "Posted 4× since Sep 1" and "Relisted" ever
                appeared (V06). */}
            {fresh.detail && (
              <>
                <span aria-hidden>·</span>
                <span>{fresh.detail}</span>
              </>
            )}
            {row.status !== "available" && <StatusChip status={row.status} />}
            {/*
              Only ever true on the poster's own copy: a demo listing is not
              returned to anybody else (src/lib/loads/query.ts), so nobody sees
              this chip on somebody else's job. It is here because "See it →"
              lands on this drawer, and a listing that looks exactly like the 98
              around it would leave the poster believing they published to the
              board. They did not.
            */}
            {row.is_demo && (
              <Chip tone="warn" title="Posted from a demo account. Only this account can see it — it is not on the public board.">
                Demo · only you
              </Chip>
            )}
            {row.needs_review && (
              <EvidenceChip kind="review" title={reviewTitle(row.flags)}>
                {NEEDS_REVIEW}
              </EvidenceChip>
            )}
            {twin && (
              <EvidenceChip kind="unknown" title={twin.title}>
                {twin.label}
              </EvidenceChip>
            )}
            {/* No "approximate" chip up here: V07 asks for source context beside
                the field it qualifies, and each Stop below carries its own --
                which also names WHICH end is the guess. */}
          </div>
        </section>

        <div className="p-[var(--sp-4)]">

        {/* ============================================================== *
            V07 — FOUR GROUPS, AND NOTHING SAID TWICE.
            Route and schedule · Load and requirements · Contact · Original
            post. The drawer used to open with a two-up size/price card, then a
            timeline, then a 2x2 grid of bordered mini-cards that repeated the
            Ready value from the timeline and the Listed value from the header
            three lines above it. The mini-cards are gone entirely -- a card
            inside a card inside a drawer, for a label and one line of text --
            and every value now appears in exactly one of these groups.
            ============================================================== */}

        {/* A — ROUTE AND SCHEDULE. Where it starts, where it ends, when it can
            be loaded and by when it must land. */}
        <Group title="Route and schedule" first>
          <Stop
            label="Pickup"
            place={from.text}
            approx={from.approx}
            approxLabel="Approximate pickup"
          >
            <div className="mt-[var(--sp-1)] flex flex-wrap items-center gap-[var(--sp-2)]">
              <ReadinessChip text={ready.text} tone={ready.tone} title={ready.title} />
              {readyEvidence(row) && (
                <span className="text-(length:--fs-base)" style={{ color: "var(--muted)" }}>
                  {readyEvidence(row)}
                </span>
              )}
            </div>
          </Stop>

          {/* Three independent statements, deliberately not merged.
              WHAT KIND OF NUMBER: a road route, a straight line, or none at all
              -- the provider either answered or it did not.
              HOW GOOD THE ENDS ARE: a post that never named a city is measured
              to a state centroid, and a road route to a centroid is still a
              route to a made-up address. This job is the live example: an exact
              Kearny pickup, "SC 29588" that resolved only to the state, and a
              confident-looking "726 mi by road" between them.
              WHAT THE TIME IS: an ESTIMATE from a routing provider (V07). It is
              a car on an empty road, not a loaded truck with a driver who has
              to sleep, and MoverMesh is not a party to when this freight
              arrives. The word "estimated" is in the line rather than in a
              tooltip for exactly that reason. */}
          <div
            className="my-[var(--sp-1)] ml-[5px] border-l border-dashed pl-[var(--sp-4)] text-(length:--fs-base)"
            style={{ borderColor: "var(--border-strong)", color: "var(--muted)", minHeight: 28 }}
            title={tripCaveat?.title ?? undefined}
          >
            {trip
              ? `${tripCaveat ? "≈ " : ""}${Math.round(trip.miles).toLocaleString()} mi by road · ${formatDuration(trip.minutes)} estimated driving`
              : data == null
                ? "checking road distance…"
                : row.trip_miles != null
                  ? `${tripCaveat ? "≈ " : ""}${Math.round(row.trip_miles).toLocaleString()} mi straight line`
                  : "Distance not available"}
            {/* Only where there is a number to qualify: "Distance not available
                to an approximate delivery" says nothing the first half did not. */}
            {tripCaveat && (trip != null || row.trip_miles != null) && (
              <span style={{ color: "var(--approx)" }}>
                {" · "}
                {tripCaveat.note}
              </span>
            )}
            {trip && (
              <div className="text-(length:--fs-sm)">
                Driving time is a routing estimate, not a delivery commitment — agree dates with
                the sender.
              </div>
            )}
          </div>

          <Stop
            label="Delivery"
            place={to.text}
            approx={to.approx}
            approxLabel="Approximate delivery"
          >
            <div className="text-(length:--fs-base)" style={{ color: "var(--muted)" }}>
              {deliverBy ? (
                <span style={{ color: deliverBy.tone === "warn" ? "var(--warn)" : undefined }}>
                  {deliverBy.text}
                </span>
              ) : (
                "No delivery deadline stated"
              )}
            </div>
          </Stop>

          <Field label="From you">
            {toPickup ? (
              <span className="nums" title={nearCaveat?.title ?? undefined}>
                {nearCaveat ? "≈ " : ""}
                {Math.round(toPickup.miles).toLocaleString()} mi ·{" "}
                {formatDuration(toPickup.minutes)} estimated driving to pickup
              </span>
            ) : row.distance_miles != null ? (
              <span className="nums" title={nearCaveat?.title ?? undefined}>
                {nearCaveat ? "≈ " : ""}
                {Math.round(row.distance_miles).toLocaleString()} mi straight line
              </span>
            ) : (
              <button
                type="button"
                className="btn btn-link btn-sm -ml-[10px]"
                onClick={() =>
                  window.dispatchEvent(
                    new CustomEvent(OPEN_LOCATION_EVENT, { detail: { slot: "current" } }),
                  )
                }
              >
                Set your location to see this
              </button>
            )}
            {/* Same caveat as the leg's, worded for this one. The drawer has the
                room for the words; the card, which shows the same number, has
                only the "≈" and the tooltip. */}
            {nearCaveat && (toPickup != null || row.distance_miles != null) && (
              <div className="text-(length:--fs-sm)" style={{ color: "var(--approx)" }}>
                {nearCaveat.note}
              </div>
            )}
          </Field>
        </Group>

        {/* B — LOAD AND REQUIREMENTS. How big, what it pays, and what the
            sender demands of whoever takes it. */}
        <Group title="Load and requirements">
          <div className="grid grid-cols-2 gap-[var(--sp-3)]">
            <div>
              <div className="label">Size</div>
              {row.cubic_feet != null ? (
                <div className="big text-(length:--fs-3xl)">{formatCf(row.cubic_feet)}</div>
              ) : (
                <div className="mt-[var(--sp-1)]">
                  <EvidenceChip
                    kind="unknown"
                    title="The post never stated a size, and MoverMesh does not estimate one."
                  >
                    Size not stated
                  </EvidenceChip>
                </div>
              )}
            </div>
            <div>
              <div className="label">Price</div>
              {/* The SAME string as the card, deliberately. The detail has room
                  for more words, and used to spend it on "Not stated — ask the
                  sender"; a driver meets a missing price dozens of times a
                  session and should not have to notice that two different
                  sentences mean one thing. The next step is not lost with the
                  wording: the contact block below is the thing that actually
                  gets you the sender. Never "Negotiable" and never "Make offer"
                  -- neither is a thing the post said. */}
              {price.tone === "muted" ? (
                <div className="text-(length:--fs-md)" style={{ color: "var(--muted)" }}>
                  {PRICE_NOT_PROVIDED}
                </div>
              ) : (
                <>
                  <div className="big text-(length:--fs-xl)" style={{ color: "var(--ok)" }}>
                    {price.headline}
                  </div>
                  {price.sub && (
                    <div className="text-(length:--fs-base)" style={{ color: "var(--muted)" }}>
                      {price.sub}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {/* The sender's own conditions, as chips beside their own words. The
              chips are a reading of that paragraph and the paragraph is under
              them, so nothing here is only a tooltip. */}
          {row.requirements && (
            <div className="mt-[var(--sp-4)]">
              <div className="label">Sender&apos;s requirements</div>
              <div className="flex flex-wrap gap-[var(--sp-1)]">
                {requirements.map((req) => (
                  <RequirementBadge key={req.label} label={req.label} title={req.title} />
                ))}
              </div>
              <p className="mt-[var(--sp-2)] text-(length:--fs-base)">
                {maskPhones(row.requirements)}
              </p>
              <p className="mt-[var(--sp-1)] text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
                Stated by the sender. MoverMesh verifies no authority, insurance or identity.
              </p>
            </div>
          )}

          {(row.job_notes || (row.tags?.length ?? 0) > 0) && (
            <div className="mt-[var(--sp-4)]">
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
            </div>
          )}
        </Group>

        {/* 6 — the only place a phone number reaches the page.
            On a phone it is not here at all: it is the bar under this scroller,
            because `position: sticky` inside a 384 px scrollport could not hold
            it once the sign-in step doubled its height, and the bottom 13 px of
            it -- the Cancel button -- was clipped. A flex row outside the
            scroller cannot be clipped by definition, and it is on screen from
            the moment the job opens rather than six sections down. */}
        {/* "Contact the poster" rather than V07's bare "Contact": ContactGate
            draws its own "Contact" caption, and a heading directly above a
            caption of the same word reads as a stutter. This is the branding
            review's own phrase for the action. */}
        {!mobile && (
          <Group title="Contact the poster" ref={contactSection}>
            {gate}
          </Group>
        )}

        {/* 6b — the mirror of the truck page's panel.
            Public, and phone-free like everything above it: a match is a
            pointer, not an introduction, and reaching a driver still means
            going through the contact gate on the truck itself. It sits after
            the contact block because it answers a different question -- "who
            could take this?" rather than "who posted it?" -- and a reader who
            has already decided to call should not have to scroll past it. */}
        <MatchPanel side="job" path={`/api/loads/${row.id}/matches`} jobCf={row.cubic_feet} />

        {/* D — ORIGINAL POST. The reading above is ours; this is what the
            sender actually wrote, one action away and with this job's own line
            highlighted. */}
        {data?.source && (
          <Group title="Original post">
            <p className="text-(length:--fs-base)" style={{ color: "var(--muted)" }}>
              {data.source.author_name ?? "Unnamed sender"}
              {data.source.group_name ? ` · ${data.source.group_name}` : ""}
              {" · WhatsApp · "}
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
                className="btn btn-sm mt-[var(--sp-2)]"
                onClick={() => setFullMessage((f) => !f)}
              >
                {fullMessage ? "Show just this job's line" : `Show full message (${excerpt.total} lines)`}
              </button>
            )}

            {/* Said in words next to the words it is about, not only in the
                chip's tooltip up in the header (V06). */}
            {row.needs_review && (
              <p className="mt-[var(--sp-2)] text-(length:--fs-base)" style={{ color: "var(--warn)" }}>
                {NEEDS_REVIEW}: {row.flags?.filter(Boolean).join(" · ") || "the rules were not confident about this reading"}. Check the message above before you call.
              </p>
            )}

            {row.confidence < 0.5 && (
              <p className="mt-[var(--sp-1)] text-(length:--fs-base)" style={{ color: "var(--warn)" }}>
                Read out of the message automatically with low confidence — confirm the details on the call.
              </p>
            )}
          </Group>
        )}

        {/* The other postings of what looks like this same load.
            "Also posted by another sender" was the whole of this before, which
            told a driver a fact they could do nothing with: not who, not what
            the other posting says, not whether it is worth the second call. The
            rows are already in the response, phone-free like every other public
            row, so this prints the two things that decide it -- what the other
            sender is offering, and how recently they said it. We do not merge
            them and we do not pick one: the match is lane, delivery ZIP and
            cubic feet, which is strong evidence and not proof, and the terms on
            the two rows can genuinely differ. */}
        {twins.length > 0 && (
          <section className="mt-[var(--sp-5)] border-t border-border pt-[var(--sp-4)]">
            <div className="label">Also posted by another sender</div>
            <ul className="flex flex-col gap-[var(--sp-1)]">
              {twins.map((d) => {
                const dp = formatPrice(d);
                const dr = readyLabel(d, today);
                return (
                  <li key={d.id} className="text-(length:--fs-base)">
                    <span className="font-semibold">{senderLine(d)}</span>
                    <span style={{ color: "var(--muted)" }}>
                      {" · "}
                      {dp.headline}
                      {" · "}
                      {dr.text}
                      {" · "}
                      {freshnessLabel(d, now).text}
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="mt-[var(--sp-1)] text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
              Same pickup, delivery ZIP and size, posted within a week. Both stay
              on the board as posted — MoverMesh cannot confirm they are the same
              freight, so it does not merge them or choose between them.
            </p>
          </section>
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
            <Link
              href={`/admin/test?message=${row.source_message_id}`}
              className="flex min-h-[var(--tap-min)] items-center md:min-h-0"
              style={{ color: "var(--accent)" }}
            >
              Open in WhatsApp console →
            </Link>
            {row.needs_review && (
              <Link
                href={`/admin?tab=attention&message=${row.source_message_id}`}
                className="flex min-h-[var(--tap-min)] items-center md:min-h-0"
                style={{ color: "var(--accent)" }}
              >
                Review in admin queue →
              </Link>
            )}
          </section>
        )}

        {/* 9 — report. Last, and open to everyone: it belongs after the reader
            has seen our reading of the post and the original message it came
            from, because that is the moment they can tell that it is wrong. */}
        <ReportProblem loadId={row.id} />
        </div>
      </div>

      {/* The phone's contact bar: outside the scroller, so it is always the
          bottom of the sheet and never scrolls away or gets cut off.

          It may shrink, and scrolls inside itself when it does. The bar is
          269 px tall with the sign-in step open and the sheet is not always
          that tall: at the shortest snap, or with the on-screen keyboard up,
          where the whole viewport is 450. `shrink-0` there pushed the Call
          buttons 77 px past the bottom of the screen with no way to reach
          them. Shrinking costs nothing at the snaps where it fits. */}
      {mobile && (
        <section
          ref={contactSection}
          /* `scroll-py`: when the browser scrolls a focused field into this
             scroller it aligns to the padding box, and without it the field
             being typed into ends up flush against the bottom edge of the
             screen with the keyboard directly under it. */
          className="min-h-0 overflow-y-auto overscroll-contain scroll-py-[var(--sp-4)] border-t border-border px-[var(--sp-4)] py-[var(--sp-3)]"
          style={{ background: "var(--surface)" }}
        >
          {gate}
        </section>
      )}
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

/**
 * One of V07's four groups.
 *
 * A real <h2> rather than the uppercase `.label` the sub-fields use: these are
 * the four things a drawer is made of, and a reader skimming for the contact
 * action or the original post is looking for a heading, not a caption. The rule
 * above it is the group's only border -- the mini-cards this replaced put a
 * second and a third border inside the drawer's own.
 */
function Group({
  title,
  first,
  ref,
  children,
}: {
  title: string;
  /** The first group needs no rule: the sticky header already drew one. */
  first?: boolean;
  ref?: React.Ref<HTMLElement>;
  children: React.ReactNode;
}) {
  return (
    <section
      ref={ref}
      className={
        first
          ? ""
          : "mt-[var(--sp-5)] border-t border-border pt-[var(--sp-4)]"
      }
    >
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
 * One end of the route: the place, whether we had to guess it, and whatever the
 * post said about the timing of that end.
 *
 * The uncertainty chip NAMES THE END -- "Approximate pickup", not a bare
 * "approximate location" that leaves the reader to work out which of the two
 * places above it is the vague one (V06). It sits directly under the place it
 * qualifies, which is what "keep source context adjacent to fields that are
 * uncertain" asks for.
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
        style={{ background: label === "Pickup" ? "var(--pickup)" : "var(--delivery)" }}
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
