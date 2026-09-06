import Link from "next/link";
import type { SessionUser } from "@/lib/auth";
import { ROLE_LABEL, loginHref } from "@/lib/session";
import { LogoutButton } from "./LogoutButton";
import { CurrentLocation } from "./CurrentLocation";
import { Footer, FooterBar, SITE_SECTIONS } from "./Footer";

export interface AppShellProps {
  /** Null for the anonymous visitor: the board is public and so is this shell. */
  user: SessionUser | null;
  /**
   * Which nav item is lit. `site` is the six content pages (/about,
   * /how-it-works, /contact, /privacy, /terms, /cookies): they light the More
   * menu instead of a nav item, because none of them is the board.
   */
  active: "board" | "post" | "admin" | "test" | "site";
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
  /**
   * The board and the WhatsApp console are exactly one viewport tall and own
   * their own scrolling, so they get the one-line bar; everything else scrolls
   * and gets the real footer at the end of it.
   */
  const appScreen = active === "board" || active === "test";
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
    <div className={appScreen ? undefined : "flex min-h-screen flex-col"}>
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

          {/* An admin carries four items plus the More menu; on a 375 px screen
              they cannot all fit beside the location pill, so the nav is the
              part that scrolls rather than the page. The one thing in here that
              opens is the More menu, and its panel is fixed below `sm` so this
              scroller cannot clip it. */}
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

            {/* The rest of the site, in a menu rather than four more nav items:
                the board has to stay first, and a phone header has no room.

                <details> and not a client popover on purpose -- this is the only
                interactive thing in an otherwise server-rendered shell, and a
                disclosure widget needs no JavaScript to open, close, take focus
                or answer the keyboard. `key` remounts it per route so a tapped
                link leaves the menu closed behind it.

                The panel is `fixed` below `sm` because the nav it sits in
                becomes a horizontal scroller on a phone, and an absolutely
                positioned child of a scroller is clipped by it; a fixed one is
                positioned against the viewport and escapes. */}
            <details key={currentPath ?? "/"} className="shrink-0 sm:relative">
              <summary
                className="flex cursor-pointer list-none items-center gap-1 whitespace-nowrap rounded-md px-2 py-1.5 text-[var(--fs-base)] font-semibold md:px-3 [&::-webkit-details-marker]:hidden"
                style={
                  active === "site"
                    ? { background: "var(--accent-soft)", color: "var(--accent)" }
                    : { color: "var(--text-2)" }
                }
                title="About, how it works, contact and legal"
              >
                More
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                  <path
                    d="M1.5 3.5 5 7l3.5-3.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </summary>
              <div className="popover fixed inset-x-[var(--sp-2)] top-[var(--header-h)] z-50 grid grid-cols-2 gap-[var(--sp-3)] sm:absolute sm:inset-x-auto sm:left-0 sm:top-full sm:mt-1 sm:w-[380px] sm:grid-cols-3">
                {SITE_SECTIONS.map((section) => (
                  <div key={section.heading}>
                    <div className="label">{section.heading}</div>
                    {section.links.map((link) => (
                      <Link
                        key={link.href}
                        href={link.href}
                        className="-mx-1 flex min-h-[40px] items-center rounded-sm px-1 text-[var(--fs-base)] font-medium"
                        style={{ color: "var(--text-2)" }}
                      >
                        {link.label}
                      </Link>
                    ))}
                  </div>
                ))}
              </div>
            </details>
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
      {/* An app screen sets its own height and must not be wrapped in a flex
          item that could shrink it; a content page is pushed down so a short
          page still has its footer at the bottom of the window. */}
      {appScreen ? children : <div className="flex-1">{children}</div>}
      {appScreen ? <FooterBar /> : <Footer />}
    </div>
  );
}
