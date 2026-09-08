"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api } from "@/lib/basePath";
import {
  OPEN_LOCATION_EVENT,
  clearLocation,
  useViewerLocation,
  writeLocation,
  type LocationSlot,
} from "@/lib/location";
import { LocationInput, type ResolvedPlace } from "./LocationInput";

/**
 * "Where are you?" -- set once, used everywhere, stored nowhere but this browser.
 *
 * This is the input the whole board hangs off: it sorts jobs by distance to
 * pickup, puts "142 mi from you" on the cards and drive time in the detail. It
 * lives in the header rather than a settings page because a mover's answer
 * changes during the day, and it needs no account because the board needs no
 * account.
 *
 * Two slots. **Current** is where you are (or will be when you're empty).
 * **Home** is where you're heading back to -- it only pre-selects the delivery
 * filter and powers the Toward-home corridor, which is why it is a separate,
 * quieter pill rather than a second required field.
 */
/**
 * The board's own definition of a narrow screen, mirrored here.
 *
 * Board.tsx calls it `compact` -- `(max-width: 767px)` OR `(max-height: 540px)`
 * -- and it decides whether the filter bar has room for the search controls
 * below. Above it the board hosts the truck-location and home-base controls
 * inside its search area (V02), so the header must not print a second pair.
 */
const COMPACT_MQ = "(max-width: 767px), (max-height: 540px)";

/** The board and its two deep links, the only routes with a search area. */
function isBoardPath(pathname: string | null): boolean {
  if (!pathname) return false;
  return pathname === "/" || pathname.startsWith("/jobs") || pathname.startsWith("/trucks");
}

function subscribeCompact(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const mq = window.matchMedia(COMPACT_MQ);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

/**
 * True while the viewport is one the board calls compact.
 *
 * The server snapshot is `true` on purpose: the header renders the pills in the
 * HTML, so a phone -- where they are the only copy there is -- has them before
 * any JavaScript runs, and the wide-screen case is handled by a media query on
 * the wrapper so nothing is ever painted twice.
 */
function useCompactViewport(): boolean {
  return useSyncExternalStore(
    subscribeCompact,
    () => window.matchMedia(COMPACT_MQ).matches,
    () => true,
  );
}

export function CurrentLocation() {
  const pathname = usePathname();
  const compact = useCompactViewport();
  // On a wide board the search area owns these two controls, so this one steps
  // aside completely -- including its OPEN_LOCATION_EVENT listener, or the
  // map's "Set truck location" nudge would open a popover inside a header that
  // is not showing (V02).
  const stepAside = isBoardPath(pathname) && !compact;

  if (stepAside) return null;
  return (
    /* The same condition as `stepAside`, written once more as a media query.
       `useCompactViewport` cannot know the viewport during server rendering, so
       without this the wide board would paint the header pills for the one
       frame between HTML and hydration and then drop them, which reads as a
       layout bug. Off the board the wrapper carries no class and nothing hides. */
    /* `min-w-0` so the pill inside can be the header row's shock absorber --
       see the button below for why the vw cap it used to carry is gone. */
    <div
      className={`min-w-0${isBoardPath(pathname) ? " md:[@media(min-height:541px)]:hidden" : ""}`}
    >
      <LocationControls variant="header" />
    </div>
  );
}

/**
 * The two location pills and the popover behind them.
 *
 * `header` is the pinned group beside the account controls, where the pills
 * shrink to a city on a phone. `search` is the board's own search area, where
 * they lead the row that forms the search -- the whole point of V02 -- and can
 * afford their full labels.
 */
function LocationControls({ variant }: { variant: "header" | "search" }) {
  const { current, home, hydrated } = useViewerLocation();
  const [open, setOpen] = useState<LocationSlot | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const inHeader = variant === "header";

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(null);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  // The Board's first-visit nudge and the detail's "From you" tile ask for this
  // popover by event, so nothing of ours has to be mounted inside the map area.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const slot = (e as CustomEvent<{ slot?: LocationSlot }>).detail?.slot;
      setOpen(slot === "home" ? "home" : "current");
    };
    window.addEventListener(OPEN_LOCATION_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_LOCATION_EVENT, onOpen);
  }, []);

  return (
    /* The search variant wraps: at 390 px the two pills are 400 px of content
       inside a 358 px sheet, and a row that cannot wrap simply pushed the home
       base off the right edge. The header variant must not wrap -- it lives in
       a fixed-height bar -- and below `sm` it only ever shows one pill anyway. */
    <div
      ref={box}
      className={`relative flex min-w-0 items-center gap-[var(--sp-2)]${inHeader ? "" : " flex-wrap"}`}
    >
      <button
        type="button"
        className={inHeader ? "pill min-w-0" : "pill min-w-0 max-w-full"}
        onClick={() => setOpen((s) => (s === "current" ? null : "current"))}
        /* The stored place is named here as well as on the face of the pill.
           A city long enough to be ellipsised on a 320 px header ("Fort
           Lauder…") is the one case where the face cannot carry the whole
           value, and the answer is to keep it reachable rather than to shorten
           the fact into a state it did not state. */
        title={
          current
            ? `Your truck comes free near ${current.label} — the board is sorted by distance to the pickup`
            : "Where your truck will be empty — sorts the board by distance to the pickup"
        }
        aria-label="Where will your truck be empty?"
        style={
          hydrated && !current
            ? { borderColor: "var(--accent)", color: "var(--accent)" }
            : undefined
        }
      >
        {/* On a phone the pill says the city and nothing else -- there is no
            room for "Near Miami, FL" beside the nav, and the state is the part
            a driver already knows.

            "Where are you?" read as a question about the person; on a board
            whose whole subject is an empty truck it has to be a statement about
            the truck (§5.1). The popover under it already asks the longer
            question, "Where will you be when you're empty?".

            V03 RESIDUAL -- "EMPTY AT", NOT "TRUCK LOCATION", AND THE ARITHMETIC
            THAT DECIDED IT.

            "◎ Truck location" sets 111 px at 14/500. With the caret, the gap
            and .pill's own 12 px of padding either side it wants a 155 px
            control -- and a 320 px header has 118 px to give it once the logo
            (44), the More menu (44), "Sign in" (74), two 8 px gaps and the
            row's own padding have been paid. So the old label could not fit,
            was capped at 32vw = 102 px, and read "Truck l…" -- a control cut
            in the middle of its own name.

            "◎ Empty at" is 75 px, which makes the whole pill 117: it fits 320
            with room over, and it is not a new word. It is the phrase this
            board already uses for this control everywhere else -- the search
            area's "◎ Truck empty at …", the map's "Where will you be empty?"
            and this button's own aria-label. The one width that could still
            cut it is a stored place whose city name is long; that is a VALUE
            being shortened, with the full text on the title and in the popover,
            not the control failing to say what it is. */}
        {/* `md`, not `sm`, for the long form -- measured, not guessed. At 640
            the header carries the wordmark, the More menu, BOTH location pills
            and "Sign in · contacts"; "◎ Near Miami, FL" wants 116 px there and
            has 108, so `sm` was eight pixels too early and cut a second label.
            From `md` the row has room to spare. Nothing is lost between the two
            breakpoints: the short form is the same place, named by its city. */}
        {inHeader ? (
          <>
            <span className="truncate md:hidden">
              ◎ {current ? shortLabel(current.label) : "Empty at"}
            </span>
            <span className="hidden truncate md:inline">
              ◎ {current ? `Near ${current.label}` : "Empty at"}
            </span>
          </>
        ) : (
          <span className="truncate">
            <span style={{ color: "var(--muted)" }}>◎ Truck empty at </span>
            {current ? current.label : "anywhere"}
          </span>
        )}
        ▾
      </button>

      {/* The home slot only feeds the Toward-home corridor and a filter hint,
          so on a phone it yields its space to the one that sorts the board and
          is reached from inside that popover instead.
          The wrapper carries `hidden`, not the button: `.pill` sets its own
          `display`, and a utility class of equal specificity declared earlier
          would lose to it. */}
      <span className={inHeader ? "hidden sm:block" : "block min-w-0 max-w-full"}>
        <button
          type="button"
          className={inHeader ? "pill" : "pill min-w-0 max-w-full"}
          onClick={() => setOpen((s) => (s === "home" ? null : "home"))}
          title="Where you're heading back to — optional. It pre-selects the delivery filter and powers Toward home."
        >
          {/* "Home" beside a job board reads as a link to the home page.
              "Home base" is the yard you are trying to get back to (§5.1). */}
          {inHeader ? (
            <>⌂ {home ? `Home base ${home.state ?? home.label}` : "Home base"}</>
          ) : (
            <span className="truncate">
              <span style={{ color: "var(--muted)" }}>⌂ Home base </span>
              {home ? (home.state ?? home.label) : "optional"}
            </span>
          )}{" "}
          ▾
        </button>
      </span>

      {open && (
        // Keyed by slot: switching between the two must start from that slot's
        // own stored value, not carry the other one's half-typed text over.
        <LocationPopover
          key={open}
          slot={open}
          onClose={() => setOpen(null)}
          onSwitchSlot={(s) => setOpen(s)}
          align={inHeader ? "right" : "left"}
        />
      )}
    </div>
  );
}

/**
 * The same two controls, rendered inside the board's search area.
 *
 * V02: "Place 'Where will your truck be empty?' within this area." It is the
 * first thing in the row that forms the search, ahead of the lane, because it
 * is the question a mover with an empty truck answers first -- and the header
 * copy stands down (see `CurrentLocation`) so there is only ever one.
 */
export function SearchLocationControls() {
  return <LocationControls variant="search" />;
}

/** "Miami, FL" -> "Miami"; "Near Kearny, NJ 07032" -> "Near Kearny". */
function shortLabel(label: string): string {
  return label.split(",")[0]?.trim() || label;
}

function LocationPopover({
  slot,
  onClose,
  onSwitchSlot,
  align = "right",
}: {
  slot: LocationSlot;
  onClose: () => void;
  onSwitchSlot: (slot: LocationSlot) => void;
  /**
   * Which edge the panel hangs from. The header group sits at the right of the
   * window, so it opens leftwards; in the search area the controls are at the
   * left edge and a right-aligned panel would run off the screen.
   */
  align?: "left" | "right";
}) {
  const { current, home } = useViewerLocation();
  const stored = slot === "current" ? current : home;

  const [text, setText] = useState(stored?.label ?? "");
  const [picked, setPicked] = useState<ResolvedPlace | null>(null);
  const [truck, setTruck] = useState(stored?.truckCf ? String(stored.truckCf) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useCallback(
    (place: ResolvedPlace) => {
      writeLocation(slot, {
        label: place.label,
        lat: place.lat,
        lng: place.lng,
        state: place.state,
        precision: place.precision,
        // A truck size belongs to the driver, not to the place they're heading
        // back to -- the home slot never carries one.
        truckCf: slot === "current" && truck.trim() ? Number(truck) || null : null,
      });
      onClose();
    },
    [slot, truck, onClose],
  );

  /** Resolve whatever is in the box: a picked suggestion, or the free text. */
  async function saveTyped() {
    if (picked) return save(picked);

    const label = text.trim();
    if (!label) return;

    setBusy(true);
    setError(null);
    try {
      const res = await fetch(api("/api/places/resolve"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label }),
      });
      if (!res.ok) {
        setError("We could not find that place — try a city or ZIP.");
        return;
      }
      save((await res.json()) as ResolvedPlace);
    } finally {
      setBusy(false);
    }
  }

  function useGps() {
    if (!navigator.geolocation) {
      setError("This browser will not share a location.");
      return;
    }
    setBusy(true);
    setError(null);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          // The browser's coordinates are what sort the board; the round trip
          // only buys a name a person recognises.
          const res = await fetch(api("/api/places/resolve"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
          });
          if (res.ok) save((await res.json()) as ResolvedPlace);
          else setError("Could not name that location — type a place instead.");
        } finally {
          setBusy(false);
        }
      },
      () => {
        setBusy(false);
        setError("Location permission denied — type a place instead.");
      },
      { timeout: 8000 },
    );
  }

  const isCurrent = slot === "current";

  return (
    <div
      className={`popover absolute ${align === "right" ? "right-0" : "left-0"} top-full z-50 mt-2 w-[340px] max-w-[calc(100vw-2rem)] p-[var(--sp-3)]`}
      style={{ background: "var(--surface)", borderColor: "var(--border-strong)" }}
    >
      <div className="label">{isCurrent ? "Where are you?" : "Where are you heading back to?"}</div>
      <p className="mb-2 text-(length:--fs-xs)" style={{ color: "var(--muted)" }}>
        {isCurrent
          ? "Where will you be when you're empty? Jobs get sorted by distance to pickup and show drive time."
          : "A state is fine — it pre-selects the delivery filter and powers Toward home."}
      </p>

      <LocationInput
        ariaLabel={isCurrent ? "Your current location" : "Where you are heading back to"}
        placeholder="City, ZIP or address…"
        value={text}
        onChange={(t) => {
          setText(t);
          setPicked(null);
        }}
        onPick={(p) => {
          setPicked(p);
          setText(p.label);
        }}
      />

      {isCurrent && (
        <div className="mt-2">
          <label className="label" htmlFor="truck-cf">
            Truck size (cf) — optional
          </label>
          <input
            id="truck-cf"
            className="field"
            inputMode="numeric"
            placeholder="1500"
            value={truck}
            onChange={(e) => setTruck(e.target.value.replace(/[^\d]/g, ""))}
          />
        </div>
      )}

      {error && (
        <p className="mt-2 text-(length:--fs-xs)" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      )}

      <div className="mt-3 flex gap-[var(--sp-2)]">
        <button
          type="button"
          className="btn btn-primary flex-1"
          disabled={busy || (!picked && !text.trim())}
          onClick={() => void saveTyped()}
        >
          {busy ? "One moment…" : "Save"}
        </button>
        <button type="button" className="btn" onClick={useGps} disabled={busy} title="Use GPS">
          ◎ Use GPS
        </button>
      </div>

      {stored && (
        <button
          type="button"
          className="btn btn-ghost btn-sm mt-2"
          onClick={() => {
            clearLocation(slot);
            onClose();
          }}
        >
          Clear
        </button>
      )}

      {/* The home pill has no room in a phone header, so it reaches its own
          popover from here instead of disappearing. */}
      {isCurrent && (
        <span className="mt-2 block sm:hidden">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => onSwitchSlot("home")}
          >
            ⌂ {home ? `Home base ${home.state ?? home.label}` : "Set where you're heading back to"}
          </button>
        </span>
      )}

      <p className="mt-3 text-(length:--fs-xs)" style={{ color: "var(--muted-2)" }}>
        Stays on this device. Sent only with your searches.
      </p>
    </div>
  );
}
