"use client";

/**
 * Pickup state and delivery state — the two controls the whole board turns on.
 *
 * A backhaul is a lane, not a radius: a driver emptying in Kearny wants "who is
 * going to Florida", and they think in state codes because that is what the
 * posts are written in ("200cf FL 33180 RFD"). So the two pickers are the most
 * prominent thing in the filter bar, they are multi-select, and they carry the
 * region shorthands people actually say out loud — Tri-State, Southeast.
 *
 * Region tokens are passed to the server verbatim (`deliveryState=tristate`);
 * the expansion lives in one place, A's query builder, so a shared link keeps
 * meaning "the Tri-State area" rather than freezing today's member list.
 */

import { useMemo, useState } from "react";
import { REGIONS, STATES } from "@/lib/geo/states";
import { PopoverButton } from "./ui";

export interface StatePickerProps {
  label: "Pickup" | "Delivery";
  value: string[];
  onChange(v: string[]): void;
  /** "Near you: FL" / "Home: NJ" — offered, never applied on its own. */
  ghost?: { text: string; state: string } | null;
  fullScreen?: boolean;
}

/** The shorthands worth one click, in the order a mover would scan them. */
const QUICK_REGIONS = [
  "tristate",
  "northeast",
  "midatlantic",
  "southeast",
  "midwest",
  "southwest",
  "westcoast",
] as const;

/** "tristate" -> "Tri-State Area"; "FL" -> "FL". */
export function tokenLabel(token: string): string {
  return REGIONS[token]?.label ?? token;
}

/** The short form shown inside the trigger, where three of them have to fit. */
function chipLabel(token: string): string {
  const region = REGIONS[token];
  if (!region) return token;
  return region.label.replace(" Area", "");
}

export function StatePicker({ label, value, onChange, ghost, fullScreen }: StatePickerProps) {
  const selected = value.filter(Boolean);
  const shown = selected.slice(0, 3);
  const overflow = selected.length - shown.length;

  const toggle = (token: string) => {
    onChange(
      selected.includes(token) ? selected.filter((t) => t !== token) : [...selected, token],
    );
  };

  const trigger = (
    <>
      <span style={{ color: selected.length ? "var(--muted)" : "var(--text)" }}>{label}</span>
      {selected.length === 0 ? (
        <span className="ghost">Any</span>
      ) : (
        <>
          {shown.map((token) => (
            <span key={token} className="pill-chip">
              {chipLabel(token)}
              <span
                role="button"
                tabIndex={-1}
                aria-label={`Remove ${chipLabel(token)}`}
                title={`Remove ${chipLabel(token)}`}
                style={{ cursor: "pointer", opacity: 0.7 }}
                onClick={(e) => {
                  e.stopPropagation();
                  onChange(selected.filter((t) => t !== token));
                }}
              >
                ×
              </span>
            </span>
          ))}
          {overflow > 0 && <span className="pill-chip">+{overflow}</span>}
        </>
      )}
      <span aria-hidden style={{ color: "var(--muted-2)" }}>
        ▾
      </span>
    </>
  );

  return (
    <span className="inline-flex items-center gap-[var(--sp-1)]">
      <PopoverButton
        label={trigger}
        active={selected.length > 0}
        width={360}
        fullScreen={fullScreen}
        panelTitle={`${label} state`}
        ariaLabel={`${label} state`}
      >
        {() => <Panel selected={selected} onToggle={toggle} onClear={() => onChange([])} />}
      </PopoverButton>

      {ghost && selected.length === 0 && (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          style={{ color: "var(--accent)" }}
          title={`Filter ${label.toLowerCase()} to ${ghost.state}`}
          onClick={() => onChange([ghost.state])}
        >
          {ghost.text}
        </button>
      )}
    </span>
  );
}

function Panel({
  selected,
  onToggle,
  onClear,
}: {
  selected: string[];
  onToggle(token: string): void;
  onClear(): void;
}) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();

  const states = useMemo(
    () =>
      needle
        ? STATES.filter(
            (s) => s.abbr.toLowerCase().startsWith(needle) || s.name.toLowerCase().includes(needle),
          )
        : STATES,
    [needle],
  );

  const regions = useMemo(
    () =>
      QUICK_REGIONS.filter(
        (key) => !needle || REGIONS[key].label.toLowerCase().includes(needle) || key.includes(needle),
      ),
    [needle],
  );

  return (
    <div className="flex flex-col gap-[var(--sp-3)]">
      <input
        className="field"
        placeholder="State name or code"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label="Search states"
      />

      {regions.length > 0 && (
        <div>
          <div className="label">Regions</div>
          <div className="flex flex-wrap gap-[var(--sp-1)]">
            {/* Florida earns a shortcut of its own: it is one end of most of
                these lanes, and typing it every time is friction. */}
            {(!needle || "florida".includes(needle) || "fl".startsWith(needle)) && (
              <Tile token="FL" label="FL" on={selected.includes("FL")} onClick={onToggle} wide />
            )}
            {regions.map((key) => (
              <Tile
                key={key}
                token={key}
                label={REGIONS[key].label}
                title={REGIONS[key].states.join(" ")}
                on={selected.includes(key)}
                onClick={onToggle}
                wide
              />
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="label">States</div>
        <div className="grid grid-cols-6 gap-[var(--sp-1)]">
          {states.map((s) => (
            <Tile
              key={s.abbr}
              token={s.abbr}
              label={s.abbr}
              title={s.name}
              on={selected.includes(s.abbr)}
              onClick={onToggle}
            />
          ))}
        </div>
        {states.length === 0 && (
          <p className="text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
            No state matches “{q}”.
          </p>
        )}
      </div>

      {selected.length > 0 && (
        <button type="button" className="btn btn-ghost btn-sm self-start" onClick={onClear}>
          Clear {selected.length} selected
        </button>
      )}
    </div>
  );
}

function Tile({
  token,
  label,
  title,
  on,
  onClick,
  wide,
}: {
  token: string;
  label: string;
  title?: string;
  on: boolean;
  onClick(token: string): void;
  wide?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={on}
      onClick={() => onClick(token)}
      className={wide ? "chip" : "chip justify-center"}
      style={{
        height: wide ? 26 : 30,
        cursor: "pointer",
        background: on ? "var(--accent-soft)" : "var(--surface-2)",
        color: on ? "var(--accent)" : "var(--text-2)",
        border: on ? "1px solid var(--accent)" : "1px solid transparent",
        borderRadius: wide ? "var(--radius-pill)" : "var(--radius-sm)",
        width: wide ? undefined : "100%",
      }}
    >
      {label}
    </button>
  );
}
