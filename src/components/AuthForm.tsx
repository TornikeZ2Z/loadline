"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/basePath";

export interface DemoOption {
  key: string;
  name: string;
  role: string;
  blurb: string;
}

/**
 * Sign-in. When demo accounts are offered, they lead -- a demo should not open
 * with a password prompt and a credential to copy. The real form stays
 * underneath for anyone who wants it, and is all that renders once
 * `DEMO_MODE=off`.
 */
export function AuthForm({
  mode,
  demoAccounts = [],
}: {
  mode: "login" | "register";
  demoAccounts?: DemoOption[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(demoAccounts.length === 0);
  const isLogin = mode === "login";

  async function enterAsDemo(role: string) {
    setBusy(role);
    setError(null);
    const res = await fetch(api("/api/auth/demo"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role }),
    });
    if (!res.ok) {
      setError(((await res.json()) as { error?: string }).error ?? "Could not start the demo");
      setBusy(null);
      return;
    }
    router.replace("/");
    router.refresh();
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
    router.replace("/");
    router.refresh();
  }

  return (
    <div className="grid min-h-screen place-items-center p-6">
      <div className="w-full max-w-[440px]">
        <div className="mb-6 text-center">
          <div
            className="mx-auto mb-3 grid h-11 w-11 place-items-center rounded-xl text-[20px] font-bold text-white"
            style={{ background: "var(--accent)" }}
          >
            L
          </div>
          <h1 className="text-[22px] font-bold tracking-tight">LoadLine</h1>
          <p className="mt-1 text-[13px] text-muted">
            The freight in your WhatsApp groups, searchable by route, radius and date.
          </p>
        </div>

        {demoAccounts.length > 0 && (
          <div className="card p-5">
            <div className="mb-1 text-[15px] font-bold">Try the demo</div>
            <p className="mb-3 text-[12px] text-muted">
              No sign-up. Pick a role and go — every account sees the same sample data.
            </p>

            <div className="space-y-2">
              {demoAccounts.map((a) => (
                <button
                  key={a.key}
                  onClick={() => enterAsDemo(a.key)}
                  disabled={busy !== null}
                  className="flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors disabled:opacity-60"
                  style={{ borderColor: "var(--border-strong)", background: "var(--surface)" }}
                >
                  <span
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-[13px] font-bold"
                    style={{ background: "var(--accent-soft)", color: "var(--accent)" }}
                  >
                    {a.name.charAt(0)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-semibold capitalize">
                      Sign in as {a.role}
                    </span>
                    <span className="block text-[12px] text-muted">{a.blurb}</span>
                  </span>
                  <span className="text-[13px] font-semibold" style={{ color: "var(--accent)" }}>
                    {busy === a.key ? "…" : "→"}
                  </span>
                </button>
              ))}
            </div>

            {error && (
              <p
                className="mt-3 rounded-md px-3 py-2 text-[13px]"
                style={{ background: "var(--danger-soft)", color: "var(--danger)" }}
              >
                {error}
              </p>
            )}

            {!showForm && (
              <button
                className="mt-3 w-full text-center text-[12px] text-muted underline"
                onClick={() => setShowForm(true)}
              >
                or sign in with an email and password
              </button>
            )}
          </div>
        )}

        {showForm && (
          <form onSubmit={submit} className={`card space-y-3 p-5 ${demoAccounts.length ? "mt-3" : ""}`}>
            {!isLogin && (
              <div>
                <label className="label">Your name</label>
                <input name="name" className="field" required placeholder="Dan Carrier" />
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
                  <label className="label">I am a</label>
                  <select name="role" className="field" defaultValue="carrier">
                    <option value="carrier">Carrier / driver — I search for loads</option>
                    <option value="broker">Broker / dispatcher — I post loads</option>
                  </select>
                </div>
                <div>
                  <label className="label">Home base</label>
                  <input name="homeLocation" className="field" placeholder="Newark, NJ" />
                  <p className="mt-1 text-[11px] text-muted">
                    Used for &ldquo;loads near me&rdquo; so the board is useful the moment you sign
                    in.
                  </p>
                </div>
                <div>
                  <label className="label">Phone (optional)</label>
                  <input name="phone" className="field" placeholder="(973) 555-1234" />
                </div>
              </>
            )}

            {error && demoAccounts.length === 0 && (
              <p
                className="rounded-md px-3 py-2 text-[13px]"
                style={{ background: "var(--danger-soft)", color: "var(--danger)" }}
              >
                {error}
              </p>
            )}

            <button className="btn btn-primary w-full" disabled={busy !== null}>
              {busy === "form" ? "One moment…" : isLogin ? "Sign in" : "Create account"}
            </button>

            <p className="text-center text-[13px] text-muted">
              {isLogin ? (
                <>
                  No account yet?{" "}
                  <Link href="/register" className="font-semibold" style={{ color: "var(--accent)" }}>
                    Create one
                  </Link>
                </>
              ) : (
                <>
                  Already registered?{" "}
                  <Link href="/login" className="font-semibold" style={{ color: "var(--accent)" }}>
                    Sign in
                  </Link>
                </>
              )}
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
