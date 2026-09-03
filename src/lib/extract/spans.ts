/**
 * Span extraction: pull the typed facts out of a message and mask where they
 * were.
 *
 * Order matters. Numbers are ambiguous in freight text -- "44000" is a weight,
 * "07102" is a ZIP, and both are five digits -- so quantities, money and phone
 * numbers are claimed *before* anything looks for places. Masking rather than
 * deleting keeps token positions stable, which is what lets the extractor tell
 * "newark -> boston" apart from "boston -> newark".
 */
import { MASK } from "@/lib/geo/match";

export interface Quantity {
  weightLbs: number | null;
  pallets: number | null;
  pieces: number | null;
}

export interface MessageScan {
  /** Tokens with every non-place span replaced by MASK. */
  tokens: string[];
  /** Original tokens, same indices, for reading text back out. */
  raw: string[];
  /** Index of each route arrow ("->", "→", ">") in the token array. */
  arrows: number[];
  /** Index of each "to"-style separator that is not part of a place name. */
  separators: number[];
  phones: string[];
  rateUsd: number | null;
  quantities: Quantity;
  /** Verbatim date phrase plus where it sat, so per-lane dates can be found. */
  dates: Array<{ text: string; start: number; end: number }>;
  times: Array<{ text: string; start: number; end: number }>;
  equipment: Array<{ type: string; start: number }>;
  /** Explicit "pickup <place>" / "delivery <place>" markers. */
  markers: Array<{ role: "pickup" | "delivery"; at: number }>;
  /** Token indices where a phone number stood, for bare "<name> <phone>" pairs. */
  phoneAt: number[];
  contactName: string | null;
}

const PHONE_RE =
  /(?:\+?1[\s.\-]?)?(?:\(\d{3}\)|\d{3})[\s.\-]?\d{3}[\s.\-]?\d{4}\b|\b\d{3}[\s.\-]\d{4}\b/g;
const MONEY_RE = /\$\s?\d[\d,]*(?:\.\d{2})?\b/g;

const UNIT_WEIGHT = /^(lbs?|pounds?|#)$/;
const UNIT_KG = /^(kgs?|kilos?)$/;
const UNIT_TON = /^(tons?|t)$/;
const UNIT_PALLET = /^(pallets?|plts?|plt|skids?|pallet)$/;
const UNIT_PIECE = /^(pcs?|pieces?|boxes|cases|cartons?|units?)$/;

const RELATIVE_DATE =
  /^(today|tonight|tmrw|tmr|tomorrow|tomorow|2morrow|asap|now|immediately|yesterday)$/;
const WEEKDAY =
  /^(sunday|sun|monday|mon|tuesday|tues|tue|wednesday|weds|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat)$/;
const MONTH =
  /^(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\.?$/;
const NUMERIC_DATE = /^\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?$/;

const EQUIPMENT: Array<[RegExp, string]> = [
  [/^(reefer|refrigerated|reefers)$/, "reefer"],
  [/^(flatbed|flat|fbed)$/, "flatbed"],
  [/^(stepdeck|step)$/, "step deck"],
  [/^(sprinter|cargo)$/, "sprinter"],
  [/^(hotshot)$/, "hotshot"],
  [/^(container|drayage)$/, "container"],
  [/^(van|dryvan)$/, "dry van"],
  [/^(boxtruck)$/, "box truck"],
];

const CONTACT_TRIGGER = /^(call|contact|text|ask|reach|llamar|hmu)$/;
const NOT_A_NAME = new Set(
  ("me us him her them dispatch dispatcher driver owner broker asap now today anytime " +
    "the my our back soon later direct cell mobile office")
    .split(" "),
);

export function scanMessage(body: string): MessageScan {
  // 1. Claim phone numbers and money before tokenizing -- both contain digits
  //    and separators that would otherwise shatter into meaningless tokens.
  const phones: string[] = [];
  let text = body.replace(PHONE_RE, (m) => {
    phones.push(m.trim());
    return ` p${phones.length - 1} `;
  });

  let rateUsd: number | null = null;
  text = text.replace(MONEY_RE, (m) => {
    if (rateUsd == null) rateUsd = Number(m.replace(/[^\d.]/g, ""));
    return " m ";
  });

  // 2. Normalize route arrows to one token so direction survives tokenizing.
  text = text
    .replace(/-->|->|=>|→|>>|»/g, " arrow ")
    .replace(/\s>\s/g, " arrow ")
    // A spaced dash separates a lane: "louisville ky - cincinnati oh".
    // Only when spaced, so "Winston-Salem" and "10-12" survive intact;
    // phone numbers were already claimed above.
    .replace(/\s[-–—]+\s/g, " arrow ");

  const raw = text
    .toLowerCase()
    .replace(/[^\w$'\-/:., ]+/g, " ")
    .split(/[\s]+/)
    .map((t) => t.replace(/^[.,:;!?]+|[.,:;!?]+$/g, ""))
    .filter(Boolean);

  const tokens = [...raw];
  const scan: MessageScan = {
    tokens,
    raw,
    arrows: [],
    separators: [],
    phones,
    rateUsd,
    quantities: { weightLbs: null, pallets: null, pieces: null },
    dates: [],
    times: [],
    equipment: [],
    markers: [],
    phoneAt: [],
    contactName: null,
  };

  for (let i = 0; i < raw.length; i++) {
    const t = raw[i];

    if (t === "arrow") {
      scan.arrows.push(i);
      tokens[i] = MASK;
      continue;
    }
    // A phone placeholder: remember where it sat, because a bare name
    // sitting next to a number is a contact even with no "call" before it.
    if (/^p\d+$/.test(t)) {
      scan.phoneAt.push(i);
      tokens[i] = MASK;
      continue;
    }
    if (t === "m") {
      tokens[i] = MASK;
      continue;
    }

    // "to" / "into" as a route separator
    if (t === "to" || t === "into") {
      scan.separators.push(i);
      tokens[i] = MASK;
      continue;
    }
    if (t === "from" || t === "out") {
      scan.markers.push({ role: "pickup", at: i });
      tokens[i] = MASK;
      continue;
    }
    if (/^(pickup|pick|pu|pickin)$/.test(t)) {
      scan.markers.push({ role: "pickup", at: i });
      tokens[i] = MASK;
      continue;
    }
    if (/^(delivery|deliver|deliveries|del|dropoff|drop|dlv)$/.test(t)) {
      scan.markers.push({ role: "delivery", at: i });
      tokens[i] = MASK;
      continue;
    }

    // --- quantities: unit glued to the number, "40000lbs" / "12plts" ---
    const glued = t.match(/^([\d,]+)(lbs?|pounds?|kgs?|kilos?|tons?|pallets?|plts?|skids?|pcs?|pieces?)$/);
    if (glued) {
      const value = Number(glued[1].replace(/,/g, ""));
      const unit = glued[2];
      if (UNIT_WEIGHT.test(unit)) scan.quantities.weightLbs ??= Math.round(value);
      else if (UNIT_KG.test(unit)) scan.quantities.weightLbs ??= Math.round(value * 2.20462);
      else if (UNIT_TON.test(unit)) scan.quantities.weightLbs ??= Math.round(value * 2000);
      else if (UNIT_PALLET.test(unit)) scan.quantities.pallets ??= value;
      else scan.quantities.pieces ??= value;
      tokens[i] = MASK;
      continue;
    }

    // --- quantities: a number followed by a unit ---
    const asNumber = Number(t.replace(/,/g, ""));
    if (Number.isFinite(asNumber) && /^[\d,]+$/.test(t)) {
      const next = raw[i + 1] ?? "";
      if (UNIT_WEIGHT.test(next)) {
        scan.quantities.weightLbs ??= Math.round(asNumber);
        maskRange(tokens, i, i + 2);
        i++;
        continue;
      }
      if (UNIT_KG.test(next)) {
        scan.quantities.weightLbs ??= Math.round(asNumber * 2.20462);
        maskRange(tokens, i, i + 2);
        i++;
        continue;
      }
      if (UNIT_TON.test(next)) {
        scan.quantities.weightLbs ??= Math.round(asNumber * 2000);
        maskRange(tokens, i, i + 2);
        i++;
        continue;
      }
      if (UNIT_PALLET.test(next)) {
        scan.quantities.pallets ??= asNumber;
        maskRange(tokens, i, i + 2);
        i++;
        continue;
      }
      if (UNIT_PIECE.test(next)) {
        scan.quantities.pieces ??= asNumber;
        maskRange(tokens, i, i + 2);
        i++;
        continue;
      }
    }

    // A bare number with no unit. In freight shorthand this is a weight
    // ("reefer 44000"), but five digits is also a ZIP, so only claim it when it
    // cannot be one: ZIPs sit next to their state, and any ZIP with a leading
    // zero is unmistakable.
    if (
      Number.isFinite(asNumber) &&
      /^[\d,]+$/.test(t) &&
      !t.startsWith("0") &&
      asNumber >= 1000 &&
      asNumber <= 99000 &&
      scan.quantities.weightLbs == null &&
      !looksLikeZipContext(raw, i)
    ) {
      scan.quantities.weightLbs = Math.round(asNumber);
      tokens[i] = MASK;
      continue;
    }

    // "44k", "38k lbs" -- shorthand thousands, always a weight in this domain
    const shorthand = t.match(/^(\d{1,3})k$/);
    if (shorthand) {
      scan.quantities.weightLbs ??= Number(shorthand[1]) * 1000;
      tokens[i] = MASK;
      if (UNIT_WEIGHT.test(raw[i + 1] ?? "")) {
        tokens[i + 1] = MASK;
        i++;
      }
      continue;
    }

    // Trailer lengths: "53'", "26ft" -- never a place or a quantity we want.
    if (/^\d{2}('|ft|foot|feet)$/.test(t)) {
      tokens[i] = MASK;
      continue;
    }

    // --- dates ---
    if (RELATIVE_DATE.test(t)) {
      scan.dates.push({ text: t, start: i, end: i + 1 });
      tokens[i] = MASK;
      continue;
    }
    if (t === "day" && raw[i + 1] === "after" && raw[i + 2] === "tomorrow") {
      scan.dates.push({ text: "day after tomorrow", start: i, end: i + 3 });
      maskRange(tokens, i, i + 3);
      i += 2;
      continue;
    }
    if (NUMERIC_DATE.test(t)) {
      scan.dates.push({ text: t, start: i, end: i + 1 });
      tokens[i] = MASK;
      continue;
    }
    if (WEEKDAY.test(t)) {
      const qualifier = /^(next|this|coming|upcoming)$/.test(raw[i - 1] ?? "") ? raw[i - 1] : null;
      const start = qualifier ? i - 1 : i;
      scan.dates.push({ text: qualifier ? `${qualifier} ${t}` : t, start, end: i + 1 });
      maskRange(tokens, start, i + 1);
      continue;
    }
    if (MONTH.test(t)) {
      const day = (raw[i + 1] ?? "").match(/^(\d{1,2})(?:st|nd|rd|th)?$/);
      if (day) {
        scan.dates.push({ text: `${t} ${day[1]}`, start: i, end: i + 2 });
        maskRange(tokens, i, i + 2);
        i++;
        continue;
      }
    }
    if (/^\d{1,2}(st|nd|rd|th)$/.test(t) && MONTH.test(raw[i + 1] ?? "")) {
      scan.dates.push({ text: `${raw[i + 1]} ${t}`, start: i, end: i + 2 });
      maskRange(tokens, i, i + 2);
      i++;
      continue;
    }
    if (t === "next" && /^(week|day)$/.test(raw[i + 1] ?? "")) {
      scan.dates.push({ text: `next ${raw[i + 1]}`, start: i, end: i + 2 });
      maskRange(tokens, i, i + 2);
      i++;
      continue;
    }
    if (t === "in" && /^\d{1,2}$/.test(raw[i + 1] ?? "") && /^days?$/.test(raw[i + 2] ?? "")) {
      scan.dates.push({ text: `in ${raw[i + 1]} days`, start: i, end: i + 3 });
      maskRange(tokens, i, i + 3);
      i += 2;
      continue;
    }
    // "2 days ago" -- a stale repost. Dating it correctly is what lets the
    // expiry sweep retire it instead of leaving it undated and live.
    if (/^\d{1,2}$/.test(t) && /^days?$/.test(raw[i + 1] ?? "") && raw[i + 2] === "ago") {
      scan.dates.push({ text: `${t} days ago`, start: i, end: i + 3 });
      maskRange(tokens, i, i + 3);
      i += 2;
      continue;
    }
    if (/^(this|end)$/.test(t) && /^(week|of)$/.test(raw[i + 1] ?? "")) {
      const end = raw[i + 1] === "of" ? i + 3 : i + 2;
      scan.dates.push({ text: raw.slice(i, end).join(" "), start: i, end });
      maskRange(tokens, i, end);
      i = end - 1;
      continue;
    }

    // --- times ---
    const time = t.match(/^(\d{1,2})(?::(\d{2}))?(am|pm|a|p)?$/);
    if (time && (time[3] || time[2])) {
      const qualifier = /^(around|about|after|before|by|at|@)$/.test(raw[i - 1] ?? "")
        ? raw[i - 1]
        : null;
      const start = qualifier ? i - 1 : i;
      scan.times.push({ text: qualifier ? `${qualifier} ${t}` : t, start, end: i + 1 });
      maskRange(tokens, start, i + 1);
      continue;
    }

    // --- equipment ---
    for (const [re, type] of EQUIPMENT) {
      if (re.test(t)) {
        // "dry van" / "box truck" / "power only" read better as pairs.
        if (t === "van" && raw[i - 1] === "dry") {
          scan.equipment.push({ type: "dry van", start: i - 1 });
          maskRange(tokens, i - 1, i + 1);
        } else if (t === "cargo" && raw[i + 1] === "van") {
          scan.equipment.push({ type: "sprinter", start: i });
          maskRange(tokens, i, i + 2);
          i++;
        } else if (t === "step" && raw[i + 1] === "deck") {
          scan.equipment.push({ type: "step deck", start: i });
          maskRange(tokens, i, i + 2);
          i++;
        } else {
          scan.equipment.push({ type, start: i });
          tokens[i] = MASK;
        }
        break;
      }
    }
    if (t === "box" && raw[i + 1] === "truck") {
      scan.equipment.push({ type: "box truck", start: i });
      maskRange(tokens, i, i + 2);
      i++;
      continue;
    }
    if (t === "power" && raw[i + 1] === "only") {
      scan.equipment.push({ type: "power only", start: i });
      maskRange(tokens, i, i + 2);
      i++;
      continue;
    }

    // --- contact name: the word right after "call"/"contact" ---
    if (CONTACT_TRIGGER.test(t)) {
      const candidate = (raw[i + 1] ?? "").replace(/[^a-z]/g, "");
      if (candidate.length >= 2 && candidate.length <= 15 && !NOT_A_NAME.has(candidate)) {
        scan.contactName ??= titleCase(candidate);
        tokens[i + 1] = MASK;
      }
      tokens[i] = MASK;
      continue;
    }
  }

  // "<Name> has a load" / "<Name>'s load" -- a third party being advertised.
  if (!scan.contactName) {
    for (let i = 0; i < raw.length - 1; i++) {
      const owns =
        (/^(has|have|got)$/.test(raw[i + 1] ?? "") && /^(a|an|one)?$/.test(raw[i + 2] ?? "")) ||
        raw[i].endsWith("'s");
      if (!owns) continue;
      const name = raw[i].replace(/'s$/, "").replace(/[^a-z]/g, "");
      const nearLoad = raw.slice(i, i + 4).some((x) => /^loads?$/.test(x));
      if (nearLoad && name.length >= 2 && !NOT_A_NAME.has(name)) {
        scan.contactName = titleCase(name);
        tokens[i] = MASK;
        break;
      }
    }
  }

  return scan;
}

/** A five-digit number hugging a state token is a ZIP, not a weight. */
function looksLikeZipContext(raw: string[], i: number): boolean {
  if (!/^\d{5}$/.test(raw[i])) return false;
  const neighbours = [raw[i - 1], raw[i + 1]];
  return neighbours.some((n) => !!n && /^[a-z]{2}$/.test(n));
}

function maskRange(tokens: string[], start: number, end: number): void {
  for (let i = Math.max(0, start); i < Math.min(tokens.length, end); i++) tokens[i] = MASK;
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/** Restore the literal phone text a masked token stood for. */
export function phoneAt(scan: MessageScan, index: number): string | null {
  const m = (scan.raw[index] ?? "").match(/^p(\d+)$/);
  return m ? (scan.phones[Number(m[1])] ?? null) : null;
}
