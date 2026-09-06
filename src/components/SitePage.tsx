/**
 * The layout every content page (/about, /how-it-works, /contact, /privacy,
 * /terms, /cookies) is built from, so the six of them read as one site.
 *
 * Presentational only: no state, no client boundary, no stylesheet. Colour,
 * size, spacing and radius all come from the tokens in globals.css; the measure
 * is capped near 70 characters because these are the only screens on this site
 * that anyone reads in sentences rather than scans.
 */

export function SitePage({
  eyebrow,
  title,
  lead,
  meta,
  children,
}: {
  /** The footer column this page belongs to: "Company", "Legal", "Product". */
  eyebrow: string;
  title: string;
  /** One or two sentences under the title. Sets up the page; never repeats it. */
  lead: string;
  /** Small print under the lead -- a draft note, a last-updated line. */
  meta?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <main className="mx-auto w-full max-w-[720px] px-[var(--sp-4)] pb-[var(--sp-8)] pt-[var(--sp-6)] md:pt-[var(--sp-8)]">
      <p className="label">{eyebrow}</p>
      <h1 className="big text-(length:--fs-2xl) md:text-(length:--fs-3xl)">{title}</h1>
      <p
        className="mt-[var(--sp-3)] text-(length:--fs-lg) leading-relaxed"
        style={{ color: "var(--text-2)" }}
      >
        {lead}
      </p>
      {meta ? (
        <div className="mt-[var(--sp-3)] text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
          {meta}
        </div>
      ) : null}
      <div className="mt-[var(--sp-8)] flex flex-col gap-[var(--sp-8)]">{children}</div>
    </main>
  );
}

/**
 * A titled block of prose. `<p>`, `<ul>` and `<ol>` children are spaced and
 * coloured here rather than in each page, so no page has to remember the rhythm.
 */
export function Section({
  title,
  id,
  children,
}: {
  title: string;
  id?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-[calc(var(--header-h)+var(--sp-4))]">
      <h2 className="big text-(length:--fs-xl)">{title}</h2>
      <div
        className="mt-[var(--sp-3)] flex flex-col gap-[var(--sp-3)] text-(length:--fs-md) leading-relaxed [&_a]:underline [&_li]:pl-1 [&_ol]:list-decimal [&_ol]:pl-[var(--sp-5)] [&_ul]:list-disc [&_ul]:pl-[var(--sp-5)] [&>ol]:flex [&>ol]:flex-col [&>ol]:gap-[var(--sp-2)] [&>ul]:flex [&>ul]:flex-col [&>ul]:gap-[var(--sp-2)]"
        style={{ color: "var(--text-2)" }}
      >
        {children}
      </div>
    </section>
  );
}

/**
 * A short aside that carries a caveat -- the thing a page would be dishonest to
 * leave out. Neutral by default; `tone="warn"` for the ones a reader must not
 * skim past.
 */
export function Note({
  title,
  tone = "plain",
  children,
}: {
  title?: string;
  tone?: "plain" | "warn";
  children: React.ReactNode;
}) {
  const warn = tone === "warn";
  return (
    <aside
      className="rounded-[var(--radius-md)] border p-[var(--sp-4)] text-(length:--fs-base) leading-relaxed"
      style={{
        background: warn ? "var(--warn-soft)" : "var(--surface-2)",
        borderColor: warn ? "var(--warn-soft)" : "var(--border)",
        color: warn ? "var(--warn)" : "var(--text-2)",
      }}
    >
      {title ? (
        <strong className="block" style={{ color: warn ? "var(--warn)" : "var(--text)" }}>
          {title}
        </strong>
      ) : null}
      <div className={title ? "mt-[var(--sp-1)]" : undefined}>{children}</div>
    </aside>
  );
}

/**
 * One stored item on /cookies: a name, what it is for, and how long it lasts.
 * A table would need a horizontal scroller on a 390 px screen; a stack of these
 * does not.
 */
export function StoredItem({
  name,
  where,
  children,
}: {
  name: string;
  where: string;
  children: React.ReactNode;
}) {
  return (
    <div className="card p-[var(--sp-4)]">
      <div className="flex flex-wrap items-center gap-[var(--sp-2)]">
        <code className="text-(length:--fs-base) font-semibold" style={{ color: "var(--text)" }}>
          {name}
        </code>
        <span className="chip">{where}</span>
      </div>
      <div
        className="mt-[var(--sp-2)] text-(length:--fs-base) leading-relaxed"
        style={{ color: "var(--text-2)" }}
      >
        {children}
      </div>
    </div>
  );
}
