/**
 * Export the learned rules and accepted pattern cases into the eval fixtures.
 * npm run rules:export
 *
 *   scripts/fixtures/learned-rules.json     the active extraction_rules as a RuleSet
 *   scripts/fixtures/learned/<message_id>.json   one accepted pattern case each:
 *                                           { body, author, authorPhone, sentAt, expected }
 *
 * `npm run eval` loads both, so a format an admin solved in the queue is
 * replayed on every edit to the extractor and can never silently regress.
 * Commit the files with the rule that produced them.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "../src/lib/db";
import { rulesFromRows, type RuleRow } from "../src/lib/pipeline/rules";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

async function main() {
  const rows = await query<RuleRow>(
    `SELECT id, kind, scope, key, value, source_message_id, created_by, note, active, created_at::text AS created_at
       FROM extraction_rules WHERE active ORDER BY id`,
  );
  const rules = rulesFromRows(rows);
  fs.mkdirSync(FIXTURES, { recursive: true });
  fs.writeFileSync(path.join(FIXTURES, "learned-rules.json"), JSON.stringify(rules, null, 2) + "\n");
  console.log(
    `learned-rules.json: ${Object.keys(rules.places).length} places, ${rules.keywords.length} keywords, ` +
      `${rules.ignoreLines.length} ignore lines, ${rules.lineTemplates.length} templates, ${Object.keys(rules.senderFormats).length} sender formats`,
  );

  const cases = await query<{
    id: number; message_id: number | null; body: string; author: string | null; author_phone: string | null;
    sent_at: string | null; expected: unknown;
  }>(
    `SELECT id, message_id, body, author, author_phone, sent_at::text AS sent_at, expected
       FROM pattern_cases WHERE status = 'accepted' ORDER BY id`,
  );
  const dir = path.join(FIXTURES, "learned");
  fs.mkdirSync(dir, { recursive: true });
  let written = 0;
  for (const c of cases) {
    const name = `${c.message_id ?? `case-${c.id}`}.json`;
    fs.writeFileSync(
      path.join(dir, name),
      JSON.stringify(
        {
          body: c.body,
          author: c.author,
          authorPhone: c.author_phone,
          sentAt: c.sent_at ? new Date(c.sent_at).toISOString() : undefined,
          expected: c.expected,
        },
        null,
        2,
      ) + "\n",
    );
    written++;
  }
  console.log(`learned/: ${written} accepted pattern case(s)`);
  console.log("run `npm run eval` to replay them");
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
