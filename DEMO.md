# MoverMesh — demo walkthrough

A 5-minute tour of what this does. Everything runs locally with no accounts, no API keys
and no database to install.

```bash
npm install
npm run seed
npm run dev
```

`npm run seed` prints what it built — 19 WhatsApp messages, 111 jobs, 98 of them available,
`FL → NJ available: 3`. Open <http://localhost:3000>. **You are already in** — the board is
public, and browsing it never asks for an account.

> **This is test mode.** The WhatsApp messages are a simulated export, not a live
> connection. Everything downstream of them — extraction, geocoding, supersession, expiry,
> search — is the real implementation running on that data.

If you want the pitch rather than the tour, `/for-movers` is the marketing page: find work,
offer work or space, understand the source — and a short list of what to settle with the
poster before you drive. `/how-it-works` covers the same ground for a customer who wants to
know why the board can be trusted.

---

## 1. The board

A map of routes, not a list of pins. Every job is an arc from its pickup to its delivery,
with direction chevrons and a line that gets thicker as the job gets bigger. The panel in
the corner counts what is on screen — *All 98 jobs · 42,506 cf ≈ 28.3 truckloads* when the
whole country fits, switching to *66 jobs in view · 26,006 cf ≈ 17.3 truckloads · of 98
filtered* as soon as you zoom past some of them. At low zoom each pickup state also carries
a `FL · 15 jobs · 4,900 cf` pill.

Hover a card and its route lights up while the others dim. Click one and the detail opens
beside the map.

### Tell it where you are

Press **Where are you?** in the header. Type `Miami` and pick **Miami, FL** from the
drop-down (or press **Use GPS**), then press **Save**. Three things change at once: jobs
sort by distance to the pickup, every card gains a distance line (*1 mi from you* on the
Miami posts, *1093 mi from you* on the Kearny ones), and the header control now reads
*Near Miami, FL*.

> With no `HERE_API_KEY` the drop-down still answers from the local table — `Miami`,
> `philly`, `socal` and `07102` all suggest — but address-level and some literal queries
> (`Miami, FL` among them) come back empty. Type the place and press **Save** anyway: the
> offline gazetteer resolves it, which is why this walk needs no key.

Open a job now and the pickup line carries the trip too: `1,279 mi by road · 19 h 25 m
driving` with a HERE key; without one the same line falls back to straight-line miles.

That location is stored in your browser and nowhere else — `localStorage` under
`loadline.viewer.v1` (the key keeps the product's former name; renaming it would throw away
the location every existing visitor has already saved). It travels with each search as two
coordinates and is never written into the URL you can share; a link you send should not carry
where you were standing. There is no account to attach it to, and no column for it if you
had one.

---

## 2. Find a backhaul: Florida → New Jersey

In the filter bar set **Pickup** to `FL` and **Delivery** to `NJ`.

Three routes are left — *3 jobs · 1,000 cf* — all from one Miami sender:
`Miami, FL → NJ 07102` (350 cf), `→ NJ 08234` (250 cf) and `→ NJ 07032` (400 cf,
`$3.25/cf · est. $1,300`). That is the whole point of the product in one screen — a truck
that delivered in Florida finding the load that pays its way home.

Try the **Tri-State Area** chip on the delivery picker instead: it expands to NY, NJ and CT
and brings back seven.

---

## 3. Show contact

Click the `Miami, FL → NJ 07032` route. The detail shows the lane, the size in cubic feet,
the price per cubic foot, when it is ready, how fresh the post is — and the original
WhatsApp message it came from, with the job's own line highlighted. **Show full message
(9 lines)** expands the rest, where the sender's sign-off ends in `[phone hidden]`.

Press **Show contact**.

Nothing navigates. The button turns into a small panel in the same place:
**Sign in to see the contact** — *Free. Browsing never needs an account — only contact
details do.* Press **Sign in as demo driver**.

The header now reads *Dan Driver · Driver · Sign out*, and your filters, the map viewport
and the open job are exactly where you left them. Press **Show contact** once more: the
number appears as **Call (305) 555-0142** and **WhatsApp** buttons with a **Copy summary**
beside them. The original message stays masked either way — the number reaches the page
from one endpoint only, and only when you ask for it.

> Pick a job whose card shows **Show contact**. Fifteen of the ninety-eight jobs genuinely
> carry no number — the sender wants to be messaged in the group — and those show no button
> at all, just a line saying so and the group's name. There is nothing to gate when the
> message is already fully visible.

That reveal is the one event this board records. It is logged once per person per job per
hour, because clicking Call twice is not twice the interest.

---

## 4. Post a load, then take it off the board

Sign out, then go to **/login** and press **Sign in as demo poster**. (Signed in, `/login`
just sends you back to the board — sign out first.)

Look at the header once you are in: beside the account controls there is a **Demo** chip, at
every width, and the account block in the ⋯ menu says what it costs you. `/post` says the
same thing again, in full, *before* you pick a form: **anything a demo account posts is
visible to that account and nobody else.** The ~98 loads you have been browsing are a
different thing — seeded sample inventory, `is_demo = false`, public to every visitor.

**Post a load** gives you a form shaped like a real post: pickup with the same type-ahead
(type `Kearny`, pick **Kearny, NJ**, and the field notes *NJ recorded from the suggestion*),
delivery state plus ZIP or city, cubic feet, price per cf or flat with a live total
(`$3.25/cf × 400 cf ≈ $1,300`), ready now or on a date, deliver by, tags, requirements,
contact name, contact phone and notes. A phone is required — without one nobody can be
reached through the board.

Press **Post job**. A green line answers *Job #133 is posted, and visible to this demo
account only.* — whatever id yours got — with a **See it →** link. Follow it: the card reads
*Posted today* and *via MoverMesh* instead of a poster and a group, it wears a **Demo · only
you** chip, and *your* board is now 99 loads deep. Open the same board in a private window
and it is still 98: `demoVisibilitySql` never serves that row to anyone else. Posting from a
real account is the same form and the same 201, with none of that qualification.

Scroll that load's detail to **Manage** and press **taken**. It drops out of the available
list immediately — *← Back to 98 jobs* — and stays taken even if the same load is posted
again. A poster can only do this to their own listings, which is why Manage is absent on the
WhatsApp ones.

---

## 5. Admin: teach it a format it has never seen

Sign out, then sign in as the admin and open **Admin**. There is no button for this one —
the console is not part of the demo any more, so it takes the e-mail form and the password
below. It opens on **Needs attention**, because that is the only tab with work waiting in
it. Four of the nineteen messages carry a code, plus anything a reader has reported, and the
row of chips above the list filters by it.

Exactly one is `unknown_format`: **Dispatcher U · FL Movers Backhaul**, 0 jobs. Open it. Its
lines get a coloured gutter — blue for a header, green for a destination, red for a line
nothing could be made of — and this message is a single red line:

```
33435/350, 33180/200
```

Click the line, press **Teach line**, and describe its shape with the placeholder chips:

```
{ZIP}/{CF}, {ZIP}/{CF}
```

**Save template** re-runs the message on the spot. The gutter turns green, the signature
becomes `H:|D:ZIP CF`, and the chip changes from `unknown_format` to `no_origin` — press the
`unknown_format` filter chip and the queue answers *Nothing needs attention.*

The shape is now understood; what is still missing is a pickup, because this post never says
where the goods are. That is the honest outcome, and it is why nothing appeared on the
board: the rules fail closed rather than invent an origin. The rule itself is stored,
survives `npm run db:reset`, and can be exported into the eval fixtures
(`npm run rules:export`) so the shape never regresses.

Now go to **Try a message** and paste a layout nobody has posted before:

```
FROM KEARNY NJ:
FL 33180 | 400 | $3
Sam 201-555-0177
```

Press **Run the pipeline** (**Preview only** extracts without writing anything). It parses —
`Kearny, NJ → FL 33180 · 400 cf · $3/cf · ready now` — but the *shape* is new, so it comes
back flagged `new_format` with its job still created.

Go back to **Needs attention**: the post is now at the top of the queue as **Manual entry**,
carrying that flag. Open it and press **Confirm format**. *Format confirmed. Reprocessed 1
messages.* — the chips become `clean` / `full`, and every future post in that layout skips
the queue.

**WhatsApp console** (`/admin/test`) is the other half: the imported groups, the transcript
as it actually looked, and the fastest way to probe the rules — edit the text of any message
and press **Save & re-extract**, and the jobs rebuild from your new wording immediately.

**Add message** posts new text into a chat through the same path. Use it to try something
that is not a job at all, and watch it correctly refuse:

```
morning all, anyone empty near newark tomorrow?
```

*No job — not_a_load · sent to the attention queue.* Five of the nineteen sample messages
are greetings, availability posts, "still available?" and price arguments. Keeping those off
the board is half the product.

**Restore demo data** puts the whole corpus back if you have edited your way into a corner.

---

## The accounts

| How you get in | Account | What it adds |
|---|---|---|
| **Sign in as demo driver** | `driver@example.com` | The contact on any listing. It can post too — `can_post` is on for every account — but the walkthrough uses the poster for that |
| **Sign in as demo poster** | `poster@example.com` | Post loads and truck space, and mark them taken. Both are demo listings: visible to this account only |
| the e-mail form | `admin@movermesh.com` | Every console, and every button inside one |

The two buttons need no password, and they are all the demo is. **There is no demo admin
button any more.** It used to hand a stranger an admin session in one click; those seeded
accounts now carry `users.is_demo`, which costs them every write, so a one-click console was
a console with nothing working in it. The real admin above is a normal account with a normal
password, reached through the *or sign in with an email and password* link.

That password is not printed here, and neither is the demo one. This repo and the deployment
are both public, so a password written down in a file is a live credential. The demo password
is derived from `SESSION_SECRET` unless you set `DEMO_PASSWORD`; the admin's is whatever
`ADMIN_PASSWORD` is set to, and on a deployment where nobody has set it, the committed
default in `src/lib/demo/accounts.ts` — read the comment there before relying on it. Running
this locally, the quickest way through section 5 is to set `ADMIN_PASSWORD` yourself and
restart. The normal way a driver signs in is the **Show contact** button inside a job, not
this page.

---

## What is real and what is simulated

| | |
|---|---|
| WhatsApp messages | **Simulated** — a sample export plus six real posts used as ground truth. The Cloud API webhook is implemented and signature-verified, but not connected to a live number. |
| Extraction | **Real** — deterministic rules, no AI service, no per-message cost |
| Geocoding | **Real** — offline gazetteer + alias table; optional HERE or free Census geocoder |
| Supersession, expiry, search, route matching | **Real** |
| Map rendering | **Real** — OpenStreetMap tiles, one arc per load |
| A demo account's own listings | **Real rows, private ones** — stamped `is_demo`, served only to the account that posted them. The ~98 seeded loads are not demo rows and are public |

```bash
npm run score   # the six real messages: 94/94 jobs, 0 fabricated
npm run eval    # 94/94 real jobs + 42 regression cases
```
