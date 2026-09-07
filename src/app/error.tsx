"use client";

/**
 * The net under every page.
 *
 * Until this file existed there was nothing between a thrown client error and
 * Next's built-in global handler, which replaces the whole document with "This
 * page couldn't load" and two buttons. That is what the CEO saw: one map that
 * could not get a WebGL context, and the entire product gone.
 *
 * The map has its own boundary now (`MapBoundary`), and it catches first
 * because it is nearer. This one is for everything that has no boundary of its
 * own -- today and, more to the point, whatever gets added next year. A page
 * someone can read and act on beats a page that says nothing.
 *
 * `retry()`, not `reset()`: Next 16.3 made `retry` the recovery prop, and it
 * re-fetches the segment as well as re-rendering it. A route-level error is
 * usually a server render or a data fetch that failed, and re-rendering the
 * same failed payload would only reproduce it. (The map boundary wants the
 * opposite -- `reset()` there, because its data was never the problem.)
 */

import { useEffect } from "react";
import Link from "next/link";

export default function BoardError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error("[MoverMesh]", error);
  }, [error]);

  return (
    <main
      className="flex min-h-[100dvh] items-center justify-center p-[var(--sp-5)]"
      style={{ background: "var(--bg)" }}
    >
      <div className="card w-full max-w-[440px] p-[var(--sp-6)] text-center">
        <div className="big text-(length:--fs-2xl)">Something went wrong</div>
        <p
          className="mx-auto mt-[var(--sp-2)] max-w-[40ch] text-(length:--fs-base) leading-relaxed"
          style={{ color: "var(--muted)" }}
        >
          This page hit an error it could not recover from on its own. The jobs
          themselves are fine — trying again usually loads them.
        </p>

        {/* The message on a client error is the real one; on a server error
            Next replaces it with a digest. Either is worth showing: one tells
            the viewer what happened, the other is the string that finds it in
            the logs. */}
        {(error.message || error.digest) && (
          <p
            className="mt-[var(--sp-3)] break-words text-(length:--fs-xs)"
            style={{ color: "var(--muted-2)" }}
          >
            {error.message || `Reference ${error.digest}`}
          </p>
        )}

        <div className="mt-[var(--sp-5)] flex items-center justify-center gap-[var(--sp-2)]">
          <button type="button" className="btn btn-primary" onClick={() => retry()}>
            Try again
          </button>
          <Link className="btn" href="/">
            Back to the board
          </Link>
        </div>
      </div>
    </main>
  );
}
