"use client";

/**
 * The primitives every board screen is built from: a chip, a status chip, an
 * empty state and the popover the filter bar hangs off.
 *
 * Colour is applied only through the `.chip-*` classes in globals.css, never as
 * a literal in a component: the whole point of the token system is that a chip
 * cannot drift from the palette by accident. Nothing here knows about a job --
 * the words come from `@/lib/loads/present`.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
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
    <div className="card px-[var(--sp-5)] py-[var(--sp-6)] text-center">
      {/* The outline of a card that is not there. No mascot and no shrug: the
          board is a working screen, and the mark's only job is to stop an
          empty result reading as a failed one. */}
      <svg
        width="40"
        height="40"
        viewBox="0 0 40 40"
        aria-hidden="true"
        className="mx-auto mb-[var(--sp-3)]"
      >
        <rect
          x="1.5"
          y="6.5"
          width="37"
          height="27"
          rx="5"
          fill="none"
          stroke="var(--border-strong)"
          strokeWidth="1.5"
          strokeDasharray="4 4"
        />
        <path
          d="M11 17h18M11 23h11"
          stroke="var(--border-strong)"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
      <div className="big text-(length:--fs-lg)">{title}</div>
      {hint && (
        <div
          className="mx-auto mt-[var(--sp-2)] max-w-[38ch] text-(length:--fs-base) leading-relaxed"
          style={{ color: "var(--muted)" }}
        >
          {hint}
        </div>
      )}
      {children && (
        <div className="mt-[var(--sp-4)] flex flex-wrap justify-center gap-[var(--sp-2)]">{children}</div>
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

/* -------------------------------- popover -------------------------------- */

/**
 * A filter trigger and the panel it opens.
 *
 * Positioned by hand from the trigger's rect rather than with a positioning
 * library: the whole filter bar is one row of pills near the top of the screen,
 * so "under the trigger, nudged left to stay on screen" is the entire
 * requirement, and package-lock.json is frozen.
 *
 * On a phone the panel becomes a full-screen sheet (`fullScreen`), because a
 * 360 px popover anchored to a 48 px bar is unusable with a thumb.
 */
export function PopoverButton({
  label,
  active = false,
  width = 320,
  title,
  ariaLabel,
  fullScreen = false,
  triggerClassName = "pill",
  panelTitle,
  children,
}: {
  label: React.ReactNode;
  active?: boolean;
  width?: number;
  title?: string;
  ariaLabel?: string;
  fullScreen?: boolean;
  triggerClassName?: string;
  /** Shown as the sheet header in full-screen mode. */
  panelTitle?: string;
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();

  const close = useCallback(() => {
    setOpen(false);
    trigger.current?.focus();
  }, []);

  // Measure after paint so the panel is placed against the trigger's real box,
  // which on a wrapped two-row filter bar is not where it was a render ago.
  useLayoutEffect(() => {
    if (!open || fullScreen) return;
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    const top = rect.bottom + 6;
    setPos({ left, top, maxHeight: Math.max(200, window.innerHeight - top - 12) });
  }, [open, fullScreen, width]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panel.current?.contains(t) || trigger.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open, close]);

  // Move focus into the panel so a keyboard user is not left behind on the pill.
  useEffect(() => {
    if (!open) return;
    const first = panel.current?.querySelector<HTMLElement>(
      "input, select, textarea, button, [tabindex]:not([tabindex='-1'])",
    );
    first?.focus();
  }, [open]);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={triggerClassName}
        data-active={active || undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? panelId : undefined}
        aria-label={ariaLabel}
        title={title}
        onClick={() => setOpen((o) => !o)}
      >
        {label}
      </button>

      {open &&
        (fullScreen ? (
          <div
            ref={panel}
            id={panelId}
            role="dialog"
            aria-modal="true"
            aria-label={panelTitle ?? ariaLabel}
            className="fixed inset-0 z-50 flex flex-col overflow-y-auto overscroll-contain"
            style={{ background: "var(--surface)" }}
          >
            {/* Sticky, and this is the whole reason the sheet has a header:
                the filter list is taller than a phone, so a Done button that
                scrolled with it left the only way out at the bottom of a
                screen the viewer had scrolled away from. */}
            <div
              className="sticky top-0 z-10 mb-[var(--sp-3)] flex items-center justify-between gap-[var(--sp-2)] border-b border-border px-[var(--sp-4)] py-[var(--sp-2)]"
              style={{ background: "var(--surface)" }}
            >
              <span className="big text-(length:--fs-lg)">{panelTitle ?? ariaLabel}</span>
              <button type="button" className="btn btn-primary" onClick={close}>
                Done
              </button>
            </div>
            <div className="px-[var(--sp-4)] pb-[var(--sp-6)]">{children(close)}</div>
          </div>
        ) : (
          <div
            ref={panel}
            id={panelId}
            role="dialog"
            aria-label={panelTitle ?? ariaLabel}
            className="popover fixed z-50 overflow-y-auto"
            style={{
              left: pos?.left ?? -9999,
              top: pos?.top ?? -9999,
              width,
              maxHeight: pos?.maxHeight,
            }}
          >
            {children(close)}
          </div>
        ))}
    </>
  );
}
