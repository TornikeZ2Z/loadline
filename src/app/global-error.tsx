"use client";

/**
 * The last net: this one catches errors thrown by the root layout itself, which
 * `error.tsx` sits inside and therefore cannot catch.
 *
 * It REPLACES the root layout when it fires, so it has to bring its own
 * `<html>` and `<body>` -- and its own stylesheet, which is why globals.css is
 * imported here and nowhere else outside the layout. Without that import the
 * tokens below resolve to nothing and the page renders as unstyled black on
 * white. (Next's docs are explicit that the built-in version of this page does
 * not get the app's global styles; importing them is how you get them back.)
 *
 * Deliberately minimal. Whatever broke was underneath everything else, so this
 * page assumes nothing works: no Link, no shell, no fonts of its own, and one
 * button. `<title>` is a React element rather than a metadata export because
 * metadata exports are not supported in a client component.
 */

import "./globals.css";

export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <html lang="en">
      <body>
        <title>Something went wrong · LoadLine</title>
        <main
          style={{
            minHeight: "100dvh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "var(--sp-5)",
            background: "var(--bg)",
            color: "var(--text)",
          }}
        >
          <div className="card" style={{ maxWidth: "440px", padding: "var(--sp-6)", textAlign: "center" }}>
            <div className="big" style={{ fontSize: "var(--fs-2xl)" }}>
              LoadLine hit an error
            </div>
            <p
              style={{
                marginTop: "var(--sp-2)",
                fontSize: "var(--fs-base)",
                lineHeight: "var(--lh-base)",
                color: "var(--muted)",
              }}
            >
              Something failed before the page could be built. Trying again is
              usually enough.
            </p>
            {error.digest && (
              <p style={{ marginTop: "var(--sp-3)", fontSize: "var(--fs-xs)", color: "var(--muted-2)" }}>
                Reference {error.digest}
              </p>
            )}
            <div style={{ marginTop: "var(--sp-5)" }}>
              <button type="button" className="btn btn-primary" onClick={() => retry()}>
                Try again
              </button>
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}
