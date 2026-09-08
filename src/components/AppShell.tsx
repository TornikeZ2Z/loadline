import Link from "next/link";
import type { SessionUser } from "@/lib/auth";
import { ROLE_LABEL, loginHref } from "@/lib/session";
import { LogoutButton } from "./LogoutButton";
import { CurrentLocation } from "./CurrentLocation";
import { MenuAutoClose } from "./MenuAutoClose";
import { LogoMark, Wordmark } from "./Logo";
import { NotificationBell } from "./NotificationBell";
import { Footer, FooterBar, SITE_SECTIONS } from "./Footer";

export interface AppShellProps {
  /** Null for the anonymous visitor: the board is public and so is this shell. */
  user: SessionUser | null;
  /**
   * Which nav item is lit. `site` is the six content pages (/about,
   * /how-it-works, /contact, /privacy, /terms, /cookies): they light the More
   * menu instead of a nav item, because none of them is the board.
   *
   * `auth` is /login and /register. Nothing is lit -- neither page is a
   * destination, both are a door someone is already standing in -- and the
   * "Sign in · contacts" button is dropped, because a button that links to
   * the page it is drawn on is furniture, not a way in.
   */
  active: "board" | "post" | "admin" | "test" | "site" | "auth" | "account";
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
  /**
   * The board is exactly one viewport at every width: its bottom sheet is
   * fixed, and a page that scrolled behind it would carry the filter bar off
   * the top. The WhatsApp console is one viewport only where its three panes
   * fit side by side -- below `lg` they stack, and it scrolls like any page.
   */
  const shellClass =
    active === "board"
      ? "flex h-screen flex-col"
      : active === "test"
        ? "flex min-h-screen flex-col lg:h-screen"
        : "flex min-h-screen flex-col";
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
    //
    // "Post a job" until the board had one kind of listing. `/post` is a chooser
    // now -- freight, or space on a truck -- and naming one of the two in the
    // nav would have told a driver the other was not on offer.
    //
    // "Post a listing" and not "Post" (V03): a bare verb in a row of nouns reads
    // as a state -- the tab you are on -- rather than as the thing it does. The
    // short form is what a narrow window gets, and every account gets it now
    // rather than only an admin: the abbreviation exists because the header runs
    // out of room, and the header runs out of room for everyone.
    { key: "post", href: "/post", label: "Post a listing", short: "Post", show: true },
    { key: "admin", href: "/admin", label: "Admin", show: isAdmin },
    { key: "test", href: "/admin/test", label: "WhatsApp console", short: "Console", show: isAdmin },
  ];

  return (
    /* An app screen is exactly one viewport tall, and until now it was one
       viewport PLUS the footer bar: the board measured 934 px in a 900 px
       window, so opening a job scrolled the whole page and took the filter
       bar off the top with it. The height lives here now rather than in each
       screen -- header, body, bar, adding up to 100vh by construction, so no
       screen has to subtract the chrome above it by hand. */
    <div className={shellClass}>
      <MenuAutoClose />
      {/* z-40, not z-30, and this is a real bug rather than a tidy-up.
          `sticky` + a z-index makes this header its own stacking context, so
          the More menu's z-50 is capped at the header's own layer -- and at
          z-30 that tied with the board's bottom sheet (BottomSheet.tsx:156),
          which comes later in the document and therefore painted OVER the open
          menu. On a 390 px board the panel reaches y=450 and the sheet's peek
          starts around y=375, so the bottom of the menu was covered by the job
          list. z-40 is the layer the cookie notice already uses to clear that
          same sheet (CookieNotice.tsx:67); the filter popovers stay at z-50 in
          the root context, so they still win over the header, as before. */}
      <header
        className="bg-surface sticky top-0 z-40 shrink-0 border-b border-border"
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
          {/* Below `sm` the wordmark is hidden and this is a 24 px badge --
              the board's only permanent way home, at a 24 x 24 target. The
              padding grows it to 44 x 44 without moving the badge: the left
              inset is pulled back by exactly the header's own 8 px padding, so
              the mark still starts where it did, and the remaining 12 px is
              taken on the right, where there is nothing to collide with. */}
          <Link
            href="/"
            aria-label="MoverMesh"
            className="-ml-[var(--sp-2)] flex h-[var(--tap-min)] shrink-0 items-center gap-2 rounded-md pl-[var(--sp-2)] pr-[var(--sp-3)] sm:ml-0 sm:px-0"
          >
            <LogoMark size={24} />
            {/* At the body size the wordmark read as another nav item. One
                step up is enough to make it the mark; two would start
                crowding the pinned group at 640-767 px, where the header is
                already tight.

                aria-label on the link above rather than a <title> in the mark:
                below `sm` this word is not rendered at all, and the board's
                only permanent way home cannot be a link with no name. */}
            <Wordmark className="hidden text-(length:--fs-md) sm:inline" />
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
          {/* From `lg`, for everyone. An admin's four items never fitted a
              768 px window, so their nav already waited for `lg`; the type
              scale put everybody else in the same position -- measured, the row
              ran 22 px past a 768 px window with the nav in it, and a header
              that scrolls the page sideways is worse than a nav one tap away.
              Nothing is lost between 768 and 1023: SITE_SECTIONS opens with
              "Board" and "Post to the board", so the More menu below `lg`
              already carries both of these links. */}
          <nav className="hidden min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden lg:flex lg:flex-none lg:shrink-0 lg:overflow-x-visible">
            {nav
              .filter((n) => n.show)
              .map((n) => (
                <Link
                  key={n.key}
                  href={n.href}
                  className="whitespace-nowrap rounded-md px-2 py-1.5 text-(length:--fs-base) font-semibold md:px-3"
                  style={
                    active === n.key
                      ? { background: "var(--accent-soft)", color: "var(--accent-deep)" }
                      : { color: "var(--text-2)" }
                  }
                >
                  {n.short ? (
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
            {/* L06 / V12 — the demo label, and it is in the header row rather
                than in the account menu because "persistent" is the whole
                requirement. The review signed in as the demo driver, saw a
                named account in this header with nothing to mark it, and only
                found out what the account was two pages later, at the bottom of
                a posting form. By then the visitor has decided what this site
                is.

                It is here, at every width, and not next to the name: the name
                only appears from `lg` (V03), so hanging the mark off it would
                hide the mark on exactly the screen where the review found the
                problem. `.chip .chip-warn` are the board's own classes, so this
                is the same yellow the row itself wears on a demo listing
                (LoadDetail, TruckDetail, TruckViews) -- one mark, one meaning.

                A word and not a dot: review 01 is explicit that an icon or a
                coloured dot is not enough for a consequential state. The full
                sentence is in the account menu below, where there is room for
                it, and in the `title` here. */}
            {user?.isDemo ? (
              <span
                className="chip chip-warn shrink-0"
                title="You are signed in to a shared demo account. Browsing and contact reveals work normally; anything you post is visible to this account only, and never to other movers."
              >
                Demo
              </span>
            ) : null}

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
                link leaves the menu closed behind it. The one thing the element
                will not do by itself is close on a click somewhere else, which
                <MenuAutoClose> adds as an enhancement -- see that file. */}
            <details key={currentPath ?? "/"} data-menu className="relative shrink-0">
              <summary
                className="tap flex h-[var(--tap-min)] min-w-[var(--tap-min)] cursor-pointer list-none items-center justify-center gap-1 whitespace-nowrap rounded-md px-3 text-(length:--fs-base) font-semibold md:h-[var(--control-h)] md:min-w-0 md:px-2 [&::-webkit-details-marker]:hidden"
                style={
                  active === "site"
                    ? { background: "var(--accent-soft)", color: "var(--accent-deep)" }
                    : { color: "var(--text-2)" }
                }
                title={
                  user
                    ? "Your account, about, how it works, contact and legal"
                    : "About, how it works, contact and legal"
                }
                /* The menu holds the account now (V03: Sign out moved in here),
                   so the name it announces has to say so. */
                aria-label={user ? "Account and more pages" : "More pages"}
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
              {/* Capped at the space between the header and the bottom of the
                  window, and scrollable inside that. Ten links in two columns
                  is 394 px, which fits a phone held upright and does not fit
                  one lying down (390 px tall, where the footer bar is already
                  hidden for the same reason). A menu that runs off the screen
                  with no way to reach the last item is worse than one that
                  scrolls. `dvh` so the browser's own retracting toolbar counts. */}
              <div className="popover fixed inset-x-[var(--sp-2)] top-[var(--header-h)] z-50 grid max-h-[calc(100dvh-var(--header-h)-var(--sp-3))] grid-cols-2 gap-[var(--sp-3)] overflow-y-auto sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-1 sm:w-[380px] sm:grid-cols-3">
                {/* V03. Sign out used to stand in the header row, next to the
                    truck-location pill -- which on a phone put a destructive,
                    rarely-used action beside the control a driver touches most.
                    It is an account menu item now.

                    FIRST in the grid, and spanning both columns on a phone: it
                    is the only thing in this menu that is about the person
                    rather than about the site, and a visitor who opened the
                    menu to sign out should not have to read past Legal to find
                    it. The name and role come with it, so the button says whose
                    account it is ending. */}
                {user ? (
                  <div className="col-span-2 sm:col-span-3">
                    <div className="label">Account</div>
                    <div className="px-1 pb-[var(--sp-2)]">
                      <div className="flex flex-wrap items-center gap-[var(--sp-2)]">
                        <span className="font-semibold">{user.name}</span>
                        {user.isDemo ? <span className="chip chip-warn">Demo</span> : null}
                      </div>
                      <div className="text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
                        {ROLE_LABEL[user.role]}
                      </div>
                      {/* L06 — the sentence the header chip's `title` carries,
                          spelled out where a touch screen can read it: a title
                          attribute is a hover, and a phone has no hover.

                          It says what to DO about it too, and the instruction is
                          the real flow rather than an invented one: there is no
                          upgrade endpoint, /register redirects anyone who is
                          already signed in, so the honest path out of the demo
                          is the Sign out button directly below this line. */}
                      {user.isDemo ? (
                        <p
                          className="mt-[var(--sp-2)] max-w-[46ch] text-(length:--fs-sm) leading-relaxed"
                          style={{ color: "var(--muted)" }}
                        >
                          A shared demo account. Browsing and contact reveals work normally; anything
                          you post from it is visible to this account only. Sign out and create your
                          own account to post something other movers can see.
                        </p>
                      ) : null}
                    </div>
                    <LogoutButton className="btn w-full" />
                  </div>
                ) : null}

                {SITE_SECTIONS.map((section) => (
                  <div key={section.heading}>
                    <div className="label">{section.heading}</div>
                    {section.links.map((link) => (
                      <Link
                        key={link.href}
                        href={link.href}
                        className="tap -mx-1 flex min-h-[var(--tap-min)] items-center rounded-sm px-1 text-(length:--fs-base) font-medium"
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
                          className="tap -mx-1 flex min-h-[var(--tap-min)] items-center rounded-sm px-1 text-(length:--fs-base) font-medium"
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

            {/* Only for a signed-in account, and inside the component only for
                one that owns a listing (SPEC 2). An anonymous visitor -- most of
                this board's traffic -- has nothing that could ever be notified
                about, so they are not shown a control that will never light up,
                and no query is made on their behalf. */}
            {user ? <NotificationBell userId={user.id} /> : null}

            {/* Who is signed in stays in the row -- it is a fact, not a control,
                and it costs no target. What left is the button (V03): Sign out
                is in the account menu above. From `lg`, because "Post a listing"
                takes the room the abbreviation used to save at `md`. */}
            {user ? (
              <div className="hidden text-right leading-tight lg:block">
                <div className="font-semibold">{user.name}</div>
                <div className="text-(length:--fs-xs)" style={{ color: "var(--muted)" }}>
                  {ROLE_LABEL[user.role]}
                </div>
              </div>
            ) : active === "auth" ? null : (
              <Link
                className="btn"
                href={loginHref(currentPath ?? "/")}
                title="Sign in to see contacts — browsing needs no account"
              >
                {/* "· contacts" is what the button is FOR, and it stays
                    wherever there is room for it. Below 380 px there is not:
                    measured, the header row ran 30 px past a 320 px window
                    before this pass and 39 after, and this phrase is 62 of
                    them. Dropping two words is not the same as truncating the
                    label -- "Sign in" is still the whole action, and the title
                    still carries the rest. */}
                Sign in<span className="max-[379px]:hidden"> · contacts</span>
              </Link>
            )}
          </div>
        </div>
      </header>
      {/* `min-h-0` so the app screen's own scrollers (the board's list column,
          the console's panes) can actually scroll instead of stretching this
          flex item past the window; a content page is pushed down so a short
          page still has its footer at the bottom. */}
      <div className={active === "board" ? "min-h-0 flex-1" : active === "test" ? "flex-1 lg:min-h-0" : "flex-1"}>
        {children}
      </div>
      {appScreen ? (
        // Hidden on a phone, and that is a decision rather than an omission:
        // the board's bottom sheet is fixed to the bottom of the viewport and
        // would cover this strip. The More menu carries the same links there.
        //
        // Hidden on a short screen for a different reason: a phone lying down
        // is 390 px tall, and this bar is 34 of them. The same menu carries the
        // same links, one tap away, at the top of the screen where the thumb
        // already is.
        <div className="hidden shrink-0 md:block [@media(max-height:540px)]:hidden">
          <FooterBar />
        </div>
      ) : (
        <Footer />
      )}
    </div>
  );
}
