"use client";

/**
 * The storage notice.
 *
 * Not a consent banner, because there is nothing here to consent to. This app
 * sets exactly one cookie -- the signed session, written only when you sign in
 * (src/lib/auth.ts) -- and keeps a handful of preferences in the browser's own
 * storage (src/lib/location.ts, PostLoadForm, Board). There is no analytics
 * script, no advertising pixel and no third-party tracker anywhere in the
 * bundle; an "Accept / Reject" pair over that would be theatre, and would imply
 * a tracker exists.
 *
 * So the notice says what is stored, links to /cookies, and goes away. The one
 * thing it writes is the fact that you dismissed it -- and it writes that only
 * when you press the button, never on arrival.
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

/** Also listed on /cookies, and cleared by `clearLoadLineStorage`. */
export const NOTICE_KEY = "loadline.notice.storage.v1";

/** Every key this app writes, so /cookies can offer a truthful "clear it" button. */
const LOCAL_KEYS = [
  "loadline.viewer.v1",
  "loadline.home.v1",
  "loadline.post.requirements.v1",
  NOTICE_KEY,
];
const SESSION_KEYS = ["loadline.locnudge"];

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(NOTICE_KEY) === "1";
  } catch {
    // Private mode and "block all cookies" throw on access. Treat an
    // unreadable store as dismissed: a notice that cannot remember being
    // dismissed would come back on every page, which is worse than silence.
    return true;
  }
}

export function CookieNotice() {
  // Starts hidden and stays hidden through the server render: the markup must
  // not depend on localStorage, or the first paint disagrees with hydration.
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!readDismissed()) setShow(true);
  }, []);

  const dismiss = useCallback(() => {
    setShow(false);
    try {
      window.localStorage.setItem(NOTICE_KEY, "1");
    } catch {
      // Nothing to do: the notice is gone for this page load either way.
    }
  }, []);

  if (!show) return null;

  return (
    <div
      // z-40 clears the board's bottom sheet (z-30) and stays under the
      // filter popovers (z-50), so it can always be dismissed.
      className="fixed inset-x-0 bottom-0 z-40 p-[var(--sp-3)]"
      role="region"
      aria-label="Cookies and storage"
    >
      <div className="card mx-auto flex max-w-[820px] flex-col gap-[var(--sp-3)] p-[var(--sp-4)] sm:flex-row sm:items-center">
        <p className="text-(length:--fs-base) leading-relaxed" style={{ color: "var(--text-2)" }}>
          <strong style={{ color: "var(--text)" }}>One cookie, and only if you sign in.</strong>{" "}
          LoadLine sets a single signed session cookie, and keeps the location you pick in your own
          browser. No analytics, no advertising, no third-party trackers &mdash; so there is nothing
          here to opt out of.{" "}
          <Link href="/cookies" className="underline" style={{ color: "var(--accent)" }}>
            What is stored
          </Link>
          .
        </p>
        <button
          type="button"
          className="btn btn-primary shrink-0 sm:ml-auto"
          onClick={dismiss}
          autoFocus
        >
          Got it
        </button>
      </div>
    </div>
  );
}

/**
 * The /cookies page's "clear it" control. Removes every key this app writes,
 * including the notice's own, so pressing it brings the notice back -- which is
 * the honest outcome: the notice is gone because a key says so, and that key is
 * now gone too.
 *
 * It cannot touch the session cookie: that one is HttpOnly, which is the point
 * of it. Signing out is what deletes it, and the copy says so.
 */
export function ClearStorageButton() {
  const [done, setDone] = useState(false);

  const clear = useCallback(() => {
    try {
      for (const key of LOCAL_KEYS) window.localStorage.removeItem(key);
      for (const key of SESSION_KEYS) window.sessionStorage.removeItem(key);
    } catch {
      // Storage is already unavailable; there is nothing left to clear.
    }
    setDone(true);
  }, []);

  return (
    <div className="flex flex-wrap items-center gap-[var(--sp-3)]">
      <button type="button" className="btn" onClick={clear}>
        Clear what this site stored
      </button>
      <span
        className="text-(length:--fs-sm)"
        style={{ color: "var(--muted)" }}
        role="status"
        aria-live="polite"
      >
        {done ? "Cleared. Reload the page to start fresh." : ""}
      </span>
    </div>
  );
}
