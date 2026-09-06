import Link from "next/link";
import type { SessionUser } from "@/lib/auth";
import { ROLE_LABEL, loginHref } from "@/lib/session";
import { LogoutButton } from "./LogoutButton";
import { CurrentLocation } from "./CurrentLocation";

export interface AppShellProps {
  /** Null for the anonymous visitor: the board is public and so is this shell. */
  user: SessionUser | null;
  active: "board" | "post" | "admin" | "test";
  /**
   * Path + query of the page rendering the shell, for `loginHref(next)`.
   * Every page passes it ("/" + query, "/jobs/:id" + query, "/post", "/admin",
   * "/admin/test"). AppShell never reads request headers for it: `x-invoke-path`
   * is not a documented Next.js header, and a guessed value would silently
   * degrade the return-to-job flow to landing on "/" with the drawer closed.
   */
  currentPath?: string;
  children: React.ReactNode;
}

export function AppShell({ user, active, currentPath, children }: AppShellProps) {
  const isAdmin = user?.role === "admin";
  const nav: Array<{ key: AppShellProps["active"]; href: string; label: string; show: boolean }> = [
    { key: "board", href: "/", label: "Board", show: true },
    // Always shown: an anonymous or driver click lands on /login?next=/post or
    // the poster-only notice, which is how someone learns what posting needs.
    { key: "post", href: "/post", label: "Post a job", show: true },
    { key: "admin", href: "/admin", label: "Admin", show: isAdmin },
    { key: "test", href: "/admin/test", label: "WhatsApp console", show: isAdmin },
  ];

  return (
    <div>
      <header
        className="bg-surface sticky top-0 z-30 border-b border-border"
        style={{ height: "var(--header-h)" }}
      >
        <div className="mx-auto flex h-full max-w-[1600px] items-center gap-[var(--sp-5)] px-[var(--sp-4)]">
          <Link href="/" className="flex items-center gap-2 font-bold tracking-tight">
            <span
              className="grid h-6 w-6 place-items-center rounded-md text-[var(--fs-base)] text-white"
              style={{ background: "var(--accent)" }}
            >
              L
            </span>
            LoadLine
          </Link>

          <nav className="flex items-center gap-1">
            {nav
              .filter((n) => n.show)
              .map((n) => (
                <Link
                  key={n.key}
                  href={n.href}
                  className="rounded-md px-3 py-1.5 text-[var(--fs-base)] font-semibold"
                  style={
                    active === n.key
                      ? { background: "var(--accent-soft)", color: "var(--accent)" }
                      : { color: "var(--text-2)" }
                  }
                >
                  {n.label}
                </Link>
              ))}
          </nav>

          <div className="ml-auto flex items-center gap-[var(--sp-3)]">
            {/* TODO(B, §4.2): CurrentLocation becomes propless and reads
                @/lib/location; drop these two props when it is rewritten. */}
            <CurrentLocation label={null} role={user?.role ?? "driver"} />

            {user ? (
              <>
                <div className="text-right leading-tight">
                  <div className="text-[var(--fs-base)] font-semibold">{user.name}</div>
                  <div className="text-[var(--fs-xs)]" style={{ color: "var(--muted)" }}>
                    {ROLE_LABEL[user.role]}
                  </div>
                </div>
                <LogoutButton />
              </>
            ) : (
              <Link
                className="btn"
                href={loginHref(currentPath ?? "/")}
                title="Sign in to see contacts — browsing needs no account"
              >
                Sign in · contacts
              </Link>
            )}
          </div>
        </div>
      </header>
      {children}
    </div>
  );
}
