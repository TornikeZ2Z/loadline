"use client";

/**
 * The one place a phone number reaches the page.
 *
 * Everything else about a job is public: the route, the size, the price, the
 * freshness, the original WhatsApp text. An account buys exactly one thing --
 * the contact -- so the sign-in step is not a wall in front of the board, it is
 * an inline step inside the job the driver already decided they want. No
 * navigation, no modal: the button turns into the step, the step turns into the
 * number, and the filters, the map viewport and the open drawer are untouched
 * throughout.
 *
 * WHEN THE POST HAS NO NUMBER this used to be a dead end -- "the sender wants
 * to be messaged in the group" and nothing to press. It is now the same gate
 * over a different payload: the group, a link to the group when an admin stored
 * one, and the job as plain text to paste there.
 *
 * There is deliberately NO "open this message" control, because WhatsApp has no
 * link to an individual message -- no scheme, no query string, nothing. Only
 * `wa.me/<digits>` (a person) and `chat.whatsapp.com/<code>` (a group invite
 * somebody generated) exist, and the block says so in one line rather than
 * shipping a button that quietly fails.
 *
 * Owned by Agent B; Agent C mounts it in the job detail's contact section and
 * nowhere else. It renders its own chrome (the "Contact" label and the name
 * line), so C mounts this and nothing around it.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/basePath";
import { registerHref } from "@/lib/session";
import type { ContactResponse } from "@/lib/loads/publicView";
import type { ContactMode } from "@/lib/loads/types";

export interface ContactGateProps {
  /**
   * Which board this listing is on, and therefore which endpoint the reveal
   * goes to and which noun the buttons say.
   *
   * ONE COMPONENT FOR BOTH KINDS. A second implementation of the phone gate is
   * not acceptable (SPEC §6): the sign-in step, the demo path, the
   * already-revealed-in-this-tab memory, the group fallback and the error
   * recovery are five states each, and two copies of them would drift within a
   * month. What the kind changes is the URL and four words.
   */
  kind?: "job" | "truck";
  /** The listing's id, on whichever table `kind` names. */
  listingId: number;
  contactName: string | null;
  /**
   * PublicLoadRow.has_phone. False -> the reveal shows the group instead of a
   * number; the gate itself is the same, because reaching the sender by any
   * route is what the account is for.
   */
  hasPhone: boolean;
  /** job.group_name, named in the "message the sender in the group" line. */
  groupName?: string | null;
  /** "dm" -> the sender asked to be messaged privately; WhatsApp leads. */
  contactMode: ContactMode;
  signedIn: boolean;
  demoMode: boolean;
  /** The card's Show contact button was used: reveal (or open the step) on mount. */
  autoOpen?: boolean;
  /** "sticky" drops the card chrome for the mobile bottom bar. */
  variant?: "card" | "sticky";
  /** LoadDetail swaps the masked message for `c.sourceBody`. */
  onRevealed?: (c: ContactResponse) => void;
}

type GateState = "idle" | "gate" | "revealing" | "revealed" | "error";

/**
 * Listings this tab has already revealed, kept outside React so a remount does
 * not lose them. Keyed "job:12" / "truck:12", because the two id spaces are
 * different tables and truck 12 is not job 12.
 *
 * Signing in here has to refresh the server tree (the header, and Board's
 * `signedIn`), and that refresh always remounts this component: Board rewrites
 * the address to /jobs/<id> with `history.replaceState`, so `router.refresh()`
 * re-fetches a different route than the one currently mounted and React swaps
 * the whole subtree. Without this the number the viewer just signed in for
 * vanishes and the gate is back to "Show contact". Only ids live here -- the
 * number itself is re-requested through POST /api/loads/:id/contact, which
 * stays the only way one reaches the page.
 */
const revealedInTab = new Set<string>();

/** Where to come back to after a real (non-demo) registration. */
function currentPath(): string {
  if (typeof window === "undefined") return "/";
  return window.location.pathname + window.location.search;
}

/**
 * Put text on the clipboard, or say it did not.
 *
 * `navigator.clipboard` needs a secure context, and this board is demoed over
 * plain http often enough that "Copy the job" silently doing nothing would be a
 * real bug rather than a theoretical one. The textarea fallback is the one
 * thing `document.execCommand` is still good for.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the textarea
  }
  try {
    const el = document.createElement("textarea");
    el.value = text;
    el.setAttribute("readonly", "");
    el.style.position = "fixed";
    el.style.top = "-1000px";
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}

export function ContactGate({
  kind = "job",
  listingId,
  contactName,
  hasPhone,
  groupName,
  contactMode,
  signedIn,
  demoMode,
  autoOpen,
  variant = "card",
  onRevealed,
}: ContactGateProps) {
  const router = useRouter();
  const [state, setState] = useState<GateState>("idle");
  const [contact, setContact] = useState<ContactResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(!demoMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
  const autoRan = useRef(false);

  const isTruck = kind === "truck";
  const tabKey = `${kind}:${listingId}`;
  const endpoint = isTruck ? `/api/trucks/${listingId}/contact` : `/api/loads/${listingId}/contact`;

  const reveal = useCallback(
    async (opts?: { afterSignIn?: boolean }) => {
      setState("revealing");
      setError(null);
      try {
        const res = await fetch(api(endpoint), { method: "POST" });
        if (res.status === 401) {
          setState("gate");
          return;
        }
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? "Could not load the contact");
        const data = body as ContactResponse;
        revealedInTab.add(tabKey);
        setContact(data);
        setState("revealed");
        onRevealed?.(data);
        // Only when this reveal followed a sign-in, so the header flips to the
        // signed-in view and Board's `signedIn` prop becomes true. Refreshing
        // on an ordinary reveal would remount this component for nothing --
        // and the remount that follows a sign-in is why `revealedInTab` exists.
        if (opts?.afterSignIn) router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load the contact");
        setState("error");
      }
    },
    [endpoint, tabKey, onRevealed, router],
  );

  // The card's Show contact button opens the detail with autoOpen set; a job
  // this tab already revealed re-opens itself after the sign-in remount.
  useEffect(() => {
    if (autoRan.current) return;
    const resume = revealedInTab.has(tabKey);
    if (!autoOpen && !resume) return;
    autoRan.current = true;
    if (signedIn) void reveal();
    else setState("gate");
  }, [autoOpen, signedIn, reveal, tabKey]);

  async function signInDemo() {
    setError(null);
    try {
      const res = await fetch(api("/api/auth/demo"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "driver" }),
      });
      if (!res.ok) throw new Error("Demo sign-in is not available");
      await reveal({ afterSignIn: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Demo sign-in is not available");
    }
  }

  async function signInWithPassword(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const res = await fetch(api("/api/auth/login"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? "Wrong email or password");
      await reveal({ afterSignIn: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Wrong email or password");
    }
  }

  async function copyListing(text: string) {
    const ok = await copyText(text);
    setCopied(ok ? "yes" : "no");
    setTimeout(() => setCopied(null), 2000);
  }

  const chrome =
    variant === "sticky"
      ? "flex flex-col gap-2"
      : "card flex flex-col gap-2 p-[var(--sp-4)]";

  const noun = isTruck ? "truck" : "job";
  const copyLabel =
    copied === "yes" ? "Copied" : copied === "no" ? "Press ⌘/Ctrl+C" : `Copy the ${noun}`;

  // --- 4. Revealed -----------------------------------------------------------
  if (state === "revealed" && contact) {
    const c = contact.contact;
    const g = contact.group;
    // Nothing to dial: either the post carried no number at all, or it wrote a
    // 7-digit shorthand with no area code. Both are dead ends on their own, so
    // both get the group instead.
    const unreachable = !c.tel;
    return (
      <section className={chrome}>
        {variant === "card" && <div className="label">Contact</div>}
        <div className="text-(length:--fs-md) font-semibold">{c.name ?? contactName ?? "Not named"}</div>
        {contactMode === "dm" && (
          <p className="text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
            The {isTruck ? "driver" : "sender"} asked to be messaged privately.
          </p>
        )}

        {c.display && (
          <>
            <div className="nums text-(length:--fs-lg) font-semibold">{c.display}</div>
            {/* Which line the driver is about to call. Calling the wrong one
                wastes a call, and "the sender's usual number" is a different
                promise from "the number in this post". */}
            <p className="text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
              {c.source === "sender"
                ? `This ${isTruck ? "driver" : "sender"}'s usual number — this post did not carry one.`
                : "The number in this post."}
            </p>
          </>
        )}

        {c.incomplete && (
          <p className="text-(length:--fs-sm)" style={{ color: "var(--warn)" }}>
            Area code missing in the post — check the original message.
          </p>
        )}

        {!unreachable && (
          <div className="flex flex-wrap gap-[var(--sp-2)]">
            {contactMode === "dm" ? (
              <>
                {c.whatsapp && (
                  <a
                    className="btn btn-primary"
                    style={{ minHeight: "var(--tap-min)" }}
                    href={c.whatsapp}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    WhatsApp
                  </a>
                )}
                <a className="btn" style={{ minHeight: "var(--tap-min)" }} href={c.tel!}>
                  Call {c.display}
                </a>
              </>
            ) : (
              <>
                <a className="btn btn-primary" style={{ minHeight: "var(--tap-min)" }} href={c.tel!}>
                  Call {c.display}
                </a>
                {c.whatsapp && (
                  <a
                    className="btn"
                    style={{ minHeight: "var(--tap-min)" }}
                    href={c.whatsapp}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    WhatsApp
                  </a>
                )}
              </>
            )}
          </div>
        )}

        {/* No number to dial: the group is the way through. */}
        {unreachable && (
          <>
            {!c.display && (
              <p className="text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
                No phone number in this post, and none from this {isTruck ? "driver" : "sender"}’s
                other posts{contactMode === "dm" ? " — they asked to be messaged privately" : ""}.
              </p>
            )}
            {g.name && (
              <p className="text-(length:--fs-base)">
                Posted in <span className="font-semibold">{g.name}</span>
              </p>
            )}
            <div className="flex flex-wrap gap-[var(--sp-2)]">
              {g.url && (
                <a
                  className="btn btn-primary"
                  style={{ minHeight: "var(--tap-min)" }}
                  href={g.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {g.kind === "wa" ? "Message the dispatcher" : "Open the group in WhatsApp"}
                </a>
              )}
              <button
                type="button"
                className={g.url ? "btn" : "btn btn-primary"}
                style={{ minHeight: "var(--tap-min)" }}
                onClick={() => void copyListing(contact.listingText)}
              >
                {copyLabel}
              </button>
            </div>
            <p className="text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
              WhatsApp cannot open one message from a link, so paste the {noun} into the group
              {g.url ? "" : " and ask for it"}.
            </p>
          </>
        )}

        {!unreachable && (
          <button
            type="button"
            className="btn btn-ghost btn-sm self-start"
            onClick={() => void copyListing(contact.listingText)}
          >
            {copyLabel}
          </button>
        )}
      </section>
    );
  }

  // --- 2. The inline sign-in step -------------------------------------------
  if (state === "gate") {
    return (
      <section className={chrome}>
        {variant === "card" && <div className="label">Contact</div>}
        <h3 className="text-(length:--fs-md) font-semibold">Sign in to see the contact</h3>
        <p className="text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
          Free. Browsing never needs an account — only contact details do.
        </p>

        {demoMode && (
          <button
            type="button"
            className="btn btn-primary w-full"
            style={{ minHeight: "var(--tap-min)" }}
            onClick={signInDemo}
          >
            Sign in as demo driver
          </button>
        )}

        {demoMode && !showForm && (
          <button
            type="button"
            className="btn btn-ghost btn-sm self-start"
            onClick={() => setShowForm(true)}
          >
            or use email and password
          </button>
        )}

        {showForm && (
          <form className="flex flex-col gap-[var(--sp-2)]" onSubmit={signInWithPassword}>
            <input
              className="field"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <input
              className="field"
              type="password"
              autoComplete="current-password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <button type="submit" className="btn btn-primary" style={{ minHeight: "var(--tap-min)" }}>
              Sign in
            </button>
          </form>
        )}

        {error && (
          <p className="text-(length:--fs-sm)" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        )}

        <p className="text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
          New here?{" "}
          <Link
            href={registerHref("driver", currentPath())}
            style={{ color: "var(--accent)", fontWeight: 600 }}
          >
            Create a driver account
          </Link>
        </p>

        <button
          type="button"
          className="btn btn-ghost btn-sm self-start"
          onClick={() => setState("idle")}
        >
          Cancel
        </button>
      </section>
    );
  }

  // --- 1. idle · 3. revealing · 5. error ------------------------------------
  // The idle copy tells the driver what pressing the button will get them, so
  // signing in for a job with no number is a choice rather than a surprise.
  return (
    <section className={chrome}>
      {variant === "card" && <div className="label">Contact</div>}
      <div className="text-(length:--fs-md) font-semibold">{contactName ?? "Not named"}</div>
      {contactMode === "dm" && (
        <p className="text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
          The {isTruck ? "driver" : "sender"} asked to be messaged privately.
        </p>
      )}
      {!hasPhone && (
        <p className="text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
          No phone number in this post — the {isTruck ? "driver" : "sender"} wants to be messaged
          {groupName ? (
            <>
              {" "}
              in <span className="font-semibold">{groupName}</span>.
            </>
          ) : (
            " in the group."
          )}
        </p>
      )}
      <button
        type="button"
        className="btn btn-primary w-full"
        style={{ minHeight: "var(--tap-min)" }}
        disabled={state === "revealing"}
        onClick={() => (signedIn ? void reveal() : setState("gate"))}
      >
        {state === "revealing" ? "One moment…" : "Show contact"}
      </button>
      {state === "error" && error && (
        <p className="text-(length:--fs-sm)" style={{ color: "var(--danger)" }}>
          {error}{" "}
          <button
            type="button"
            className="underline"
            style={{ color: "var(--accent)" }}
            onClick={() => void reveal()}
          >
            Try again
          </button>
        </p>
      )}
    </section>
  );
}
