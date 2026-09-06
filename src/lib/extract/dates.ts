/**
 * Relative-date resolution for load posts.
 *
 * Design note: the model is asked for the *verbatim* date phrase from the
 * message ("tomorrow", "Mon", "9/5", "next Tuesday") rather than a computed
 * calendar date. Date arithmetic is deterministic, cheap, and unit-testable, so
 * it belongs in code -- and "tomorrow" only means something relative to when
 * the message was sent, which the model does not reliably know. The model's own
 * ISO guess is kept as a fallback for phrasings this parser does not cover.
 */

/** Timezone used to decide what day a message was sent on. */
export const DEFAULT_TZ = process.env.LOAD_TZ ?? "America/New_York";

export interface LocalDate {
  y: number;
  m: number; // 1-12
  d: number; // 1-31
}

export function toLocalDate(instant: Date, tz: string = DEFAULT_TZ): LocalDate {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

export function isoOf(d: LocalDate): string {
  return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
}

export function addDays(d: LocalDate, days: number): LocalDate {
  const utc = new Date(Date.UTC(d.y, d.m - 1, d.d));
  utc.setUTCDate(utc.getUTCDate() + days);
  return { y: utc.getUTCFullYear(), m: utc.getUTCMonth() + 1, d: utc.getUTCDate() };
}

/** 0 = Sunday. */
export function dayOfWeek(d: LocalDate): number {
  return new Date(Date.UTC(d.y, d.m - 1, d.d)).getUTCDay();
}

export function diffDays(a: LocalDate, b: LocalDate): number {
  const ms = Date.UTC(a.y, a.m - 1, a.d) - Date.UTC(b.y, b.m - 1, b.d);
  return Math.round(ms / 86_400_000);
}

const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, weds: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};

/**
 * Resolve a date phrase against the day the message was sent.
 * Returns an ISO date string, or null if the phrase carries no date.
 */
export function resolveDatePhrase(
  phrase: string | null | undefined,
  sentAt: Date,
  tz: string = DEFAULT_TZ,
): string | null {
  if (!phrase) return null;
  const today = toLocalDate(sentAt, tz);
  const t = phrase
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return null;

  // Already an ISO date
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return isoOf({ y: +iso[1], m: +iso[2], d: +iso[3] });

  if (/\b(today|tonight|this morning|this afternoon|this evening|asap|now|immediately|same day)\b/.test(t)) {
    return isoOf(today);
  }
  if (/\bday after tomorrow\b/.test(t)) return isoOf(addDays(today, 2));
  if (/\b(tomorrow|tmrw|tmr|tomm?orrow|2morrow|next day)\b/.test(t)) {
    return isoOf(addDays(today, 1));
  }
  if (/\byesterday\b/.test(t)) return isoOf(addDays(today, -1));

  const inDays = t.match(/\bin (\d{1,2}) days?\b/);
  if (inDays) return isoOf(addDays(today, Number(inDays[1])));

  // "2 days ago" -- a stale repost. Dating it correctly is what lets the expiry
  // sweep retire it, instead of leaving it undated and sitting live on the board.
  const daysAgo = t.match(/\b(\d{1,2}) days? ago\b/);
  if (daysAgo) return isoOf(addDays(today, -Number(daysAgo[1])));

  // "this week" is a soft commitment rather than a date. Anchoring it to today
  // keeps the load searchable instead of dropping it into the undated bucket.
  if (/\bthis week\b/.test(t)) return isoOf(today);

  // "next week" with no weekday -> the coming Monday
  const weekdayMatch = t.match(
    /\b(next |this |coming |upcoming )?(sunday|sun|monday|mon|tuesday|tues|tue|wednesday|weds|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat)\b/,
  );
  if (weekdayMatch) {
    const qualifier = (weekdayMatch[1] ?? "").trim();
    const target = WEEKDAYS[weekdayMatch[2]];
    // The coming occurrence. A bare weekday name on that same weekday means
    // today ("loading Friday", said on Friday).
    let delta = (target - dayOfWeek(today) + 7) % 7;
    if (qualifier === "next") {
      // "next Tuesday" means the Tuesday of the following week. Said on a
      // Thursday, the coming Tuesday is already next week, so adding a week
      // would overshoot by seven days -- only add one when it would not.
      if (!isInFollowingWeek(today, delta)) delta += 7;
      if (delta === 0) delta = 7;
    }
    return isoOf(addDays(today, delta));
  }
  if (/\bnext week\b/.test(t)) {
    const delta = ((1 - dayOfWeek(today) + 7) % 7) || 7;
    return isoOf(addDays(today, delta));
  }
  if (/\b(end of week|eow|by friday)\b/.test(t)) {
    const delta = (5 - dayOfWeek(today) + 7) % 7;
    return isoOf(addDays(today, delta));
  }

  // "Sept 5", "5 Sept", "October 3rd"
  const monthName = t.match(
    /\b(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\b\s*(\d{1,2})(?:st|nd|rd|th)?\b/,
  );
  const dayFirst = t.match(
    /\b(\d{1,2})(?:st|nd|rd|th)?\s*(?:of\s*)?(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\b/,
  );
  if (monthName || dayFirst) {
    const m = MONTHS[(monthName ? monthName[1] : dayFirst![2])];
    const d = Number(monthName ? monthName[2] : dayFirst![1]);
    const yearMatch = t.match(/\b(20\d{2})\b/);
    if (yearMatch) return isoOf({ y: Number(yearMatch[1]), m, d });
    return isoOf(inferYear(m, d, today));
  }

  // "9/5", "9-5-2026", "09/05"
  const numeric = t.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/);
  if (numeric) {
    const m = Number(numeric[1]);
    const d = Number(numeric[2]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      if (numeric[3]) {
        const yr = Number(numeric[3]);
        return isoOf({ y: yr < 100 ? 2000 + yr : yr, m, d });
      }
      return isoOf(inferYear(m, d, today));
    }
  }

  return null;
}

/**
 * Does `today + delta` land in the calendar week after `today`?
 * Weeks start Monday, which is how dispatchers talk about "next week".
 */
function isInFollowingWeek(today: LocalDate, delta: number): boolean {
  const mondayOffset = (dayOfWeek(today) + 6) % 7; // days since Monday
  const daysLeftThisWeek = 6 - mondayOffset;
  return delta > daysLeftThisWeek && delta <= daysLeftThisWeek + 7;
}

/**
 * A bare "9/5" means the next 9/5 that makes sense: allow a little slack into
 * the past (a message posted at 11pm about "today"), otherwise look forward.
 */
function inferYear(m: number, d: number, today: LocalDate): LocalDate {
  for (const y of [today.y, today.y + 1, today.y - 1]) {
    const delta = diffDays({ y, m, d }, today);
    if (delta >= -14 && delta <= 300) return { y, m, d };
  }
  return { y: today.y, m, d };
}

/** "around 10", "10am", "14:30", "after 2pm" -> "HH:MM:SS" plus the raw note. */
export function resolveTimePhrase(
  phrase: string | null | undefined,
): { time: string | null; note: string | null } {
  if (!phrase) return { time: null, note: null };
  const raw = phrase.trim();
  if (!raw) return { time: null, note: null };
  const t = raw.toLowerCase();

  const m = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?\b/);
  if (!m) return { time: null, note: raw };

  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const mer = m[3]?.[0];

  if (hour > 23 || minute > 59) return { time: null, note: raw };
  if (mer === "p" && hour < 12) hour += 12;
  if (mer === "a" && hour === 12) hour = 0;
  // No meridiem: freight pickups at "7" or "8" mean morning, "1"-"5" afternoon.
  if (!mer && hour >= 1 && hour <= 5) hour += 12;

  return {
    time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`,
    note: raw,
  };
}

/**
 * When a website post stops being useful: the ready day's end plus a grace
 * window, or 72 hours when undated. Batch posts never use this -- their
 * expiry is the sender's silence (src/lib/pipeline/reconcile.ts).
 */
export function computeExpiry(
  pickupDateIso: string | null,
  sentAt: Date,
  graceHours = 12,
): Date {
  if (!pickupDateIso) {
    return new Date(sentAt.getTime() + 72 * 3600_000);
  }
  const [y, m, d] = pickupDateIso.split("-").map(Number);
  // End of the pickup day, interpreted generously in US Eastern (UTC-4/5).
  const endOfDay = Date.UTC(y, m - 1, d, 23 + 5, 59, 59);
  return new Date(endOfDay + graceHours * 3600_000);
}
