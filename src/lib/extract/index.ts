/**
 * Extract jobs from one WhatsApp message.
 *
 * Deterministic rules only: no model, no API cost, no network dependency, and
 * the same input always produces the same output -- which is what makes
 * `npm run score` (94 real jobs from six real posts) and `npm run eval`
 * meaningful, and the rules tunable.
 *
 * PHASE 0a: `extractInventory` is a thin adapter over the v1 freight extractor
 * in ./rules.ts, so that the contract every other file codes against
 * (ExtractionOutcome / ExtractedJob) is real and stable while the inventory-v1
 * tokenizer is being written. The adapter fabricates nothing: fields the old
 * extractor cannot know (cubic feet, per-cf price, tags, line audits) come out
 * null or empty rather than guessed. Phase 0b replaces the body of this
 * function and deletes rules.ts / spans.ts.
 */
import { extractWithRules, type LegacyLoad } from "./rules";
import { EMPTY_RULES, type RuleSet } from "./rules-store";
import type {
  ExtractedJob,
  ExtractionOutcome,
  MessageContext,
  OriginRef,
} from "./schema";

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
  type KeywordRule,
  type LearnedPlace,
  type LineTemplate,
  type RuleSet,
  type SenderFormat,
} from "./rules-store";

export function extractInventory(
  ctx: MessageContext,
  _rules: RuleSet = EMPTY_RULES,
): ExtractionOutcome {
  const legacy = extractWithRules(ctx);
  const loads = legacy.loads.map((l, i) => toJob(l, i));

  const primary = loads[0] ?? null;
  const contactPhone = primary?.contact_phone ?? ctx.authorPhone ?? null;
  const contactName = primary?.contact_name ?? ctx.authorName ?? null;

  return {
    is_load_post: legacy.is_load_post,
    reason: legacy.reason,
    loads,
    extractor: "inventory-v1",
    contact: {
      name: contactName,
      phone: contactPhone,
      source: contactPhone == null ? null : contactPhone === ctx.authorPhone ? "author" : "footer",
      mode: "public",
    },
    contacts: contactPhone || contactName ? [{ name: contactName, phone: contactPhone }] : [],
    requirements: [],
    flags: [],
    attention: null,
    parse_status: legacy.is_load_post ? "clean" : "unknown",
    truncated: false,
    rfd_anywhere: false,
    message_ready: { ready_now: false, source: null },
    partial_marker: null,
    // Structural only, and deliberately coarse: the real signature comes from
    // the inventory-v1 line classifier in Phase 0b.
    format_signature: `legacy:${legacy.extractor}`,
    // No line classifier yet, so no audit. The admin gutter renders nothing
    // rather than colouring every line "unknown".
    lines: [],
    orphans: [],
    last_origin: loads.length ? loads[loads.length - 1].origin : null,
  };
}

/** So scripts/score-fixture.ts and every existing import keep working. */
export const extractLoads = extractInventory;

function toJob(l: LegacyLoad, index: number): ExtractedJob {
  const origin: OriginRef = {
    label: l.pickup_location,
    city: null,
    state: null,
    zip: null,
    context: null,
    address: l.pickup_address,
    // The v1 extractor only ever read a one-line "A -> B" lane.
    source: "lane",
    state_source: null,
    raw_text: l.pickup_location,
    line_no: index + 1,
    flags: [],
  };

  return {
    pickup_location: l.pickup_location,
    delivery_location: l.delivery_location,
    origin,
    dest_state: null,
    dest_zip: null,
    dest_city: null,

    cubic_feet: null,
    cf_source: null,
    price_per_cf: null,
    price_flat: l.rate_usd,
    price_basis: l.rate_usd == null ? null : "threshold",

    ready_now: false,
    ready_date_text: l.pickup_date_text,
    ready_source: l.pickup_date_text ? "line" : null,
    deliver_by_text: null,

    tags: [],
    notes: l.notes,
    contact_name: l.contact_name,
    contact_phone: l.contact_phone,

    line_no: index + 1,
    line_text: "",
    ordinal: 1,
    flags: [],
    confidence: l.confidence,

    pickup_address: l.pickup_address,
    delivery_address: l.delivery_address,
    pickup_date_text: l.pickup_date_text,
    pickup_date_iso: l.pickup_date_iso,
    pickup_time_text: l.pickup_time_text,
    delivery_date_text: l.delivery_date_text,
    load_type: l.load_type,
    weight_lbs: l.weight_lbs,
    pallets: l.pallets,
    pieces: l.pieces,
    rate_usd: l.rate_usd,
  };
}
