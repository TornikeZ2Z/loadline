# LoadLine

Turns unstructured WhatsApp freight posts into a searchable, geographic load marketplace.

The product thesis is that the value is not "WhatsApp messages on a website" — it is the
processing layer in between. This repo implements that layer for real: extraction,
location normalization, geocoding, duplicate clustering, expiry, and a search engine that
answers radius, lane, viewport and **route-corridor** questions.

Extraction is **deterministic rules, not a model**. No API key, no per-message cost, no
network dependency, and the same message always produces the same load — which is what
makes `npm run eval` a meaningful regression gate.

---

## Run it

```bash
npm install
npm run seed
npm run dev
```

Open http://localhost:3000 and press **Sign in as Carrier** (or Broker, or Admin). No
credentials to type. The email/password form is still there behind a link, and the demo
accounts are `carrier@ / broker@ / admin@example.com` with password `demo1234`.

The database **seeds itself when empty**, so a fresh deployment is usable on first visit
without anyone running a script.

**New here? Follow [DEMO.md](DEMO.md)** — a five-minute guided tour.

No database to install: with `DATABASE_URL` unset the app runs Postgres in-process via
PGlite, persisted in `./.pgdata`. Set `DATABASE_URL` and the identical SQL runs against
managed Postgres — see [Database](#database).

`npm run seed` pushes ~55 realistic WhatsApp messages through the **same** entry point the
Cloud API webhook uses, so the demo exercises the production code path rather than
inserting rows directly.

---

## What the pipeline does

```
WhatsApp Cloud API webhook
        │  (verify signature, enqueue, return fast)
        ▼
   raw_messages ─────────────── immutable source of truth
        │
        ▼  POST /api/cron/process
   extraction        deterministic rules: claim typed spans, then look
        │            up places in a dictionary rather than parsing grammar
        │            → is this even a load? how many loads? which fields?
        ▼
   normalization     "philly" → Philadelphia, PA · "tmrw" → a calendar date
        │            · "44k" → 44000 lbs · "9085557788" → +19085557788
        ▼
   geocoding         cache → alias → offline gazetteer → optional provider
        │            records precision: address | zip | city | region | state
        ▼
   dedup             cluster reposts and cross-group forwards, keep one canonical
        │
        ▼
      loads          with expires_at and a cached trip distance
```

Every stage is re-runnable. Because `loads` are derived and `raw_messages` are not, a
rule change or a new alias can be replayed over historical traffic from
**/admin → Message feed → Re-run**, with no re-ingestion.

## Test mode

The app currently runs on a **simulated WhatsApp export** rather than a live connection.
The **WhatsApp test** tab is where you see and control it:

- the imported group chats, rendered as the transcript actually looked;
- a green edge on every message that produced a load, grey on every one deliberately
  rejected, with the reason attached;
- click a message to see precisely what the pipeline made of it — lane, resolved date,
  freight, contact, location precision, confidence;
- **edit the text and the load rebuilds from it immediately**, which is the fastest way to
  probe what the rules do and do not handle;
- add messages, delete them, or restore the original corpus.

This works because `raw_messages` is the source of truth and loads are derived: editing a
message and re-deriving is the same operation the pipeline performs on arrival, so nothing
special-cases test mode. `POST /api/test/*` backs the console; the endpoints exist only to
serve it.

Going live means pointing the Meta webhook at the deployment (see
[Connecting real WhatsApp](#connecting-real-whatsapp)) — no other code changes.

---

### Extraction

Rule-based, in `src/lib/extract/`. Freight posts are formulaic enough for this to work
well — but only because the rules are arranged in a specific order.

**1. Claim typed spans first** (`spans.ts`). Phones, money, weights, pallet counts, dates,
times, equipment and trailer lengths are matched and *masked* before anything looks for a
place. This is what prevents the classic failure: `44000` is a weight and `07102` is a
ZIP, and both are five digits. Masking rather than deleting keeps token positions stable,
which is what lets the extractor tell `newark -> boston` from `boston -> newark`.

**2. Resolve places by dictionary lookup, not by parsing** (`geo/match.ts`). The naive
approach splits on `->` and guesses where the place name ends — which fails immediately,
because the delivery half of a real post is `charlotte nc 28202 today after 2pm, 18
pallets, call mike`. There is no grammar there to parse. Instead every n-gram is slid past
the alias table, gazetteer, state list and ZIP ranges, and the longest, most specific hits
win. `las vegas nv this week` yields a place because the dictionary recognizes one, not
because we guessed that `this` begins the non-place part.

A dictionary hit always outranks a guess, regardless of length. Without that rule,
`reposting: elizabeth nj to charlotte nc` extracts a town called "Reposting Elizabeth" in
New Jersey — the longer span wins on span bonus alone. Unknown towns paired with a real
state are still kept, scored between "bare state" and every real hit.

**3. Assemble the lane** (`rules.ts`). Direction is the one thing a load board cannot get
wrong, so it comes from explicit evidence wherever any exists — `pickup X, delivery Y`
markers first, then a route arrow or `to`, and only then reading order. Each basis feeds
the confidence score differently.

**Dates stay verbatim through extraction** and are resolved in `dates.ts` against the
message's send time, because "tomorrow" is meaningless without knowing when it was said.
That module also handles `next tuesday` (the Tuesday of next week, not merely the next
one), `2 days ago`, `9/5`, `sept 5` and `this week`.

**Confidence is real** and drives the review queue: direction evidence, how precisely each
end was pinned, and whether a date, phone, equipment and weight are present. On the seed
corpus, 47 of 48 loads land above 0.84 and exactly one is flagged for review — a town
missing from the gazetteer, which is correctly held back because it could only be placed
at state precision.

### Tuning the rules

```bash
npm run eval
```

Runs `scripts/eval-cases.ts` through the real extractor and reports what broke — 26 cases,
107 assertions, no database, milliseconds. A third of the cases assert that a message
produces **no** loads, because keeping chatter and driver-availability posts off the board
matters as much as extracting well.

This is the workflow: meet a message shape the rules get wrong, add it as a case, fix the
rule, re-run. Every rule you add to fix one message can quietly break three others, and
this is what catches that. `/admin -> Try a message` does the same thing interactively
against the live database.

### Geocoding

Default is **fully offline**: an alias table for how people actually talk (`philly`,
`socal`, `north jersey`, `EWR`, `the city`) plus a curated gazetteer of freight-relevant
cities and USPS ZIP-prefix ranges. Set `GEOCODER=census` (free, keyless) or
`GEOCODER=mapbox` (needs `MAPBOX_TOKEN`) to resolve anything the gazetteer misses; results
are cached in `places`, so an unknown place costs one lookup ever.

Every resolution records a **precision**. A load posted as "somewhere in Florida" is
stored at state precision, flagged for review, and drawn on the map in a different colour
with an "approximate location" chip. Presenting a state centroid as a pinned pickup is how
a load board loses a driver's trust.

> After changing aliases or the gazetteer, run `npm run geocache:clear` — otherwise places
> resolved badly before the fix stay resolved badly.

### Road distance and drive time (HERE)

With `HERE_API_KEY` set, opening a load shows the **truck** road distance and drive time
for its lane, and the road distance from wherever the driver currently is to the pickup.
`transportMode=truck` matters: it respects height, weight and hazmat restrictions, so the
number matches what the driver's own navigation will say rather than a car's shortcut.

Routing is only ever called when a **single load is opened**, never for a list. A board
query returns 50 loads; routing all of them would be 50 billable calls to answer a question
nobody asked. Straight-line miles remain what ranking, filtering and corridor matching use;
the road number is for the moment a driver is choosing one specific job. The lane result is
cached on the row (`road_miles`, `road_minutes`) because it can never change.

### The location type-ahead

Two things worth knowing, both learned the hard way against the live API:

**It uses `/autocomplete`, not `/autosuggest`.** Autosuggest is point-of-interest weighted:
typing "newar" returns PATH-Newark Station, Newark City Hall and a phone shop, but never
the city of Newark. Autocomplete returns properly ranked localities and addresses, and
handles partials that plain geocoding fumbles -- "phila" gives Philadelphia, where
`/geocode` returns Phila St in Saratoga Springs.

**Local matches come first.** The freight vocabulary is exactly what dispatchers type and
exactly what a general geocoder is worst at: HERE turns "north jer" into North Jerico,
Virginia, while our alias table knows it means the Tri-State Area. Those entries are also
free and instant. HERE then supplies everything the curated list cannot -- every US city,
ZIP and street address.

Autocomplete carries no coordinates, so results are resolved with one `/lookup` call when a
suggestion is actually **picked**, never per keystroke. The key is server-side only: the
browser calls our `/api/places/suggest`, never HERE directly. Without a key everything
falls back to the offline gazetteer and straight-line distance.

---

### Duplicate detection

A cheap blocking pass (same pickup day, same state pair, last 7 days) followed by weighted
field agreement, with the callback phone number carrying most of the weight. Above
threshold the newcomer joins the cluster and stops being canonical, so search shows the
load once. Marking a load **taken** moves the whole cluster — it is the same freight.

### Expiry

Derived, not manual. Every load carries `expires_at` (end of the pickup day plus a grace
window, or 48h for undated posts) and `POST /api/cron/expire` flips the status. Nobody
goes back to WhatsApp to say a load is gone.

---

## Search

One parameterized SQL statement drives every filter. Radius queries use a bounding-box
prefilter on the `(lat, lng)` btree indexes plus an exact haversine — the box alone returns
corner false-positives, the haversine alone table-scans.

| Capability | Example |
|---|---|
| Date | `?date=tomorrow`, `?date=custom&from=…&to=…` |
| Radius | `?origin=Newark, NJ&radius=50` |
| Lane | `?pickupState=NJ&deliveryState=FL` |
| ZIP (partial) | `?pickupZip=070` — all of north Jersey |
| Map viewport | `?minLat=…&maxLat=…&minLng=…&maxLng=…` ("Search this area") |
| **Route corridor** | `?origin=philly&dest=Atlanta, GA&routeMode=corridor&corridor=75` |

Searches are URLs, so they are linkable, bookmarkable, and savable without a second
serialization format.

### Route matching

The differentiator, and the part that is genuinely hard. A driver in Philadelphia heading
to Georgia should not only see Philadelphia → Georgia loads:

```
corridor 75mi, Philadelphia → Atlanta
   +0mi detour,  0mi off route:  Philadelphia, PA → Washington, DC
   +11mi detour, 58mi off route: Charlotte, NC   → Atlanta, GA
   +14mi detour,  4mi off route: Washington, DC  → Charlotte, NC
   +23mi detour, 11mi off route: Baltimore, MD   → Richmond, VA
```

A load qualifies when its pickup is within the corridor, its delivery makes forward
progress toward the destination, the delivery is not itself wildly off the line, and the
total detour stays within `min(2 × corridor, 30% of the trip)`. Results rank by extra
miles driven.

Corridor matching and detour scoring run in JS over a bounding-box-limited candidate set
(`src/lib/loads/query.ts`), because cross-track geometry is unpleasant in portable SQL and
corridor searches are naturally narrow.

> One geometry note worth preserving: the textbook along-track formula uses `acos()` and is
> therefore unsigned, which reports a point *behind* the origin as far along the route.
> That is how a northbound Newark → Boston load can look like it belongs on a
> Philadelphia → Atlanta run. `src/lib/geo/math.ts` recovers the sign from the bearing
> difference.

---

## Connecting real WhatsApp

`POST /api/webhooks/whatsapp` implements the Meta Cloud API contract:

1. **GET** handles the subscription handshake (`hub.mode` / `hub.verify_token` /
   `hub.challenge`), echoing the challenge as bare text.
2. **POST** verifies `X-Hub-Signature-256` (HMAC-SHA256 of the raw body with the app
   secret) *before parsing*, then writes to `raw_messages` and returns immediately. Meta
   retries anything that is not answered promptly and disables webhooks that keep failing,
   so extraction never runs inline.
3. Delivery is idempotent on `wa_message_id`, because Meta redelivers.

Set `WHATSAPP_VERIFY_TOKEN` and `WHATSAPP_APP_SECRET`, point the Meta dashboard at
`https://your-host/api/webhooks/whatsapp`, and schedule `POST /api/cron/process` (bearer
`CRON_SECRET`) every minute.

**The constraint to plan around:** the Cloud API delivers messages to *your own business
number*. It is not a mechanism for reading arbitrary third-party WhatsApp groups — that
capability is limited-availability at best, and unofficial bridges (`whatsapp-web.js`,
Baileys) violate WhatsApp's terms and get numbers banned. The realistic paths are getting
your number added to the groups you want to source, or having group admins share chat
exports. Intake is deliberately isolated behind one function (`ingestMessage`), so
swapping the source touches only the caller.

Until then, `/admin → Try a message` runs pasted text through the identical pipeline, and
`npm run seed` populates a realistic board.

---

## Database

Plain portable SQL in `db/schema.sql` — no ORM dialect, nothing PGlite-specific.

```bash
DATABASE_URL=postgres://user:pass@host:5432/loadboard npm run dev
```

Geo columns are plain `double precision` with btree indexes, which is what makes the
prototype run anywhere. `db/postgis.sql` is the drop-in upgrade to real spatial indexes
once volume justifies it; it lists the two SQL fragments in the query builder that change.

---

## Deployment

Live at **https://loadline.ziptozip.app**, on AWS ECS Fargate behind the shared
ziptozip ALB. Infrastructure is OpenTofu in [`infra/`](infra/); the design and the
reasoning behind each choice are in
[`docs/superpowers/specs/2026-09-06-aws-deployment-design.md`](docs/superpowers/specs/2026-09-06-aws-deployment-design.md).

Push to `main` and `.github/workflows/deploy.yml` builds, pushes to ECR and forces a
new ECS deployment — once the `AWS_DEPLOY_ROLE_ARN` repository secret is set. There
are no AWS keys in the pipeline; it authenticates by OIDC to
`arn:aws:iam::908768512179:role/loadline-deploy`.

The app is served at the **root** of its own subdomain, so `NEXT_PUBLIC_BASE_PATH`
stays unset. Serving it under a sub-path instead would mean rebuilding the image with
that variable set: Next bakes it in at build time, and setting it only at run time
produces an app whose pages load and whose every button 404s.

> **`DEMO_MODE=off` is the switch to throw the day real data goes in.** One-click
> sign-in is an intentional authentication bypass, and this deployment is public:
> anyone with the link can enter as admin and edit messages or change load statuses.
> That is the right trade for a demo on sample data and the wrong one for anything
> else. Turning it off leaves the ordinary email/password form; change the demo
> passwords at the same time.

---

## Configuration

Copy `.env.example` to `.env.local`. Everything has a working default except the WhatsApp
secrets; the app runs with none of it set.

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | *(unset → PGlite)* | Managed Postgres connection |
| `SESSION_SECRET` | dev fallback | Signs session cookies; **required in production** |
| `LOAD_TZ` | `America/New_York` | Timezone relative dates resolve against |
| `NEXT_PUBLIC_BASE_PATH` | *(unset)* | Serve under a sub-path, e.g. `/loadline`. Needed at **build** time. |
| `DEMO_MODE` | `on` | One-click demo sign-in. Set to `off` for real data — see below. |
| `PGLITE_DIR` | `./.pgdata`, or the temp dir on serverless | Where the embedded database lives |
| `GEOCODER` | `local` | `local` \| `census` \| `mapbox` |
| `WHATSAPP_VERIFY_TOKEN` | — | Webhook handshake |
| `WHATSAPP_APP_SECRET` | — | Signature verification |
| `WHATSAPP_ALLOW_UNSIGNED` | `1` in dev | Local testing escape hatch; refuses to apply in production |
| `CRON_SECRET` | — | Bearer token for `/api/cron/*` |

---

## Layout

```
db/schema.sql              tables, indexes, and why the geo columns are shaped that way
src/lib/demo/              sample WhatsApp corpus, reset, test-console queries
src/lib/extract/           spans → lanes: rules.ts, spans.ts, dates.ts, phone.ts
src/lib/geo/               aliases, gazetteer, states/ZIPs, place matcher, geocoder, math
src/lib/pipeline/          ingest, process, dedup, expire
src/lib/loads/             search query builder, params, dashboard stats
src/app/api/               REST surface incl. the Cloud API webhook and cron workers
src/components/            board, filters, list/table/map views, test + admin consoles
scripts/                   eval + cases, seed, reprocess, expire, cache maintenance
```

## Commands

| | |
|---|---|
| `npm run eval` | Extraction regression suite — run this after any rule change |
| `npm run seed` | Demo users, groups, sample traffic, full pipeline run |
| `npm run process` | Drain the pending message queue |
| `npm run expire` | Run the expiry sweep |
| `npm run db:reset` | Truncate everything, keep the schema |
| `npm run geocache:clear` | Drop cached place lookups after a geo change |
| `npm run typecheck` | |

---

## Scope

Built (phase 1): intake, extraction, normalization, geocoding, dedup, expiry, accounts and
roles, list/table/map views, radius/lane/ZIP/viewport search, route-corridor matching,
saved searches, broker posting and status management, admin pipeline console.

Deliberately not built: notifications and alerts (§10 of the brief — the saved-search
records carry a `notify` flag ready for a matcher), SMS/push/email delivery, and
drive-time routing.

**Where rules will fall short.** They handle the shapes in `eval-cases.ts` and everything
shaped like them, which covers the bulk of real group traffic. They will not handle prose
("we've got a truck coming out of the Newark area Thursday that needs a backhaul"),
messages in other languages, or lanes described without any recognizable place name. Those
fail *closed* — no load is created, and the message shows up in the admin feed with a skip
reason rather than producing a wrong load. Widening coverage means adding gazetteer
entries, aliases, and eval cases, which is cheap and safe. Corridor distances are great-circle, not road miles; swapping in a
routing engine means replacing `detourMiles` in `src/lib/geo/math.ts` and nothing else.

`maplibre-gl` is pinned to v5 on purpose: v6 resolves its web worker through
`import.meta.url`, which the Next dev bundler does not serve as a real asset, so the worker
never starts and the map fails silently. v5 inlines the worker.

Note for anyone testing in a headless or offscreen browser: MapLibre drives its render loop
from `requestAnimationFrame`, which never fires while a page is hidden. The map then mounts
a correctly sized canvas and draws nothing, with no error. That is the harness, not the
app -- in a real browser tab it renders normally.
