import { extractWithRules } from "./rules";
import type { ExtractionOutcome, MessageContext } from "./schema";

export type {
  ExtractedLoad,
  ExtractionOutcome,
  ExtractionResult,
  MessageContext,
} from "./schema";

/**
 * Extract loads from one WhatsApp message.
 *
 * Deterministic rules only: no API calls, no cost per message, no network
 * dependency, and the same input always produces the same output -- which is
 * what makes the eval in scripts/eval.ts meaningful and the rules tunable.
 */
export function extractLoads(ctx: MessageContext): ExtractionOutcome {
  return extractWithRules(ctx);
}
