"use client";

/**
 * The form behind /admin/settings.
 *
 * It edits five strings, so it is deliberately five inputs and one button --
 * no tabs, no autosave, no optimistic update. Autosave on a field that ends up
 * inside a limitation-of-liability clause is the wrong affordance: the operator
 * should be able to type, look at what they typed, and then decide.
 *
 * PREVIEWS, NOT PROMISES. Under each input is the sentence that value lands in
 * on the public page, drawn with the CURRENT SAVED value and not with what is
 * in the box, so the page never claims a change has taken effect before it has.
 *
 * Field definitions arrive as a prop rather than by importing @/lib/settings:
 * that module reads the database and must not be pulled into a client bundle.
 * Its TYPES come across with `import type`, which is erased at compile time.
 */

import { useState } from "react";
import Link from "next/link";
import type { SettingKey, SiteSettingField, SiteSettings } from "@/lib/settings";

type Draft = Record<SettingKey, string>;

function draftFrom(settings: SiteSettings, fields: readonly SiteSettingField[]): Draft {
  const out = {} as Draft;
  for (const f of fields) out[f.key] = settings[f.key] ?? "";
  return out;
}

export function SettingsForm({
  fields,
  initial,
  canWrite,
}: {
  fields: readonly SiteSettingField[];
  initial: SiteSettings;
  /**
   * False for the demo admin, whose PUT the API refuses anyway. Disabling the
   * inputs here is not the security boundary -- `requireWriteRole` is -- it
   * just stops someone typing a company name for two minutes before finding
   * out.
   */
  canWrite: boolean;
}) {
  const [saved, setSaved] = useState<SiteSettings>(initial);
  const [draft, setDraft] = useState<Draft>(() => draftFrom(initial, fields));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const dirty = fields.some((f) => draft[f.key].trim() !== (saved[f.key] ?? ""));

  const set = (key: SettingKey, value: string) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setDone(false);
    setError(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      const res = await fetch("/api/admin/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values: draft }),
      });
      const body = (await res.json().catch(() => null)) as
        | { settings?: SiteSettings; error?: string }
        | null;
      if (!res.ok || !body?.settings) {
        setError(body?.error ?? `Could not save (HTTP ${res.status})`);
        return;
      }
      setSaved(body.settings);
      setDraft(draftFrom(body.settings, fields));
      setDone(true);
    } catch {
      setError("Could not reach the server. Nothing was saved.");
    } finally {
      setBusy(false);
    }
  };

  const unfilled = fields.filter((f) => !saved[f.key]);

  return (
    <form onSubmit={submit} className="flex flex-col gap-[var(--sp-5)]">
      {/* What is true right now, before anything is typed. The count is of
          SAVED values, so it does not move while the operator is typing. */}
      <div
        className="rounded-[var(--radius-md)] border p-[var(--sp-4)] text-(length:--fs-base) leading-relaxed"
        style={
          unfilled.length
            ? { background: "var(--warn-soft)", borderColor: "var(--warn-soft)", color: "var(--warn)" }
            : { background: "var(--surface-2)", borderColor: "var(--border)", color: "var(--text-2)" }
        }
      >
        {unfilled.length ? (
          <>
            <strong className="block">
              {unfilled.length} of {fields.length} still unfilled
            </strong>
            <div className="mt-[var(--sp-1)]">
              Public pages show the bracketed placeholder for{" "}
              {unfilled.map((f) => f.placeholder).join(", ")} — visibly unfinished, which is
              correct until somebody knows the answer. Nothing is guessed on your behalf.
            </div>
          </>
        ) : (
          <>
            <strong className="block" style={{ color: "var(--text)" }}>
              All five are filled in
            </strong>
            <div className="mt-[var(--sp-1)]">
              The legal pages still carry their &ldquo;not reviewed by a lawyer&rdquo; notices.
              Those come off when counsel has actually read the pages, not when this form is
              complete. Check <Link href="/terms" className="underline">Terms</Link>,{" "}
              <Link href="/privacy" className="underline">Privacy</Link>,{" "}
              <Link href="/cookies" className="underline">Cookies</Link> and{" "}
              <Link href="/contact" className="underline">Contact</Link> read correctly.
            </div>
          </>
        )}
      </div>

      {fields.map((field) => {
        const current = saved[field.key];
        return (
          <div key={field.key}>
            <label className="label" htmlFor={`setting-${field.key}`}>
              {field.label}
            </label>
            <input
              id={`setting-${field.key}`}
              className="field"
              type={field.kind === "date" ? "date" : field.kind === "email" ? "email" : "text"}
              maxLength={field.maxLength}
              value={draft[field.key]}
              disabled={!canWrite || busy}
              onChange={(e) => set(field.key, e.target.value)}
              /* The placeholder attribute is the SHAPE, never a value that
                 could be mistaken for a default: an input whose grey text
                 reads like a real company name is one Enter key away from
                 being published as one. */
              placeholder={field.kind === "date" ? "YYYY-MM-DD" : `e.g. ${field.example}`}
              aria-describedby={`hint-${field.key}`}
            />
            <div
              id={`hint-${field.key}`}
              className="mt-[var(--sp-1)] text-(length:--fs-sm) leading-relaxed"
              style={{ color: "var(--muted)" }}
            >
              {field.hint}
              <br />
              <span style={{ color: "var(--muted-2)" }}>Appears on {field.appearsOn}.</span>
              {" "}
              {current ? (
                <span style={{ color: "var(--ok)" }}>Saved.</span>
              ) : (
                <span style={{ color: "var(--warn)" }}>
                  Unset — pages show {field.placeholder}.
                </span>
              )}
            </div>
          </div>
        );
      })}

      {error && (
        <div
          role="alert"
          className="rounded-[var(--radius-md)] border p-[var(--sp-3)] text-(length:--fs-base)"
          style={{ background: "var(--warn-soft)", borderColor: "var(--warn-soft)", color: "var(--warn)" }}
        >
          {error} Nothing was changed.
        </div>
      )}

      <div className="flex flex-wrap items-center gap-[var(--sp-3)]">
        <button type="submit" className="btn btn-primary" disabled={!canWrite || busy || !dirty}>
          {busy ? "Saving…" : "Save"}
        </button>
        {done && !dirty && (
          <span className="text-(length:--fs-base)" style={{ color: "var(--ok)" }}>
            Saved. The public pages show this now.
          </span>
        )}
        {!canWrite && (
          <span className="text-(length:--fs-base)" style={{ color: "var(--muted)" }}>
            The demo can open this form but cannot change what the public pages say.
          </span>
        )}
      </div>
    </form>
  );
}
