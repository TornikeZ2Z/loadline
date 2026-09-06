/**
 * The three primitives every board screen is built from: a chip, a status chip
 * and an empty state.
 *
 * Colour is applied only through the `.chip-*` classes in globals.css, never as
 * a literal in a component: the whole point of the token system is that a chip
 * cannot drift from the palette by accident. Nothing here knows about a job --
 * the words come from `@/lib/loads/present`.
 */

import type { LoadStatus } from "@/lib/loads/types";
import type { Tone } from "@/lib/loads/present";

/**
 * `delisted` is the status the lifecycle produces most often, and it is not a
 * failure: it means the sender's newest post no longer lists the job. So it
 * reads as quiet rather than alarming, the same as `expired`.
 */
const STATUS_STYLE: Record<LoadStatus, { tone: Tone; label: string; title: string }> = {
  available: { tone: "ok", label: "Available", title: "On the sender's latest list" },
  delisted: {
    tone: "muted",
    label: "Delisted",
    title: "The sender's latest post no longer lists this job",
  },
  pending: { tone: "warn", label: "Pending", title: "Someone is working on it" },
  taken: { tone: "muted", label: "Taken", title: "Marked taken — it stays taken if re-posted" },
  expired: { tone: "muted", label: "Expired", title: "The sender has been silent for days" },
  cancelled: { tone: "danger", label: "Cancelled", title: "Cancelled by the poster" },
};

export function StatusChip({ status }: { status: LoadStatus }) {
  const s = STATUS_STYLE[status] ?? STATUS_STYLE.available;
  return (
    <Chip tone={s.tone} title={s.title}>
      {s.label}
    </Chip>
  );
}

const TONE_CLASS: Record<Tone, string> = {
  default: "chip",
  accent: "chip chip-accent",
  ok: "chip chip-ok",
  ready: "chip chip-ready",
  fresh: "chip chip-fresh",
  warn: "chip chip-warn",
  review: "chip chip-review",
  approx: "chip chip-approx",
  danger: "chip chip-danger",
  muted: "chip chip-muted",
};

export function Chip({
  children,
  tone = "default",
  title,
  className,
}: {
  children: React.ReactNode;
  tone?: Tone;
  title?: string;
  className?: string;
}) {
  return (
    <span className={`${TONE_CLASS[tone] ?? TONE_CLASS.default}${className ? ` ${className}` : ""}`} title={title}>
      {children}
    </span>
  );
}

export function EmptyState({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="card p-[var(--sp-6)] text-center">
      <div className="font-semibold">{title}</div>
      {hint && (
        <div className="mt-[var(--sp-1)] text-[var(--fs-base)]" style={{ color: "var(--muted)" }}>
          {hint}
        </div>
      )}
      {children && (
        <div className="mt-[var(--sp-3)] flex flex-wrap justify-center gap-[var(--sp-2)]">{children}</div>
      )}
    </div>
  );
}

/**
 * A job whose end could only be placed at a state or region centroid is shown
 * with the caveat attached. Pretending "somewhere in Florida" is a pin on a map
 * is how a board loses a driver's trust the first time they drive to it.
 */
export function PrecisionNote({ precision }: { precision: string | null }) {
  if (precision !== "state" && precision !== "region") return null;
  return (
    <Chip tone="approx" title="The post did not give a specific city, so this location is approximate.">
      approximate location
    </Chip>
  );
}
