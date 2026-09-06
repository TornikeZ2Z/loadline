import Link from "next/link";

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
      { href: "/how-it-works", label: "How it works" },
      { href: "/post", label: "Post a job" },
    ],
  },
  {
    heading: "Company",
    links: [
      { href: "/about", label: "About" },
      { href: "/contact", label: "Contact" },
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

/** The one honest line about what this is. Repeated nowhere else. */
export const SITE_TAGLINE =
  "A backhaul board for movers: jobs posted in WhatsApp groups, read by rules and put on a map.";

/** The links a one-line bar has room for. */
const BAR_LINKS: SiteLink[] = [
  { href: "/about", label: "About" },
  { href: "/how-it-works", label: "How it works" },
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
  { href: "/cookies", label: "Cookies" },
];

function year(): number {
  return new Date().getFullYear();
}

/**
 * `[[COMPANY LEGAL NAME]]` is a deliberate placeholder, not an oversight: the
 * operating entity is a real-world fact nobody has told this codebase. See
 * .design/impl/legal-placeholders.md.
 */
function Copyright({ className }: { className?: string }) {
  return (
    <span className={className} style={{ color: "var(--muted)" }}>
      © {year()} [[COMPANY LEGAL NAME]]
    </span>
  );
}

function FooterLink({ href, label }: SiteLink) {
  return (
    <Link
      href={href}
      className="-mx-1 flex min-h-[40px] items-center rounded-sm px-1 text-[var(--fs-base)] hover:underline md:min-h-0 md:py-[3px]"
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
          <div className="flex items-center gap-2 font-bold tracking-tight">
            <span
              className="grid h-6 w-6 place-items-center rounded-md text-[var(--fs-base)] text-white"
              style={{ background: "var(--accent)" }}
            >
              L
            </span>
            LoadLine
          </div>
          <p
            className="mt-[var(--sp-2)] text-[var(--fs-base)] leading-relaxed"
            style={{ color: "var(--muted)" }}
          >
            {SITE_TAGLINE}
          </p>
        </div>

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

      <div className="border-t border-border">
        <div className="mx-auto flex max-w-[1100px] flex-col gap-[var(--sp-1)] px-[var(--sp-4)] py-[var(--sp-4)] text-[var(--fs-sm)] md:flex-row md:items-center md:justify-between">
          <Copyright />
          <span style={{ color: "var(--muted)" }}>
            Browsing is public. An account is needed for one thing: a sender&rsquo;s phone number.
          </span>
        </div>
      </div>
    </footer>
  );
}

/**
 * The one-line bar for a full-height app screen.
 *
 * Hidden below `md`, and that is a decision rather than an omission: on a phone
 * the board's bottom sheet is fixed to the bottom of the viewport and would
 * cover anything underneath it. The header's More menu carries the same links
 * on a phone.
 */
export function FooterBar() {
  return (
    <footer className="bg-surface hidden border-t border-border md:block">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-[var(--sp-4)] gap-y-[var(--sp-1)] px-[var(--sp-4)] py-[var(--sp-2)] text-[var(--fs-sm)]">
        <Copyright />
        <span className="hidden lg:inline" style={{ color: "var(--muted-2)" }}>
          {SITE_TAGLINE}
        </span>
        <nav aria-label="Site" className="ml-auto flex flex-wrap items-center gap-x-[var(--sp-4)]">
          {BAR_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="hover:underline"
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
