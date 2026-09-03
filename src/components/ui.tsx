import type { LoadRow, LoadStatus } from "@/lib/loads/types";

const STATUS_STYLE: Record<LoadStatus, { bg: string; fg: string; label: string }> = {
  available: { bg: "var(--ok-soft)", fg: "var(--ok)", label: "Available" },
  pending: { bg: "var(--warn-soft)", fg: "var(--warn)", label: "Pending" },
  taken: { bg: "var(--surface-2)", fg: "var(--muted)", label: "Taken" },
  expired: { bg: "var(--surface-2)", fg: "var(--muted)", label: "Expired" },
  cancelled: { bg: "var(--danger-soft)", fg: "var(--danger)", label: "Cancelled" },
};

export function StatusChip({ status }: { status: LoadStatus }) {
  const s = STATUS_STYLE[status] ?? STATUS_STYLE.available;
  return (
    <span className="chip" style={{ background: s.bg, color: s.fg }}>
      {s.label}
    </span>
  );
}

export function Chip({
  children,
  tone = "neutral",
  title,
}: {
  children: React.ReactNode;
  tone?: "neutral" | "accent" | "warn" | "ok";
  title?: string;
}) {
  const tones = {
    neutral: { background: "var(--surface-2)", color: "var(--muted)" },
    accent: { background: "var(--accent-soft)", color: "var(--accent)" },
    warn: { background: "var(--warn-soft)", color: "var(--warn)" },
    ok: { background: "var(--ok-soft)", color: "var(--ok)" },
  } as const;
  return (
    <span className="chip" style={tones[tone]} title={title}>
      {children}
    </span>
  );
}

/**
 * Dates are rendered relative ("Tomorrow") because that is how the source
 * messages talk and how drivers think, with the calendar date kept alongside so
 * nothing is ambiguous.
 */
export function formatPickupDate(iso: string | null): { text: string; relative: string | null } {
  if (!iso) return { text: "No date given", relative: null };
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const today = new Date();
  const todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const days = Math.round((date.getTime() - todayUtc) / 86_400_000);

  const text = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

  if (days === 0) return { text, relative: "Today" };
  if (days === 1) return { text, relative: "Tomorrow" };
  if (days === -1) return { text, relative: "Yesterday" };
  if (days > 1 && days < 7) {
    return { text, relative: date.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" }) };
  }
  if (days < 0) return { text, relative: `${Math.abs(days)}d ago` };
  return { text, relative: null };
}

export function formatTime(time: string | null, note: string | null): string | null {
  if (!time) return note;
  const [h, m] = time.split(":").map(Number);
  const suffix = h >= 12 ? "pm" : "am";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return m ? `${hour}:${String(m).padStart(2, "0")}${suffix}` : `${hour}${suffix}`;
}

export function formatWeight(load: LoadRow): string | null {
  const parts: string[] = [];
  if (load.weight_lbs) parts.push(`${load.weight_lbs.toLocaleString()} lbs`);
  if (load.pallets) parts.push(`${load.pallets} pallet${load.pallets === 1 ? "" : "s"}`);
  if (load.pieces) parts.push(`${load.pieces} pcs`);
  return parts.length ? parts.join(" · ") : null;
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="card" style={{ padding: 40, textAlign: "center" }}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>{title}</div>
      {hint && <div style={{ color: "var(--muted)", fontSize: 13 }}>{hint}</div>}
    </div>
  );
}

/**
 * Loads whose origin could only be resolved to a state or a region are shown
 * with the caveat attached. Pretending "somewhere in Florida" is a pin on a map
 * is how a load board loses a driver's trust.
 */
export function PrecisionNote({ precision }: { precision: string | null }) {
  if (precision !== "state" && precision !== "region") return null;
  return (
    <Chip tone="warn" title="The message did not give a specific city, so this location is approximate.">
      approximate location
    </Chip>
  );
}
