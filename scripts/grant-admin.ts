/**
 * Make a real admin out of an existing account. npm run admin:grant -- <email>
 *
 * A real admin is a `users` row with `role = 'admin'` and `is_demo = false`.
 * The distinction is the whole of src/lib/auth.ts `requireWriteRole`: the demo
 * hands an admin session to anyone who clicks a button on the public sign-in
 * page, so a demo admin may open every console and change nothing in one. Only
 * a real admin resets the corpus, edits a rule or spends money at HERE.
 *
 * One real admin already exists: `admin@movermesh.com`, defined in
 * src/lib/demo/accounts.ts and re-asserted on every cold start so the live site
 * always has somebody who can run a write. This script is for the SECOND one
 * and the ones after it -- a named person with their own password, which is
 * what the shared built-in account should be replaced by.
 *
 * There is deliberately no route, no form and no field on /register that can
 * produce one -- this script and a psql prompt are the only two ways, and they
 * both need access to the machine or the database.
 *
 * It sets no password. The person registers themselves at /register (or already
 * has an account) and this promotes that row, so no password ever passes
 * through a command line or a shell history.
 *
 *   npm run admin:grant -- ops@yourcompany.com
 *   npm run admin:grant -- ops@yourcompany.com --revoke
 */
import { query, queryOne } from "../src/lib/db";
import { ADMIN_EMAIL } from "../src/lib/demo/accounts";

interface Row {
  id: number;
  email: string;
  name: string;
  role: string;
  is_demo: boolean;
}

async function main() {
  const args = process.argv.slice(2);
  const revoke = args.includes("--revoke");
  const email = args.find((a) => !a.startsWith("--"))?.trim().toLowerCase();

  if (!email) {
    console.error("usage: npm run admin:grant -- <email> [--revoke]");
    process.exit(2);
  }

  const user = await queryOne<Row>(
    `SELECT id, email, name, role, is_demo FROM users WHERE email = $1`,
    [email],
  );
  if (!user) {
    console.error(`No account with that email. Create one at /register first, then run this.`);
    process.exit(1);
  }

  if (email === ADMIN_EMAIL) {
    // Both directions. Granting is a no-op -- the row is already an admin --
    // and revoking LOOKS like it worked and is undone by the next cold start,
    // which is the worse of the two failures: somebody would believe they had
    // closed the account. Deleting the row, or setting ADMIN_PASSWORD, are the
    // two things that actually hold.
    console.error(
      `${ADMIN_EMAIL} is defined in src/lib/demo/accounts.ts and re-asserted on every start. ` +
        `Set ADMIN_PASSWORD or delete the row; this script cannot change it.`,
    );
    process.exit(1);
  }

  if (user.is_demo && !revoke) {
    // Promoting a seeded demo row would hand the whole point away: every cold
    // start re-asserts is_demo on those three e-mails anyway (see
    // src/lib/demo/accounts.ts), so the promotion would not even survive.
    console.error(
      `${user.email} is a seeded demo identity. Register a separate account and promote that one.`,
    );
    process.exit(1);
  }

  const role = revoke ? "driver" : "admin";
  await query(`UPDATE users SET role = $1 WHERE id = $2`, [role, user.id]);

  console.log(
    revoke
      ? `${user.email} (${user.name}) is no longer an admin -- role is now driver.`
      : `${user.email} (${user.name}) is a real admin: every console, and every write.`,
  );
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
