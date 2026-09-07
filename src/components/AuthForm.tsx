"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/basePath";
import { isSafeNext, loginHref, registerHref, type Role } from "@/lib/session";
import { Logo } from "./Logo";

export interface DemoOption {
  key: Role;
  name: string;
  role: Role;
  blurb: string;
}

/**
 * Sign-in and registration.
 *
 * This page is not the front door -- the board is, and it needs no account.
 * That is the first thing the copy says, because someone who arrives here from
 * a bookmark should not conclude the product is behind a login. When demo
 * accounts are offered they lead: a demo should not open with a password prompt
 * and a credential to copy. The real form stays underneath for anyone who wants
 * it, and is all that renders once `DEMO_MODE=off`.
 */
export function AuthForm({
  mode,
  next,
  as,
  demoAccounts = [],
}: {
  mode: "login" | "register";
  /** Where to land afterwards; anything not a same-origin app path is ignored. */
  next?: string | null;
  /** Which kind of account the person came here for. */
  as?: "driver" | "poster";
  demoAccounts?: DemoOption[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(demoAccounts.length === 0);
  const [role, setRole] = useState<"driver" | "poster">(as ?? "driver");
  const isLogin = mode === "login";

  function done() {
    router.replace(isSafeNext(next) ? next : "/");
    router.refresh();
  }

  async function enterAsDemo(key: string) {
    setBusy(key);
    setError(null);
    const res = await fetch(api("/api/auth/demo"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: key }),
    });
    if (!res.ok) {
      setError(((await res.json()) as { error?: string }).error ?? "Could not start the demo");
      setBusy(null);
      return;
    }
    done();
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("form");
    setError(null);

    const data = Object.fromEntries(new FormData(event.currentTarget));
    const res = await fetch(api(`/api/auth/${mode}`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    });

    if (!res.ok) {
      setError(((await res.json()) as { error?: string }).error ?? "Something went wrong");
      setBusy(null);
      return;
    }
    done();
  }

  return (
    /* No `min-h-screen`: these two screens render inside AppShell like every
       other page, so the header above already carries the way back to the
       board. The <h1> says what the PAGE is -- an <h1> reading "MoverMesh" on
       the sign-in screen would tell a visitor nothing they cannot see in the
       tab.

       The LOCKUP above it is a different thing from that heading and earns its
       place: this is the one screen someone can land on from a bookmark with no
       idea what the site is, and the tagline under the wordmark answers it in
       five words. It is not a heading, it is not a link, and it does not repeat
       the h1. */
    <div className="grid place-items-center px-[var(--sp-4)] py-[var(--sp-8)]">
      <div className="w-full max-w-[440px]">
        <div className="mb-[var(--sp-5)] text-center">
          <Logo size={40} tagline className="mb-[var(--sp-5)]" />
          <h1 className="big text-(length:--fs-2xl)">
            {isLogin ? "Sign in" : "Create your account"}
          </h1>
          <p className="mt-[var(--sp-1)] text-(length:--fs-md) text-muted">
            {isLogin
              ? "Only to see a sender's contact or post a job. Browsing the board needs no account."
              : "One account, two things it unlocks: contacts on the board, and posting your own jobs."}
          </p>
        </div>

        {demoAccounts.length > 0 && (
          <div className="card p-5">
            <div className="mb-1 text-(length:--fs-lg) font-bold">Try the demo</div>
            {/* This sentence used to end "...or run the admin console", which
                was true when a third button opened one. The console is not a
                demo any more -- it is password-only -- so the copy has to stop
                promising it, and has to say where the door went instead. */}
            <p className="mb-3 text-(length:--fs-sm) text-muted">
              Browsing the board needs no account. These two see a sender&rsquo;s contact and post
              jobs. The admin console is not part of the demo — it needs a real password, through
              the form below.
            </p>

            <div className="space-y-2">
              {demoAccounts.map((a) => (
                <button
                  key={a.key}
                  onClick={() => enterAsDemo(a.key)}
                  disabled={busy !== null}
                  className="option-row flex w-full items-center gap-3 rounded-[var(--radius-md)] border p-[var(--sp-3)] text-left disabled:opacity-60"
                >
                  <span
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-(length:--fs-base) font-bold"
                    style={{ background: "var(--accent-soft)", color: "var(--accent-deep)" }}
                  >
                    {a.name.charAt(0)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-(length:--fs-base) font-semibold">
                      Sign in as demo {a.key}
                    </span>
                    <span className="block text-(length:--fs-sm) text-muted">{a.blurb}</span>
                  </span>
                  <span className="text-(length:--fs-base) font-semibold" style={{ color: "var(--accent)" }}>
                    {busy === a.key ? "…" : "→"}
                  </span>
                </button>
              ))}
            </div>

            {error && (
              <p
                className="mt-3 rounded-md px-3 py-2 text-(length:--fs-base)"
                style={{ background: "var(--danger-soft)", color: "var(--danger)" }}
              >
                {error}
              </p>
            )}

            {!showForm && (
              /* A real button rather than an underlined line of 12 px text: it
                 is the alternative to every demo account above it, and it was
                 a 17 px tall target. */
              <button
                className="btn btn-ghost mt-3 w-full"
                onClick={() => setShowForm(true)}
              >
                or sign in with an email and password
              </button>
            )}
          </div>
        )}

        {showForm && (
          <form
            onSubmit={submit}
            className={`card space-y-3 p-5 ${demoAccounts.length ? "mt-3" : ""}`}
          >
            {/* The two words are not a choice about what you may DO.
                `Role` is "which door you came in through" and posting is
                `users.can_post`, a capability every account has -- but this
                control read as an exclusive pair ("See contacts on jobs" OR
                "Post jobs from the website"), and a driver who picked the first
                had every reason to think they could not post.

                That was survivable while the only thing to post was somebody
                else's freight. It stopped being survivable the day a driver
                could post their own empty leg: the person this feature exists
                for is exactly the person the old wording turned away. SPEC §20
                flagged this copy as deferred and load-bearing here. */}
            {!isLogin && (
              <div>
                <label className="label">Mostly here to</label>
                <div className="grid grid-cols-2 gap-2">
                  {(
                    [
                      { value: "driver", title: "Find work for my truck" },
                      { value: "poster", title: "Post freight I need moved" },
                    ] as const
                  ).map((opt) => (
                    <label
                      key={opt.value}
                      className="cursor-pointer rounded-lg border p-3 text-(length:--fs-sm)"
                      style={
                        role === opt.value
                          ? { borderColor: "var(--accent)", background: "var(--accent-soft)" }
                          : { borderColor: "var(--border-strong)" }
                      }
                    >
                      <input
                        type="radio"
                        name="role"
                        value={opt.value}
                        checked={role === opt.value}
                        onChange={() => setRole(opt.value)}
                        className="sr-only"
                      />
                      {opt.title}
                    </label>
                  ))}
                </div>
                <p className="mt-2 text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
                  This only sets what we show you first. Either account can browse the board, see
                  contacts, post a job, and post space on a truck.
                </p>
              </div>
            )}

            {!isLogin && (
              <div>
                <label className="label">Your name</label>
                <input name="name" className="field" required placeholder="Dan Driver" />
              </div>
            )}

            <div>
              <label className="label">Email</label>
              <input
                name="email"
                type="email"
                className="field"
                required
                placeholder="you@company.com"
              />
            </div>

            <div>
              <label className="label">Password</label>
              <input
                name="password"
                type="password"
                className="field"
                required
                minLength={isLogin ? 1 : 8}
                placeholder={isLogin ? "" : "At least 8 characters"}
              />
            </div>

            {!isLogin && (
              <>
                <div>
                  <label className="label">Phone (optional)</label>
                  {/* Not a phone-shaped placeholder. This codebase treats any
                      stray run of phone digits in the DOM as a leak signal
                      (scripts/check-redact.ts), and a fake number in a
                      placeholder is exactly the string that check exists to
                      catch -- a false positive there costs someone an hour. */}
                  <input
                    name="phone"
                    type="tel"
                    className="field"
                    placeholder="So a sender can call you back"
                  />
                </div>
                <div>
                  <label className="label">Company (optional)</label>
                  <input name="company" className="field" placeholder="Kaz Moving LLC" />
                </div>
              </>
            )}

            {error && demoAccounts.length === 0 && (
              <p
                className="rounded-md px-3 py-2 text-(length:--fs-base)"
                style={{ background: "var(--danger-soft)", color: "var(--danger)" }}
              >
                {error}
              </p>
            )}

            <button className="btn btn-primary w-full" disabled={busy !== null}>
              {busy === "form" ? "One moment…" : isLogin ? "Sign in" : "Create account"}
            </button>

            <p className="text-center text-(length:--fs-base) text-muted">
              {isLogin ? (
                <>
                  No account yet?{" "}
                  <Link
                    href={registerHref("driver", next)}
                    className="font-semibold"
                    style={{ color: "var(--accent)" }}
                  >
                    Create one
                  </Link>
                </>
              ) : (
                <>
                  Already registered?{" "}
                  <Link
                    href={loginHref(next)}
                    className="font-semibold"
                    style={{ color: "var(--accent)" }}
                  >
                    Sign in
                  </Link>
                </>
              )}
            </p>
          </form>
        )}

        {/* The link is its own line and its own 44 px row: it is the way out of
            this page, and inside the sentence it was a 15 px tall target. */}
        <p className="mt-[var(--sp-3)] flex flex-col items-center text-(length:--fs-sm) text-muted">
          <Link
            href="/"
            className="flex min-h-[var(--tap-min)] items-center px-[var(--sp-2)] font-semibold"
            /* --accent-deep, not --accent: this link sits on --bg rather than
               on a white card, where the brand blue measures 4.23:1 at the
               12 px it is set in. Every other accent-coloured link in the app
               is on --surface, where it measures 4.57. */
            style={{ color: "var(--accent-deep)" }}
          >
            ← Back to the board
          </Link>
          <span>Browsing never needs an account.</span>
        </p>
      </div>
    </div>
  );
}
