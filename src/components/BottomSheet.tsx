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

export interface BottomSheetProps {
  snap: SheetSnap;
  onSnapChange(next: SheetSnap): void;
  /** The summary row: it lives in the handle so the peek state says something. */
  handle: React.ReactNode;
  children: React.ReactNode;
}

const ORDER: SheetSnap[] = ["peek", "half", "full"];

export function BottomSheet({ snap, onSnapChange, handle, children }: BottomSheetProps) {
  const [viewportHeight, setViewportHeight] = useState(0);
  const [drag, setDrag] = useState<{ startY: number; startHeight: number; height: number } | null>(
    null,
  );

  useEffect(() => {
    const measure = () => setViewportHeight(window.innerHeight);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const snapHeight = useCallback(
    (s: SheetSnap) => Math.round((viewportHeight || 0) * SNAP_FRACTION[s]),
    [viewportHeight],
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
      Math.min(viewportHeight * 0.96, drag.startHeight + (drag.startY - e.clientY)),
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
      <div
        className="overflow-y-auto px-[var(--sp-3)] pb-[var(--sp-6)]"
        style={{ height: `calc(100% - var(--sheet-handle-h))` }}
      >
        {children}
      </div>
    </div>
  );
}
