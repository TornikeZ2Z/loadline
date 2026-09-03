"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/basePath";

export function AuthForm({ mode }: { mode: "login" | "register" }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isLogin = mode === "login";

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const data = Object.fromEntries(new FormData(event.currentTarget));
    const res = await fetch(api(`/api/auth/${mode}`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    });

    if (!res.ok) {
      setError(((await res.json()) as { error?: string }).error ?? "Something went wrong");
      setBusy(false);
      return;
    }
    router.replace("/");
    router.refresh();
  }

  return (
    <div className="grid min-h-screen place-items-center p-6">
      <div className="w-full max-w-[420px]">
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

        <form onSubmit={submit} className="card space-y-3 p-5">
          {!isLogin && (
            <div>
              <label className="label">Your name</label>
              <input name="name" className="field" required placeholder="Dan Carrier" />
            </div>
          )}

          <div>
            <label className="label">Email</label>
            <input name="email" type="email" className="field" required placeholder="you@company.com" />
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
                  Used for &ldquo;loads near me&rdquo; so the board is useful the moment you sign in.
                </p>
              </div>
              <div>
                <label className="label">Phone (optional)</label>
                <input name="phone" className="field" placeholder="(973) 555-1234" />
              </div>
            </>
          )}

          {error && (
            <p className="rounded-md px-3 py-2 text-[13px]" style={{ background: "var(--danger-soft)", color: "var(--danger)" }}>
              {error}
            </p>
          )}

          <button className="btn btn-primary w-full" disabled={busy}>
            {busy ? "One moment…" : isLogin ? "Sign in" : "Create account"}
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

        {isLogin && (
          <div className="card mt-4 p-3 text-[12px]" style={{ background: "var(--surface-2)" }}>
            <div className="mb-1 font-semibold">Demo accounts (password demo1234)</div>
            <ul className="space-y-0.5 text-muted">
              <li>carrier@example.com — searches loads</li>
              <li>broker@example.com — posts and manages loads</li>
              <li>admin@example.com — pipeline and data quality</li>
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
