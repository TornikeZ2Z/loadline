# loadline infrastructure

OpenTofu for the deployment at https://loadline.ziptozip.app.

Design and reasoning: [`../docs/superpowers/specs/2026-09-06-aws-deployment-design.md`](../docs/superpowers/specs/2026-09-06-aws-deployment-design.md)

## Before you run anything

**`AWS_PROFILE=ziptozip` on every command.** This machine's default AWS profile
points at a different account (`654654141799`). A bare `tofu apply` targets another
client's infrastructure.

```bash
cd infra
AWS_PROFILE=ziptozip tofu init
AWS_PROFILE=ziptozip tofu plan
```

## What this stack does and does not own

It owns 27 declared resources (39 addresses in state — the 27 resources plus 12
read-only data sources):

| | |
|---|---|
| Registry | ECR repository + lifecycle policy |
| Network | 2 security groups (`loadline-tasks`, `loadline-rds`) |
| Data | DB subnet group, RDS instance, 3 Secrets Manager secrets |
| Compute | ECS cluster, task definition, service, CloudWatch log group |
| Edge | target group, ACM certificate + validation, **listener-certificate attachment**, 1 listener rule, **2 Route 53 records** (the A-alias and the certificate-validation CNAME) |
| IAM | **3 roles** — task execution, task, and the GitHub deploy role — plus 3 inline policies and 1 managed-policy attachment |

**Running cost: ~$23/month** — RDS `db.t4g.micro` + 20 GB gp3 ≈ $14.70, Fargate
0.25 vCPU / 0.5 GB on Graviton ≈ $7.20, ECR storage and CloudWatch Logs ≈ $1. The
ALB, the ACM certificate and the Route 53 records add nothing: the load balancer
already exists and is already paid for, and this stack only attaches to it.

It owns **none** of the platform. The VPC, subnets, the ALB itself, the Route 53
zone and the GitHub OIDC provider all belong to the ziptozip production stack and
are read only — through `terraform_remote_state` against `prod/terraform.tfstate`,
and through data sources. **No operation here applies the ziptozip stack.**

The two resources that attach to shared infrastructure —
`aws_lb_listener_certificate` and `aws_lb_listener_rule` — are additive. The
certificate is selected by SNI and does not replace prod's default; the rule matches
on host-header and cannot capture `ziptozip.app` traffic.

## Gotchas

1. **Everything here is arm64, and that is not negotiable.** The task's
   `runtime_platform` is ARM64 (Graviton) and the CI runner is `ubuntu-24.04-arm`.
   Do not "fix" a build by forcing `--platform linux/amd64`: Next 16's `next build`
   runs Turbopack, a native Rust binary that **segfaults under QEMU** (signal 11,
   exit 139), so an x86 image cannot be produced on an arm64 machine at all. If a
   pushed image is ever amd64, the task dies with `exec format error` and no useful
   log line.

2. **Secrets are created empty and populated by hand.** A task definition
   referencing a secret with no version fails at startup *before* the container
   runs, so nothing appears in the application logs. If tasks die instantly, check
   that all three secrets have versions first.

3. **The database is unreachable from a laptop, by design.** `loadline-rds` admits
   5432 from the `loadline-tasks` security group only. Use **Restore demo data** in
   `/admin`, or `aws ecs execute-command` — ECS Exec is enabled on the service.

4. **The app normally needs no seeding.** `src/app/login/page.tsx` calls
   `ensureDemoData`, so the demo corpus populates itself the first time anyone loads
   the login page.

5. **`tofu destroy` really deletes the secrets** — `recovery_window_in_days = 0`.
   That is deliberate: with the 30-day default, re-applying fails with "already
   scheduled for deletion" and cannot be worked around quickly.

6. **`DATABASE_URL` has two non-obvious requirements, and getting either wrong
   produces a task that reports HEALTHY and 500s on every real page.** Both were
   hit for real on 2026-09-06.

   **The password must be percent-encoded.** AWS-generated RDS master passwords
   routinely contain characters that are structurally significant in a URL — this
   deployment's contained `#` and `?`. Unencoded, `#` opens a fragment and the
   embedded `:` breaks host/port parsing; the app dies with `TypeError: Invalid
   URL`. Build the value with `urllib.parse.quote(pw, safe="")` — `safe=""`
   matters, the default leaves `/` alone.

   **It must carry `?sslmode=no-verify`.** `rds.force_ssl = 1` is a *system*
   default of the `default.postgres16` parameter group — it is set by AWS, not by
   this stack, so it appears nowhere in the HCL. Without SSL, Postgres rejects the
   connection with `no pg_hba.conf entry ... no encryption` (SQLSTATE 28000).

   Do **not** "fix" that with `?sslmode=require`. In `pg-connection-string`
   2.14.0, `require` maps to `ssl = {}`, which verifies the CA — and RDS's CA is
   not in Node's trust store, so it fails a third time. `no-verify` maps to
   `{rejectUnauthorized: false}`: encrypted, CA unverified. That is an accepted
   trade-off for a demo whose database sits in private subnets reachable only from
   the tasks security group. Verify with `sslmode`, not with a byte count:

   ```
   aws secretsmanager get-secret-value --secret-id loadline/DATABASE_URL \
     --query SecretString --output text | python3 -c '
   import sys
   from urllib.parse import urlsplit
   u = urlsplit(sys.stdin.read().strip())
   assert u.scheme=="postgres" and u.port==5432 and u.username=="loadline"
   print("parses OK", u.hostname, u.query)'
   ```

   **Changing the secret is not enough on its own** — ECS resolves `secrets` at
   task start, so a running task keeps the old value until
   `aws ecs update-service --force-new-deployment`.

7. **The health check is shallow on purpose, so "healthy" does not mean "working."**
   `/api/health` returns 200 without touching Postgres (see
   `src/app/api/health/route.ts` for why: a deep check would kill the task doing
   first-boot schema creation and seeding, forever). The cost is real and has
   fired: gotcha 6's broken database showed as a healthy target serving 500s.
   When diagnosing, curl `/login`, not `/api/health`.

## The cron is in the app, not in EventBridge

The deployment design deferred scheduling — *"An EventBridge Scheduler is a later
addition"* ([`../docs/superpowers/specs/2026-09-06-aws-deployment-design.md`](../docs/superpowers/specs/2026-09-06-aws-deployment-design.md),
line 28) — and the later addition never arrived, because this stack cannot be applied
from the machine the app is developed on. Meanwhile three bearer-guarded routes sat in
the repo with nothing calling them: jobs never expired, trucks never departed, and the
notification bell rendered a permanent zero.

So **the sweeps run inside the task**, on timers started from `src/instrumentation.ts`.
**There is no infrastructure here for them and this file adds no Terraform.** They ship
with the image, so they are live the moment the next `main` push deploys, and there is
nothing in AWS to drift from.

| Sweep | Every | Lock key |
|---|---|---|
| `process` | 60 s | `pg_try_advisory_lock(1819238756, 1)` |
| `expire` | 1 h | `pg_try_advisory_lock(1819238756, 2)` |
| `match` | 3 min | `pg_try_advisory_lock(1819238756, 3)` |

(`1819238756` is `0x6C6F6164`, `"load"` in ASCII — it shows up as `classid` in `pg_locks`.)

`desired_count = 1` today. **Raising it does not double-run anything**: each sweep takes
its advisory lock on a dedicated connection, and a task that cannot get the lock records
a skip and waits for its next tick. Watch for it in `/admin` — the strip at the top shows
the last run per sweep and which container ran it — or in `cron_runs` directly.

### Handing the job to EventBridge, when somebody can apply this stack

Nothing has to be rewritten; the three `POST /api/cron/*` routes are untouched and still
guarded by `CRON_SECRET`. **Documentation only — do not treat the snippets below as
applied state.**

1. Add `CRON_IN_PROCESS=off` to the task definition's `environment`. The next task to
   start prints `[cron] in-process scheduler OFF (CRON_IN_PROCESS=off)` and arms nothing.
   Do this **first**: with both running, the advisory locks keep them from colliding, but
   the ledger fills with skips and nobody can tell which scheduler is the live one.
2. Create an EventBridge **connection** holding the secret as an API-key authorization
   parameter — header `Authorization`, value `Bearer <the CRON_SECRET value>`. Point it
   at the same string that is in `loadline/CRON_SECRET`; EventBridge cannot read a
   Secrets Manager secret for you, it stores its own copy (in a secret it manages).
3. Create one **API destination** per route
   (`https://loadline.ziptozip.app/api/cron/process`, `…/expire`, `…/match`), method
   `POST`, using that connection.
4. Create one **schedule** per destination — `rate(1 minute)`, `rate(1 hour)`,
   `rate(3 minutes)` — with an execution role that allows
   `events:InvokeApiDestination` on the destination ARNs. Give each a different starting
   minute; the in-process scheduler staggers them to 15/30/45 s past the minute and
   EventBridge should not undo that.
5. Confirm from `/admin`, not from the EventBridge console: a schedule that fires and
   gets a 401 back looks *successful* in CloudWatch. The strip goes red when a sweep has
   not **completed** within twice its interval, which is the only end-to-end check.

The one thing that genuinely changes: with an external scheduler the sweeps run against
whichever task the ALB routes to, so `cron_runs.runner` stops being a single container.
That is fine — the advisory lock does not care which task holds it.

## HERE — on, and what that took

HERE **is** configured in production as of 2026-09-07: `loadline/HERE_API_KEY` in Secrets
Manager, injected into the task, with `GEOCODER=here`. Road routes, road miles and drive
time, exact ZIP coordinates and place autocomplete all work on the live board.

Three things have to be true together, and the third is the one that looks optional and
is not:

1. the task gets `HERE_API_KEY` from the secret,
2. the **execution** role may read that specific secret ARN — miss this and the task will
   not start at all (`ResourceInitializationError: unable to pull secrets`), and ECS keeps
   the old task running, so the site stays up and looks unchanged,
3. `GEOCODER` leaves `"local"`. `src/lib/geo/geocode.ts` reads that variable *before* it
   checks whether a key exists, so a correctly wired key with `GEOCODER=local` gives you
   road routes and still draws every destination as an approximate marker.

`here_secret_name` in `terraform.tfvars` is the secret's NAME, never the key: that file is
committed to a public repository, and `variables.tf` rejects a value with no `/` in it for
exactly that reason.

### If you ever move to a fresh database

Rows keep the coordinates they were created with, so a restored or re-seeded board starts
approximate even with HERE configured. Sign in as admin and use **Admin → Map precision**,
or `POST /api/admin/geocode` in batches. It is idempotent and costs one HERE call per
distinct ZIP, ever. On 2026-09-07 that took three batches to move 109 ZIPs from 0 precise
to 107, and 98 board deliveries from 97 approximate to 95 exact.

### Doing it by hand, when OpenTofu is not to hand

It was first turned on through the console — create the secret, add the ARN to the
`loadline-task-execution-secrets` inline policy, create a task-definition revision carrying
`HERE_API_KEY` (type `valueFrom`) and `GEOCODER=here`, then update the service onto that
revision. That works, but it drifts from this stack: the next `tofu apply` reconciles it,
which is why `here_secret_name` is set above.

