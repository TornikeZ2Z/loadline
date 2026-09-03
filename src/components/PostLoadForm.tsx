"use client";

import { useState } from "react";

/**
 * Direct load entry for brokers who would rather type than post in a group.
 * Locations go through the same geocoder as WhatsApp traffic, so a typed
 * "philly" lands in the same place an extracted one does.
 */
export function PostLoadForm() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setResult(null);

    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    const res = await fetch("/api/loads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    });
    const json = (await res.json()) as { id?: number; error?: string };

    setBusy(false);
    if (res.ok) {
      setResult({ ok: true, message: `Load #${json.id} is live on the board.` });
      form.reset();
    } else {
      setResult({ ok: false, message: json.error ?? "Could not post the load" });
    }
  }

  return (
    <div className="mx-auto max-w-[720px] p-5">
      <h1 className="text-[19px] font-bold tracking-tight">Post a load</h1>
      <p className="mt-1 text-[13px] text-muted">
        Goes straight onto the board with full confidence — no extraction step, because you are
        giving us the structured version already.
      </p>

      <form onSubmit={submit} className="card mt-4 space-y-4 p-5">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Pickup location" required>
            <input name="pickup" className="field" required placeholder="Newark, NJ 07102" />
          </Field>
          <Field label="Delivery location" required>
            <input name="delivery" className="field" required placeholder="Miami, FL" />
          </Field>
          <Field label="Pickup date">
            <input name="pickupDate" type="date" className="field" />
          </Field>
          <Field label="Delivery date">
            <input name="deliveryDate" type="date" className="field" />
          </Field>
          <Field label="Equipment">
            <select name="loadType" className="field" defaultValue="">
              <option value="">Not specified</option>
              {["dry van", "reefer", "flatbed", "step deck", "box truck", "sprinter", "hotshot", "power only", "container"].map(
                (t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ),
              )}
            </select>
          </Field>
          <Field label="Rate (USD)">
            <input name="rateUsd" type="number" min="0" step="50" className="field" placeholder="3200" />
          </Field>
          <Field label="Weight (lbs)">
            <input name="weightLbs" type="number" min="0" className="field" placeholder="44000" />
          </Field>
          <Field label="Pallets">
            <input name="pallets" type="number" min="0" className="field" placeholder="18" />
          </Field>
          <Field label="Contact name">
            <input name="contactName" className="field" placeholder="Defaults to your name" />
          </Field>
          <Field label="Contact phone">
            <input name="contactPhone" className="field" placeholder="(973) 555-1234" />
          </Field>
        </div>

        <Field label="Notes">
          <textarea
            name="notes"
            className="field"
            rows={3}
            placeholder="Liftgate required, dock hours 7am-3pm, appointment needed…"
          />
        </Field>

        {result && (
          <p
            className="rounded-md px-3 py-2 text-[13px]"
            style={
              result.ok
                ? { background: "var(--ok-soft)", color: "var(--ok)" }
                : { background: "var(--danger-soft)", color: "var(--danger)" }
            }
          >
            {result.message}
          </p>
        )}

        <button className="btn btn-primary" disabled={busy}>
          {busy ? "Posting…" : "Post load"}
        </button>
      </form>
    </div>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="label">
        {label}
        {required && <span style={{ color: "var(--danger)" }}> *</span>}
      </label>
      {children}
    </div>
  );
}
