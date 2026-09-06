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
  // `short` is what a phone header has room for. Only the two admin items need
  // one, and only because an admin carries four nav items beside the location
  // pill; nobody else sees them.
  const nav: Array<{
    key: AppShellProps["active"];
    href: string;
    label: string;
    short?: string;
    show: boolean;
  }> = [
    { key: "board", href: "/", label: "Board", show: true },
    // Always shown: an anonymous or driver click lands on /login?next=/post or
    // the poster-only notice, which is how someone learns what posting needs.
    { key: "post", href: "/post", label: "Post a job", short: "Post", show: true },
    { key: "admin", href: "/admin", label: "Admin", show: isAdmin },
    { key: "test", href: "/admin/test", label: "WhatsApp console", short: "Console", show: isAdmin },
  ];

  return (
    <div>
      <header
        className="bg-surface sticky top-0 z-30 border-b border-border"
        style={{ height: "var(--header-h)" }}
      >
        {/* Everything stays reachable on a phone rather than folding into a
            hamburger: the word mark, the name and the role label are what get
            dropped, because they are the only parts nobody taps. */}
        <div className="mx-auto flex h-full max-w-[1600px] items-center gap-[var(--sp-2)] px-[var(--sp-2)] md:gap-[var(--sp-5)] md:px-[var(--sp-4)]">
          <Link href="/" className="flex shrink-0 items-center gap-2 font-bold tracking-tight">
            <span
              className="grid h-6 w-6 place-items-center rounded-md text-[var(--fs-base)] text-white"
              style={{ background: "var(--accent)" }}
            >
              L
            </span>
            <span className="hidden sm:inline">LoadLine</span>
          </Link>

          {/* An admin carries four items; on a 375 px screen they cannot all
              fit beside the location pill, so the nav is the part that scrolls
              rather than the page. Nothing in here opens a popover, so clipping
              it is safe -- unlike the location control beside it. */}
          <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:flex-none sm:shrink-0 sm:overflow-x-visible">
            {nav
              .filter((n) => n.show)
              .map((n) => (
                <Link
                  key={n.key}
                  href={n.href}
                  className="whitespace-nowrap rounded-md px-2 py-1.5 text-[var(--fs-base)] font-semibold md:px-3"
                  style={
                    active === n.key
                      ? { background: "var(--accent-soft)", color: "var(--accent)" }
                      : { color: "var(--text-2)" }
                  }
                >
                  {n.short ? (
                    <>
                      <span className="sm:hidden">{n.short}</span>
                      <span className="hidden sm:inline">{n.label}</span>
                    </>
                  ) : (
                    n.label
                  )}
                </Link>
              ))}
          </nav>

          <div className="ml-auto flex shrink-0 items-center gap-[var(--sp-2)] md:gap-[var(--sp-3)]">
            {/* Propless by design: the location lives in localStorage, not on
                the user row, so it is the same control signed in or out. */}
            <CurrentLocation />

            {user ? (
              <>
                <div className="hidden text-right leading-tight sm:block">
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
