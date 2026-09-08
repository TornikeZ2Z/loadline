"use client";

/**
 * "Loads that fit this truck", and its mirror on a job.
 *
 * ONE component for both directions, because the two panels make the same
 * claim from opposite ends and the day they stop looking alike is the day a
 * reader starts wondering which one to believe. What differs is the noun, the
 * link and the row's own summary line; everything that decides -- the tier, the
 * reason clauses, the refusal histogram, the admissions -- comes from
 * `@/lib/match/reasons`, which the server and the notification cron import too.
 *
 * THREE THINGS THIS PANEL WILL NOT DO.
 *
 *   It never prints the score. It is on the wire and it orders the list, and a
 *   rendered "82" would invite belief proportional to its precision about a
 *   weighted opinion over six quantities, three of them estimates.
 *
 *   It never prints a bare "No matches". An empty list is the LIKELIEST screen
 *   here -- 98 jobs, a handful of trucks -- and "11 were going the wrong way ·
 *   4 were bigger than your 400 cf free" is the difference between a board a
 *   driver keeps opening and one they decide is broken.
 *
 *   It never hides a gate that could not fire. The deadline gate refuses
 *   nothing when no candidate states a deadline, and service matching is doing
 *   almost nothing at 0 tags on 98 jobs. Both are printed as admissions rather
 *   than left looking like passed tests.
 *
 * SPEC 11.8 and 11.10.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/basePath";
import { formatCf } from "@/lib/moving/cubicFeet";
import { boardDay, formatPrice, laneLabel, requirementChips } from "@/lib/loads/present";
import { freeSpaceLabel, truckLaneLabel } from "@/lib/loads/truckPresent";
import type { PublicLoadRow, PublicTruckRow } from "@/lib/loads/publicView";
import type { MatchOk, MatchResult } from "@/lib/match/types";
import {
  DEADLINE_INERT_NOTE,
  SERVICE_THIN_NOTE,
  SIZE_CAVEAT,
  basisNote,
  emptyMatchCopy,
  type MatchSide,
} from "@/lib/match/reasons";
import { Chip } from "./ui";

type Listing = PublicLoadRow | PublicTruckRow;

export interface MatchPanelProps {
  /** Which way round. "truck" = this page is a truck, and the rows are jobs. */
  side: MatchSide;
  /** Where to fetch from: `/api/trucks/12/matches` or `/api/loads/12/matches`. */
  path: string;
  /** The anchor truck's stated free space, for the histogram's own numbers. */
  freeCf?: number | null;
  /** The anchor job's stated size, for the mirror. */
  jobCf?: number | null;
  /** The anchor truck stated no destination: "near you", not "near your route". */
  radius?: boolean;
  /** Bumped by the parent when the listing changes, to refetch. */
  refreshKey?: number;
}

const HEADING: Record<MatchSide, string> = {
  truck: "Loads that fit this truck",
  job: "Trucks that could take this",
};

/** Two bands, and the words a driver actually acts on. */
const TIER_LABEL = {
  strong: { label: "Worth a call", tone: "ok" as const },
  possible: { label: "Worth a look", tone: "default" as const },
};

function isTruck(item: Listing): item is PublicTruckRow {
  return "origin_label" in item;
}

/** The row's own one-line summary: what it is, before why it fits. */
function summaryOf(item: Listing, today: string): string {
  if (isTruck(item)) {
    const space = freeSpaceLabel(item);
    return [truckLaneLabel(item), space.text].join(" · ");
  }
  const price = formatPrice(item);
  return [
    laneLabel(item),
    item.cubic_feet != null ? formatCf(item.cubic_feet) : "Size not stated",
    price.tone === "muted" ? null : price.headline,
    item.ready_now || (item.ready_date != null && item.ready_date <= today) ? "Ready now" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function MatchRow({ item, verdict, today }: { item: Listing; verdict: MatchOk; today: string }) {
  const href = isTruck(item) ? `/trucks/${item.id}` : `/jobs/${item.id}`;
  const requirements = requirementChips(verdict.requirements);
  return (
    <li className="border-t border-border py-[var(--sp-2)] first:border-t-0" data-match-id={item.id}>
      <Link
        href={href}
        className="flex min-h-[var(--tap-min)] flex-col justify-center md:min-h-0"
        style={{ color: "var(--text)" }}
      >
        <span className="font-semibold">{summaryOf(item, today)}</span>
        {/* The reason line. Every clause is a number off a column or an
            explicit statement of absence -- no adjectives, and nothing here is
            a confidence. */}
        <span className="text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
          {verdict.reasons.join(" · ")}
        </span>
      </Link>
      {requirements.length > 0 && (
        <div className="mt-[var(--sp-1)] flex flex-wrap gap-[var(--sp-1)]">
          {requirements.map((req) => (
            <Chip key={req.label} tone="warn" title={req.title}>
              {req.label}
            </Chip>
          ))}
        </div>
      )}
    </li>
  );
}

export function MatchPanel({ side, path, freeCf, jobCf, radius, refreshKey = 0 }: MatchPanelProps) {
  const [data, setData] = useState<MatchResult<Listing> | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let live = true;
    setState("loading");
    fetch(api(path))
      .then((r) => (r.ok ? (r.json() as Promise<MatchResult<Listing>>) : Promise.reject(r.status)))
      .then((d) => {
        if (!live) return;
        setData(d);
        setState("ready");
      })
      .catch(() => {
        if (live) setState("error");
      });
    return () => {
      live = false;
    };
  }, [path, refreshKey]);

  const today = boardDay(new Date());

  return (
    <section className="mt-[var(--sp-5)] border-t border-border pt-[var(--sp-4)]">
      <div className="label">{HEADING[side]}</div>

      {state === "loading" && (
        <p className="text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
          Checking the board…
        </p>
      )}

      {/* A matching failure must never look like an answer. The two boards fail
          independently everywhere else in this app and so does this. */}
      {state === "error" && (
        <p className="text-(length:--fs-sm)" style={{ color: "var(--warn)" }}>
          Couldn&apos;t check for matches. Nothing here means there are none — try again in a moment.
        </p>
      )}

      {state === "ready" && data && <MatchBody data={data} side={side} freeCf={freeCf} jobCf={jobCf} radius={radius} today={today} />}
    </section>
  );
}

function MatchBody({
  data,
  side,
  freeCf,
  jobCf,
  radius,
  today,
}: {
  data: MatchResult<Listing>;
  side: MatchSide;
  freeCf?: number | null;
  jobCf?: number | null;
  radius?: boolean;
  today: string;
}) {
  const strong = data.matches.filter((m) => m.verdict.tier === "strong");
  const possible = data.matches.filter((m) => m.verdict.tier === "possible");

  if (data.matches.length === 0) {
    const copy = emptyMatchCopy(data, side, { freeCf, jobCf, radius });
    return (
      <div data-match-empty>
        <p className="text-(length:--fs-base)">{copy.headline}</p>
        {copy.clauses.length > 0 && (
          <p className="mt-[var(--sp-1)] text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
            {copy.clauses.join(" · ")}.
          </p>
        )}
        {copy.ask && (
          <p className="mt-[var(--sp-1)] text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
            {copy.ask}
          </p>
        )}
        {side === "job" && data.candidates === 0 && (
          <Link
            href="/post/truck"
            className="btn btn-sm mt-[var(--sp-2)] inline-flex"
            style={{ color: "var(--accent)" }}
          >
            Post available truck space
          </Link>
        )}
        {/* Nothing was weighed, so there is nothing to explain. The admissions
            below are about HOW a match was decided; printed over an empty
            candidate set they are noise dressed as diligence. */}
        {data.candidates > 0 && <Admissions data={data} side={side} />}
      </div>
    );
  }

  return (
    <div>
      {[
        { tier: "strong" as const, rows: strong },
        { tier: "possible" as const, rows: possible },
      ]
        .filter((g) => g.rows.length > 0)
        .map((g) => (
          <div key={g.tier} className="mt-[var(--sp-2)]">
            <Chip tone={TIER_LABEL[g.tier].tone}>
              {TIER_LABEL[g.tier].label} ({g.rows.length})
            </Chip>
            <ul className="mt-[var(--sp-1)] flex flex-col">
              {g.rows.map((m) => (
                <MatchRow key={m.item.id} item={m.item} verdict={m.verdict} today={today} />
              ))}
            </ul>
          </div>
        ))}
      <Admissions data={data} side={side} />
    </div>
  );
}

/**
 * How this was matched: the estimate behind the dates, the caveat about what cf
 * does not measure, and the two gates that are not doing their job yet.
 *
 * Once per panel, the way `truckLine` names its 1,500 cf divisor once per
 * header. Repeated on every row it would be wallpaper; left off entirely it
 * would make a straight-line guess look like a routed answer.
 */
function Admissions({ data, side }: { data: MatchResult<Listing>; side: MatchSide }) {
  const basis = data.matches[0]?.verdict.facts.basis ?? "estimate";
  return (
    <details className="mt-[var(--sp-3)]">
      <summary
        className="flex min-h-[var(--tap-min)] cursor-pointer items-center text-(length:--fs-sm) md:min-h-0"
        style={{ color: "var(--accent)" }}
      >
        How this was matched
      </summary>
      <div className="mt-[var(--sp-1)] flex flex-col gap-[var(--sp-1)] text-(length:--fs-sm)" style={{ color: "var(--muted)" }}>
        {data.matches.length > 0 && <p>{basisNote(basis)}</p>}
        {side === "truck" && <p>{SIZE_CAVEAT}</p>}
        {data.gates.deadline === "inert" && <p>{DEADLINE_INERT_NOTE}</p>}
        {data.gates.service === "thin" && <p>{SERVICE_THIN_NOTE}</p>}
        {data.truncated && (
          <p style={{ color: "var(--warn)" }}>
            Showing the first {data.candidates.toLocaleString("en-US")} nearby listings — there may be
            more.
          </p>
        )}
      </div>
    </details>
  );
}
