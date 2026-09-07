import { NextResponse } from "next/server";
import { badRequest, handler } from "@/lib/api";
import { requireRole, requireWriteRole } from "@/lib/auth";
import { query } from "@/lib/db";
import {
  SITE_SETTING_FIELDS,
  isSettingKey,
  loadSiteSettings,
  readSiteSettings,
  sanitiseSetting,
  type SettingKey,
} from "@/lib/settings";

/**
 * The five legal-identity values, read and written by an admin.
 *
 * GET is `requireRole` and PUT is `requireWriteRole`, which is the split the
 * whole console runs on: a demo admin may LOOK at the form -- it is part of
 * what there is to show -- but must not change the company name printed on a
 * public Terms page. See the note on `users.is_demo` in db/schema.sql.
 *
 * These are not secrets. Every one of them is printed on a public page the
 * moment it is filled in, which is the point of filling it in; the gate is
 * about who may CHANGE what the site asserts about its operator, not about who
 * may see it.
 */

interface SettingsBody {
  values?: Record<string, unknown>;
}

/** The current values, plus the field definitions the form draws itself from. */
export const GET = handler(async () => {
  await requireRole("admin");
  const settings = await readSiteSettings();
  return NextResponse.json({ settings, fields: SITE_SETTING_FIELDS });
});

/**
 * Replace the five values.
 *
 * A whole-form PUT rather than a per-key PATCH, because that is the shape of
 * the decision being made: these five sentences are read together on one page,
 * and an operator who is filling them in is filling them in as a set.
 *
 * Every value goes through `sanitiseSetting`, and the first failure rejects the
 * WHOLE request -- nothing is written. A half-applied legal identity (a new
 * company name beside last month's address) is worse than the placeholders,
 * because it looks finished.
 *
 * A key set to blank is not an error and is not stored as "": its row is
 * deleted, and the public pages go back to showing the bracketed placeholder.
 * That undo has to exist. A wrong registered address on a Terms page is worse
 * than an obviously missing one.
 */
export const PUT = handler(async (req: Request) => {
  const user = await requireWriteRole("admin");

  const body = (await req.json().catch(() => null)) as SettingsBody | null;
  if (!body || typeof body.values !== "object" || body.values === null) {
    badRequest("values is required");
  }
  const values = body.values as Record<string, unknown>;

  for (const key of Object.keys(values)) {
    if (!isSettingKey(key)) badRequest(`Unknown setting "${key}"`);
  }

  // Validate every field before writing any of them.
  const writes: { key: SettingKey; value: string | null }[] = [];
  for (const field of SITE_SETTING_FIELDS) {
    if (!(field.key in values)) continue; // absent means "leave this one alone"
    const result = sanitiseSetting(field.key, values[field.key]);
    if (!result.ok) badRequest(result.error);
    writes.push({ key: field.key, value: result.value });
  }

  for (const write of writes) {
    if (write.value === null) {
      await query(`DELETE FROM site_settings WHERE key = $1`, [write.key]);
    } else {
      await query(
        `INSERT INTO site_settings (key, value, updated_at, updated_by)
              VALUES ($1, $2, now(), $3)
         ON CONFLICT (key) DO UPDATE
                 SET value = EXCLUDED.value,
                     updated_at = EXCLUDED.updated_at,
                     updated_by = EXCLUDED.updated_by`,
        [write.key, write.value, user.id],
      );
    }
  }

  // Re-read rather than echoing the input: what the caller gets back is what a
  // visitor will see, including any key this request did not touch. Uncached,
  // because the writes above happened inside this same request.
  const settings = await loadSiteSettings();
  return NextResponse.json({ settings });
});
