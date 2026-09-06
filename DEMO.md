# LoadLine — demo walkthrough

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
`loadline.viewer.v1`. It travels with each search as two coordinates and is never written
into the URL you can share; a link you send should not carry where you were standing. There
is no account to attach it to, and no column for it if you had one.

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

## 4. Post a job, then take it off the board

Sign out, then go to **/login** and press **Sign in as demo poster**. (Signed in, `/login`
just sends you back to the board — sign out first.)

**Post a job** gives you a form shaped like a real post: pickup with the same type-ahead
(type `Kearny`, pick **Kearny, NJ**, and the field notes *NJ recorded from the suggestion*),
delivery state plus ZIP or city, cubic feet, price per cf or flat with a live total
(`$3.25/cf × 400 cf ≈ $1,300`), ready now or on a date, deliver by, tags, requirements,
contact name, contact phone and notes. A phone is required — without one nobody can be
reached through the board.

Press **Post job**. A green line answers *Job #133 is live on the board.* — whatever id
yours got — with a **See it →** link. Follow it: the card reads *Posted today* and *via
LoadLine* instead of a sender and a group, and the board is now 99 jobs deep.

Scroll that job's detail to **Manage** and press **taken**. It leaves the public board
immediately — *← Back to 98 jobs* — and stays taken even if the same job is posted again. A
poster can only do this to their own jobs, which is why Manage is absent on the WhatsApp
ones.

---

## 5. Admin: teach it a format it has never seen

Sign out, then sign in as **demo admin** and open **Admin**. It opens on **Needs
attention**, because that is the only tab with work waiting in it. Four of the nineteen
messages carry a code, and the row of chips above the list filters by it.

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

## The demo accounts

| Button | Account | What it adds |
|---|---|---|
| **Sign in as demo driver** | `driver@example.com` | The contact on any job — nothing else |
| **Sign in as demo poster** | `poster@example.com` | Post jobs from the website and mark them taken |
| **Sign in as demo admin** | `admin@example.com` | The pipeline, the needs-attention queue and both consoles |

The three buttons need no password. The e-mail form behind the *or sign in with an email and
password* link needs one, and it is not printed here on purpose: this repo and the demo are
both public, so a password written down is a live admin credential. It is derived from
`SESSION_SECRET` unless you set `DEMO_PASSWORD`. They see the same data; switching between them is just switching hats. The
normal way a driver signs in is the **Show contact** button inside a job, not this page.

---

## What is real and what is simulated

| | |
|---|---|
| WhatsApp messages | **Simulated** — a sample export plus six real posts used as ground truth. The Cloud API webhook is implemented and signature-verified, but not connected to a live number. |
| Extraction | **Real** — deterministic rules, no AI service, no per-message cost |
| Geocoding | **Real** — offline gazetteer + alias table; optional HERE or free Census geocoder |
| Supersession, expiry, search, route matching | **Real** |
| Map rendering | **Real** — OpenStreetMap tiles, one arc per job |

```bash
npm run score   # the six real messages: 94/94 jobs, 0 fabricated
npm run eval    # 94/94 real jobs + 42 regression cases
```
