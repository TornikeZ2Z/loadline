import { NextResponse } from "next/server";
import { badRequest, handler } from "@/lib/api";
import { HttpError, startSession } from "@/lib/auth";
import { queryOne } from "@/lib/db";
import {
  createDemoAccounts,
  demoModeEnabled,
  ensureDemoData,
  findDemoAccount,
} from "@/lib/demo/accounts";

/**
 * One-click sign-in for the demo, so nobody has to be handed a password.
 *
 * This is a deliberate authentication bypass and only makes sense while the app
 * is a demo running on sample data. `DEMO_MODE=off` disables it without any
 * code change, which is the switch to throw the day real data goes in.
 */
export const POST = handler(async (req: Request) => {
  if (!demoModeEnabled()) {
    throw new HttpError(404, "Demo sign-in is disabled");
  }

  const { role } = (await req.json().catch(() => ({}))) as { role?: string };
  const account = findDemoAccount(role ?? "carrier");
  if (!account) badRequest("Unknown demo role");

  // A cold start on a hosted demo can arrive with an empty database.
  await ensureDemoData();

  let user = await queryOne<{ id: number }>(`SELECT id FROM users WHERE email = $1`, [
    account.email,
  ]);
  if (!user) {
    await createDemoAccounts();
    user = await queryOne<{ id: number }>(`SELECT id FROM users WHERE email = $1`, [account.email]);
  }
  if (!user) throw new HttpError(500, "Could not prepare the demo account");

  await startSession(user.id);
  return NextResponse.json({ id: user.id, name: account.name, role: account.role });
});
