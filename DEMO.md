# LoadLine — demo walkthrough

A 5-minute tour of what this does. Everything runs locally with no accounts, no API keys
and no database to install.

```bash
npm install
npm run seed
npm run dev
```

Open <http://localhost:3000>. **You are already in** — the board is public, and browsing it
never asks for an account.

> **This is test mode.** The WhatsApp messages are a simulated export, not a live
> connection. Everything downstream of them — extraction, geocoding, supersession, expiry,
> search — is the real implementation running on that data.

---

## 1. The board

A map of routes, not a list of pins. Every job is an arc from its pickup to its delivery,
with direction chevrons and a line that gets thicker as the job gets bigger. The panel in
the corner counts what is currently in view: *11 jobs in view · 3,900 cf ≈ 2.6 truckloads*.

Hover a card and its route lights up while the others dim. Click one and the detail opens
beside the map.

### Tell it where you are

Press **Where are you?** in the header and type `Miami, FL` (or press **Use GPS**). Three
things change at once: jobs sort by distance to the pickup, every card gains a
"*142 mi from you*" line, and the job detail starts showing road miles and drive time.

That location is stored in your browser and nowhere else. It travels with each search as
two coordinates and is never written into the URL you can share — a link you send should
not carry where you were standing. There is no account to attach it to, and no column for
it if you had one.

---

## 2. Find a backhaul: Florida → New Jersey

In the filter bar set **Pickup state** to `FL` and **Delivery state** to `NJ`.

At least three routes are left, all from one Miami sender: `Miami, FL → NJ 07032`,
`→ NJ 08234` and `→ NJ 07102`. That is the whole point of the product in one screen — a
truck that delivered in Florida finding the load that pays its way home.

Try the **Tri-State** chip on the delivery picker instead: it expands to NY, NJ and CT and
brings back more.

---

## 3. Show contact

Click the `Miami, FL → NJ 07032` route. The detail shows the lane, the size in cubic feet,
the price per cubic foot, when it is ready, how fresh the post is — and the original
WhatsApp message it came from, with the job's own line highlighted and every phone number
replaced by `[phone hidden]`.

Press **Show contact**.

Nothing navigates. The button turns into a small panel inside the drawer:
**Sign in to see the contact** — *Free. Browsing never needs an account — only contact
details do.* Press **Sign in as demo driver**.

The number appears as **Call** and **WhatsApp** buttons with a **Copy summary** beside
them, the masked marks in the original message resolve into the real number, and the header
now reads *Dan Driver · Driver · Sign out*. Your filters, the map viewport and the open
drawer are exactly where you left them.

> Pick a job whose card shows **Show contact**. Some posts genuinely carry no number — the
> sender wants to be messaged in the group — and those show no button at all, just a line
> saying so and the group's name. There is nothing to gate when the message is already
> fully visible.

That reveal is the one event this board records. It is logged once per person per job per
hour, because clicking Call twice is not twice the interest.

---

## 4. Post a job, then take it off the board

Sign out, then go to **/login** and press **Sign in as demo poster**.

**Post a job** gives you a form shaped like a real post: pickup (with the same type-ahead —
picking `Kearny, NJ 07032` fills in the state and ZIP), delivery state plus ZIP or city,
cubic feet, price per cf or flat with a live total, ready now or on a date, deliver by,
tags, requirements, contact and a note. Submit it and it appears on the map immediately,
labelled *Posted today* and *via LoadLine*.

Now open it and mark it **Taken**. It leaves the public board and stays taken — a poster
can only do this to their own jobs, which is why the buttons are absent on the WhatsApp
ones.

---

## 5. Admin: teach it a format it has never seen

Sign in as **demo admin** and open **Admin**. It opens on **Needs attention**, because that
is the only tab with work waiting in it.

There is a message in the queue the rules could not read. Each of its lines has a coloured
gutter — blue for a header, green for a destination, red for a line nothing could be made
of. Use **Teach line** on the unreadable one, describing its shape with placeholders. The
message re-runs on save, its jobs appear on the board, and the queue count drops by one.
The rule is stored, survives `npm run db:reset`, and can be exported into the eval fixtures
(`npm run rules:export`) so the shape never regresses.

Then go to **Try a message** and paste a layout nobody has posted before:

```
NJ 07032 | 400 | $3
```

It parses — but the *shape* is new, so it comes back flagged `new_format` with its jobs
still created. Press **Confirm format** and the flag clears for every future post in that
layout.

**WhatsApp console** (`/admin/test`) is the other half: the imported groups, the transcript
as it actually looked, and the fastest way to probe the rules — **edit a message and the
jobs rebuild from your new wording immediately**. Try a real batch:

```
FROM KEARNY NJ:
200cf FL 33180 RFD
350 FL 33435 $3.50
Marco 201-555-0199
```

Then try something that is not a job at all, and watch it correctly refuse:

```
morning all, anyone empty near newark tomorrow?
```

Roughly a fifth of the sample traffic is greetings, availability posts, "still available?"
and price arguments. Keeping those off the board is half the product.

---

## The demo accounts

| Button | Account | What it adds |
|---|---|---|
| **Sign in as demo driver** | `driver@example.com` | The contact on any job — nothing else |
| **Sign in as demo poster** | `poster@example.com` | Post jobs from the website and mark them taken |
| **Sign in as demo admin** | `admin@example.com` | The pipeline, the needs-attention queue and both consoles |

Password for all three: `demo1234`. They see the same data; switching between them is just
switching hats. The normal way a driver signs in is the **Show contact** button inside a
job, not this page.

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
npm run eval    # the regression suite
```
