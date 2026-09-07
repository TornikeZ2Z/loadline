import { NextResponse } from "next/server";
import { badRequest, handler } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { getPrefs, setInAppPref } from "@/lib/notify/query";

/**
 * What this account wants to be told, and how.
 *
 * Own row only, in both directions: `requireUser()` names the row and there is
 * no id anywhere else in the request to name a different one.
 */
export const GET = handler(async () => {
  const user = await requireUser();
  return NextResponse.json(await getPrefs(user.id));
});

/**
 * ONE FIELD IS WRITABLE, AND THAT IS THE POINT.
 *
 * `email` is on the wire, is false on every row, and is refused here rather than
 * quietly ignored. A PUT that accepted it would leave an account holding a
 * setting that promises mail, on a product with no SES, no verified domain and
 * no bounce handling behind it -- and the day the sender is written, every one
 * of those accounts would start receiving without ever having been asked again.
 * The 400 says so in words a caller can print.
 *
 * The switch flips back on with `sendViaSes` and one line in the CHANNELS map
 * (`src/lib/notify/dispatch.ts`), at which point this refusal becomes a
 * `CHANNELS.email != null` test rather than a constant. SPEC 12.4.
 */
export const PUT = handler(async (req: Request) => {
  const user = await requireUser();
  const body = (await req.json().catch(() => ({}))) as { inapp?: unknown; email?: unknown };

  if (body.email != null) {
    const prefs = await getPrefs(user.id);
    if (!prefs.emailAvailable) {
      badRequest("E-mail alerts aren't available yet, so this setting cannot be turned on");
    }
  }
  if (typeof body.inapp !== "boolean") badRequest("inapp must be true or false");

  return NextResponse.json(await setInAppPref(user.id, body.inapp));
});
