"use client";

/**
 * Posting an empty leg from the website.
 *
 * Shaped like the sentence a driver would type into the group -- "empty in
 * Newark Friday, 700 cf, heading to Miami" -- rather than like a row of the
 * `trucks` table. What it will not do is fill anything in for them:
 *
 *   * the destination has a "Not decided yet" checkbox, and leaving the field
 *     blank WITHOUT ticking it is an error naming the field. Those are two
 *     different answers and we will not guess which one was meant;
 *   * free space has a "Not sure" checkbox, and blank means blank. It renders
 *     as "Space not stated" everywhere, never as 0 cf;
 *   * the truck description is stored as words. A size in feet is NEVER
 *     converted into cubic feet, and the helper text says so where the driver
 *     is typing it;
 *   * "Available" has no default. Not today, not now, nothing preselected --
 *     because a departure this board invented is the one lie that costs a
 *     dispatcher a wasted phone call;
 *   * and a departure that has ALREADY HAPPENED is refused outright, in the
 *     server's own words. A truck advertising last Tuesday is worse than no
 *     truck at all: it costs a dispatcher the one call they were going to make.
 *
 * Every one of those rules is enforced again in `insertWebTruck`; this is the
 * half that explains them.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/basePath";
import { TRUCK_CORRIDOR_OPTIONS, DEFAULT_TRUCK_CORRIDOR_MILES } from "@/lib/loads/constants";
import { TAG_LABELS } from "@/lib/loads/present";
import {
  DEPARTURE_ALREADY_PASSED,
  departureHasPassed,
  SPACE_NOT_STATED,
} from "@/lib/loads/truckPresent";
import { emptyMatchCopy } from "@/lib/match/reasons";
import type { MatchPreview } from "@/lib/match/types";
import { LocationInput, type ResolvedPlace } from "./LocationInput";

export interface PostTruckFormProps {
  user: { name: string; phone: string | null; isDemo: boolean };
}

type PickedPlace = ResolvedPlace & {
  state?: string | null;
  city?: string | null;
  zip?: string | null;
};

/** No default. The fifth state -- "nothing chosen yet" -- is the empty string. */
type AvailMode = "" | "now" | "from" | "between" | "unknown";

/**
 * The job tags a truck can meaningfully answer for.
 *
 * A subset of the twenty-tag vocabulary, and the line under the control says
 * what the subset means: these are the only things the matcher can compare, and
 * a job that never stated a requirement is still shown to this truck. The tags
 * left out are the ones that describe the JOB's logistics rather than the
 * truck's capability ("urgent", "cod", "partial", "full", "elevator",
 * "ground_floor") -- a driver ticking "urgent" would be claiming something
 * about somebody else's freight.
 */
const MATCHABLE_TAGS = [
  "piano",
  "hot_tub",
  "safe",
  "pool_table",
  "motorcycle",
  "treadmill",
  "bulky",
  "fragile",
  "stairs",
  "no_elevator",
  "long_carry",
  "shuttle",
  "packing",
  "storage",
];

export function PostTruckForm({ user }: PostTruckFormProps) {
  const [origin, setOrigin] = useState("");
  const [originPick, setOriginPick] = useState<PickedPlace | null>(null);

  const [dest, setDest] = useState("");
  const [destPick, setDestPick] = useState<PickedPlace | null>(null);
  const [destUndecided, setDestUndecided] = useState(false);

  const [freeCf, setFreeCf] = useState("");
  const [freeUnknown, setFreeUnknown] = useState(false);
  const [truckCf, setTruckCf] = useState("");
  const [truckText, setTruckText] = useState("");

  const [availMode, setAvailMode] = useState<AvailMode>("");
  const [availFrom, setAvailFrom] = useState("");
  const [availTo, setAvailTo] = useState("");

  const [corridorMiles, setCorridorMiles] = useState(String(DEFAULT_TRUCK_CORRIDOR_MILES));

  const [equipment, setEquipment] = useState<string[]>([]);
  const [cannot, setCannot] = useState<string[]>([]);
  const [equipmentNotes, setEquipmentNotes] = useState("");

  const [hasDotMc, setHasDotMc] = useState(false);
  const [hasHhg, setHasHhg] = useState(false);
  const [hasCoi, setHasCoi] = useState(false);

  const [requirements, setRequirements] = useState("");
  const [notes, setNotes] = useState("");
  const [contactName, setContactName] = useState(user.name);
  const [contactPhone, setContactPhone] = useState(user.phone ?? "");

  const [busy, setBusy] = useState(false);
  const [posted, setPosted] = useState<number | null>(null);
  const [fieldError, setFieldError] = useState<{ field: string; message: string } | null>(null);

  /**
   * The live preview: how many jobs on the board today this leg would fit.
   *
   * A COUNT, and the same refusal histogram the panels print -- never a list.
   * A driver who has not posted yet has no listing for anybody to have
   * answered, and showing them job rows here would make the posting form a
   * second board with no contact gate in front of it. The number is the honest
   * part: "4 fit this" is a reason to finish the form, and a list is a reason
   * not to.
   *
   * Null until there is an origin COORDINATE. A typed place with no suggestion
   * picked has no lat/lng, and guessing one would make the count a fiction
   * about a place the driver did not choose.
   */
  const [preview, setPreview] = useState<MatchPreview | null>(null);
  const [previewState, setPreviewState] = useState<"idle" | "loading" | "ready" | "error">("idle");

  const errorFor = (field: string) =>
    fieldError?.field === field ? (
      <p className="mt-[2px] text-(length:--fs-sm)" style={{ color: "var(--danger)" }}>
        {fieldError.message}
      </p>
    ) : null;

  /** A tag ticked in one column is untickd in the other: the server refuses both. */
  const toggle = (
    tag: string,
    on: string[],
    setOn: (v: string[]) => void,
    off: string[],
    setOff: (v: string[]) => void,
  ) => {
    if (on.includes(tag)) {
      setOn(on.filter((t) => t !== tag));
      return;
    }
    setOn([...on, tag]);
    if (off.includes(tag)) setOff(off.filter((t) => t !== tag));
  };

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFieldError(null);
    setPosted(null);

    if (!dest.trim() && !destUndecided) {
      setFieldError({
        field: "dest",
        message: 'Give a destination, or tick "Not decided yet" — we will not guess which you meant.',
      });
      return;
    }
    if (!availMode) {
      setFieldError({
        field: "availMode",
        message: "Say when the truck is empty. There is no default — a date we invented is worse than none.",
      });
      return;
    }
    if (!contactPhone.trim()) {
      setFieldError({
        field: "contactPhone",
        message: "A truck without a phone number cannot be contacted from the board.",
      });
      return;
    }

    // The dates as the body will carry them: a "from" date left behind in the
    // box after the driver switched back to "Now" is not part of this post, and
    // must not be part of what is checked either.
    const postedFrom = availMode === "from" || availMode === "between" ? availFrom : "";
    const postedTo = availMode === "between" ? availTo : "";

    // A departure that has already happened. `insertWebTruck` refuses this and
    // the refusal is the one that counts -- this is here so the driver reads it
    // under the date they typed rather than after a round trip, and it is the
    // SAME string and the SAME predicate, imported, so the form cannot start
    // disagreeing with the server about what "past" means.
    if (departureHasPassed({ availFrom: postedFrom || null, availTo: postedTo || null })) {
      setFieldError({
        field: postedTo ? "availTo" : "availFrom",
        message: DEPARTURE_ALREADY_PASSED,
      });
      return;
    }

    setBusy(true);
    try {
      const body = {
        origin,
        originLat: originPick?.lat != null ? String(originPick.lat) : "",
        originLng: originPick?.lng != null ? String(originPick.lng) : "",
        originState: originPick?.state ?? "",
        originZip: originPick?.zip ?? "",
        originPrecision: originPick?.precision ?? "",

        dest: destUndecided ? "" : dest,
        destLat: !destUndecided && destPick?.lat != null ? String(destPick.lat) : "",
        destLng: !destUndecided && destPick?.lng != null ? String(destPick.lng) : "",
        destState: destUndecided ? "" : (destPick?.state ?? ""),
        destZip: destUndecided ? "" : (destPick?.zip ?? ""),
        destPrecision: destUndecided ? "" : (destPick?.precision ?? ""),
        destUndecided: destUndecided ? "on" : "",

        // "Not sure" wins over anything left in the box: the checkbox is the
        // driver's most recent statement, and posting a stale number they had
        // already decided not to claim is the failure this form exists to avoid.
        freeCf: freeUnknown ? "" : freeCf,
        truckCf: freeUnknown ? "" : truckCf,
        truckText,

        availMode,
        availFrom: postedFrom,
        availTo: postedTo,

        corridorMiles,

        equipment: equipment.join(","),
        cannot: cannot.join(","),
        equipmentNotes,

        hasDotMc: hasDotMc ? "on" : "",
        hasHhgAuthority: hasHhg ? "on" : "",
        hasCoi: hasCoi ? "on" : "",

        requirements,
        notes,
        contactName,
        contactPhone,
      };

      const res = await fetch(api("/api/trucks"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => null)) as { id?: number; error?: string } | null;

      if (!res.ok || json?.id == null) {
        const raw = json?.error ?? "Could not post the truck";
        const [field, ...rest] = raw.split(":");
        setFieldError(
          rest.length
            ? { field: field.trim(), message: rest.join(":").trim() }
            : { field: "", message: raw },
        );
        return;
      }

      setPosted(json.id);
      // A driver posting a second empty leg is posting a DIFFERENT lane, so
      // unlike the job form nothing about the route is kept: the origin and the
      // destination clear with everything else. What stays is who they are.
      setOrigin("");
      setOriginPick(null);
      setDest("");
      setDestPick(null);
      setDestUndecided(false);
      setFreeCf("");
      setFreeUnknown(false);
      setTruckCf("");
      setAvailMode("");
      setAvailFrom("");
      setAvailTo("");
      setNotes("");
    } finally {
      setBusy(false);
    }
  }

  const swing = Number(corridorMiles) || DEFAULT_TRUCK_CORRIDOR_MILES;

  const originLat = originPick?.lat ?? null;
  const originLng = originPick?.lng ?? null;
  const previewDestLat = destUndecided ? null : (destPick?.lat ?? null);
  const previewDestLng = destUndecided ? null : (destPick?.lng ?? null);
  const previewFreeCf = freeUnknown ? "" : freeCf;

  // Debounced, because the corridor select and the free-space box both change
  // the answer and a request per keystroke would spend the 20/min bucket in
  // seconds. Aborted on every change, so a slow early answer can never land on
  // top of a fast later one.
  useEffect(() => {
    if (originLat == null || originLng == null) {
      setPreview(null);
      setPreviewState("idle");
      return;
    }
    const controller = new AbortController();
    setPreviewState("loading");
    const timer = setTimeout(() => {
      fetch(api("/api/trucks/preview-matches"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          originLat,
          originLng,
          destLat: previewDestLat,
          destLng: previewDestLng,
          corridorMiles,
          freeCf: previewFreeCf,
          availMode,
          availFrom,
          availTo,
        }),
      })
        .then((r) => (r.ok ? (r.json() as Promise<MatchPreview>) : Promise.reject(r.status)))
        .then((d) => {
          setPreview(d);
          setPreviewState("ready");
        })
        .catch((e: unknown) => {
          if (e instanceof DOMException && e.name === "AbortError") return;
          setPreviewState("error");
        });
    }, 400);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [
    originLat,
    originLng,
    previewDestLat,
    previewDestLng,
    corridorMiles,
    previewFreeCf,
    availMode,
    availFrom,
    availTo,
  ]);

  return (
    <div className="mx-auto max-w-[720px] p-[var(--sp-5)]">
      <h1 className="big text-(length:--fs-xl)">Post available truck space</h1>
      <p className="mt-[var(--sp-1)] text-(length:--fs-base)" style={{ color: "var(--muted)" }}>
        Driving a leg empty? Say where you will be free and where you are headed. Dispatchers on this
        board see it, and anything you do not know stays blank — we never fill it in for you.
      </p>

      {user.isDemo && (
        <p
          className="mt-[var(--sp-3)] rounded-[var(--radius-sm)] px-[var(--sp-3)] py-[var(--sp-2)] text-(length:--fs-base)"
          style={{ background: "var(--warn-soft)", color: "var(--warn)" }}
        >
          You are signed in to the demo. The whole flow works — post it, open it, edit the date — but
          a demo truck is visible to this account only. Nobody browsing the board will see it.
        </p>
      )}

      <form onSubmit={submit} className="card mt-[var(--sp-4)] flex flex-col gap-[var(--sp-4)] p-[var(--sp-5)]">
        <Field label="Where you'll be empty" required htmlFor="origin">
          <LocationInput
            value={origin}
            onChange={(text) => {
              setOrigin(text);
              setOriginPick(null);
            }}
            onPick={(place) => {
              setOriginPick(place as PickedPlace);
              setOrigin(place.label);
            }}
            placeholder="Newark, NJ 07102"
            ariaLabel="Where the truck will be empty"
          />
          {originPick?.state && (
            <p className="mt-[2px] text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
              {originPick.state}
              {originPick.zip ? ` · ${originPick.zip}` : ""} recorded from the suggestion
            </p>
          )}
          {errorFor("origin")}
        </Field>

        <Field label="Where you're headed" htmlFor="dest">
          <LocationInput
            value={dest}
            onChange={(text) => {
              setDest(text);
              setDestPick(null);
              if (text.trim()) setDestUndecided(false);
            }}
            onPick={(place) => {
              setDestPick(place as PickedPlace);
              setDest(place.label);
              setDestUndecided(false);
            }}
            placeholder="Miami, FL 33101"
            ariaLabel="Where the truck is headed"
          />
          <label className="check-row mt-[var(--sp-2)]">
            <input
              type="checkbox"
              checked={destUndecided}
              onChange={(e) => {
                setDestUndecided(e.target.checked);
                if (e.target.checked) {
                  setDest("");
                  setDestPick(null);
                }
              }}
            />
            Not decided yet
          </label>
          {destUndecided && (
            <p className="mt-[2px] text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
              Your truck will be shown at its current location only, and matches won&apos;t claim a
              direction.
            </p>
          )}
          {errorFor("dest")}
        </Field>

        <Field label="Free space (cf)" htmlFor="freeCf">
          <div className="flex flex-wrap items-center gap-[var(--sp-3)]">
            <input
              id="freeCf"
              className="field nums"
              style={{ width: "auto" }}
              type="number"
              min={10}
              max={20000}
              step="any"
              placeholder="700"
              disabled={freeUnknown}
              value={freeCf}
              onChange={(e) => setFreeCf(e.target.value)}
            />
            <label className="check-row">
              <input
                type="checkbox"
                checked={freeUnknown}
                onChange={(e) => {
                  setFreeUnknown(e.target.checked);
                  if (e.target.checked) {
                    setFreeCf("");
                    setTruckCf("");
                  }
                }}
              />
              Not sure
            </label>
          </div>
          <p className="mt-[2px] text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
            How much of the truck is empty — not how big the truck is.
            {freeUnknown && ` Your listing will read “${SPACE_NOT_STATED}”, never 0 cf.`}
          </p>
          {errorFor("freeCf")}
        </Field>

        {/* Only once there is a free figure to compare it against: on its own,
            "truck size" is the number people confuse with free space, and asking
            for it first is how a 1,600 cf truck gets posted as 1,600 cf free. */}
        {!freeUnknown && freeCf.trim() !== "" && (
          <Field label="Truck size (cf)" htmlFor="truckCf">
            <div className="flex flex-wrap items-center gap-[var(--sp-3)]">
              <input
                id="truckCf"
                className="field nums"
                style={{ width: "auto" }}
                type="number"
                min={10}
                max={20000}
                step="any"
                placeholder="1600"
                value={truckCf}
                onChange={(e) => setTruckCf(e.target.value)}
              />
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={truckCf.trim() !== "" && truckCf === freeCf}
                  onChange={(e) => {
                    if (e.target.checked && truckCf.trim() !== "") setFreeCf(truckCf);
                  }}
                />
                Running empty — all of it is free
              </label>
            </div>
            {errorFor("truckCf")}
          </Field>
        )}

        <Field label="Truck / equipment" htmlFor="truckText">
          <input
            id="truckText"
            className="field"
            placeholder="26 ft box truck, lift gate"
            value={truckText}
            onChange={(e) => setTruckText(e.target.value)}
          />
          <p className="mt-[2px] text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
            Written exactly as you type it. We never convert a truck size into cubic feet.
          </p>
          {errorFor("truckText")}
        </Field>

        <Field label="Available">
          <div className="flex flex-col gap-[var(--sp-1)]">
            {(
              [
                ["now", "Now"],
                ["from", "From a date"],
                ["between", "Between two dates"],
                ["unknown", "Not decided"],
              ] as Array<[AvailMode, string]>
            ).map(([mode, text]) => (
              <label key={mode} className="check-row flex-wrap">
                <input
                  type="radio"
                  name="availMode"
                  checked={availMode === mode}
                  onChange={() => setAvailMode(mode)}
                />
                {text}
                {mode === "from" && availMode === "from" && (
                  <input
                    className="field"
                    style={{ width: "auto" }}
                    type="date"
                    aria-label="Empty from"
                    value={availFrom}
                    onChange={(e) => setAvailFrom(e.target.value)}
                  />
                )}
                {mode === "between" && availMode === "between" && (
                  <>
                    <input
                      className="field"
                      style={{ width: "auto" }}
                      type="date"
                      aria-label="Empty from"
                      value={availFrom}
                      onChange={(e) => setAvailFrom(e.target.value)}
                    />
                    <span style={{ color: "var(--muted)" }}>to</span>
                    <input
                      className="field"
                      style={{ width: "auto" }}
                      type="date"
                      aria-label="Empty until"
                      value={availTo}
                      onChange={(e) => setAvailTo(e.target.value)}
                    />
                  </>
                )}
              </label>
            ))}
          </div>
          {availMode === "unknown" && (
            <p className="mt-[2px] text-(length:--fs-sm)" style={{ color: "var(--approx)" }}>
              Your listing will read “Departure not stated”, and no match on it can be better than
              Possible.
            </p>
          )}
          {errorFor("availMode")}
          {errorFor("availFrom")}
          {errorFor("availTo")}
        </Field>

        <Field label="How far off your route will you go?" required htmlFor="corridorMiles">
          <select
            id="corridorMiles"
            className="field"
            style={{ width: "auto" }}
            value={corridorMiles}
            onChange={(e) => setCorridorMiles(e.target.value)}
          >
            {TRUCK_CORRIDOR_OPTIONS.map((m) => (
              <option key={m} value={m}>
                {m} miles
              </option>
            ))}
          </select>
          <p className="mt-[2px] text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
            We&apos;ll show you jobs whose pickup is within {swing} miles of your line.
          </p>
          {errorFor("corridorMiles")}
          <PreviewLine state={previewState} preview={preview} freeCf={previewFreeCf} radius={previewDestLat == null} />
        </Field>

        <Field label="What you can handle">
          <TagColumn
            tags={MATCHABLE_TAGS}
            selected={equipment}
            onToggle={(t) => toggle(t, equipment, setEquipment, cannot, setCannot)}
          />
          {errorFor("equipment")}
        </Field>

        <Field label="What you can't take">
          <TagColumn
            tags={MATCHABLE_TAGS}
            selected={cannot}
            onToggle={(t) => toggle(t, cannot, setCannot, equipment, setEquipment)}
            tone="danger"
          />
          <p className="mt-[var(--sp-1)] text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
            These are the only things we can match on. A job that doesn&apos;t state a requirement
            will still be shown to you.
          </p>
          {errorFor("cannot")}
        </Field>

        <Field label="Equipment notes" htmlFor="equipmentNotes">
          <input
            id="equipmentNotes"
            className="field"
            placeholder="Lift gate, four straps, no ramp"
            maxLength={500}
            value={equipmentNotes}
            onChange={(e) => setEquipmentNotes(e.target.value)}
          />
          {errorFor("equipmentNotes")}
        </Field>

        <Field label="Self-reported — we do not verify any of this">
          <div className="flex flex-col gap-[var(--sp-1)]">
            <label className="check-row">
              <input type="checkbox" checked={hasDotMc} onChange={(e) => setHasDotMc(e.target.checked)} />
              DOT &amp; MC numbers
            </label>
            <label className="check-row">
              <input type="checkbox" checked={hasHhg} onChange={(e) => setHasHhg(e.target.checked)} />
              HHG authority
            </label>
            <label className="check-row">
              <input type="checkbox" checked={hasCoi} onChange={(e) => setHasCoi(e.target.checked)} />
              COI available
            </label>
          </div>
          <p className="mt-[var(--sp-1)] text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
            Shown on your listing as your own claim, and never used to rank or filter you.
          </p>
        </Field>

        <Field label="Requirements" htmlFor="requirements">
          <textarea
            id="requirements"
            className="field"
            rows={2}
            maxLength={500}
            placeholder="Cash on delivery, no brokers"
            value={requirements}
            onChange={(e) => setRequirements(e.target.value)}
          />
          {errorFor("requirements")}
        </Field>

        <div className="grid gap-[var(--sp-3)] md:grid-cols-2">
          <Field label="Contact name" htmlFor="contactName">
            <input
              id="contactName"
              className="field"
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
            />
            {errorFor("contactName")}
          </Field>
          <Field label="Contact phone" required htmlFor="contactPhone">
            <input
              id="contactPhone"
              className="field"
              placeholder="(201) 555-0199"
              value={contactPhone}
              onChange={(e) => setContactPhone(e.target.value)}
            />
            <p className="mt-[2px] text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
              Dispatchers reach you through the Show contact button; without a number the truck
              cannot be contacted.
            </p>
            {errorFor("contactPhone")}
          </Field>
        </div>

        <Field label="Notes" htmlFor="notes">
          <textarea
            id="notes"
            className="field"
            rows={3}
            maxLength={500}
            placeholder="Anything a dispatcher should know before they call."
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
          {errorFor("notes")}
        </Field>

        {fieldError && !fieldError.field && (
          <p
            className="rounded-[var(--radius-sm)] px-[var(--sp-3)] py-[var(--sp-2)] text-(length:--fs-base)"
            style={{ background: "var(--danger-soft)", color: "var(--danger)" }}
          >
            {fieldError.message}
          </p>
        )}

        {posted != null && (
          <p
            className="rounded-[var(--radius-sm)] px-[var(--sp-3)] py-[var(--sp-2)] text-(length:--fs-base)"
            style={{ background: "var(--ok-soft)", color: "var(--ok)" }}
          >
            {user.isDemo
              ? `Truck #${posted} is posted, and visible to this demo account only. `
              : `Truck #${posted} is live on the board. `}
            <Link href={`/trucks/${posted}`} className="underline">
              See it →
            </Link>
          </p>
        )}

        <button className="btn btn-primary self-start" disabled={busy}>
          {busy ? "Posting…" : "Post truck space"}
        </button>

        {/* Said once, at the bottom, where a driver is deciding whether to
            commit: the departure is the field that goes stale, and it is the one
            they can come back and change. */}
        <p className="text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
          A truck stays on the board until the day after it leaves, or 48 hours if you did not give a
          date. You can edit the dates and the space afterwards — going somewhere else is a second
          truck, not an edit to this one.
        </p>
      </form>
    </div>
  );
}

/**
 * "4 jobs on the board fit this right now" — or, when nothing does, why not.
 *
 * The zero case is the one that earns this control its place. A driver who
 * fills in a leg and is told nothing at all fits will assume the board is
 * empty; told "18 were going the wrong way · 6 weren't near your route", they
 * know the board is full of jobs and this particular leg is the mismatch —
 * which is a reason to widen the corridor rather than a reason to close the tab.
 *
 * It is a COUNT and never a list: see the note on `preview` above.
 */
function PreviewLine({
  state,
  preview,
  freeCf,
  radius,
}: {
  state: "idle" | "loading" | "ready" | "error";
  preview: MatchPreview | null;
  freeCf: string;
  radius: boolean;
}) {
  if (state === "idle") return null;
  if (state === "loading") {
    return (
      <p className="mt-[var(--sp-1)] text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
        Checking the board…
      </p>
    );
  }
  // A failure must never read as an answer: "0 jobs fit" and "we could not ask"
  // are different sentences and only one of them is about the driver's leg.
  if (state === "error" || !preview) {
    return (
      <p className="mt-[var(--sp-1)] text-(length:--fs-sm)" style={{ color: "var(--warn)" }}>
        Couldn&apos;t check the board just now. It changes nothing about your post.
      </p>
    );
  }

  if (preview.total === 0) {
    const cf = Number(freeCf);
    const copy = emptyMatchCopy(preview, "truck", {
      freeCf: Number.isFinite(cf) && cf > 0 ? cf : null,
      radius,
    });
    return (
      <div className="mt-[var(--sp-2)] rounded-[var(--radius-sm)] px-[var(--sp-3)] py-[var(--sp-2)]" style={{ background: "var(--surface-2)" }} data-match-preview>
        <p className="text-(length:--fs-base)">{copy.headline}</p>
        {copy.clauses.length > 0 && (
          <p className="mt-[2px] text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
            {copy.clauses.join(" · ")}. Post it anyway — the board turns over daily.
          </p>
        )}
        {copy.clauses.length === 0 && copy.ask && (
          <p className="mt-[2px] text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
            {copy.ask}
          </p>
        )}
      </div>
    );
  }

  const parts = [
    preview.strong > 0 ? `${preview.strong} worth a call` : null,
    preview.possible > 0 ? `${preview.possible} worth a look` : null,
  ].filter(Boolean);

  return (
    <div className="mt-[var(--sp-2)] rounded-[var(--radius-sm)] px-[var(--sp-3)] py-[var(--sp-2)]" style={{ background: "var(--accent-soft)" }} data-match-preview>
      <p className="text-(length:--fs-base)" style={{ color: "var(--accent-deep)" }}>
        {preview.total} {preview.total === 1 ? "job" : "jobs"} on the board fit this
        {parts.length ? ` — ${parts.join(", ")}` : ""}.
      </p>
      <p className="mt-[2px] text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
        That is the board as it stands today, not a promise. You will see the list once you post.
      </p>
    </div>
  );
}

function TagColumn({
  tags,
  selected,
  onToggle,
  tone = "accent",
}: {
  tags: string[];
  selected: string[];
  onToggle: (tag: string) => void;
  tone?: "accent" | "danger";
}) {
  return (
    <div className="flex flex-wrap gap-[var(--sp-1)]">
      {tags.map((tag) => {
        const on = selected.includes(tag);
        return (
          <button
            key={tag}
            type="button"
            className="chip chip-button"
            aria-pressed={on}
            onClick={() => onToggle(tag)}
            style={{
              background: on
                ? tone === "danger"
                  ? "var(--danger-soft)"
                  : "var(--accent-soft)"
                : "var(--surface-2)",
              color: on ? (tone === "danger" ? "var(--danger)" : "var(--accent)") : "var(--text-2)",
            }}
          >
            {TAG_LABELS[tag]?.label ?? tag}
          </button>
        );
      })}
    </div>
  );
}

function Field({
  label,
  required,
  htmlFor,
  children,
}: {
  label: string;
  required?: boolean;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="label" htmlFor={htmlFor}>
        {label}
        {required && <span style={{ color: "var(--danger)" }}> *</span>}
      </label>
      {children}
    </div>
  );
}
