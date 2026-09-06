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
  // Rendered by the nav from `md` up, and by the More menu below it.
  //
  // `short` is only ever used for an admin, and only below `xl`: four nav items
  // plus a name, a role and a Sign out button need 1012 px, which does not fit
  // a 1024 px window once the scrollbar has taken its 15 -- and "WhatsApp
  // console" is 120 px of the reason. Nobody else carries enough items to need
  // it, so nobody else is shown an abbreviation.
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
        {/* What a narrow header drops, in order: the word mark, the account name
            and the role label -- the parts nobody taps -- and then the nav,
            which the More menu picks up. What it never drops: the board (the
            logo links to it), the location control, and the way in.

            The roomier gap and padding wait for `lg`, not `md`. They are worth
            40 px across this row, and at 768 -- the width at which the nav comes
            back -- that 40 px is the difference between a header that fits and a
            page that scrolls sideways. */}
        <div className="mx-auto flex h-full max-w-[1600px] items-center gap-[var(--sp-2)] px-[var(--sp-2)] lg:gap-[var(--sp-5)] lg:px-[var(--sp-4)]">
          <Link href="/" className="flex shrink-0 items-center gap-2 font-bold tracking-tight">
            <span
              className="grid h-6 w-6 place-items-center rounded-md text-[var(--fs-base)] text-white"
              style={{ background: "var(--accent)" }}
            >
              L
            </span>
            <span className="hidden sm:inline">LoadLine</span>
          </Link>

          {/* Hidden below `md`, and this is a change of mind that measurements
              forced. The nav used to be a horizontal scroller on a phone. But
              the nav is `flex-1` with a zero basis, so its width is whatever the
              pinned group on the right leaves over -- at 390 px that group (menu
              + location pill + "Sign in · contacts") is 306 px, leaving 28 px,
              which renders the word "Board" as "Bo" under a scrollbar nobody can
              see. And from `sm` up the nav does not scroll at all, so at 640 and
              768 the whole header row simply overflowed the page instead.

              Folding the nav into the More menu below `md` costs one tap and
              buys a header that is not broken at any width a visitor is likely
              to have. The board stays first: the word mark links to it, and it
              is the first item in the menu. Nothing here opens a popover, which
              is why the More menu is NOT in this row. */}
          <nav
            className={
              // An admin carries four items instead of two, which is 230 px
              // more than a 768 px window has to spare, so their nav waits for
              // `lg`. Two literal strings rather than a computed class name:
              // Tailwind only emits what it can see in the source.
              isAdmin
                ? "hidden min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden lg:flex lg:flex-none lg:shrink-0 lg:overflow-x-visible"
                : "hidden min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:flex md:flex-none md:shrink-0 md:overflow-x-visible"
            }
          >
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
                  {isAdmin && n.short ? (
                    <>
                      <span className="xl:hidden">{n.short}</span>
                      <span className="hidden xl:inline">{n.label}</span>
                    </>
                  ) : (
                    n.label
                  )}
                </Link>
              ))}
          </nav>

          <div className="ml-auto flex shrink-0 items-center gap-[var(--sp-2)] lg:gap-[var(--sp-3)]">
            {/* The rest of the site, in a menu rather than six more nav items:
                the board has to stay first, and a phone header has no room.

                It sits in this pinned group and not at the end of the nav for a
                concrete reason: on a phone the nav is a horizontal scroller, so
                a menu inside it scrolls out of sight -- and on the board, where
                the bottom sheet hides the footer, this menu is the ONLY way to
                reach /about or /privacy. It has to be on screen at all times.

                <details> and not a client popover on purpose: this is the one
                interactive thing in an otherwise server-rendered shell, and a
                disclosure widget needs no JavaScript to open, close, take focus
                or answer the keyboard. `key` remounts it per route, so a tapped
                link leaves the menu closed behind it. */}
            <details key={currentPath ?? "/"} className="relative shrink-0">
              <summary
                className="flex h-[var(--tap-min)] cursor-pointer list-none items-center justify-center gap-1 whitespace-nowrap rounded-md px-3 text-[var(--fs-base)] font-semibold md:h-[var(--control-h)] md:px-2 [&::-webkit-details-marker]:hidden"
                style={
                  active === "site"
                    ? { background: "var(--accent-soft)", color: "var(--accent)" }
                    : { color: "var(--text-2)" }
                }
                title="About, how it works, contact and legal"
                aria-label="More pages"
              >
                <span className="hidden md:inline">More</span>
                {/* Three dots wherever the nav is folded in here, because the
                    word does not fit beside the location pill and the sign-in
                    button; the word from `md`, beside a visible nav. */}
                <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                  <g className="md:hidden" fill="currentColor">
                    <circle cx="3" cy="7" r="1.4" />
                    <circle cx="7" cy="7" r="1.4" />
                    <circle cx="11" cy="7" r="1.4" />
                  </g>
                  <path
                    className="hidden md:inline"
                    d="M3.5 5.5 7 9l3.5-3.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </summary>
              {/* Full width under the header on a phone, a panel under the
                  trigger from `sm` up. */}
              <div className="popover fixed inset-x-[var(--sp-2)] top-[var(--header-h)] z-50 grid grid-cols-2 gap-[var(--sp-3)] sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-1 sm:w-[380px] sm:grid-cols-3">
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

                {/* An admin's nav is hidden below `lg`, so the two admin screens
                    would otherwise be unreachable there. From `lg` the nav has
                    them and this block would only duplicate it. */}
                {isAdmin ? (
                  <div className="lg:hidden">
                    <div className="label">Admin</div>
                    {nav
                      .filter((n) => n.show && (n.key === "admin" || n.key === "test"))
                      .map((n) => (
                        <Link
                          key={n.key}
                          href={n.href}
                          className="-mx-1 flex min-h-[40px] items-center rounded-sm px-1 text-[var(--fs-base)] font-medium"
                          style={{ color: "var(--text-2)" }}
                        >
                          {n.label}
                        </Link>
                      ))}
                  </div>
                ) : null}
              </div>
            </details>

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
      {appScreen ? (
        // Hidden on a phone, and that is a decision rather than an omission:
        // the board's bottom sheet is fixed to the bottom of the viewport and
        // would cover this strip. The More menu carries the same links there.
        <div className="hidden md:block">
          <FooterBar />
        </div>
      ) : (
        <Footer />
      )}
    </div>
  );
}
