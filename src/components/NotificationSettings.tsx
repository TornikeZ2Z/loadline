"use client";

/**
 * Two controls, and only one of them does anything.
 *
 * THE E-MAIL CONTROL IS RENDERED, DISABLED, AND SAYS WHY. That is the decision
 * worth defending. Leaving it out would make the product look as though nobody
 * had thought about mail; rendering it live would be a promise there is no SES,
 * no verified domain and no bounce handling behind. Disabled and labelled is the
 * only honest third state, and it is the register wave 2 used for the report
 * queue's "Nothing replies to you automatically."
 *
 * `emailAvailable` comes from the server, computed from the CHANNELS map rather
 * than from a flag, so the day `sendViaSes` lands this control turns itself on.
 *
 * SPEC 12.3, 12.4.
 */

import { useState } from "react";
import { EMAIL_UNAVAILABLE, EMAIL_UNAVAILABLE_WHY } from "@/lib/notify/copy";
import type { NotifyPrefs } from "@/lib/notify/types";

export function NotificationSettings({ initial }: { initial: NotifyPrefs }) {
  const [prefs, setPrefs] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const setInApp = async (inapp: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    const before = prefs;
    setPrefs((p) => ({ ...p, inapp }));
    try {
      const res = await fetch("/api/notification-prefs", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ inapp }),
      });
      const body = (await res.json().catch(() => null)) as (NotifyPrefs & { error?: string }) | null;
      if (!res.ok || !body || typeof body.inapp !== "boolean") {
        setPrefs(before);
        setError(body?.error ?? `Could not save (HTTP ${res.status})`);
        return;
      }
      setPrefs(body);
      setSaved(true);
    } catch {
      setPrefs(before);
      setError("Could not reach the server. Nothing was changed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-[var(--sp-3)]">
      <Row
        title="In the app"
        body="A bell in the header and a list at /notifications, when a load matches one of your trucks or a truck could take one of your jobs. At most one alert per listing every twelve hours, always as a digest."
        control={
          <label className="flex cursor-pointer items-center gap-[var(--sp-2)]">
            <input
              type="checkbox"
              checked={prefs.inapp}
              disabled={busy}
              onChange={(e) => setInApp(e.target.checked)}
              aria-label="In-app notifications"
            />
            <span className="text-(length:--fs-base) font-semibold">
              {prefs.inapp ? "On" : "Off"}
            </span>
          </label>
        }
      />

      <Row
        title="By e-mail"
        disabled={!prefs.emailAvailable}
        body={EMAIL_UNAVAILABLE_WHY}
        control={
          <label className="flex items-center gap-[var(--sp-2)]" style={{ cursor: "not-allowed" }}>
            <input
              type="checkbox"
              checked={false}
              disabled={!prefs.emailAvailable}
              readOnly
              aria-label={EMAIL_UNAVAILABLE}
            />
            <span className="text-(length:--fs-base) font-semibold" style={{ color: "var(--muted)" }}>
              {prefs.emailAvailable ? "Off" : "Unavailable"}
            </span>
          </label>
        }
        note={EMAIL_UNAVAILABLE}
      />

      <p className="text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
        {error ? (
          <span style={{ color: "var(--danger)" }}>{error}</span>
        ) : saved ? (
          "Saved."
        ) : (
          "Changes save as you make them."
        )}
      </p>
    </div>
  );
}

function Row({
  title,
  body,
  control,
  note,
  disabled = false,
}: {
  title: string;
  body: string;
  control: React.ReactNode;
  note?: string;
  disabled?: boolean;
}) {
  return (
    <div
      className="card flex flex-wrap items-start justify-between gap-[var(--sp-3)] p-[var(--sp-4)]"
      style={disabled ? { background: "var(--surface-2)" } : undefined}
    >
      <div className="min-w-0 max-w-[46ch]">
        <div className="flex items-center gap-[var(--sp-2)]">
          <span className="big text-(length:--fs-lg)">{title}</span>
          {note ? (
            // Not a Chip: this is a sentence, and shrinking it into a pill would
            // make the one honest thing on the row the easiest thing to miss.
            <span className="text-(length:--fs-sm) font-semibold" style={{ color: "var(--warn)" }}>
              {note}
            </span>
          ) : null}
        </div>
        <p className="mt-[var(--sp-1)] text-(length:--fs-base) leading-relaxed" style={{ color: "var(--muted)" }}>
          {body}
        </p>
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}
