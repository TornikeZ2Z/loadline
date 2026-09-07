import { NextResponse } from "next/server";
import { handler, jobIdFrom, notFound, rateLimit } from "@/lib/api";
import { HttpError, getCurrentUser, isAdminActor } from "@/lib/auth";
import { query } from "@/lib/db";
import { getTruck } from "@/lib/loads/truckQuery";
import { parseGroupLink } from "@/lib/loads/groupLink";
import { revealContact } from "@/lib/pipeline/reconcile";
import { normalizePhone } from "@/lib/extract/phone";
import { boardDay } from "@/lib/loads/present";
import { departureLabel, freeSpaceLabel, truckPlaceLabel } from "@/lib/loads/truckPresent";
import type { ContactResponse } from "@/lib/loads/publicView";
import type { TruckRow } from "@/lib/loads/truckTypes";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * The one endpoint that returns a TRUCK's phone number.
 *
 * The same gate as a job's, in the same words, through the same function: an
 * account of any kind, a per-account rate limit, and a logged reveal with a
 * real actor id. `revealContact("truck", …)` is the job path's own
 * implementation with the table swapped (SPEC §6) -- a second implementation of
 * the phone gate is not acceptable, because the dedupe window and the event are
 * the whole of the accountability story and two copies of them drift.
 *
 * The response is the IDENTICAL `ContactResponse` shape, so `ContactGate` on the
 * client is the same component with a different `kind`. What changes is the
 * plain-text listing it hands to the clipboard, and the WhatsApp opener, which
 * asks whether the SPACE is still open rather than whether the job is still
 * available -- the same question in the other direction of trade (SPEC §15.4).
 *
 * `visibility = 'public'` is checked twice on purpose: once here by `getTruck`,
 * which is what makes an unreviewed truck 404 rather than 403, and once inside
 * `revealTruckContact`'s own WHERE clause, which is what survives a future
 * caller forgetting the first.
 */
export const POST = handler(async (req: Request, ctx: Ctx) => {
  // requireUser()'s message is "Sign in to continue", which is wrong here --
  // the gate is not the site, it is this one number. The string is the same one
  // the job gate uses, because it is the same promise.
  const user = await getCurrentUser();
  if (!user) throw new HttpError(401, "Sign in to see the contact");

  // Scoped to the account, and its OWN bucket: a driver working the truck board
  // and the job board in one session must not spend one allowance twice.
  rateLimit(req, `truck-contact:${user.id}`, 60);

  const { id } = await ctx.params;
  const truckId = jobIdFrom(id);
  if (truckId == null) notFound("Truck not found");

  // Scoped and audienced, and this is the load-bearing call: it is what makes a
  // pending truck, and another account's demo truck, indistinguishable from an
  // id that was never issued.
  const truck = await getTruck(truckId, "public", {
    userId: user.id,
    includeDemo: isAdminActor(user),
  });
  if (!truck) notFound("Truck not found");

  const contact = await revealContact("truck", truck.id, user.id);
  if (!contact) notFound("Truck not found");

  const phone = normalizePhone(contact.contact_phone);

  // The original WhatsApp text, unmasked: the driver has an account now, and
  // the footer number in the post is the number they just revealed. Null for a
  // truck typed into the form, which is every truck until stage 6.
  const source = truck.source_message_id
    ? (
        await query<{ body: string }>(`SELECT body FROM raw_messages WHERE id = $1`, [
          truck.source_message_id,
        ])
      )[0] ?? null
    : null;

  const e164 = phone.e164;
  const display = phone.display;
  const incomplete = e164 == null && display != null;

  const link = parseGroupLink(contact.group_link);

  const body: ContactResponse = {
    id: truck.id,
    contact: {
      name: contact.contact_name,
      phone: e164,
      display,
      incomplete,
      mode: contact.contact_mode,
      tel: e164 ? `tel:${e164}` : null,
      whatsapp: e164
        ? `https://wa.me/${e164.replace(/\D/g, "")}?text=${encodeURIComponent(waText(truck))}`
        : null,
      source: display == null ? null : contact.contact_phone_source,
    },
    group: {
      name: contact.group_name,
      url: link?.url ?? null,
      kind: link?.kind ?? null,
    },
    listingText: truckText(truck, contact.contact_name, display),
    sourceBody: source?.body ?? null,
    viewer: { id: user.id, name: user.name, role: user.role },
  };

  return NextResponse.json(body);
});

/**
 * The truck as plain text -- what a dispatcher pastes into the group.
 *
 * Written for a person reading it in WhatsApp. Nothing is invented: a truck
 * whose post never stated its free space says so in words rather than being
 * left out, because "Space not stated" is the fact a dispatcher needs before
 * they ring, and a silently missing line reads as "small".
 */
function truckText(truck: TruckRow, name: string | null, display: string | null): string {
  const today = boardDay(new Date());
  const from = truckPlaceLabel(truck, "origin");
  const to = truckPlaceLabel(truck, "dest");
  const depart = departureLabel(truck, today);

  const lines: string[] = [
    to.stated ? `${from.text} → ${to.text}` : `Empty in ${from.text} — no destination stated`,
    freeSpaceLabel(truck).text,
    depart.text,
  ];

  if (truck.truck_text) lines.push(truck.truck_text);

  const who = [name, display].filter(Boolean).join(" · ");
  if (who) lines.push(who);

  return lines.join("\n");
}

/**
 * The WhatsApp opener. It quotes the truck, never the phone number.
 *
 * "is the space still open?" and not "still available?": the job version asks
 * the poster whether their freight is still there, and asking a driver the same
 * words about their vehicle reads as a question about the truck's existence
 * (SPEC §15.4).
 */
function waText(truck: TruckRow): string {
  const from = truckPlaceLabel(truck, "origin");
  const to = truckPlaceLabel(truck, "dest");
  const lane = to.stated ? `${from.text} → ${to.text}` : `${from.text}`;
  const space = truck.free_cf != null ? ` (${truck.free_cf.toLocaleString("en-US")} cf free)` : "";
  return `Hi, about your ${lane}${space} truck on MoverMesh — is the space still open?`;
}
