"use client";

/**
 * The map's own error boundary, and the panel it puts in the map's place.
 *
 * WHY THIS EXISTS. `new maplibregl.Map()` throws SYNCHRONOUSLY when the browser
 * will not give it a WebGL context -- a machine with no GPU acceleration, a
 * hardened or enterprise-locked browser, a VM, `--disable-3d-apis`. That throw
 * happens inside a React effect, so with nothing to catch it, it propagated all
 * the way to Next's built-in global handler and replaced the ENTIRE page with
 * "This page couldn't load". The board, the filters, the list, every job and
 * every deep link to `/jobs/[id]` -- all of it gone, because one canvas could
 * not start. The whole product was unreachable for that visitor.
 *
 * The map is the one part of this page that depends on the GPU. Nothing else
 * does. So the map, and only the map, is what should disappear.
 *
 * WHY `catchError` AND NOT A HAND-ROLLED CLASS. Next 16.3 ships `catchError`
 * for exactly this -- component-level recovery that is not tied to a route
 * segment. It knows about the framework in ways a bare `componentDidCatch`
 * cannot: `redirect()` and `notFound()` throw special errors under the hood and
 * it lets those pass through instead of swallowing them into a "map unavailable"
 * panel, and it clears itself on a client navigation, so a broken map does not
 * stay broken-looking after the viewer moves to another page.
 *
 * WHY `reset()` AND NOT `retry()`. `retry()` re-fetches the route segment;
 * `reset()` only clears the error and re-renders the children. The board's rows
 * live in `Board`'s state, OUTSIDE this boundary, and they were never the thing
 * that failed -- re-fetching 98 jobs to find out whether a canvas works this
 * time would be a page reload wearing a smaller button. `reset()` remounts the
 * map alone, with fresh state, and leaves everything else exactly as it was.
 */

import { catchError, type ErrorInfo } from "next/error";

export interface MapBoundaryProps {
  /** A phone, or a phone lying down: the map band is only a few hundred px. */
  compact?: boolean;
  /**
   * How much of the map's box the bottom sheet is covering right now, in px.
   * On a phone the map runs the full height of the board and the sheet floats
   * over its lower half, so a panel centred in the box would be centred behind
   * the sheet -- which is exactly where a message nobody can read goes. This is
   * the same measurement `--map-inset-b` gives the map's own legend and
   * MapLibre's attribution; the panel sits in what is left above it.
   */
  bottomPadding?: number;
}

/**
 * What stands where the map was.
 *
 * It keeps the map's own paper colour rather than going white, so the board
 * still reads as "map on the left, list on the right" and the eye is not sent
 * hunting for what changed. And it says the one thing that actually matters to
 * someone who came here to find a backhaul: the jobs are still there.
 */
export function MapUnavailable({
  onRetry,
  detail,
  compact = false,
  bottomPadding = 0,
}: {
  onRetry?: () => void;
  /** The underlying message, e.g. "Failed to initialize WebGL". */
  detail?: string | null;
  compact?: boolean;
  bottomPadding?: number;
}) {
  return (
    <div
      data-map-chrome
      data-map-unavailable
      role="status"
      className="absolute inset-0 flex flex-col items-center justify-center px-[var(--sp-4)] text-center"
      style={{
        background: "var(--map-paper)",
        // Capped at 55vh for the same reason the legend is: a sheet dragged to
        // full would otherwise push this up and out through the top.
        paddingBottom: bottomPadding ? `min(${bottomPadding}px, 55vh)` : undefined,
      }}
    >
      {/* The outline of a map that is not there -- the same dashed-frame idea
          the empty list state uses, so the two read as one family. */}
      <svg width="44" height="44" viewBox="0 0 44 44" aria-hidden="true">
        <rect
          x="2"
          y="7"
          width="40"
          height="30"
          rx="5"
          fill="none"
          stroke="var(--border-strong)"
          strokeWidth="1.5"
          strokeDasharray="4 4"
        />
        <path
          d="M15 7v30M29 7v30"
          stroke="var(--border-strong)"
          strokeWidth="1.5"
          strokeDasharray="4 4"
        />
      </svg>

      <div className="big mt-[var(--sp-3)] text-(length:--fs-lg)">Map unavailable</div>
      <p
        className="mt-[var(--sp-1)] max-w-[42ch] text-(length:--fs-base) leading-relaxed"
        style={{ color: "var(--muted)" }}
      >
        You can still browse jobs — the list has every one of them, filters and
        sorting work, and opening a job still shows its details and contact.
      </p>

      {/* The reason, quietly. "Failed to initialize WebGL" is the difference
          between a driver thinking the site is broken and knowing it is their
          browser -- and it is the first thing anyone debugging this will ask
          for. Hidden on a short map band, where the four lines above it are
          already most of the height there is. */}
      {detail && !compact && (
        <p className="mt-[var(--sp-2)] text-(length:--fs-xs)" style={{ color: "var(--muted-2)" }}>
          {detail}
        </p>
      )}

      {onRetry && (
        <button type="button" className="btn btn-sm mt-[var(--sp-3)]" onClick={onRetry}>
          Try the map again
        </button>
      )}
    </div>
  );
}

/**
 * Not a component -- `catchError` calls this with (props, errorInfo), so it has
 * no hooks and no state of its own.
 *
 * `ErrorInfo.error` is typed `unknown`, because a throw can be anything at all.
 * Only a real message is shown; anything else gets no detail line rather than
 * "[object Object]" under the headline.
 */
function MapFallback({ compact, bottomPadding }: MapBoundaryProps, { error, reset }: ErrorInfo) {
  const detail = error instanceof Error ? error.message : null;
  return (
    <MapUnavailable
      compact={compact}
      bottomPadding={bottomPadding}
      detail={detail}
      onRetry={reset}
    />
  );
}

export const MapBoundary = catchError<MapBoundaryProps>(MapFallback);
