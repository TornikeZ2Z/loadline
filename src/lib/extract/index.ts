/**
 * Extract jobs from one WhatsApp message (inventory-v1).
 *
 * Deterministic rules only: no model, no API cost, no network dependency, and
 * the same input always produces the same output -- which is what makes
 * `npm run score` (94 real jobs from six real posts) and `npm run eval`
 * meaningful, and the rules tunable.
 *
 *   P0-P1  tokens.ts     normalize, "Read more", split into lines
 *   P2-P3  tokens.ts     one sticky scanner; lines.ts tags keywords, places, states
 *   P4-P6  lines.ts      classify (context-free, then neighbour-aware), demote empty headers
 *   P7     lines.ts      contacts, requirements, ready flags, signatures
 *   P8-P9  inventory.ts  origin state machine, job assembly, confidence
 *   P10    here          message flags, attention, skip reason
 *
 * Everything here is pure and synchronous: geocoding and the lifecycle are the
 * pipeline's business (src/lib/pipeline).
 */
import { buildLexicon } from "./lexicon";
import { annotate, classifyA, classifyB, demoteHeaders, messagePass, type Line, type LineContext } from "./lines";
import { assemble } from "./inventory";
import { EMPTY_RULES, type RuleSet } from "./rules-store";
import type { ExtractionOutcome, LineAudit, MessageContext } from "./schema";
import { tokenizeBody } from "./tokens";

export type {
  CfSource,
  ExtractedJob,
  ExtractedLoad,
  ExtractionOutcome,
  ExtractionResult,
  LineAudit,
  LineClass,
  MessageContext,
  OriginRef,
  ReadySource,
} from "./schema";

export {
  EMPTY_RULES,
  normalizeRuleKey,
  scopedRules,
  compileTemplate,
  type KeywordRule,
  type IgnoreLineRule,
  type LearnedPlace,
  type LineTemplate,
  type RuleSet,
  type SenderFormat,
} from "./rules-store";

export { KNOWN_SIGNATURES } from "./formats";

const ST_ZIP_LINE = /\b[A-Z]{2}\s*\d{5}\b/;

export function extractInventory(ctx: MessageContext, rules: RuleSet = EMPTY_RULES): ExtractionOutcome {
  const { lines: scanned, truncated: readMore } = tokenizeBody(ctx.body);
  const lineCtx: LineContext = {
    lex: buildLexicon(rules),
    rules,
    format: ctx.senderHints?.format ?? null,
    sentAt: ctx.sentAt,
  };

  // P3-P4
  const lines: Line[] = scanned.map((s) => {
    const { toks, ev } = annotate(s, lineCtx);
    return { s, toks, ev, cls: "UNKNOWN", sub: null, reason: null, flags: [], contacts: [], jobIndex: null };
  });
  for (let i = 0; i < lines.length; i++) {
    lines[i].prevIsDestination = i > 0 && lines[i - 1].cls === "DESTINATION";
    classifyA(lines[i], lineCtx);
  }
  // P5
  for (let i = 0; i < lines.length; i++) classifyB(lines, i, lineCtx);
  // P6
  demoteHeaders(lines);
  // P7
  const pass = messagePass(lines, lineCtx);
  // P8-P9
  const asm = assemble(lines, pass, ctx);

  // P10 -- message flags, skip reason, attention.
  const flags: string[] = [];
  const push = (f: string) => { if (!flags.includes(f)) flags.push(f); };
  if (readMore) { push("read_more"); }
  for (const f of asm.flags) push(f);
  if (readMore && !flags.includes("truncated_tail")) push("truncated_tail");
  const truncated = readMore || asm.truncated;

  const jobs = asm.loads;
  const contact = pass.contacts.find((c) => c.phone) ?? null;
  const authorIsPhone = isPhoneShaped(ctx.authorName);
  const primary = contact
    ? { name: contact.name, phone: contact.phone, source: "footer" as const }
    : { name: authorIsPhone ? null : (ctx.authorName ?? null), phone: ctx.authorPhone ?? null, source: ctx.authorPhone || ctx.authorName ? ("author" as const) : null };
  if (!primary.phone) push("no_contact");

  const unknownContent = lines.filter((L) => L.cls === "UNKNOWN");
  const unknownNumeric = unknownContent.filter((L) => L.flags.includes("unknown_numeric")).length;
  const stZipLines = lines.filter((L) => ST_ZIP_LINE.test(L.s.text)).length;
  const structural = lines.some((L) => L.cls === "DESTINATION" || L.cls === "LANE" || L.cls === "HEADER");

  let reason: string | null = null;
  if (jobs.length === 0) {
    push("no_jobs");
    if (asm.orphans.length) { reason = "no_origin"; push("no_origin"); }
    else if (unknownNumeric > 0 || (stZipLines >= 3 && !structural)) { reason = "unknown_format"; push("unknown_format"); }
    else reason = "not_a_load";
  }
  if (unknownContent.length) {
    push(`unknown_lines:${unknownContent.length}`);
    if (jobs.length) push("partial_unknown");
  }

  const needsReview = jobs.some((j) => j.flags.includes("needs_review"));
  const attention =
    reason === "unknown_format" ? "unknown_format"
    : reason === "no_origin" ? "no_origin"
    : reason === "not_a_load" ? null
    : asm.originUnresolved ? "origin_unresolved"
    : unknownContent.length ? "unknown_lines"
    : truncated ? "truncated"
    : flags.includes("state_header_ambiguous") ? "state_header_ambiguous"
    : needsReview ? "needs_review"
    : !primary.phone ? "no_contact"
    : null;

  const parse_status: ExtractionOutcome["parse_status"] =
    jobs.length === 0 ? "unknown"
    : (unknownContent.length || truncated || asm.originUnresolved || asm.orphans.length || flags.includes("state_header_ambiguous")) ? "partial"
    : "clean";

  const audit: LineAudit[] = lines.map((L) => ({
    n: L.s.n,
    text: L.s.text,
    class: L.cls,
    sub: L.sub ?? null,
    tokens: L.toks.map((t) => ({
      cls: t.role ? `${t.cls}:${t.role}` : t.st ? `${t.cls}:ST` : t.stname ? `${t.cls}:STNAME` : t.city ? `${t.cls}:CITY` : t.kw ? `${t.cls}:${[...t.kw.kinds][0]}` : t.cls,
      raw: t.raw,
      norm: t.norm,
      value: t.value ?? null,
      start: t.start,
      end: t.end,
    })),
    flags: [...new Set([...L.flags, ...L.ev.flags])],
    reason: L.reason,
    job_index: L.jobIndex != null && L.jobIndex >= 0 ? L.jobIndex : null,
  }));

  return {
    is_load_post: jobs.length > 0,
    reason,
    loads: jobs,
    extractor: "inventory-v1",
    contact: { name: primary.name, phone: primary.phone, source: primary.source, mode: pass.dm ? "dm" : "public" },
    contacts: pass.contacts,
    requirements: pass.requirements,
    flags,
    attention,
    parse_status,
    truncated,
    rfd_anywhere: pass.rfdAnywhere,
    message_ready: pass.messageReady,
    partial_marker: pass.partialMarker,
    format_signature: pass.formatSignature,
    lines: audit,
    orphans: asm.orphans,
    last_origin: asm.lastOrigin,
  };
}

/** So scripts/score-fixture.ts and every existing import keep working. */
export const extractLoads = extractInventory;

function isPhoneShaped(s: string | null | undefined): boolean {
  if (!s) return false;
  const digits = s.replace(/\D/g, "");
  return digits.length >= 7 && /^[\s+()\d.\-]+$/.test(s.trim());
}
