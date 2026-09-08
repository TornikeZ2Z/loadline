/**
 * The MoverMesh mark, wordmark and lockup.
 *
 * Inline SVG in a component rather than a file in /public, for three reasons
 * that all matter here: the header draws it at 24 px on every route and an
 * <img> would be a network round trip on the critical path; the mark is built
 * out of the same tokens as the rest of the board (--brand-navy, --brand-blue,
 * --brand-green), so it cannot drift from the palette; and it has to be crisp
 * at 16 px in a browser tab and at 180 px on a login screen from one source.
 *
 * WHAT IT IS. A letter M drawn as one folded ribbon of road: a navy plane and a
 * bright blue plane meeting at a vertical fold through the middle of the letter,
 * white lane dashes running up the navy stem, and two map pins dropped into the
 * letter's own counters -- blue at the lower left, green at the upper right.
 * The pins sit INSIDE the counters rather than floating off the corners: a pin
 * parked in white space beside the letter reads as a sticker, and at 24 px it
 * reads as dirt. Nested, they are part of the letter and the mark stays one
 * shape. Everything is drawn as geometry on a 32-unit grid -- no bitmap trace
 * -- so there is no detail in it that cannot survive being 16 px wide.
 *
 * GEOMETRY, so the next person can move it without guessing:
 *   ribbon   M 5.6 28.9 -> 5.6 12.5 -> 16 19.8 -> 26.4 12.5 -> 26.4 28.9,
 *            stroked at 5.15 with miter joins and butt caps. The V is 44% of
 *            the stem height deep, and that is a decision: at 5.15 of a 25-wide
 *            letter, a deeper V closes the counters the pins live in (measured
 *            -- at 83% deep the left counter is 0.4 units wide), and a bold
 *            geometric M is what has to survive 16 px, not a text M.
 *   fold     a vertical seam at x = 16, exactly through the valley of the V.
 *            The same path is stroked twice and clipped either side of it, so
 *            the two planes always meet with no seam artefact.
 *   road     the left stem only. On the navy plane white dashes have their
 *            largest contrast, and running them along the whole ribbon (tried
 *            first) turned the M into a ladder.
 *   pins     teardrops whose flanks are the true tangents from the apex to the
 *            head circle (shoulders at 0.9006r out and 0.4348r down for an apex
 *            at 2.3r), so head and tail meet without a kink. The blue one
 *            clears the arm above it by 1.19 units and the stem beside it by
 *            2.17; the green one clears the arm below it by 1.6.
 * The artwork's painted bounds are x 3.03..28.98, y 4.65..28.90 -- 25.95 by
 * 24.25, near enough square -- and the viewBox is a 28-unit square around them,
 * so the mark sits centred with about a unit of air on every side at every size
 * it is drawn, from the browser tab to the sign-in screen.
 *
 * `src/app/icon.svg` is this same geometry, hand-copied with literal hexes
 * because a static icon file has no CSS custom properties to read. If the
 * geometry below changes, change that file too.
 */

const RIBBON = "M 5.6 28.9 L 5.6 12.5 L 16 19.8 L 26.4 12.5 L 26.4 28.9";

/** A map pin: head circle of radius `r` at (cx, cy), apex at 2.3r below it. */
function Pin({ cx, cy, r, fill }: { cx: number; cy: number; r: number; fill: string }) {
  const dx = +(0.9006 * r).toFixed(3);
  const shoulder = +(cy + 0.4348 * r).toFixed(3);
  const tip = +(cy + 2.3 * r).toFixed(3);
  return (
    <>
      <path d={`M ${cx - dx} ${shoulder} L ${cx} ${tip} L ${cx + dx} ${shoulder} Z`} fill={fill} />
      <circle cx={cx} cy={cy} r={r} fill={fill} />
    </>
  );
}

/**
 * The three variants the branding review asks the logo system to produce:
 * "horizontal, symbol-only, one-color dark and reversed white".
 *
 *   brand     the two planes and the two pins, in the brand's own colours.
 *   mono      one colour, the ink. For a fax, a stamp, an embroidered shirt,
 *             or any ground that is already carrying colour.
 *   reversed  the same, in white, for a dark or photographic ground.
 *
 * The road dashes and the pins have to change with the plane they sit on: on
 * `mono` the white dashes stay white (they are the paper showing through the
 * ink) and the pins take the ink; on `reversed` the dashes go to the dark
 * ground, because a white dash on a white ribbon is not a dash.
 */
export type LogoTone = "brand" | "mono" | "reversed";

/**
 * MINIMUM SIZES, from the review: 120 px for the full lockup, 24 px for the
 * symbol on its own. A separately simplified favicon may go below that; this
 * geometry is drawn on a 32-unit grid with no detail finer than 1.5 units, so
 * it survives 16 px, and src/app/icon.svg is that same geometry.
 *
 * CLEAR SPACE: half the symbol's height on all sides. The viewBox carries about
 * one unit of air, which is not clear space -- it is optical centring. A caller
 * placing the mark next to other content owes it size/2 of margin.
 */
export const LOGO_MIN_LOCKUP_PX = 120;
export const LOGO_MIN_MARK_PX = 24;

export interface LogoMarkProps {
  /** Rendered size in px. 24 in the header, 28-44 in a lockup, 180 on /login. */
  size?: number;
  /** Which of the three variants to draw. Defaults to the brand's colours. */
  tone?: LogoTone;
  className?: string;
}

/**
 * The mark on its own: the header badge, and the shape the favicon is cut from.
 *
 * Always aria-hidden. Every place it is used sits inside a link or a heading
 * that already says "MoverMesh" in words, and a second announcement of the same
 * name is noise. The one caller that has no visible wordmark (the header below
 * `sm`) labels its own link.
 */
export function LogoMark({ size = 24, tone = "brand", className }: LogoMarkProps) {
  /* Four inks per variant: the two planes, the road dashes and the two pins.
     Written as var() with a literal fallback because this renders in server
     components and in src/app/icon.svg's static twin, where there are no custom
     properties to read. */
  const ink =
    tone === "reversed"
      ? {
          navy: "#ffffff",
          blue: "#ffffff",
          /* The dashes are a knockout THROUGH the ribbon, so they take the
             ground; the pins sit in the counters, ON the ground, so they take
             the mark. Reversed inverts the two, and getting it backwards paints
             a navy pin on a navy ground -- invisible, and only caught because
             the variants were rendered and read back rather than reasoned about
             (.design/impl/rev-tokens-logo.png). */
          road: "var(--brand-navy, #17284A)",
          pinA: "#ffffff",
          pinB: "#ffffff",
        }
      : tone === "mono"
        ? {
            navy: "var(--brand-navy, #17284A)",
            blue: "var(--brand-navy, #17284A)",
            road: "#ffffff",
            /* The ink, not the paper. Both pins sit in the letter's COUNTERS --
               measured, they clear the ribbon by 1.6 and 2.17 units -- so they
               are drawn on the background, and a white pin on white paper is
               nothing at all. */
            pinA: "var(--brand-navy, #17284A)",
            pinB: "var(--brand-navy, #17284A)",
          }
          : {
            navy: "var(--brand-navy, #17284A)",
            blue: "var(--brand-blue, #155EEF)",
            road: "#ffffff",
            pinA: "var(--brand-blue, #155EEF)",
            pinB: "var(--brand-green, #1FA463)",
          };
  /* The clipPath ids are keyed on the size, not on a counter and not on
     useId(): this renders inside server components, so there is no hook to
     call, and a module counter would give the server and the client different
     ids and a hydration mismatch. The three call sites are three different
     sizes, so the ids are unique on every page today -- and if two marks of the
     SAME size ever meet, both <defs> define the same two rects, so the
     reference resolves to an identical clip and the mark still draws correctly. */
  const id = `mm${size}${tone}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="2 2.8 28 28"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        {/* The two clips overlap by nothing and extend past the artwork, so the
            fold is a single hairline shared by both planes rather than a gap. */}
        <clipPath id={`${id}a`}>
          <rect x="-6" y="-6" width="22" height="44" />
        </clipPath>
        <clipPath id={`${id}b`}>
          <rect x="16" y="-6" width="22" height="44" />
        </clipPath>
      </defs>
      <g fill="none" strokeWidth="5.15" strokeLinecap="butt" strokeLinejoin="miter">
        <path d={RIBBON} stroke={ink.navy} clipPath={`url(#${id}a)`} />
        <path d={RIBBON} stroke={ink.blue} clipPath={`url(#${id}b)`} />
        {/* The road. 1.5 of a 5.15 ribbon: wide enough to still be a lane at
            32 px, narrow enough that the stem is a plane and not a stripe.
            It is a knockout, so on `reversed` it takes the ground rather than
            the mark: a white dash on a white ribbon is not a dash. */}
        <path d="M 5.6 27.7 L 5.6 13.7" stroke={ink.road} strokeWidth="1.5" strokeDasharray="2.9 2.8" />
      </g>
      {/* Lower left, nested in the M's own counter; upper right, in the counter
          above the right arm. Diagonal to each other, which is the one thing a
          pair of pins on a load board is for. */}
      <Pin cx={12.2} cy={24} r={1.85} fill={ink.pinA} />
      <Pin cx={21.6} cy={6.6} r={1.95} fill={ink.pinB} />
    </svg>
  );
}

/**
 * The word, in two colours, as HTML rather than SVG text.
 *
 * It has to set in Inter -- the same face as the rest of the site, loaded once
 * by next/font -- and it has to be selectable, searchable and translatable.
 * Outlining it into paths would buy nothing here (there is no custom
 * letterform) and would cost all three.
 */
export function Wordmark({
  tone = "brand",
  className,
  style,
}: {
  tone?: LogoTone;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <span
      className={className}
      style={{
        fontWeight: 700,
        letterSpacing: "-0.02em",
        ...(tone === "reversed" ? { color: "#fff" } : null),
        ...style,
      }}
    >
      {/* "Mover" is not given a colour of its own: --text IS the brand navy
          now, so the first half of the wordmark is simply the page's ink -- and
          on the one-colour variants both halves are, which is what makes them
          one colour. */}
      <span>Mover</span>
      <span style={tone === "brand" ? { color: "var(--accent)" } : undefined}>Mesh</span>
    </span>
  );
}

/** The one line under the wordmark. The CEO's, verbatim. */
export const LOGO_TAGLINE = "The Load Board for Movers.";

export interface LogoProps {
  /** Size of the mark; the wordmark is set from `fontSize`. */
  size?: number;
  /** brand | mono | reversed. See LogoTone. */
  tone?: LogoTone;
  /** Wordmark size. Defaults to the mark's size times 0.62, which is the ratio
   *  the supplied artwork uses between the mark's height and the cap height. */
  fontSize?: number;
  /** Show the tagline under the wordmark. Only where there is room for it. */
  tagline?: boolean;
  className?: string;
}

/**
 * Mark plus wordmark, and optionally the tagline: the footer, the sign-in
 * screen, anywhere the product introduces itself rather than just labels a tab.
 *
 * The header does NOT use this -- it needs the wordmark to disappear below
 * `sm` while the mark stays as the way home, which is a layout decision that
 * belongs to the header, not to the logo.
 */
export function Logo({ size = 28, tone = "brand", fontSize, tagline = false, className }: LogoProps) {
  const word = fontSize ?? Math.round(size * 0.62);
  return (
    <span
      className={className}
      style={{ display: "inline-flex", alignItems: "center", gap: Math.round(size * 0.28) }}
    >
      <LogoMark size={size} tone={tone} />
      <span style={{ display: "inline-flex", flexDirection: "column", gap: Math.max(2, Math.round(word * 0.2)) }}>
        <Wordmark tone={tone} className="leading-none" style={{ fontSize: word }} />
        {tagline ? (
          <span
            className="leading-none"
            style={{
              color: tone === "reversed" ? "rgb(255 255 255 / .78)" : "var(--muted)",
              /* Never below the 12 px floor the type scale sets for the app. */
              fontSize: Math.max(12, Math.round(word * 0.5)),
              fontWeight: 500,
              letterSpacing: ".01em",
            }}
          >
            {LOGO_TAGLINE}
          </span>
        ) : null}
      </span>
    </span>
  );
}
