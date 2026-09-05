# LoadLine — demo walkthrough

A 5‑minute tour of what this does. Everything runs locally with no accounts, no API keys
and no database to install.

```bash
npm install
npm run seed
npm run dev
```

Open <http://localhost:3000> and press one of the three buttons — there is nothing to type:

| Button | What it shows you |
|---|---|
| **Sign in as Carrier** | The driver's view: search by route, radius and date |
| **Sign in as Broker** | Also post loads and mark them taken |
| **Sign in as Admin** | Also the pipeline, skip reasons and data quality |

All three see the same sample data, so switching between them is just switching hats.

> **This is test mode.** The WhatsApp messages are a simulated export, not a live
> connection. Everything downstream of them — extraction, geocoding, deduplication,
> expiry, search — is the real implementation running on that data.

---

## 1. Start at the WhatsApp test console → **WhatsApp test**

This is the part worth seeing first, because it shows the actual problem being solved.

On the left are the imported group chats. In the middle is the transcript exactly as it
looked in WhatsApp — lowercase, abbreviated, no structure. Messages with a **green edge**
became loads; **grey** ones were deliberately rejected.

Click any message. The right panel shows what the pipeline made of it: the lane, the
resolved date, freight details, contact, how precisely each end could be located, and a
confidence score.

**Now edit it.** Change the text — rewrite the lane, move the date, drop the ZIP — and hit
**Save & re-extract**. The load rebuilds from your new wording immediately. Try:

```
newark nj -> savannah ga next tuesday, 20 pallets, 42k lbs, reefer, call nina 201-555-7000
```

Then try something that is *not* a load, and watch it correctly refuse:

```
morning all, anyone empty near newark tomorrow?
```

**Add message** posts new text into a chat through the same path. **Restore demo data**
puts everything back.

Notice what the rejections are doing. Roughly a fifth of the sample traffic is greetings,
driver-availability posts, "still available?" and rate arguments. Keeping those off the
board is half the product.

---

## 2. The dashboard

Counts for today and tomorrow, loads nearest the signed-in user, the most active pickup
states, and the busiest lanes. The headline says how many WhatsApp messages produced the
current board.

---

## 3. Find loads

Three views of the same query — **List**, **Table**, **Map** — with the filter panel on the
left. Worth trying:

- **Radius** — put `philly` (or `07102`, or `Newark, NJ`) in *Pick up near*, set 50 miles.
  Informal names resolve: `philly`, `socal`, `the city`, `EWR`, `north jersey`.
- **Partial ZIP** — `070` in *Pickup ZIP* matches all of north Jersey.
- **Map** — pins cluster by metro; drag the map and hit **Search this area**. Amber pins are
  loads the message could only place to a state, and are labelled as approximate rather
  than pretending to a precision they do not have.

### Route matching — the differentiator

Switch the **Route** toggle to *Along my route*, then set:

- Pick up near: `philly`
- Deliver to: `Atlanta, GA`
- Corridor: 75 miles

A normal load board answers this with Philadelphia → Atlanta loads only. This returns the
loads that are **on the way**, ranked by the extra miles they cost:

```
+0 mi   Philadelphia, PA → Washington, DC
+11 mi  Charlotte, NC    → Atlanta, GA
+14 mi  Washington, DC   → Charlotte, NC
+23 mi  Baltimore, MD    → Richmond, VA
```

A driver can chain those. Open any of them to see the original WhatsApp message it came
from, and a **Call** button.

---

## 4. Duplicates and expiry

Search `miami`. The Philadelphia → Miami load shows a **3× posted** chip: it was posted
once, reposted an hour later, and forwarded into a second group. The board shows it once.

Sign in as the broker and mark it **Taken** — all three move together, because it is one
piece of freight.

Loads also expire on their own: anything whose pickup date has passed leaves the board
without anybody going back to WhatsApp to say so.

---

## 5. Admin → pipeline

Signed in as admin: the full message feed with each message's outcome and skip reason
(*"why isn't that load on the board?"*), per-group yield, and a **Re-run** button. Because
loads are derived from stored messages, a rule change can be replayed over history without
re-importing anything.

---

## What is real and what is simulated

| | |
|---|---|
| WhatsApp messages | **Simulated** — a sample export. The Cloud API webhook is implemented and signature-verified, but not connected to a live number. |
| Extraction | **Real** — deterministic rules, no AI service, no per-message cost |
| Geocoding | **Real** — offline gazetteer + alias table; optional free Census geocoder |
| Dedup, expiry, search, route matching | **Real** |
| Map rendering | **Real** — OpenStreetMap tiles, clustered pins, route overlay |

Extraction quality on the sample corpus: **48 loads from 55 messages**, 10 correctly
rejected as non-loads, 3 duplicates clustered, 1 flagged for human review.

```bash
npm run eval    # 26 extraction test cases, 107 assertions
```
