/**
 * The origin state machine and job assembly (inventory-v1, A §3.5-§3.9).
 *
 * A batch post is read top to bottom with one piece of state: the running
 * origin. A header sets it, a lane with a FROM marker sets it, a destination
 * line emits a job under it, and NOTHING ELSE changes it -- not a blank line,
 * not a contact line, not chatter. A state-only header ("NEW JERSEY", "Ready
 * for Delivery From California") sets the block state that the city headers
 * below it inherit ("📍 Kearny" -> Kearny, NJ), and it is not single-use.
 */
import { STATE_BY_ABBR } from "@/lib/geo/states";
import type { HeaderParse } from "./header";
import { originLabel, resolveCityState } from "./header";
import { type DestParse, type Line, type MessagePass } from "./lines";
import type { ExtractedJob, MessageContext, OriginRef } from "./schema";

export interface Assembly {
  loads: ExtractedJob[];
  orphans: number[];
  lastOrigin: OriginRef | null;
  flags: string[];
  truncated: boolean;
  originUnresolved: boolean;
}

interface BlockState {
  origin: OriginRef | null;
  blockState: string | null;
  blockStateSource: "block" | "title";
  blockReady: boolean;
  blockReadyDate: string | null;
}

export function slug(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function originKeyOf(state: string | null, city: string | null): string {
  return `${state ?? "?"}:${slug(city) || "*"}`;
}

export function destKeyOf(state: string | null, zip: string | null, city: string | null): string {
  return `${state ?? "?"}:${zip || slug(city) || "*"}`;
}

/** Build an OriginRef from a parsed header, resolving a bare city's state offline. */
export function buildOrigin(
  parse: HeaderParse,
  kind: "from" | "pin" | "bare" | "state" | "city" | "lane",
  lineNo: number,
  rawText: string,
  block: BlockState,
  opts: { titleLike?: boolean } = {},
): OriginRef {
  const flags = [...parse.flags];
  let city = parse.city;
  let state = parse.state;
  let stateSource = parse.stateSource;

  if (city && !state) {
    const r = resolveCityState(city, block.blockState, { hintSource: block.blockStateSource, allowShortAlias: true });
    if (r) {
      state = r.state;
      stateSource = r.source;
      if (r.city) city = r.city;
      flags.push(...r.flags);
    }
  }

  let source: OriginRef["source"];
  if (kind === "lane") source = "lane";
  else if (parse.stateOnly) source = opts.titleLike ? "title" : "state_header";
  else if (kind === "from") source = "from_header";
  else if (kind === "pin") source = "pin_header";
  else source = "bare_header";

  return {
    label: originLabel(city, state, parse.zip),
    city,
    state,
    zip: parse.zip,
    context: parse.context,
    address: parse.address,
    source,
    state_source: stateSource,
    raw_text: rawText,
    line_no: lineNo,
    flags,
  };
}

export type OriginPrecision = "zip" | "city" | "state" | "none";

export function originPrecision(o: OriginRef): OriginPrecision {
  if (o.zip && o.state) return "zip";
  if (o.city && o.state) return "city";
  if (o.state) return "state";
  return "none";
}

interface Pending {
  line: Line;
  origin: OriginRef | null;
  dest: DestParse;
  block: { blockReady: boolean; blockReadyDate: string | null };
  cf: number | null;
  cfSource: ExtractedJob["cf_source"];
  extraFlags: string[];
}

export function assemble(lines: Line[], pass: MessagePass, ctx: MessageContext): Assembly {
  const flags: string[] = [];
  const orphans: number[] = [];
  let truncated = false;
  let originUnresolved = false;

  const st: BlockState = { origin: null, blockState: null, blockStateSource: "block", blockReady: false, blockReadyDate: null };

  // Continuation messages: no header at all, but the sender's last origin is known.
  const hasOwnOrigin = lines.some((L) => (L.cls === "HEADER") || (L.cls === "LANE" && L.lane?.setsOrigin));
  const hasDest = lines.some((L) => L.cls === "DESTINATION");
  if (!hasOwnOrigin && hasDest) {
    const hint = ctx.senderHints;
    if (hint?.lastOrigin) {
      st.origin = { ...hint.lastOrigin, source: "sender_last", flags: [...(hint.lastOrigin.flags ?? []), "origin_inherited"], line_no: 0 };
      st.blockState = st.origin.state;
      flags.push("origin_inherited");
    } else if (hint?.defaultOrigin) {
      st.origin = { ...hint.defaultOrigin, source: "sender_default", flags: [...(hint.defaultOrigin.flags ?? []), "origin_default"], line_no: 0 };
      st.blockState = st.origin.state;
      flags.push("origin_default");
    }
  }

  const pending: Pending[] = [];
  const incomplete: Pending[] = [];
  let lastOrigin: OriginRef | null = st.origin;

  const emit = (L: Line, dest: DestParse, origin: OriginRef | null, extra: string[] = []) => {
    const p: Pending = {
      line: L, origin, dest,
      block: { blockReady: st.blockReady, blockReadyDate: st.blockReadyDate },
      cf: dest.cf, cfSource: dest.cfSource, extraFlags: extra,
    };
    if (!origin) { orphans.push(L.s.n); return null; }
    if (dest.stateOnly) { incomplete.push(p); return null; }
    pending.push(p);
    for (const extraCf of dest.extraCf) {
      pending.push({ ...p, cf: extraCf, cfSource: dest.cfSource, extraFlags: [...extra, "multi_job_line"] });
    }
    return p;
  };

  for (const L of lines) {
    switch (L.cls) {
      case "HEADER": {
        const h = L.header!;
        const parse = h.parse;
        if (parse.stateOnly) {
          const titleLike = L.ev.fromRfd || L.ev.titleHit || parse.blockReady;
          st.blockState = parse.state;
          st.blockStateSource = titleLike ? "title" : "block";
          st.origin = buildOrigin(parse, h.kind, L.s.n, h.rawPlace, st, { titleLike });
          st.blockReady = false;
          st.blockReadyDate = null;
        } else {
          const origin = buildOrigin(parse, h.kind, L.s.n, h.rawPlace, st);
          st.origin = origin;
          if (parse.stateExplicit && origin.state) st.blockState = origin.state;
          st.blockReady = parse.blockReady;
          st.blockReadyDate = parse.blockReadyDate;
          if (!origin.state) originUnresolved = true;
        }
        lastOrigin = st.origin;
        break;
      }
      case "LANE": {
        const lane = L.lane!;
        const origin = buildOrigin(lane.origin, "lane", L.s.n, lane.rawOrigin, st);
        if (lane.setsOrigin) {
          st.origin = origin;
          if (lane.origin.stateExplicit && origin.state) st.blockState = origin.state;
          lastOrigin = origin;
        }
        const p = emit(L, lane.dest, origin);
        if (p) p.line.jobIndex = -1;
        break;
      }
      case "DESTINATION": {
        emit(L, L.dest!, st.origin, L.flags.includes("cfless_destination") ? ["cfless_destination"] : []);
        break;
      }
      case "CONTINUATION": {
        const last = pending[pending.length - 1];
        if (!last || !L.continuation) break;
        const c = L.continuation;
        if (c.cf != null && last.cf == null) { last.cf = c.cf; last.cfSource = "next_line"; last.extraFlags.push("continuation"); }
        if (c.rfd) last.dest = { ...last.dest, rfd: true };
        if (c.price && !last.dest.price) last.dest = { ...last.dest, price: c.price };
        if (c.dateText && !last.dest.readyDateText) last.dest = { ...last.dest, readyDateText: c.dateText };
        break;
      }
      case "NOTE": {
        const last = pending[pending.length - 1];
        if (last && L.noteTags && last.line.s.n === L.s.n - 1) {
          last.dest = { ...last.dest, tags: [...new Set([...last.dest.tags, ...L.noteTags])] };
        }
        break;
      }
      default:
        break;
    }
  }

  // Incomplete (state-only) destinations: dropped when the message clearly has
  // a ZIP-bearing grammar, emitted at state precision otherwise.
  const completeCount = pending.length;
  const lastContent = [...lines].reverse().find((L) => L.cls !== "BLANK" && L.cls !== "DECORATION");
  for (const p of incomplete) {
    if (completeCount >= 2) {
      p.line.flags.push("incomplete_destination");
      if (!flags.includes("incomplete_destination")) flags.push("incomplete_destination");
      if (lastContent === p.line) {
        truncated = true;
        p.line.flags.push("truncated_tail");
        if (!flags.includes("truncated_tail")) flags.push("truncated_tail");
      }
      continue;
    }
    p.extraFlags.push("state_only_destination");
    pending.push(p);
  }
  pending.sort((a, b) => a.line.s.n - b.line.s.n);

  // (d) a last line whose CF was cut mid-number.
  const lastPending = pending[pending.length - 1];
  if (lastPending && lastContent === lastPending.line && lastPending.cf != null && lastPending.cf < 20 && pending.length > 1 &&
      pending.slice(0, -1).every((p) => p.cf == null || p.cf >= 100)) {
    lastPending.extraFlags.push("truncated_suspect");
    truncated = true;
    if (!flags.includes("truncated_suspect")) flags.push("truncated_suspect");
  }

  // A destination-state heading that is not an origin: every job under a
  // state-only header goes to that same state.
  const underStateHeader = pending.filter((p) => p.origin && !p.origin.city && p.origin.state);
  if (underStateHeader.length && underStateHeader.every((p) => p.dest.state === p.origin!.state)) {
    for (const p of underStateHeader) p.extraFlags.push("state_header_ambiguous");
    flags.push("state_header_ambiguous");
  }

  // Ordinals, contact, ready, confidence.
  const contact = pass.contacts.find((c) => c.phone) ?? null;
  const contactName = contact?.name ?? (isPhoneShaped(ctx.authorName) ? null : (ctx.authorName ?? null));
  const contactPhone = contact?.phone ?? ctx.authorPhone ?? null;
  const seen = new Map<string, number>();
  const loads: ExtractedJob[] = [];
  const lineSeen = new Map<string, number>();

  for (const p of pending) {
    const origin = p.origin!;
    const d = p.dest;
    const jobFlags = [...new Set([...d.flags, ...p.extraFlags, ...lineLevelFlags(p.line), ...origin.flags])];

    const key = `${originKeyOf(origin.state, origin.city)}>${destKeyOf(d.state, d.zip, d.city)}@${p.cf ?? "null"}`;
    const ordinal = (seen.get(key) ?? 0) + 1;
    seen.set(key, ordinal);
    const lt = p.line.s.text.trim();
    lineSeen.set(lt, (lineSeen.get(lt) ?? 0) + 1);
    if (lineSeen.get(lt)! > 1 && !flags.includes("dup_line")) flags.push("dup_line");

    // Ready. Four states, and the last branch is the one the product's central
    // claim rests on: a post with no marker says NOTHING about readiness, so
    // that is what we write down (review L01). It used to write `ready_now =
    // true, ready_source = "assumed"`, which is the board inventing a fact.
    //
    // A stated DATE is not a stated "now" even when the day has already come:
    // `ready_now` means "the sender wrote ready", and whether the date has
    // arrived is a question about today's calendar, asked at query time
    // (`ready_now OR ready_date <= today`) so the answer cannot go stale in the
    // row.
    let ready_now = false;
    let ready_date_text: string | null = null;
    let ready_source: ExtractedJob["ready_source"] = null;
    let ready_state: ExtractedJob["ready_state"] = "unknown";
    if (d.readyDateText) {
      ready_date_text = d.readyDateText;
      ready_source = "line";
      ready_state = "date";
    } else if (d.rfd) {
      ready_now = true;
      ready_source = "line";
      ready_state = "now";
    } else if (p.block.blockReadyDate) {
      ready_date_text = p.block.blockReadyDate;
      ready_source = "header";
      ready_state = "date";
    } else if (p.block.blockReady) {
      ready_now = true;
      ready_source = "header";
      ready_state = "now";
    } else if (pass.messageReady.ready_now) {
      ready_now = true;
      ready_source = pass.messageReady.source;
      ready_state = "now";
    } else if (pass.rfdAnywhere) {
      // The sender marked other lines ready and left this one unmarked: a
      // distinction they drew, not one we invented.
      ready_state = "not_ready";
    }

    const price_per_cf = d.price?.kind === "per_cf" ? d.price.value : null;
    const price_flat = d.price?.kind === "flat" ? d.price.value : null;

    const confidence = score(origin, d, p.cf, p.cfSource, ready_source, jobFlags, d.leftoverWords);
    const prec = originPrecision(origin);
    const REVIEW = new Set([
      "zip_state_mismatch", "ambiguous_la", "ambiguous_city", "cfless_destination", "dest_unresolved_city",
      "state_header_ambiguous", "origin_inherited", "origin_default", "truncated_suspect", "price_ambiguous",
      "large_number", "state_only_destination", "header_without_jobs", "origin_state_assumed",
    ]);
    const needsReview = confidence < 0.5 || prec === "state" || prec === "none" || p.cf == null || jobFlags.some((f) => REVIEW.has(f));
    if (needsReview && !jobFlags.includes("needs_review")) jobFlags.push("needs_review");

    const job: ExtractedJob = {
      pickup_location: origin.label,
      delivery_location: d.written,
      origin,
      dest_state: d.state,
      dest_zip: d.zip,
      dest_city: d.city,
      cubic_feet: p.cf,
      cf_source: p.cf == null ? null : p.cfSource,
      price_per_cf,
      price_flat,
      price_basis: d.price?.basis ?? null,
      ready_now,
      ready_date_text,
      ready_source,
      ready_state,
      deliver_by_text: d.deliverByText,
      tags: d.tags,
      notes: d.notes,
      contact_name: contactName,
      contact_phone: contactPhone,
      line_no: p.line.s.n,
      line_text: p.line.s.text.trim(),
      ordinal,
      flags: jobFlags,
      confidence,
    };
    p.line.jobIndex = loads.length;
    loads.push(job);
  }

  if (originUnresolved) flags.push("origin_unresolved");
  for (const L of lines) {
    if (L.flags.includes("cfless_destination") && !flags.includes("cfless_destination")) flags.push("cfless_destination");
    if (L.dest?.zipStateMismatch && !flags.includes("zip_state_mismatch")) flags.push("zip_state_mismatch");
    if (L.flags.includes("two_places") && !flags.includes("two_places")) flags.push("two_places");
    if (L.flags.includes("header_without_jobs") && !flags.includes("header_without_jobs")) flags.push("header_without_jobs");
  }

  return { loads, orphans, lastOrigin, flags, truncated, originUnresolved };
}

function lineLevelFlags(L: Line): string[] {
  const keep = new Set([
    "multi_number", "low_cf", "price_ambiguous", "unit_ft", "zip_leading_zero_restored", "zip_plus4_suspect",
    "ambiguous_la", "unmarked_number", "extra_number", "multi_job_line", "large_number",
  ]);
  return [...L.ev.flags, ...L.flags].filter((f) => keep.has(f));
}

function isPhoneShaped(s: string | null | undefined): boolean {
  if (!s) return false;
  const digits = s.replace(/\D/g, "");
  return digits.length >= 7 && /^[\s+()\d.\-]+$/.test(s.trim());
}

/** A §3.8. */
function score(
  origin: OriginRef,
  d: DestParse,
  cf: number | null,
  cfSource: ExtractedJob["cf_source"],
  readySource: ExtractedJob["ready_source"],
  flags: string[],
  leftoverWords: number,
): number {
  let c = 0.5;
  if (d.zip && d.state && !d.zipStateMismatch) c += 0.2;
  else if (d.city && d.state && (d.citySource === "gazetteer" || d.citySource === "alias" || d.citySource === "learned")) c += 0.1;
  else if (d.city && d.state) c += 0.05;
  else if (d.city && !d.state) c -= 0.15;
  else if (d.state) c -= 0.1;

  switch (originPrecision(origin)) {
    case "zip": c += 0.15; break;
    case "city": c += 0.1; break;
    case "state": c -= 0.2; break;
    case "none": c -= 0.3; break;
  }
  if (origin.source === "state_header" || origin.source === "title") c -= 0.1;
  if (flags.includes("origin_inherited")) c -= 0.15;

  if (cf == null) c -= 0.2;
  else if (cfSource === "unit") c += 0.05;
  else if (cfSource === "next_line") c -= 0.05;

  if (readySource === "line" || readySource === "header" || readySource === "footer" || readySource === "title") c += 0.05;

  const penalty: Record<string, number> = {
    zip_state_mismatch: 0.15, ambiguous_la: 0.15, ambiguous_city: 0.1, cfless_destination: 0.1, multi_number: 0.05,
    low_cf: 0.05, zip_leading_zero_restored: 0.05, state_hint_overridden: 0.05, price_ambiguous: 0.05, unit_ft: 0.05,
    homonym_state_city: 0.05,
  };
  for (const f of new Set(flags)) c -= penalty[f] ?? 0;
  if (leftoverWords > 2) c -= 0.05;

  return Math.round(Math.min(0.97, Math.max(0.05, c)) * 100) / 100;
}

export function stateName(abbr: string | null): string | null {
  return abbr ? (STATE_BY_ABBR.get(abbr)?.name ?? abbr) : null;
}
