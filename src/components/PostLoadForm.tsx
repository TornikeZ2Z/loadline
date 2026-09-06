"use client";

/**
 * Posting a job from the website.
 *
 * Shaped like a real WhatsApp post rather than like a database row: an origin,
 * a destination state with a ZIP or a city, cubic feet, a price per cf, and
 * whether it is ready. A poster usually enters several jobs out of the same
 * warehouse in one sitting, so after a successful post the origin, the contact
 * and the requirements stay and only the destination, size and price clear.
 *
 * The phone is required, and the form says why: a job with no number cannot
 * pass the contact gate, so it would sit on the board unreachable.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/basePath";
import { STATES } from "@/lib/geo/states";
import { TAG_LABELS } from "@/lib/loads/present";
import { LocationInput, type ResolvedPlace } from "./LocationInput";

export interface PostLoadFormProps {
  user: { name: string; phone: string | null };
}

/** The tags worth a checkbox; the rest of the vocabulary only ever arrives from a post. */
const POSTABLE_TAGS = ["bulky", "urgent", "hot_tub", "piano", "safe", "fragile", "partial"];

const REQUIREMENTS_KEY = "loadline.post.requirements.v1";

/**
 * B's `ResolvedPlace` gains `state`, `city` and `zip` in its own commit. Reading
 * them through this widened view means the form fills the hidden fields as soon
 * as that lands, without a type error before it does.
 */
type PickedPlace = ResolvedPlace & {
  state?: string | null;
  city?: string | null;
  zip?: string | null;
};

type PriceMode = "percf" | "flat" | "";

export function PostLoadForm({ user }: PostLoadFormProps) {
  const [pickup, setPickup] = useState("");
  const [picked, setPicked] = useState<PickedPlace | null>(null);

  const [deliveryState, setDeliveryState] = useState("");
  const [deliveryZip, setDeliveryZip] = useState("");
  const [deliveryCity, setDeliveryCity] = useState("");

  const [cubicFeet, setCubicFeet] = useState("");
  const [priceMode, setPriceMode] = useState<PriceMode>("percf");
  const [pricePerCf, setPricePerCf] = useState("");
  const [priceFlat, setPriceFlat] = useState("");

  const [readyNow, setReadyNow] = useState(true);
  const [readyDate, setReadyDate] = useState("");
  const [deliverBy, setDeliverBy] = useState("");

  const [tags, setTags] = useState<string[]>([]);
  const [requirements, setRequirements] = useState("");
  const [contactName, setContactName] = useState(user.name);
  const [contactPhone, setContactPhone] = useState(user.phone ?? "");
  const [notes, setNotes] = useState("");

  const [busy, setBusy] = useState(false);
  const [posted, setPosted] = useState<number | null>(null);
  const [fieldError, setFieldError] = useState<{ field: string; message: string } | null>(null);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(REQUIREMENTS_KEY);
      if (saved) setRequirements(saved);
    } catch {
      // Private mode: the field just starts empty.
    }
  }, []);

  const cf = Number(cubicFeet) || 0;
  const perCf = Number(pricePerCf) || 0;
  const preview =
    priceMode === "percf" && cf > 0 && perCf > 0
      ? `$${perCf.toFixed(2)}/cf × ${cf.toLocaleString()} cf ≈ $${Math.round(perCf * cf).toLocaleString()}`
      : priceMode === "flat" && cf > 0 && Number(priceFlat) > 0
        ? `$${Number(priceFlat).toLocaleString()} over ${cf.toLocaleString()} cf ≈ $${(
            Number(priceFlat) / cf
          ).toFixed(2)}/cf`
        : null;

  const errorFor = (field: string) =>
    fieldError?.field === field ? (
      <p className="mt-[2px] text-(length:--fs-sm)" style={{ color: "var(--danger)" }}>
        {fieldError.message}
      </p>
    ) : null;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFieldError(null);
    setPosted(null);

    if (!deliveryZip.trim() && !deliveryCity.trim()) {
      setFieldError({ field: "deliveryZip", message: "Give a ZIP or a city for the delivery." });
      return;
    }
    if (!contactPhone.trim()) {
      setFieldError({
        field: "contactPhone",
        message: "A job without a phone number cannot be contacted from the board.",
      });
      return;
    }

    setBusy(true);
    try {
      const body = {
        pickup,
        pickupLat: picked?.lat != null ? String(picked.lat) : "",
        pickupLng: picked?.lng != null ? String(picked.lng) : "",
        pickupState: picked?.state ?? "",
        pickupZip: picked?.zip ?? "",
        // How exact the picked place actually is. "Florida — anywhere in the
        // state" and "north jersey" come back as state/region rows with a
        // centroid, and dropping this made them look like a pinned city: a
        // solid arc from the middle of Florida, no "approximate" chip.
        pickupPrecision: picked?.precision ?? "",
        deliveryState,
        deliveryZip: deliveryZip.trim(),
        deliveryCity: deliveryCity.trim(),
        cubicFeet,
        priceMode,
        pricePerCf: priceMode === "percf" ? pricePerCf : "",
        priceFlat: priceMode === "flat" ? priceFlat : "",
        readyNow: readyNow ? "on" : "",
        readyDate: readyNow ? "" : readyDate,
        deliverBy,
        tags: tags.join(","),
        requirements,
        contactName,
        contactPhone,
        notes,
      };

      const res = await fetch(api("/api/loads"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => null)) as { id?: number; error?: string } | null;

      if (!res.ok || json?.id == null) {
        const raw = json?.error ?? "Could not post the job";
        const [field, ...rest] = raw.split(":");
        setFieldError(
          rest.length
            ? { field: field.trim(), message: rest.join(":").trim() }
            : { field: "", message: raw },
        );
        return;
      }

      try {
        window.localStorage.setItem(REQUIREMENTS_KEY, requirements);
      } catch {
        // ignore
      }

      setPosted(json.id);
      // Keep the origin, the contact and the requirements: the next job is
      // almost always out of the same warehouse.
      setDeliveryState("");
      setDeliveryZip("");
      setDeliveryCity("");
      setCubicFeet("");
      setPricePerCf("");
      setPriceFlat("");
      setNotes("");
      setTags([]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-[720px] p-[var(--sp-5)]">
      <h1 className="big text-(length:--fs-xl)">Post a job</h1>
      <p className="mt-[var(--sp-1)] text-(length:--fs-base)" style={{ color: "var(--muted)" }}>
        Same shape as a post in the group — origin, destination, cubic feet, price — but structured,
        so nothing has to be read out of it.
      </p>

      <form onSubmit={submit} className="card mt-[var(--sp-4)] flex flex-col gap-[var(--sp-4)] p-[var(--sp-5)]">
        <Field label="Pickup" required htmlFor="pickup">
          <LocationInput
            value={pickup}
            onChange={(text) => {
              setPickup(text);
              setPicked(null);
            }}
            onPick={(place) => {
              setPicked(place as PickedPlace);
              setPickup(place.label);
            }}
            placeholder="Kearny, NJ 07032"
            ariaLabel="Pickup location"
          />
          {picked?.state && (
            <p className="mt-[2px] text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
              {picked.state}
              {picked.zip ? ` · ${picked.zip}` : ""} recorded from the suggestion
            </p>
          )}
          {errorFor("pickup")}
        </Field>

        <div className="grid gap-[var(--sp-3)] md:grid-cols-2">
          <Field label="Delivery state" required htmlFor="deliveryState">
            <select
              id="deliveryState"
              className="field"
              required
              value={deliveryState}
              onChange={(e) => setDeliveryState(e.target.value)}
            >
              <option value="">Choose a state</option>
              {STATES.map((s) => (
                <option key={s.abbr} value={s.abbr}>
                  {s.abbr} — {s.name}
                </option>
              ))}
            </select>
            {errorFor("deliveryState")}
          </Field>

          <Field label="Delivery ZIP" htmlFor="deliveryZip">
            <input
              id="deliveryZip"
              className="field nums"
              inputMode="numeric"
              pattern="\d{5}"
              placeholder="33180"
              value={deliveryZip}
              onChange={(e) => setDeliveryZip(e.target.value)}
            />
            {errorFor("deliveryZip")}
          </Field>
        </div>

        <Field label="Delivery city" htmlFor="deliveryCity">
          <input
            id="deliveryCity"
            className="field"
            placeholder="or a city, if you don't have the ZIP"
            value={deliveryCity}
            onChange={(e) => setDeliveryCity(e.target.value)}
          />
          {errorFor("deliveryCity")}
        </Field>

        <Field label="Size" required htmlFor="cubicFeet">
          {/* step="any", not step={50}: real posts carry 1,056 and 950 cf, and a
              50-step constraint makes the browser reject them ("the two nearest
              valid values are 1,010 and 1,060") before the form is ever read. */}
          <input
            id="cubicFeet"
            className="field nums"
            type="number"
            min={10}
            step="any"
            required
            placeholder="350"
            value={cubicFeet}
            onChange={(e) => setCubicFeet(e.target.value)}
          />
          <p className="mt-[2px] text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
            Cubic feet as you would post it in the group.
          </p>
          {errorFor("cubicFeet")}
        </Field>

        <Field label="Price">
          <div className="flex flex-wrap gap-[var(--sp-1)]">
            {(
              [
                ["percf", "Per cf"],
                ["flat", "Flat"],
                ["", "No price"],
              ] as Array<[PriceMode, string]>
            ).map(([mode, text]) => (
              <button
                key={text}
                type="button"
                className="chip"
                aria-pressed={priceMode === mode}
                onClick={() => setPriceMode(mode)}
                style={{
                  height: 28,
                  cursor: "pointer",
                  background: priceMode === mode ? "var(--accent-soft)" : "var(--surface-2)",
                  color: priceMode === mode ? "var(--accent)" : "var(--text-2)",
                }}
              >
                {text}
              </button>
            ))}
          </div>

          {priceMode === "percf" && (
            <input
              className="field nums mt-[var(--sp-2)]"
              type="number"
              min={0}
              step="any"
              placeholder="3.50"
              aria-label="Price per cubic foot"
              value={pricePerCf}
              onChange={(e) => setPricePerCf(e.target.value)}
            />
          )}
          {priceMode === "flat" && (
            <input
              className="field nums mt-[var(--sp-2)]"
              type="number"
              min={0}
              step="any"
              placeholder="1500"
              aria-label="Flat price"
              value={priceFlat}
              onChange={(e) => setPriceFlat(e.target.value)}
            />
          )}
          {preview && (
            <p className="nums mt-[2px] text-(length:--fs-sm)" style={{ color: "var(--ok)" }}>
              {preview}
            </p>
          )}
          {errorFor("pricePerCf")}
          {errorFor("priceFlat")}
        </Field>

        <Field label="Ready">
          <label className="flex items-center gap-[var(--sp-2)]">
            <input type="radio" name="ready" checked={readyNow} onChange={() => setReadyNow(true)} />
            Ready now — already picked up / in the warehouse
          </label>
          <label className="mt-[var(--sp-1)] flex items-center gap-[var(--sp-2)]">
            <input type="radio" name="ready" checked={!readyNow} onChange={() => setReadyNow(false)} />
            Ready on
            <input
              className="field"
              style={{ width: "auto" }}
              type="date"
              aria-label="Ready date"
              disabled={readyNow}
              value={readyDate}
              onChange={(e) => {
                setReadyNow(false);
                setReadyDate(e.target.value);
              }}
            />
          </label>
          {errorFor("readyDate")}
        </Field>

        <Field label="Deliver by" htmlFor="deliverBy">
          <input
            id="deliverBy"
            className="field"
            style={{ width: "auto" }}
            type="date"
            value={deliverBy}
            onChange={(e) => setDeliverBy(e.target.value)}
          />
          {errorFor("deliverBy")}
        </Field>

        <Field label="Tags">
          <div className="flex flex-wrap gap-[var(--sp-1)]">
            {POSTABLE_TAGS.map((tag) => {
              const on = tags.includes(tag);
              return (
                <button
                  key={tag}
                  type="button"
                  className="chip"
                  aria-pressed={on}
                  onClick={() => setTags(on ? tags.filter((t) => t !== tag) : [...tags, tag])}
                  style={{
                    height: 26,
                    cursor: "pointer",
                    background: on ? "var(--accent-soft)" : "var(--surface-2)",
                    color: on ? "var(--accent)" : "var(--text-2)",
                  }}
                >
                  {TAG_LABELS[tag]?.label ?? tag}
                </button>
              );
            })}
          </div>
        </Field>

        <Field label="Requirements" htmlFor="requirements">
          <textarea
            id="requirements"
            className="field"
            rows={2}
            placeholder="Must have active DOT & MC"
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
              Drivers reach you through the Show contact button; without a number the job cannot be
              contacted.
            </p>
            {errorFor("contactPhone")}
          </Field>
        </div>

        <Field label="Notes" htmlFor="notes">
          <textarea
            id="notes"
            className="field"
            rows={3}
            placeholder="Anything a driver should know before they call."
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
            Job #{posted} is live on the board.{" "}
            <Link href={`/jobs/${posted}`} className="underline">
              See it →
            </Link>
          </p>
        )}

        <button className="btn btn-primary self-start" disabled={busy}>
          {busy ? "Posting…" : "Post job"}
        </button>
      </form>
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
