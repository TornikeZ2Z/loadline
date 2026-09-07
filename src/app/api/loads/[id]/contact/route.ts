import { NextResponse } from "next/server";
import { handler, jobIdFrom, notFound, rateLimit } from "@/lib/api";
import { HttpError, getCurrentUser, isAdminActor } from "@/lib/auth";
import { query } from "@/lib/db";
import { getLoad } from "@/lib/loads/query";
import { parseGroupLink } from "@/lib/loads/groupLink";
import { revealContact } from "@/lib/pipeline/reconcile";
import { normalizePhone } from "@/lib/extract/phone";
import type { ContactResponse } from "@/lib/loads/publicView";
import type { LoadRow } from "@/lib/loads/types";

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
 * A post with no number still answers 200, and it is no longer a dead end: the
 * response names the group, carries the group's stored WhatsApp link when an
 * admin set one, and always carries the job as plain text to paste there. The
 * group link is gated with the number rather than published, because a `wa.me`
 * link IS a phone number -- see the note on ContactResponse.
 */
export const POST = handler(async (req: Request, ctx: Ctx) => {
  // requireUser()'s message is "Sign in to continue", which is wrong here --
  // the gate is not the site, it is this one number.
  const user = await getCurrentUser();
  if (!user) throw new HttpError(401, "Sign in to see the contact");

  // Scoped to the account, not the network address: a header cannot forge a
  // user id, and every reveal already needs one. Still 60 a minute, still the
  // "contact" bucket -- only the key is now something the caller cannot pick.
  rateLimit(req, `contact:${user.id}`, 60);

  const { id } = await ctx.params;
  const jobId = jobIdFrom(id);
  if (jobId == null) notFound("Job not found");

  // Audienced, and this is the load-bearing call: `revealContact` below is a
  // bare `WHERE l.id = $1` with no predicate of its own, so a listing this
  // caller may not see has to fail HERE or its phone number leaves the server.
  // A demo account still reveals contacts on the real corpus, and still reveals
  // its own listing's; nobody else can reach a demo listing at all.
  const load = await getLoad(jobId, {
    userId: user.id,
    includeDemo: isAdminActor(user),
  });
  if (!load) notFound("Job not found");

  // `"job"` is the kind, and it is stated rather than defaulted: the reveal is
  // one function over two tables now (SPEC §6), and a default would let the
  // truck handler inherit the job branch by forgetting to say so.
  const contact = await revealContact("job", load.id, user.id);
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

  // Re-parsed rather than trusted: the column is admin-typed, and a stored link
  // that no longer validates must not become a broken href.
  const link = parseGroupLink(contact.group_link);

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
      source: display == null ? null : contact.contact_phone_source,
    },
    group: {
      name: contact.group_name,
      url: link?.url ?? null,
      kind: link?.kind ?? null,
    },
    listingText: jobText(load, contact.contact_name, display),
    sourceBody: source?.body ?? null,
    viewer: { id: user.id, name: user.name, role: user.role },
  };

  return NextResponse.json(body);
});

/**
 * The job as plain text -- what a driver pastes into the group when there is no
 * number to call, and what "Copy the job" puts on the clipboard either way.
 *
 * Written for a person reading it in WhatsApp, not for a parser: short lines,
 * no labels the sender did not use, and the sender's OWN line last so they can
 * see at a glance which of the fifteen they posted this morning is being asked
 * about. Nothing is invented -- a field the post did not state is left out.
 */
function jobText(load: LoadRow, name: string | null, display: string | null): string {
  const lines: string[] = [`${load.pickup_label} → ${load.delivery_label}`];

  const size: string[] = [];
  if (load.cubic_feet) size.push(`${load.cubic_feet.toLocaleString("en-US")} cf`);
  if (load.price_per_cf) size.push(`$${load.price_per_cf}/cf`);
  else if (load.price_flat) size.push(`$${Number(load.price_flat).toLocaleString("en-US")}`);
  if (size.length) lines.push(size.join(" · "));

  const when: string[] = [];
  if (load.ready_now) when.push("Ready now");
  else if (load.ready_date) when.push(`Ready ${load.ready_date}`);
  if (load.deliver_by) when.push(`deliver by ${load.deliver_by}`);
  if (when.length) lines.push(when.join(" · "));

  const who = [name, display].filter(Boolean).join(" · ");
  if (who) lines.push(who);

  if (load.line_text) lines.push(`Your line: ${load.line_text}`);

  return lines.join("\n");
}

/**
 * The WhatsApp opener. It quotes the job, never the phone number: the sender
 * posted fifteen lines this morning and needs to know which one this is about.
 */
function waText(load: LoadRow): string {
  const size = load.cubic_feet ? ` (${load.cubic_feet.toLocaleString("en-US")} cf)` : "";
  return `Hi, about your ${load.pickup_label} → ${load.delivery_label}${size} job on MoverMesh — still available?`;
}
