"use client";

/**
 * The phone layout's list: a sheet you drag up over the map.
 *
 * On a phone the map and the list want the same screen, and a toggle between
 * them loses the connection that makes the board work -- you tap a route, you
 * want the job. A sheet keeps both: at 18 % it is a summary line over a full
 * map, at 55 % the map still shows the selected arc above it, at 92 % it is a
 * list. The handle doubles as the summary, so the peek state is not wasted.
 *
 * `touch-action: none` is on the handle only: the body has to keep scrolling
 * normally, or the card list becomes unusable at the tall snap.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export type SheetSnap = "peek" | "half" | "full";

/** Fractions of viewport height, from the spec's 18 / 55 / 92. */
export const SNAP_FRACTION: Record<SheetSnap, number> = {
  peek: 0.18,
  half: 0.55,
  full: 0.92,
};

/**
 * How tall the sheet actually is at a snap. Exported because the map has to
 * know: it is drawn full-height underneath and fits its content into whatever
 * the sheet leaves showing.
 */
export function snapHeightPx(viewportHeight: number, snap: SheetSnap, topInset = 0): number {
  return Math.min(
    Math.round(viewportHeight * SNAP_FRACTION[snap]),
    Math.max(0, viewportHeight - topInset),
  );
}

export interface BottomSheetProps {
  snap: SheetSnap;
  onSnapChange(next: SheetSnap): void;
  /** The summary row: it lives in the handle so the peek state says something. */
  handle: React.ReactNode;
  /**
   * Pixels of chrome above the sheet that it must never cover -- the header and
   * the filter bar. 92 % of a 844 px screen is 776, which puts the top of the
   * sheet at y = 68 and slices the filter bar (52–113) in half: at the tall
   * snap you could see the state pickers but not press them. The full snap is
   * whichever is smaller, this or the fraction.
   */
  topInset?: number;
  /** The list pads its own cards; the job detail is full-bleed. */
  padded?: boolean;
  /**
   * An id for the scrolling body, so something outside the sheet can send focus
   * into it -- the board's "Skip the map" link (V15). The body takes
   * `tabIndex={-1}` with it: a landing place, never a tab stop of its own.
   */
  bodyId?: string;
  children: React.ReactNode;
}

const ORDER: SheetSnap[] = ["peek", "half", "full"];

export function BottomSheet({
  snap,
  onSnapChange,
  handle,
  topInset = 0,
  padded = true,
  bodyId,
  children,
}: BottomSheetProps) {
  const [viewportHeight, setViewportHeight] = useState(0);
  const [drag, setDrag] = useState<{ startY: number; startHeight: number; height: number } | null>(
    null,
  );

  useEffect(() => {
    const measure = () => setViewportHeight(window.innerHeight);
    measure();
    window.addEventListener("resize", measure);
    // Same reason as the board's own viewport effect: the layout viewport can
    // change without a `resize` event arriving first, and a sheet measured
    // against a stale height is the wrong height on screen.
    const ro =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(document.documentElement);
    return () => {
      window.removeEventListener("resize", measure);
      ro?.disconnect();
    };
  }, []);

  /** The tallest the sheet may be without covering the filter bar. */
  const ceiling = Math.max(0, (viewportHeight || 0) - topInset);

  const snapHeight = useCallback(
    (s: SheetSnap) => snapHeightPx(viewportHeight || 0, s, topInset),
    [viewportHeight, topInset],
  );

  const height = drag ? drag.height : snapHeight(snap);

  const nearest = useCallback(
    (h: number): SheetSnap => {
      let best: SheetSnap = "peek";
      let bestDistance = Infinity;
      for (const s of ORDER) {
        const d = Math.abs(snapHeight(s) - h);
        if (d < bestDistance) {
          bestDistance = d;
          best = s;
        }
      }
      return best;
    },
    [snapHeight],
  );

  const pointer = useRef<number | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    pointer.current = e.pointerId;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ startY: e.clientY, startHeight: height, height });
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (pointer.current !== e.pointerId || !drag) return;
    const next = Math.max(
      snapHeight("peek") * 0.6,
      Math.min(ceiling, drag.startHeight + (drag.startY - e.clientY)),
    );
    setDrag({ ...drag, height: next });
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (pointer.current !== e.pointerId || !drag) return;
    pointer.current = null;
    const settled = nearest(drag.height);
    setDrag(null);
    if (settled !== snap) onSnapChange(settled);
  };

  /** Keyboard equivalent of the drag, so the sheet is not pointer-only. */
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const at = ORDER.indexOf(snap);
    if (e.key === "ArrowUp" && at < ORDER.length - 1) {
      e.preventDefault();
      onSnapChange(ORDER[at + 1]);
    } else if (e.key === "ArrowDown" && at > 0) {
      e.preventDefault();
      onSnapChange(ORDER[at - 1]);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSnapChange(snap === "full" ? "half" : "full");
    }
  };

  return (
    <div
      className="sheet z-30"
      style={{
        height,
        transition: drag ? "none" : undefined,
      }}
    >
      <div
        className="sheet-handle relative"
        role="slider"
        tabIndex={0}
        aria-label="Job list height"
        aria-valuemin={0}
        aria-valuemax={2}
        aria-valuenow={ORDER.indexOf(snap)}
        aria-valuetext={snap}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
      >
        {handle}
      </div>
      {/* `overscroll-contain` stops a flick that reaches the end of the list
          from handing the scroll to the page behind the sheet. The padding is
          the list's, not the sheet's: the job detail brings its own, and with
          both it was inset 28 px from a 390 px screen. */}
      <div
        id={bodyId}
        data-results={bodyId ? "" : undefined}
        tabIndex={bodyId ? -1 : undefined}
        className={`overflow-y-auto overscroll-contain${padded ? " px-[var(--sp-3)] pb-[var(--sp-6)]" : ""}`}
        style={{ height: `calc(100% - var(--sheet-handle-h))` }}
      >
        {children}
      </div>
    </div>
  );
}
