# LoadLine

A backhaul board for movers, built out of the WhatsApp groups they already post in.

Long-distance moving companies run half their miles empty. The jobs that would fill those
miles exist — they are posted every morning, in group chats, as batches like this:

```
FROM KEARNY NJ:
200cf FL 33180 RFD
350 FL 33435 $3.50
2000. FL 32439 $3.75 Bulky
Marco 201-555-0199
```

One origin, then a line per destination: state, ZIP, cubic feet, sometimes a price. Nobody
can search that. Fifteen senders posting fifteen batches a day is a wall of text, and the
job you want scrolled past an hour ago.

LoadLine reads those posts and puts every job on a map as a **route** — pickup to delivery,
with cubic feet, price per cubic foot, when it is ready and how fresh the post is. The
board is public: no account to browse it, filter it, open a job or read the original
message. An account buys exactly one thing, the sender's phone number.

Extraction is **deterministic rules, not a model**. No API key, no per-message cost, no
network dependency, and the same message always produces the same jobs — which is what
makes `npm run eval` and `npm run score` meaningful regression gates.

---

## Run it

```bash
npm install
npm run seed
npm run dev
```

Open <http://localhost:3000> — **the board is public**, so there is nothing to sign in to
first. Press **Show contact** on any job and choose **Sign in as demo driver** to see a
number; **Sign in as demo poster** to post a job of your own; **demo admin** for the
consoles. The accounts are `driver@ / poster@ / admin@example.com`, password `demo1234`,
and the email form is still there behind a link on `/login`.

The database **seeds itself when empty**, so a fresh deployment is usable on first visit
without anyone running a script.

**New here? Follow [DEMO.md](DEMO.md)** — a five-minute guided tour.

No database to install: with `DATABASE_URL` unset the app runs Postgres in-process via
PGlite, persisted in `./.pgdata`. Set `DATABASE_URL` and the identical SQL runs against
managed Postgres — see [Database](#database).

---

## The access model, in one paragraph

Everything about a job is public — the route, the size, the price, the freshness, the
original WhatsApp text with every number replaced by `[phone hidden]`. `GET /api/loads`
and `GET /api/loads/:id` are phone-free **for every caller**, signed in or not: the
`contact_phone` column is nulled, `sender_key` is nulled (for a phone-keyed sender it *is*
the number), a sender name that is nothing but a number becomes "Unnamed sender", and the
public `?sender=` filter is ignored for anyone but an admin so a result count cannot be
used to confirm whose number it is. The number itself comes from one endpoint,
`POST /api/loads/:id/contact`, which needs an account and records the reveal once per
person per job per hour. `npm run check:redact` greps the serialized payloads for E.164
runs and bare ten-digit numbers, not only for dashed ones.

| | anonymous | driver | poster | admin |
|---|---|---|---|---|
| Browse the board, filters, map, job detail, original message | yes | yes | yes | yes |
| See the contact | — | yes | yes | yes |
| Post a job, mark it taken | — | — | own jobs | any |
| Admin console, WhatsApp console, needs-attention queue | — | — | — | yes |

A driver account holds nothing but an identity. Your location lives in the browser
(`localStorage`), never on the server, for everyone.

---

## What the pipeline does

```
WhatsApp Cloud API webhook
        │  (verify signature, enqueue, return fast)
        ▼
   raw_messages ─────────────── immutable source of truth
        │
        ▼  POST /api/cron/process
   extraction        one origin header, then a line per destination.
        │            Typed spans are claimed first, then places are looked
        │            up in a dictionary rather than parsed as grammar
        ▼
   normalization     "philly" → Philadelphia, PA · "tmrw" → a calendar date
        │            · "2000." → 2000 cf · "9085557788" → +19085557788
        ▼
   geocoding         cache → alias → offline gazetteer → optional provider
        │            records precision: address | zip | city | region | state
        ▼
   supersession      the sender's newest full post is the truth: jobs it
        │            omits are delisted, a silent sender's jobs expire
        ▼
      jobs           with expires_at, freshness counters and a cached
                     road distance for the lane
```

Every stage is re-runnable. Because jobs are derived and `raw_messages` are not, a rule
change or a new alias can be replayed over historical traffic from
**/admin → Needs attention**, with no re-ingestion.

### Supersession: why the board does not rot

Nobody goes back to a group chat to say a job is gone. So the board reads the *absence* of
a job as information:

- a sender's newest **full** post is their current list — jobs missing from it are
  **delisted**, not deleted, and can be shown again with one filter;
- a sender silent for four days has their jobs **expire**;
- a job a poster marked **Taken** stays taken even if it is reposted, because the person
  who marked it knows something the post does not;
- a repost is not a duplicate — it bumps "last seen" and the card reads
  *Posted 4× since Sep 1*.

A post only counts as a *partial* addition (delisting nothing) when it clearly is one:
fewer than half the sender's usual count **and** worded like one ("still available", "one
more") or missing its own origin. A daily post titled `UPDATED LIST` is a full list and
retires what it omits — the latest information from a sender wins.

---

## Extraction

Rule-based, in `src/lib/extract/`. Batch posts are formulaic enough for this to work well —
but only because the rules are arranged in a specific order.

**1. Claim typed spans first.** Phones, money, cubic feet, dates and ZIPs are matched and
*masked* before anything looks for a place. This is what prevents the classic failure:
`33180` is a ZIP and `2000` is a size, and the line `2000. FL 32439 $3.75` contains both.
Masking rather than deleting keeps token positions stable.

**2. Resolve places by dictionary lookup, not by parsing** (`geo/match.ts`). The naive
approach splits on `->` and guesses where the place name ends — which fails immediately on
a real line like `To:KY 400 c/f-40741 RFD 9/9`. There is no grammar there to parse.
Instead every n-gram is slid past the alias table, gazetteer, state list and ZIP ranges,
and the longest, most specific hits win. A dictionary hit always outranks a guess.

**3. Inherit the origin.** A batch has one origin header (`FROM KEARNY NJ:`, `📍 Kearny`,
`NEW JERSEY`, `Desde Miami FL:`) and every following line is a destination for it. Getting
that inheritance right is most of the work, because a line that looks like a new header and
is not will silently re-home a dozen jobs.

**Dates stay verbatim through extraction** and are resolved against the message's send
time, because "tomorrow" is meaningless without knowing when it was said.

### The gates

```bash
npm run score   # the six real WhatsApp messages: 94/94 jobs, 0 fabricated
npm run eval    # the regression suite: real-message baselines, negatives, variants
```

`scripts/fixtures/real-whatsapp.ts` is ground truth — six posts as they actually arrived,
with every job they contain written out. `npm run score` is the number that matters, and
neither that fixture nor its scorer may be edited to make a change pass.

A third of the eval cases assert that a message produces **no** jobs, because keeping
chatter and availability posts off the board matters as much as extracting well.

### Unknown formats are solved once and kept

A message the rules cannot read lands in **/admin → Needs attention** with a per-line
colour gutter and buttons: *Resolve place*, *Ignore line*, *Add word*, *Teach line*,
*Sender format*, *Confirm format*. A message that *did* parse, but in a layout never seen
before, lands there once as `new_format` until an admin confirms it. Each fix is stored as
a rule, re-runs the message immediately, survives `npm run db:reset`, and is exported into
the eval fixtures (`npm run rules:export`) so it never regresses.

### Geocoding

Default is **fully offline**: an alias table for how people actually talk (`philly`,
`socal`, `north jersey`, `EWR`) plus a curated gazetteer and USPS ZIP-prefix ranges. Set
`GEOCODER=census` (free, keyless) or `GEOCODER=mapbox` to resolve anything it misses;
results are cached in `places`, so an unknown place costs one lookup ever.

Every resolution records a **precision**. A job posted as "somewhere in Florida" is stored
at state precision and drawn as a dashed route to the state centroid rather than a pinned
address. Presenting a centroid as a real pickup is how a board loses a driver's trust.

> After changing aliases or the gazetteer, run `npm run geocache:clear` — otherwise places
> resolved badly before the fix stay resolved badly.

### Road distance and drive time (HERE)

With `HERE_API_KEY` set, opening a job shows the **truck** road distance and drive time for
its lane, and the road distance from wherever the driver is to the pickup.
`transportMode=truck` matters: it respects height, weight and hazmat restrictions, so the
number matches what the driver's own navigation will say rather than a car's shortcut.

Routing is only ever called when a **single job is opened**, never for a list. A board
query returns 50 jobs; routing all of them would be 50 billable calls to answer a question
nobody asked. The lane result is cached on the row (`road_miles`, `road_minutes`) because
it can never change.

Because the place routes are public now, HERE is also capped: `HERE_DAILY_BUDGET`
(default 2000) counts every billable call per UTC day, and past it the app silently falls
back to the offline gazetteer and straight-line distance — the same behaviour as having no
key at all.

### The location type-ahead

Two things worth knowing, both learned the hard way against the live API:

**It uses `/autocomplete`, not `/autosuggest`.** Autosuggest is point-of-interest weighted:
typing "newar" returns PATH-Newark Station, Newark City Hall and a phone shop, but never
the city of Newark. Autocomplete returns properly ranked localities and addresses, and
handles partials that plain geocoding fumbles — "phila" gives Philadelphia, where
`/geocode` returns Phila St in Saratoga Springs.

**Local matches come first.** The mover vocabulary is exactly what people type and exactly
what a general geocoder is worst at: HERE turns "north jer" into North Jerico, Virginia,
while our alias table knows what it means. Those entries are also free and instant.

Autocomplete carries no coordinates, so a result is resolved with one `/lookup` call when a
suggestion is actually **picked**, never per keystroke. The key is server-side only: the
browser calls our `/api/places/suggest`, never HERE directly.

---

## The board

The map is the primary view and every job is a **route**, pickup to delivery, with
direction chevrons and a line width that grows with cubic feet. No pins, no clusters, no
list/table/map toggle. A panel in the corner shows the total cubic feet currently in view
("11 jobs in view · 3,900 cf ≈ 2.6 truckloads"), and at low zoom each pickup state carries
a `FL · 6 jobs · 2,300 cf` pill.

Filters are built for the return trip: **Pickup state** and **Delivery state** as two
prominent pickers with region chips (Tri-State, Southeast…), then Size (cf), Ready,
Listed, More, an optional **Toward home** corridor, Clear and Sort.

### Search

One parameterized SQL statement drives every filter. Radius queries use a bounding-box
prefilter on the `(lat, lng)` btree indexes plus an exact haversine — the box alone returns
corner false-positives, the haversine alone table-scans.

| Capability | Example |
|---|---|
| Lane | `?pickupState=FL&deliveryState=NJ` |
| Region | `?deliveryState=tristate` |
| Size | `?minCf=300&maxCf=600` |
| Ready | `?readyOnly=1`, `?readyBy=2026-09-12` |
| Freshness | `?seenDays=3` |
| Map viewport | `?minLat=…&maxLat=…&minLng=…&maxLng=…` |
| **Route corridor** | `?originLat=…&destLat=…&routeMode=corridor&corridor=100` |

Searches are URLs, so they are linkable and bookmarkable without a second serialization
format — which is why there is no "saved searches" feature to maintain.

### Route matching

The differentiator, and the part that is genuinely hard. A driver empty in Miami and headed
home to New Jersey should not only see Miami → New Jersey jobs, but everything on the way,
ranked by the extra miles it costs. A job qualifies when its pickup is within the corridor,
its delivery makes forward progress toward home, the delivery is not itself wildly off the
line, and the total detour stays within `min(2 × corridor, 30% of the trip)`.

Corridor matching and detour scoring run in JS over a bounding-box-limited candidate set
(`src/lib/loads/query.ts`), because cross-track geometry is unpleasant in portable SQL and
corridor searches are naturally narrow.

> One geometry note worth preserving: the textbook along-track formula uses `acos()` and is
> therefore unsigned, which reports a point *behind* the origin as far along the route.
> That is how a northbound job can look like it belongs on a southbound run.
> `src/lib/geo/math.ts` recovers the sign from the bearing difference.

### Your location

A header control — "Where are you?" (type a place or Use GPS) and an optional "Home". Set
it and jobs sort by distance to pickup, cards say "142 mi from you", the detail shows road
miles and drive time, and Toward home draws the corridor.

It is stored in `localStorage` under `loadline.viewer.v1` and travels to the server only as
`viewerLat`/`viewerLng` query parameters on each search. It is never written to the
shareable URL — a link you send should not carry where you were standing — and there is no
column for it on the user row, signed in or not.

---

## The consoles

`/admin/test` is the **WhatsApp console** (admin only). The app currently runs on a
simulated export rather than a live connection, and this is where you see and control it:
the imported groups, the transcript as it actually looked, a parse-status chip and a
coloured per-line gutter on every message, and — the useful part — **edit the text and the
jobs rebuild from it immediately**. That works because `raw_messages` is the source of
truth and jobs are derived, so editing a message and re-deriving is the same operation the
pipeline performs on arrival.

`/admin` is the pipeline console, opening on **Needs attention** because that is the only
tab with work waiting in it. Tabs: Needs attention · Try a message · Messages · Senders ·
Rules · Groups.

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
exports. Intake is deliberately isolated behind one function (`ingestMessage`), so swapping
the source touches only the caller.

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

Migrations are additive and re-runnable: the schema applies twice in a row on a fresh
directory and on an existing `.pgdata`.

---

## Deploying to ziptozip.systems/loadline

The app is set up to be served from a sub-path. Two things it needs:

**1. A real Postgres.** Locally the app needs nothing, which hides a real constraint: the
embedded PGlite database writes to `./.pgdata`, and on an ephemeral serverless filesystem
every cold start would silently reset the board. Create a free managed Postgres (Neon,
Supabase and Railway all work) and pass its connection string.

**2. The base path, set at *build* time.**

```bash
NEXT_PUBLIC_BASE_PATH=/loadline
DATABASE_URL=postgres://…
SESSION_SECRET=<32+ random bytes>     # the app refuses to start in production without it
CRON_SECRET=<random>                  # gates /api/cron/*
WHATSAPP_VERIFY_TOKEN=<your choice>   # only when connecting a real number
WHATSAPP_APP_SECRET=<from Meta>
```

`NEXT_PUBLIC_BASE_PATH` must be present for `next build`, not just `next start` — Next
bakes the path into the bundle, and client code reads the same value to prefix its API
calls (`src/lib/basePath.ts`). Setting it only at run time produces an app whose pages load
and whose every button 404s.

The schema creates itself on first connection. Seed the demo corpus once, either by running
`npm run seed` against the same `DATABASE_URL` or by pressing **Restore demo data** in the
WhatsApp console.

### Putting it behind the domain

The app must receive the `/loadline` prefix — do **not** strip it in the proxy, since Next
is expecting it.

*nginx:*

```nginx
location /loadline/ {
    proxy_pass http://127.0.0.1:3000;   # no trailing path: keeps the prefix intact
    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
}
```

*Vercel / Netlify:* deploy the repo as its own project with the env vars above, then add a
rewrite from `ziptozip.systems/loadline/*` to that deployment, preserving the path.

*Cloudflare:* a Worker route on `ziptozip.systems/loadline*` proxying to the origin, again
without rewriting the path away.

Once live, the WhatsApp webhook URL becomes
`https://ziptozip.systems/loadline/api/webhooks/whatsapp`.

> **`DEMO_MODE=off` is the switch to throw the day real data goes in.** One-click sign-in
> is an intentional authentication bypass: anyone who opens the URL can enter as admin and
> edit messages or change job statuses. That is the right trade for a demo on sample data
> and the wrong one for anything else. Turning it off leaves the ordinary email/password
> form and the self-serve `/register`; change the demo passwords at the same time.

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
| `DEMO_MODE` | `on` | One-click demo sign-in. Set to `off` for real data — see above. |
| `PGLITE_DIR` | `./.pgdata`, or the temp dir on serverless | Where the embedded database lives |
| `GEOCODER` | `local` | `local` \| `census` \| `mapbox` |
| `HERE_API_KEY` | — | Type-ahead, address geocoding, truck road distance |
| `HERE_DAILY_BUDGET` | `2000` | Billable HERE calls per UTC day before falling back offline |
| `WHATSAPP_VERIFY_TOKEN` | — | Webhook handshake |
| `WHATSAPP_APP_SECRET` | — | Signature verification |
| `WHATSAPP_ALLOW_UNSIGNED` | `1` in dev | Local testing escape hatch; refuses to apply in production |
| `CRON_SECRET` | — | Bearer token for `/api/cron/*` |

---

## Layout

```
db/schema.sql              tables, indexes, and why the geo columns are shaped that way
src/lib/demo/              sample WhatsApp corpus, reset, console queries
src/lib/extract/           tokens, lexicon, lines, header, inventory, formats, rules
src/lib/geo/               aliases, gazetteer, states/ZIPs, place matcher, geocoder, math
src/lib/moving/            cubic feet, truck equivalents, price per cf
src/lib/pipeline/          ingest, process, reconcile (supersession), issues, expire, web
src/lib/loads/             search query builder, params, redaction, the public wire shapes
src/lib/location.ts        the viewer's location, in the browser and nowhere else
src/app/api/               REST surface incl. the Cloud API webhook and cron workers
src/components/            board, map, filters, cards, detail, post form, consoles
scripts/                   eval + cases, scorer, seed, reprocess, expire, maintenance
```

## Commands

| | |
|---|---|
| `npm run score` | The six real WhatsApp messages: 94/94 jobs, 0 fabricated |
| `npm run eval` | Extraction regression suite — run this after any rule change |
| `npm run eval:lifecycle` | Supersession: delisting, expiry, sticky Taken |
| `npm run check:redact` | Asserts no phone survives into a public payload |
| `npm run rules:export` | Write admin-taught rules into the eval fixtures |
| `npm run seed` | Demo accounts, groups, sample traffic, full pipeline run |
| `npm run process` | Drain the pending message queue |
| `npm run expire` | Run the expiry sweep |
| `npm run zips:warm` | Pre-resolve the ZIPs in the corpus |
| `npm run db:reset` | Truncate everything, keep the schema and the learned rules |
| `npm run geocache:clear` | Drop cached place lookups after a geo change |
| `npm run typecheck` | |

---

## Scope

Built: intake, extraction, normalization, geocoding, supersession and expiry, accounts and
roles, a public map-first board with lane/size/ready/freshness filters and route-corridor
matching, the contact gate, website posting and status management, the needs-attention
queue and both consoles.

Deliberately not built: notifications and alerts, SMS/push/email delivery, and a public
"other jobs from this sender" link — the sender id embeds the author's number, so a public
version needs an opaque id first.

**Where rules will fall short.** They handle the shapes in the fixtures and everything
shaped like them, which covers the bulk of real group traffic. They will not handle prose
("we've got a truck coming out of the Newark area Thursday that needs a backhaul"),
messages in languages the lexicon does not cover, or lanes described without any
recognizable place name. Those fail *closed* — no job is created, and the message lands in
the needs-attention queue with a reason rather than producing a wrong job. Widening
coverage means adding gazetteer entries, aliases and eval cases, which is cheap and safe.

`maplibre-gl` is pinned to v5 on purpose: v6 resolves its web worker through
`import.meta.url`, which the Next dev bundler does not serve as a real asset, so the worker
never starts and the map fails silently. v5 inlines the worker.

Note for anyone testing in a headless or offscreen browser: MapLibre drives its render loop
from `requestAnimationFrame`, which never fires while a page is hidden. The map then mounts
a correctly sized canvas and draws nothing, with no error. That is the harness, not the
app — in a real browser tab it renders normally.
