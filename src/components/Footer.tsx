import Link from "next/link";
import { REPORT_PROBLEM_HREF } from "@/lib/support";
import { readSiteSettings, settingText } from "@/lib/settings";
import { Logo } from "./Logo";

/**
 * The site footer, and the link map the header menu shares with it.
 *
 * Two shapes, because the app has two kinds of page:
 *
 *   <Footer />     the ordinary one, at the end of a page that scrolls;
 *   <FooterBar />  a single line, for the screens that are exactly one viewport
 *                  tall (the board, the WhatsApp console). A full footer under
 *                  a 100vh map would either eat the map or push it off-screen.
 *
 * Every colour, size and gap here is a token from globals.css -- nothing in
 * this file invents a value.
 */

export interface SiteLink {
  href: string;
  label: string;
}

export interface SiteSection {
  heading: string;
  links: SiteLink[];
}

/**
 * One list, used by the footer columns and by the header's More menu, so the
 * two can never drift apart. Product first: the board is the product.
 */
export const SITE_SECTIONS: SiteSection[] = [
  {
    heading: "Product",
    links: [
      { href: "/", label: "Board" },
      // L05. Truck space had no way in from anywhere on the site except the
      // /post chooser -- which is the POSTING side of it. A driver who wanted
      // to LOOK at available space had to know that `?show=trucks` exists
      // (Board.tsx: "reachable only from a URL"). The board itself is still
      // both kinds by default; this is the filtered view, named.
      { href: "/?show=trucks", label: "Find truck space" },
      { href: "/for-movers", label: "For movers" },
      { href: "/how-it-works", label: "How it works" },
      // The nav calls it "Post a listing" (V03) and so does this, because they
      // are the same destination and a reader should not have to work that out.
      { href: "/post", label: "Post a listing" },
    ],
  },
  {
    heading: "Company",
    links: [
      { href: "/about", label: "About" },
      { href: "/contact", label: "Contact" },
      // Named as the thing a person is trying to do, not as the page it lands
      // on: somebody who has just found a job that does not match its post is
      // looking for "report", not for "contact". It is the same page, and this
      // is the only route to a human that is worded like the problem.
      { href: REPORT_PROBLEM_HREF, label: "Report a problem" },
    ],
  },
  {
    heading: "Legal",
    links: [
      { href: "/privacy", label: "Privacy" },
      { href: "/terms", label: "Terms" },
      { href: "/cookies", label: "Cookies" },
    ],
  },
];

/**
 * The one honest line about what this is. Repeated nowhere else.
 *
 * L05 rewrote it, twice over. It said "jobs posted in WhatsApp groups", which
 * is the provenance of most of the board and not of the listings a poster types
 * in here; and it led on the mechanism ("read by rules"), which review 01 names
 * as the thing to stop doing -- a tagline should say what the reader gets. The
 * rules are still the reason to trust the board, and they are still on
 * /how-it-works, one click from this footer.
 *
 * It is also the FooterBar's line from `xl` up, so its length is load-bearing:
 * 83 characters, six shorter than the line it replaces, which is why the bar
 * still fits on one row at 1280.
 */
export const SITE_TAGLINE =
  "A load board for movers: loads and truck space, by route, capacity and stated dates.";

/**
 * The links a one-line bar has room for.
 *
 * "Contact" is on this list and did not used to be, which was the one real hole
 * in the route to a human: the board is the front door and its footer is this
 * bar, so on the busiest page of the site the only way to reach a person was to
 * open the More menu and know that "Company" is where support lives. A visitor
 * who wants to tell somebody that a job is wrong should not have to guess that.
 */
const BAR_LINKS: SiteLink[] = [
  { href: "/for-movers", label: "For movers" },
  { href: "/how-it-works", label: "How it works" },
  { href: "/about", label: "About" },
  { href: "/contact", label: "Contact" },
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
  { href: "/cookies", label: "Cookies" },
];

function year(): number {
  return new Date().getFullYear();
}

/**
 * The bottom-bar copyright, on every page of the site.
 *
 * The company name comes from the settings store, and while nobody has filled
 * it in this renders the same `[[COMPANY LEGAL NAME]]` it always did -- an
 * obvious placeholder, not an empty string and not a guess. See
 * src/lib/settings.ts and .design/impl/legal-placeholders.md.
 *
 * Async, so both footer shapes are async and so is anything that renders one.
 * That costs nothing: every page in this app is already `force-dynamic` and
 * already awaits `getCurrentUser()`, and `readSiteSettings` is request-cached,
 * so a legal page that reads these values for its own prose and then renders a
 * footer makes one query between them, not two.
 */
async function Copyright({ className }: { className?: string }) {
  const settings = await readSiteSettings();
  return (
    <span className={className} style={{ color: "var(--muted)" }}>
      © {year()} {settingText(settings, "company_legal_name")}
    </span>
  );
}

function FooterLink({ href, label }: SiteLink) {
  return (
    <Link
      href={href}
      className="tap -mx-1 flex min-h-[var(--tap-min)] items-center rounded-sm px-1 text-(length:--fs-base) hover:underline md:min-h-0 md:py-[3px]"
      style={{ color: "var(--text-2)" }}
    >
      {label}
    </Link>
  );
}

/** The full footer: for every page that scrolls. */
export function Footer() {
  return (
    <footer
      className="bg-surface border-t border-border"
      style={{ marginTop: "var(--sp-8)" }}
    >
      <div className="mx-auto grid max-w-[1100px] gap-[var(--sp-6)] px-[var(--sp-4)] py-[var(--sp-6)] md:grid-cols-[minmax(0,1.4fr)_repeat(3,minmax(0,1fr))] md:py-[var(--sp-8)]">
        <div className="max-w-[34ch]">
          {/* The full lockup, and the one place on a scrolling page that gets
              the tagline: the footer is where a visitor who has read the page
              finds out what the thing is called and what it claims to be. The
              sentence under it says how it works; the tagline says what it is. */}
          <Logo size={28} tagline />
          <p
            className="mt-[var(--sp-2)] text-(length:--fs-base) leading-relaxed"
            style={{ color: "var(--muted)" }}
          >
            {SITE_TAGLINE}
          </p>
        </div>

        {/* Two-up on a phone and three-up on a tablet, so nine links do not
            become a 700 px column nobody scrolls past. `md:contents` dissolves
            this wrapper on a wide screen, letting the three navs become columns
            of the grid above. */}
        <div className="grid grid-cols-2 gap-x-[var(--sp-4)] gap-y-[var(--sp-5)] sm:grid-cols-3 md:contents">
          {SITE_SECTIONS.map((section) => (
            <nav key={section.heading} aria-label={section.heading}>
              <h2 className="label">{section.heading}</h2>
              <ul>
                {section.links.map((link) => (
                  <li key={link.href}>
                    <FooterLink {...link} />
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
      </div>

      <div className="border-t border-border">
        <div className="mx-auto flex max-w-[1100px] flex-col gap-[var(--sp-1)] px-[var(--sp-4)] py-[var(--sp-4)] text-(length:--fs-sm) md:flex-row md:items-center md:justify-between">
          <Copyright />
          {/* L05. "one thing: a sender's phone number" was the site's most
              repeated sentence and it had been wrong since posting shipped:
              `requirePosting()` needs a session too. Two things, named. */}
          <span style={{ color: "var(--muted)" }}>
            Browsing is public. An account is for two things: seeing a phone number, and posting a
            listing.
          </span>
        </div>
      </div>
    </footer>
  );
}

/**
 * The one-line bar: for a full-height app screen, and for the sign-in pages,
 * which are a single centred card with no shell around them.
 *
 * Whether it is visible on a phone is the caller's decision, not this
 * component's -- on the board it has to be hidden, because the bottom sheet is
 * fixed over that strip of viewport; on /login there is nothing in the way.
 */
export function FooterBar() {
  return (
    <footer className="bg-surface border-t border-border">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-[var(--sp-4)] gap-y-[var(--sp-1)] px-[var(--sp-4)] py-[var(--sp-2)] text-(length:--fs-sm)">
        <Copyright />
        {/* From `xl`, not `lg`, and that is the seventh link's doing: at 1024
            the copyright, this sentence and seven links measure past the row and
            the bar wraps to 56 px, taking 22 px off the board's map. Measured at
            1024 / 1280 / 1440 / 1600 -- one row at every width from 1280 up. */}
        <span className="hidden xl:inline" style={{ color: "var(--muted-2)" }}>
          {SITE_TAGLINE}
        </span>
        <nav aria-label="Site" className="ml-auto flex flex-wrap items-center gap-x-[var(--sp-4)]">
          {BAR_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="tap flex items-center hover:underline"
              style={{ color: "var(--text-2)" }}
            >
              {link.label}
            </Link>
          ))}
        </nav>
      </div>
    </footer>
  );
}
