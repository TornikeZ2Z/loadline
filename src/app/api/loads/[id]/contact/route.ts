import { NextResponse } from "next/server";
import { handler, notFound, rateLimit } from "@/lib/api";
import { HttpError, getCurrentUser } from "@/lib/auth";
import { query } from "@/lib/db";
import { getLoad } from "@/lib/loads/query";
import { revealContact } from "@/lib/pipeline/reconcile";
import { normalizePhone } from "@/lib/extract/phone";
import type { ContactResponse } from "@/lib/loads/publicView";
import type { LoadRow } from "@/lib/loads/types";
import type { SessionUser } from "@/lib/auth";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * The one endpoint that returns a phone number.
 *
 * Everything else about a job is public. This is the single door, it needs an
 * account of any kind (driver, poster or admin -- they are all people who might
 * genuinely want to call), and every pass through it is logged with a real
 * actor id. That is what makes the number worth an account: not scarcity, but
 * accountability. `revealContact` handles the once-per-hour dedupe, so clicking
 * Call twice is not counted as twice the interest.
 *
 * A post with no number still answers 200: the sender may have asked to be
 * messaged in the group, and the unmasked original text is the useful part.
 */
export const POST = handler(async (req: Request, ctx: Ctx) => {
  // requireUser()'s message is "Sign in to continue", which is wrong here --
  // the gate is not the site, it is this one number.
  const user = await getCurrentUser();
  if (!user) throw new HttpError(401, "Sign in to see the contact");

  rateLimit(req, "contact", 60);
  const { id } = await ctx.params;

  const load = await getLoad(Number(id));
  if (!load) notFound("Job not found");

  const contact = await revealContact(load.id, user.id);
  if (!contact) notFound("Job not found");

  const phone = normalizePhone(contact.contact_phone);

  // Unmasked, unlike the copy the detail already showed: the driver has an
  // account now, and the footer number in the post is the same number they
  // just revealed.
  const source = load.source_message_id
    ? (
        await query<{ body: string }>(`SELECT body FROM raw_messages WHERE id = $1`, [
          load.source_message_id,
        ])
      )[0] ?? null
    : null;

  const e164 = phone.e164;
  const display = phone.display;
  // "Incomplete" means the post wrote a 7-digit shorthand: there is a number to
  // show, but nothing to dial. A job with no number at all is not incomplete,
  // it simply has none.
  const incomplete = e164 == null && display != null;
  const summary = jobSummary(load, contact.contact_name, display);

  const body: ContactResponse = {
    id: load.id,
    contact: {
      name: contact.contact_name,
      phone: e164,
      display,
      incomplete,
      mode: contact.contact_mode,
      tel: e164 ? `tel:${e164}` : null,
      whatsapp: e164
        ? `https://wa.me/${e164.replace(/\D/g, "")}?text=${encodeURIComponent(waText(load))}`
        : null,
      summary,
    },
    sourceBody: source?.body ?? null,
    viewer: { id: user.id, name: user.name, role: (user as SessionUser).role },
  };

  return NextResponse.json(body);
});

/** One line for the clipboard, and the seed of the WhatsApp opener. */
function jobSummary(load: LoadRow, name: string | null, display: string | null): string {
  const parts = [
    `${load.pickup_label} → ${load.delivery_label}`,
    load.cubic_feet ? `${load.cubic_feet.toLocaleString("en-US")} cf` : "size not stated",
    load.price_per_cf
      ? `$${load.price_per_cf}/cf`
      : load.price_flat
        ? `$${load.price_flat.toLocaleString("en-US")}`
        : "no price",
  ];

  if (load.ready_now) parts.push("ready now");
  else if (load.ready_date) parts.push(`ready ${load.ready_date}`);

  const who = [name, display].filter(Boolean).join(" ");
  if (who) parts.push(who);

  return parts.join(" · ");
}

/**
 * The WhatsApp opener. It quotes the job, never the phone number: the sender
 * posted fifteen lines this morning and needs to know which one this is about.
 */
function waText(load: LoadRow): string {
  const size = load.cubic_feet ? ` (${load.cubic_feet.toLocaleString("en-US")} cf)` : "";
  return `Hi, about your ${load.pickup_label} → ${load.delivery_label}${size} job on LoadLine — still available?`;
}
