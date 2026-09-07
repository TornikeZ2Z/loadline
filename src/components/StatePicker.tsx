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
  /** `pickupZip` / `deliveryZip`, which the API has always honoured. */
  zip?: string;
  onZip?(v: string): void;
  /** How many jobs on the board actually carry a ZIP on this end. */
  zipNote?: React.ReactNode;
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

export function StatePicker({
  label,
  value,
  onChange,
  ghost,
  fullScreen,
  zip = "",
  onZip,
  zipNote,
}: StatePickerProps) {
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
      {selected.length === 0 && !zip ? (
        <span className="ghost">Any</span>
      ) : (
        <>
          {zip && (
            <span className="pill-chip" title={`${label} ZIP starts with ${zip}`}>
              {zip}
              <span
                role="button"
                tabIndex={-1}
                aria-label={`Remove ZIP ${zip}`}
                title={`Remove ZIP ${zip}`}
                style={{ cursor: "pointer", opacity: 0.7 }}
                onClick={(e) => {
                  e.stopPropagation();
                  onZip?.("");
                }}
              >
                ×
              </span>
            </span>
          )}
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
    /* `shrink-0`: on a phone this sits in a horizontal scroller, and a flex item
       that is allowed to shrink turns "Delivery Any ▾" into a sliver. */
    <span className="inline-flex shrink-0 items-center gap-[var(--sp-1)]">
      <PopoverButton
        label={trigger}
        active={selected.length > 0 || Boolean(zip)}
        width={360}
        triggerClassName="pill shrink-0"
        fullScreen={fullScreen}
        panelTitle={`${label} state`}
        ariaLabel={`${label} state`}
      >
        {() => (
          <StatePanel
            selected={selected}
            onToggle={toggle}
            onClear={() => onChange([])}
            zip={zip}
            onZip={onZip}
            zipLabel={`${label} ZIP`}
            zipNote={zipNote}
          />
        )}
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

/**
 * The regions-and-states grid, on its own.
 *
 * Exported because the phone bar no longer has room for two separate picker
 * pills: at 390 px the Delivery one was pushed off the end of a scroller (§5.2),
 * so both panels are now stacked inside one Lane sheet, which is also the only
 * arrangement in which a driver who set a pickup cannot miss the delivery.
 */
export function StatePanel({
  selected,
  onToggle,
  onClear,
  zip,
  onZip,
  zipLabel,
  zipNote,
}: {
  selected: string[];
  onToggle(token: string): void;
  onClear(): void;
  /** `pickupZip` / `deliveryZip` — omitted where this panel has no zip to own. */
  zip?: string;
  onZip?(v: string): void;
  zipLabel?: string;
  zipNote?: React.ReactNode;
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

      {/* The ZIP filter lives here rather than in the route controls: it
          narrows one end of the lane, which is the question this panel already
          answers. A prefix is a real filter -- the query builder matches
          `zip LIKE '070%'` on anything shorter than five digits -- so the field
          says so instead of silently truncating. */}
      {onZip && (
        <div>
          <div className="label">{zipLabel ?? "ZIP"}</div>
          <input
            className="field nums"
            inputMode="numeric"
            placeholder="07032"
            aria-label={`${zipLabel ?? "ZIP"} code or prefix`}
            value={zip ?? ""}
            onChange={(e) => onZip(e.target.value.replace(/\D/g, "").slice(0, 5))}
          />
          <p className="mt-[5px] text-(length:--fs-xs)" style={{ color: "var(--muted)" }}>
            A prefix works: <span className="nums">070</span> is north Jersey.
          </p>
          {/* Plenty of posts give a city and no ZIP, so this filter is much
              narrower than it looks. It says how much narrower rather than
              leaving a driver to conclude the board is empty. */}
          {zipNote}
        </div>
      )}

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
