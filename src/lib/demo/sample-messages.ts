/**
 * Sample WhatsApp traffic (A §11.1).
 *
 * The six real posts verbatim, plus the variants that make the lifecycle and
 * the admin queue visible in a demo:
 *   - the same sender posting on two days (E then F): supersession;
 *   - a repost of C two hours later: sightings bump, no new rows;
 *   - D's truncated post and its one-line continuation: inherited origin;
 *   - Luis's Spanish numbered list from Miami: the README walkthrough's
 *     FL -> NJ routes, with a footer phone the contact gate can reveal;
 *   - a stale full post from a sender who went silent: expiry;
 *   - chatter, a requirement-only post, and one unknown-format post that
 *     lands in the "Needs attention" queue.
 *
 * Timestamps are relative to the seed run so "yesterday's post" is always
 * yesterday's.
 */
import { REAL_MESSAGES } from "../../../scripts/fixtures/real-whatsapp";

export interface SeedMessage {
  group: string;
  author: string;
  phone?: string;
  /** Hours before the seed run that this was sent. */
  hoursAgo: number;
  body: string;
}

/**
 * `invite` is a group's WhatsApp invite link, the only URL that can reach a
 * group from a web page (there is none for an individual message). It cannot be
 * derived -- a group admin generates it -- so it is stored, and an admin sets
 * it per group in the console.
 *
 * Only "Movers Nationwide" has one here, on purpose: it is the group message B
 * was posted in, the one post in the corpus that carries no phone anywhere, so
 * the demo shows both halves of §1.4 -- a no-phone job WITH a group link, and
 * (in the other groups) the same block without one, still offering "Copy the
 * job". The code is a placeholder shape, not a real invite; a real one is
 * pasted in at /admin?tab=groups.
 */
export const GROUPS = [
  {
    waId: "120363011111111111@g.us",
    name: "Movers Nationwide",
    description: "HHG backhauls coast to coast",
    invite: "https://chat.whatsapp.com/DemoMoversNationwide01",
  },
  { waId: "120363022222222222@g.us", name: "NJ Movers Loads", description: "Tri-State movers, jobs leaving NJ" },
  { waId: "120363033333333333@g.us", name: "FL Movers Backhaul", description: "Florida movers heading north" },
  { waId: "120363044444444444@g.us", name: "West Coast HHG", description: "California, Arizona, Nevada inventories" },
] as Array<{ waId: string; name: string; description: string; invite?: string }>;

const real = (letter: string) => REAL_MESSAGES.find((m) => m.format.startsWith(letter))!.body;

export const MESSAGES: SeedMessage[] = [
  // --- A: title state header, city headers, bare "ST ZIP CF" lines --------------
  { group: "Movers Nationwide", author: "Dispatcher A", phone: "+16035550100", hoursAgo: 20, body: real("A") },

  // --- B: "From City ST ZIP" / "To ST ZIP 350cf", no phone anywhere -------------
  { group: "Movers Nationwide", author: "Dispatch (unnamed)", hoursAgo: 30, body: real("B") },

  // --- C: "NEW JERSEY" + "📍 Kearny", cf-first lines; reposted two hours ago ----
  { group: "NJ Movers Loads", author: "Marco", phone: "+12015550199", hoursAgo: 8, body: real("C") },
  { group: "NJ Movers Loads", author: "Marco", phone: "+12015550199", hoursAgo: 2, body: real("C") },

  // --- D: "From:Kent ,Seattle ,WA", truncated by WhatsApp; then a continuation --
  { group: "Movers Nationwide", author: "Dispatcher D", phone: "+14105550188", hoursAgo: 5, body: real("D") },
  { group: "Movers Nationwide", author: "Dispatcher D", phone: "+14105550188", hoursAgo: 4.5, body: "To FL 34113 200cf" },

  // --- E then F: the same sender on two days -> E's jobs are delisted ----------
  { group: "Movers Nationwide", author: "Dispatcher E", phone: "+17865550128", hoursAgo: 30, body: real("E") },
  { group: "Movers Nationwide", author: "Dispatcher E", phone: "+17865550128", hoursAgo: 4, body: real("F") },

  // --- G: "FROM LA" is Los Angeles -------------------------------------------
  {
    group: "West Coast HHG",
    author: "Dispatcher G",
    phone: "+13105550177",
    hoursAgo: 10,
    body: "FROM LA\nTo FL 33435 350cf\nTo GA 30303 400cf",
  },

  // --- H: one-line lanes -------------------------------------------------------
  {
    group: "NJ Movers Loads",
    author: "Hank",
    phone: "+12015552200",
    hoursAgo: 12,
    body: "Newark NJ -> Miami FL 33101 350cf RFD\nEdison NJ -> Orlando FL 32801 500cf",
  },

  // --- I: the flagship FL -> NJ demo data (Spanish numbered list) --------------
  {
    group: "FL Movers Backhaul",
    author: "Luis",
    phone: "+13055550142",
    hoursAgo: 14,
    body: `Desde Miami FL:
1. GA 30303 400 $3.50 por cube
2. NC 28202 300 listo
3. NJ 07032 400 $3.25 por cube
4. NJ 08234 250 listo
5. NJ 07102 350
6. NY 11217 300
7. CT 06511 200 listo
Llamar Luis 305-555-0142`,
  },

  // --- J: a state header whose block holds several pinned cities ---------------
  {
    group: "Movers Nationwide",
    author: "Dispatcher J",
    phone: "+16145550133",
    hoursAgo: 16,
    body: "OHIO\n📍 Columbus\nFL 33435 300\nGA 30303 400\n📍 Springfield\nTX 75201 500",
  },

  // --- K: a full post from a sender who then went silent -> expired ------------
  {
    group: "Movers Nationwide",
    author: "Dispatcher K",
    phone: "+12145550199",
    hoursAgo: 120,
    body: "FROM DALLAS TX:\n300 - FL 33101\n400 - GA 30303",
  },

  // --- chatter that must not become a job --------------------------------------
  { group: "Movers Nationwide", author: "Ruslan", hoursAgo: 2, body: "Good morning everyone 🙏" },
  { group: "NJ Movers Loads", author: "Marcus", hoursAgo: 3.4, body: "still available?" },
  { group: "NJ Movers Loads", author: "Rosa", hoursAgo: 3.2, body: "taken" },
  { group: "FL Movers Backhaul", author: "Nina", hoursAgo: 5.5, body: "thanks!" },

  // --- a requirement-only post ---------------------------------------------------
  {
    group: "Movers Nationwide",
    author: "Admin",
    hoursAgo: 40,
    body: "MUST HAVE ACTIVE DOT AND INSURANCE. NO BROKERS.",
  },

  // --- an unknown format: feeds the admin "Needs attention" queue ----------------
  {
    group: "FL Movers Backhaul",
    author: "Dispatcher U",
    phone: "+19545550166",
    hoursAgo: 6,
    body: "33435/350, 33180/200",
  },
];
