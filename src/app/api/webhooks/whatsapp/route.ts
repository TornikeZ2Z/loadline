/**
 * WhatsApp Cloud API webhook.
 *
 * GET  -- the one-time subscription handshake from Meta's dashboard.
 * POST -- message delivery.
 *
 * Two things matter for correctness here:
 *
 * 1. Answer fast. Meta retries any delivery that does not get a prompt 2xx, and
 *    it disables a webhook that keeps failing. Extraction takes seconds, so this
 *    route only writes rows to `raw_messages` and returns; POST /api/cron/process
 *    does the work.
 *
 * 2. Verify the signature. The X-Hub-Signature-256 header is an HMAC of the raw
 *    request body using the app secret. It must be checked against the exact
 *    bytes received, before parsing, or anyone who learns the URL can inject
 *    loads into the marketplace.
 */
import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { handler } from "@/lib/api";
import { HttpError } from "@/lib/auth";
import { ingestMessage } from "@/lib/pipeline/ingest";

export const GET = handler(async (req: Request) => {
  const sp = new URL(req.url).searchParams;
  const mode = sp.get("hub.mode");
  const token = sp.get("hub.verify_token");
  const challenge = sp.get("hub.challenge");

  if (mode === "subscribe" && token && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    // Meta requires the challenge echoed back as bare text, not JSON.
    return new Response(challenge ?? "", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  }
  throw new HttpError(403, "Verification failed");
});

export const POST = handler(async (req: Request) => {
  const raw = await req.text();
  verifySignature(raw, req.headers.get("x-hub-signature-256"));

  let payload: CloudApiPayload;
  try {
    payload = JSON.parse(raw) as CloudApiPayload;
  } catch {
    throw new HttpError(400, "Body is not valid JSON");
  }

  let accepted = 0;
  let duplicates = 0;
  let ignored = 0;

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value?.messages?.length) {
        // Delivery receipts and read statuses arrive on the same webhook.
        ignored++;
        continue;
      }

      const profileByWaId = new Map(
        (value.contacts ?? []).map((c) => [c.wa_id, c.profile?.name ?? null]),
      );

      for (const message of value.messages) {
        const body = textOf(message);
        if (!body) {
          ignored++; // images, audio, stickers, reactions
          continue;
        }

        // Group identity: Cloud API group delivery reports the chat on the
        // message (field name has moved around across versions), so accept any
        // of them and fall back to the business phone number, which keeps
        // single-thread deployments working.
        const groupWaId =
          message.group_id ?? value.group_id ?? value.metadata?.phone_number_id ?? null;
        const groupName =
          value.group_subject ?? message.group_subject ?? value.metadata?.display_phone_number ?? null;

        const result = await ingestMessage({
          waMessageId: message.id,
          body,
          // Cloud API sends unix seconds as a string.
          sentAt: new Date(Number(message.timestamp) * 1000),
          authorName: profileByWaId.get(message.from) ?? null,
          authorPhone: message.from ? `+${message.from.replace(/\D/g, "")}` : null,
          groupWaId,
          groupName,
          payload: { entry_id: entry.id, message, metadata: value.metadata },
        });

        if (result.duplicate) duplicates++;
        else accepted++;
      }
    }
  }

  return NextResponse.json({ accepted, duplicates, ignored });
});

function verifySignature(rawBody: string, header: string | null): void {
  const secret = process.env.WHATSAPP_APP_SECRET;

  if (!secret) {
    // Explicit, loud opt-out for local testing. Never leave this on in prod:
    // an unsigned webhook is an open write endpoint into the load database.
    if (process.env.WHATSAPP_ALLOW_UNSIGNED === "1" && process.env.NODE_ENV !== "production") {
      return;
    }
    throw new HttpError(500, "WHATSAPP_APP_SECRET is not configured");
  }

  if (!header?.startsWith("sha256=")) throw new HttpError(401, "Missing signature");

  const expected = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const provided = header.slice("sha256=".length);

  if (
    provided.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(provided, "hex"), Buffer.from(expected, "hex"))
  ) {
    throw new HttpError(401, "Bad signature");
  }
}

/** Text can arrive as a plain message, a caption, or a quoted reply. */
function textOf(message: CloudApiMessage): string | null {
  const candidate =
    message.text?.body ??
    message.image?.caption ??
    message.document?.caption ??
    message.video?.caption ??
    message.button?.text ??
    message.interactive?.list_reply?.title ??
    null;
  const trimmed = candidate?.trim();
  return trimmed ? trimmed : null;
}

// --- Cloud API payload shapes (only the fields this route reads) ------------

interface CloudApiPayload {
  object?: string;
  entry?: Array<{
    id?: string;
    changes?: Array<{
      field?: string;
      value?: {
        metadata?: { phone_number_id?: string; display_phone_number?: string };
        contacts?: Array<{ wa_id: string; profile?: { name?: string } }>;
        messages?: CloudApiMessage[];
        statuses?: unknown[];
        group_id?: string;
        group_subject?: string;
      };
    }>;
  }>;
}

interface CloudApiMessage {
  id: string;
  from: string;
  timestamp: string;
  type?: string;
  text?: { body?: string };
  image?: { caption?: string };
  video?: { caption?: string };
  document?: { caption?: string };
  button?: { text?: string };
  interactive?: { list_reply?: { title?: string } };
  group_id?: string;
  group_subject?: string;
}
