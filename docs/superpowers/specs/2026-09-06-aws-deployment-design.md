# loadline on AWS — deployment design

**Date:** 2026-09-06
**Status:** implemented 2026-09-06 — live at https://loadline.ziptozip.app
**Target:** `https://loadline.ziptozip.app` — a public demo/showcase deployment

---

## 1. Purpose and shape

Deploy loadline as a public, always-on demo at `loadline.ziptozip.app`, running on
the existing ziptozip AWS account (`908768512179`, `us-east-1`).

This is a **showcase deployment on seeded sample data**, not production for real
WhatsApp traffic. That decision sets everything downstream: one Fargate task, the
smallest RDS instance, one-day backups, no deletion protection, no multi-AZ.

`DEMO_MODE` stays `on`. It is an intentional authentication bypass — one-click
sign-in as admin — and the deployment will sit at a real public HTTPS URL, so
anyone with the link can enter as admin and edit messages or change load statuses.
That is the correct trade for a demo on sample data and the wrong one for anything
else. The day real data goes in, `DEMO_MODE=off` is the switch, and the demo
passwords change at the same time.

### Non-goals

- No staging environment. One stack, one environment.
- No `/api/cron/*` schedule. With no WhatsApp number connected there is nothing to
  drain, and seeded data is fresh. An EventBridge Scheduler is a later addition.
- No PostGIS. `db/postgis.sql` stays an unused upgrade path; the haversine queries
  are correct at demo volume.
- No WhatsApp Cloud API wiring. The `/admin` test console exercises the identical
  pipeline.

---

## 2. What already exists (verified live, 2026-09-06)

Read from the account, not assumed:

| Thing | Value |
|---|---|
| Account / region | `908768512179` / `us-east-1` |
| Route 53 zones | **`ziptozip.app` only** (`Z0220997QEOBEAXT0XGO`) |
| ALB | one shared, name `ziptozip` |
| 443 listener rules | priorities 5, 10, 40, 100, 130 in use |
| ACM cert on listener | `ziptozip.app` + `www.` + `staging.` |
| ECS clusters | `ziptozip`, `ziptozip-staging` |
| RDS | `ziptozip-prod` (t4g.small), `ziptozip-staging` (t4g.micro), both PG 16.13 |
| Tofu state | `s3://ziptozip-tfstate/`, keys `prod/` and `staging/`, native lockfile locking |
| GitHub OIDC provider | exists, `arn:aws:iam::908768512179:oidc-provider/token.actions.githubusercontent.com` |
| `ziptozip-tasks` SG | `sg-04a9d26402d8aa3c9`, ingress **3008 and 5008 only** |

Two corrections to written assumptions:

- **`ziptozip.systems` does not exist in this account.** loadline's `README.md`
  ("Deploying to ziptozip.systems/loadline") and the `next.config.ts` docblock both
  name it. The only delegated zone is `ziptozip.app`. Those docs are aspirational.
  The README should be updated when this ships.
- **The ziptozip repo's `CLAUDE.md` cites `ziptozip.tetrobyte.com`** as production.
  No such zone is in this account either; the tofu-managed app is on `ziptozip.app`.
  Not this project's problem, but worth not being confused by.

---

## 3. Architectural decisions

### 3.1 Subdomain, not path prefix

`loadline.ziptozip.app`, served at the **root** of its own origin.

Rejected: `ziptozip.app/loadline` (what the README assumes). Two reasons.

1. **Origin isolation.** A demo whose auth is an intentional one-click-admin bypass
   should not share a cookie domain and a JavaScript origin with the internal
   business system.
2. **No build-time base-path trap.** `NEXT_PUBLIC_BASE_PATH` is baked in by
   `next build`, not read at run time. Setting it only at run time yields an app
   whose pages load and whose every button 404s. Serving at root means the variable
   stays unset and the trap cannot fire.

### 3.2 A second certificate, not a new SAN

`envs/prod/main.tf` warns, correctly, that ACM **replaces** a certificate when a SAN
is added or removed — which on a live listener means re-validating and re-attaching
mid-flight.

An ALB listener can carry many certificates and select by SNI. So loadline creates
its **own** single-name certificate for `loadline.ziptozip.app` and attaches it with
`aws_lb_listener_certificate`. Prod's certificate is never touched, and public ACM
certificates are free.

### 3.3 Dedicated RDS instance

`db.t4g.micro`, PG 16, 20 GB gp3, private subnets, `manage_master_user_password`.

Rejected: a second database on `ziptozip-prod`. It is $0, but the `ziptozip-rds`
security group admits 5432 from the tasks SG only — there is no route from a
laptop — so `CREATE DATABASE` / `CREATE ROLE` would need a one-off in-VPC ECS task
before tofu could wire anything. More moving parts than a dedicated instance is
worth, and it puts demo load on the instance holding real business data.

Rejected: ephemeral PGlite. It is free and loadline does re-seed itself when empty,
but anything anyone does in the demo would vanish on every redeploy with no error.

### 3.4 Own security groups, own cluster

loadline creates `loadline-tasks` and `loadline-rds` rather than reusing ziptozip's.

This is not stylistic. **`ziptozip-tasks` admits only ports 3008 and 5008.** Next.js
listens on 3000. Reusing that SG produces a service that deploys clean and then
fails its health check forever, with nothing in the application logs to explain it.

The ECS cluster is likewise loadline's own. Clusters are free, and it keeps demo
tasks out of the production cluster's Container Insights and metrics.

### 3.5 Own state, reading prod's platform

State key `loadline/terraform.tfstate` in the existing `ziptozip-tfstate` bucket —
a third key alongside `prod/` and `staging/`.

This stack **creates nothing that prod owns.** It reads the platform through
`data "terraform_remote_state" "platform"` pointed at `prod/terraform.tfstate`,
exactly as `envs/staging` already does:

- `vpc_id`
- `public_subnet_ids` — ECS tasks (`assign_public_ip = true`, which is how the
  existing services reach ECR; the private subnets have no internet route)
- `private_subnet_ids` — the RDS subnet group
- `alb_security_group_id` — the ingress source for `loadline-tasks`

Prod does not export the HTTPS listener ARN or the ALB `arn_suffix`, so the ALB and
its listener are looked up with `data "aws_lb"` / `data "aws_lb_listener"` —
the same workaround, and for the same reason, that `envs/staging/main.tf`
documents.

### 3.6 GitHub OIDC — a second role, not a widened one

Push-to-deploy from `TornikeZ2Z/loadline`.

**The OIDC provider is a singleton per AWS account.** One already exists, created by
prod's state. loadline must `data`-source it by URL; declaring a second
`aws_iam_openid_connect_provider` fails with `EntityAlreadyExists`.

loadline creates its own `loadline-deploy` role, trusting that provider with
`sub = repo:TornikeZ2Z/loadline:*`, scoped to loadline's ECR repository and ECS
service only. Prod's `github_deploy` role is left alone — its `sub` condition is a
trust boundary, not a label, and widening it to admit a second repository would be
the wrong instinct.

Consequence worth stating plainly: **the entire deploy role lives in loadline's own
state, so prod's stack is never applied as part of this work.**

---

## 4. Resources created

All in `loadline/infra/`, one environment, one state.

| Layer | Resource |
|---|---|
| Registry | `aws_ecr_repository.app` (`loadline`), lifecycle policy expiring untagged after 14 days |
| Network | `aws_security_group.tasks` (3000 ← ALB SG), `aws_security_group.rds` (5432 ← tasks SG) |
| Data | `aws_db_subnet_group`, `aws_db_instance.app` — t4g.micro, PG 16, 20 GB gp3, `max_allocated_storage` 50, `manage_master_user_password`, `backup_retention_period` 1, `deletion_protection` false, `skip_final_snapshot` true |
| Secrets | `loadline/DATABASE_URL`, `loadline/SESSION_SECRET`, `loadline/CRON_SECRET` |
| Edge | `aws_acm_certificate` + validation records + `aws_acm_certificate_validation`; `aws_lb_listener_certificate`; `aws_route53_record` A-alias; `aws_lb_target_group` (:3000); `aws_lb_listener_rule` priority **20** |
| Compute | `aws_ecs_cluster.app`; `aws_cloudwatch_log_group` `/ecs/loadline` (14-day retention); `aws_ecs_task_definition` Fargate 256 CPU / 512 MB **ARM64/Graviton**; execution + task roles; `aws_ecs_service` desired_count 1, public subnets, `enable_execute_command` true |
| CI | `aws_iam_role.deploy` + inline policy |

### Listener rule priority

Priority **20**: after prod's `/api/*` at 10, before prod's catch-all at 40, and
clear of staging's 100/130. The rule matches on `host-header = loadline.ziptozip.app`
only, so it cannot collide with a `ziptozip.app` path rule regardless of ordering —
the priority choice is defensive, not load-bearing.

### Secrets are created empty, on purpose

Values are set by hand with `aws secretsmanager put-secret-value`, never generated
into tofu state by `random_password`.

This mirrors the house pattern, and prod's own outputs document the trap it creates:
*"the ECS task will fail to start if this secret has no version set before the task
definition referencing it is deployed."* Hence the runbook order in §7 —
**apply, then put secrets, then deploy the image.** Applying and deploying in one
motion produces a service that never starts.

### ECS Exec is enabled

`enable_execute_command = true` on the service, with the SSM messaging permissions
on the task role. Because the database is reachable only from inside the tasks
security group, ECS Exec is the *only* way to get a shell next to it — for
inspecting the database, re-running a seed, or debugging a task that starts and
then misbehaves. Without it the sole recourse is redeploying and reading logs.

`HERE_API_KEY` and the WhatsApp secrets are deliberately **not** created. loadline
falls back to the offline gazetteer and straight-line distance without a HERE key
and every screen still works, and an unset secret referenced by a task definition is
a startup failure. They get added the day they are actually wanted.

---

## 5. Application changes in this repo

### 5.1 `src/app/api/health/route.ts` — new

A **shallow** liveness check: returns 200 without touching the database.

The alternative, a deep check running `SELECT 1`, was considered and rejected for a
specific reason. loadline creates its schema *and seeds itself* on first connection
(`migrate()` in `src/lib/db.ts`, then the empty-database seed). A deep check can
fail during that window, and ECS would replace the very task doing the seeding —
which then starts the seed again on a fresh task, forever. Shallow plus a generous
`health_check_grace_period_seconds` avoids the loop entirely.

The cost is honest and accepted: a task with an unreachable database reports healthy
and serves broken pages rather than being replaced. At demo scale that is visible
immediately and recoverable by hand.

### 5.2 `Dockerfile` — new

Multi-stage, `node:22-slim`. Plain `next build` + `next start`. **Not**
`output: "standalone"`.

Two constraints drive this, both verified in the source:

- **`db/schema.sql` must exist in the runtime image at `process.cwd()/db/`.**
  `migrate()` reads it with `fs.readFileSync` at *run* time. Standalone tracing
  follows the JS import graph, would never see that read, and would drop `db/` —
  yielding an image that builds clean, starts, and dies on the first request.
- **PGlite's wasm bundle** is exactly the kind of non-JS asset file tracing omits
  silently. It is still imported conditionally by `src/lib/db.ts` even when
  `DATABASE_URL` is set.

The image is larger than a standalone build. That is the right trade for a demo.

`next build` needs **no** `DATABASE_URL`: all six pages declare
`export const dynamic = "force-dynamic"`, so nothing is prerendered and no page
touches Postgres at build time. Verified across `src/app/`.

`NEXT_PUBLIC_BASE_PATH` stays unset — the app is served at the root of its own
subdomain (§3.1).

### 5.3 `.dockerignore` — new

At minimum `node_modules`, `.next`, `.pgdata`, `.git`, `.env*`, `infra`, `.design`.
`.pgdata` matters: it is a local embedded database directory that would otherwise be
copied into the image.

### 5.4 `.github/workflows/deploy.yml` — new

On push to the default branch: assume `loadline-deploy` via OIDC, build, push to
ECR tagged with the commit SHA, `aws ecs update-service --force-new-deployment`,
`aws ecs wait services-stable`. No AWS access key anywhere.

### 5.5 `.gitignore` — amend

Add `infra/.terraform/`, `infra/*.tfstate*`, `infra/*.tfplan`. `infra/*.tfvars` is
**committed** — it holds no secrets, matching ziptozip's committed `prod.tfvars`.

### 5.6 `README.md` — amend

The "Deploying to ziptozip.systems/loadline" section describes a domain that does not
exist and a proxy/base-path arrangement this deployment does not use. Replace it with
the real target and the §7 runbook.

---

## 6. Cost

**Architecture: ARM64 (Graviton), decided 2026-09-06 during implementation.** The
design originally specified x86_64. That is not buildable here: Next 16's
`next build` runs Turbopack, a native Rust binary, which segfaults under QEMU
emulation on an arm64 machine (`uncaught target signal 11`, exit 139) about 11
seconds into the build. ARM64 is native on both the developer machine and the CI
runner (`ubuntu-24.04-arm`, free for public repositories), needs no emulation
anywhere, and is ~20% cheaper on Fargate.

| Item | Monthly |
|---|---|
| RDS db.t4g.micro + 20 GB gp3 | ~$14.70 |
| Fargate 0.25 vCPU / 0.5 GB ARM64 (Graviton), always on | ~$7.20 |
| ECR storage + CloudWatch Logs | ~$1.00 |
| ALB, ACM certificate, Route 53 records | $0 marginal |
| **Total** | **~$23/mo** |

The ALB is already running and already paid for; loadline adds a target group, a
rule and a certificate to it, none of which are billed.

---

## 7. Runbook — order matters

1. `tofu init` / `plan` / `apply` in `infra/`, with `AWS_PROFILE=ziptozip`.
   ACM validation blocks until the DNS records resolve; the zone is already
   delegated, so this is a wait, not a hang.
2. Read the RDS master password from the AWS-managed secret
   (`aws secretsmanager get-secret-value` on `rds_master_secret_arn`) and assemble
   `DATABASE_URL`. Put it into `loadline/DATABASE_URL`.
3. Generate and put `SESSION_SECRET` (32+ random bytes) and `CRON_SECRET`.
4. **Only now** push the first image to ECR and let the service start.

   Expect the service to be failing at this point, and do not treat it as a fault.
   One `apply` creates the ECR repository and the ECS service together, so between
   step 1 and here the service is trying to launch tasks with no image to pull and
   no secret versions to resolve. ECS retries indefinitely and converges by itself
   once both exist; the failed-task events from the gap are noise, not damage.
5. Verify `https://loadline.ziptozip.app/api/health` returns 200 and the target
   group reports a healthy target.
6. Load `https://loadline.ziptozip.app/login` once. **This is the seed step.**
   `src/app/login/page.tsx` calls `ensureDemoData`, so the demo corpus populates
   itself on first visit. Nothing is run by hand.

   Note what does *not* work here: `npm run seed` from a laptop. The
   `loadline-rds` security group admits 5432 from the tasks security group only
   (§3.4), so there is no network path from a developer machine to this database
   — by design. If the board ever needs re-seeding, use **Restore demo data** in
   the `/admin` test console, which runs server-side inside the task, or
   `aws ecs execute-command` (ECS Exec is enabled on the service).

**`AWS_PROFILE=ziptozip` on every command.** The machine's default AWS profile
points at a *different* account (`654654141799`). A bare `tofu apply` or `aws` call
targets the wrong client's infrastructure.

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| ACM validation blocks the first apply | `ziptozip.app` is already delegated to this account's zone; validation is a wait of a few minutes |
| Attaching a cert to the shared listener touches prod's edge | `aws_lb_listener_certificate` is additive and SNI-selected; prod's default certificate and rules are untouched. Verify prod still serves after apply |
| Listener rule priority collision | 20 is unused; the rule is host-header-scoped so it cannot match prod traffic |
| Task starts before secrets have versions, or before an image exists | Expected and self-correcting: a single `apply` creates both the ECR repository and the ECS service, so the service has nothing to pull and no secret versions to resolve until steps 2-4. ECS retries failed task launches indefinitely, so it converges on its own once the image and secrets are in place. The cost is a few minutes of failed-task events in the service's event log — noisy, not harmful |
| Public demo with an admin auth bypass | Accepted and documented (§1). `DEMO_MODE=off` is the switch when real data arrives |
| Reading prod's remote state couples the stacks | Read-only. If prod's outputs are renamed, loadline's plan fails loudly rather than drifting |

---

## 9. Open questions and follow-ups

None blocking. Deferred by choice: the `/api/cron/*` schedule, HERE geocoding,
WhatsApp Cloud API wiring, and PostGIS — each is additive and none changes the
shape above.

### Hardening backlog

Triaged at the final whole-branch review (2026-09-06): none of these block merge,
and all are demo-appropriate as they stand. Ordered by what to do first if loadline
stops being a demo.

1. **RDS CA verification.** `DATABASE_URL` carries `?sslmode=no-verify` — the
   connection is TLS-encrypted but RDS's CA is not verified. Doing it properly means
   shipping the RDS CA bundle into the image, setting `NODE_EXTRA_CA_CERTS`, and
   moving to `sslmode=verify-full`. Note that `sslmode=require` is NOT the fix: in
   `pg-connection-string` 2.14.0 it maps to full CA verification and fails the same
   way. That mapping is also deprecated — it changes in pg v9, so revisit on upgrade.

2. **Tasks security-group egress** is `0.0.0.0/0` on all protocols. This cannot
   simply be narrowed: the tasks run in public subnets and the VPC has no NAT
   gateway, so ECR, Secrets Manager, CloudWatch and SSM are all reached over the
   internet. Tightening it requires VPC endpoints first, not a rule edit.

3. **Task-execution role uses `AmazonECSTaskExecutionRolePolicy`**, which grants
   `ecr:BatchGetImage` / `GetDownloadUrlForLayer` on `*` — so loadline's execution
   role can pull ziptozip's container images — and `logs:*` on `*`. Replacing it with
   an inline policy scoped to `aws_ecr_repository.app.arn` and
   `aws_cloudwatch_log_group.app.arn` would make the least-privilege story literally
   true, as the secrets statement beside it already is.

4. **ECS Exec has no audit trail.** The cluster sets no
   `execute_command_configuration`, so exec sessions are not logged to CloudWatch or
   S3. Fine here; matters the moment this pattern is copied somewhere auditable.

5. **`aws_iam_role_policy.deploy`'s sid `EcrPushToLoadlineRepoOnly`** also grants two
   pull actions. The resource scoping is what enforces; only the sid overstates.

6. **`Dockerfile` startup goes through `npx`**, and the runner's `useradd` creates no
   home directory, so npm cannot write `~/.npm/_logs` and crash logs are lost.
   `CMD ["./node_modules/.bin/next", "start", …]` removes npm from the path entirely.

7. **`aws_route53_record.cert_validation` sets `allow_overwrite = true`** — the only
   write in this stack that can replace an existing record in the shared production
   zone rather than failing. The record name is ACM-generated and prod cannot own it,
   so the risk is theoretical, but it deserves a justifying comment.

8. **RDS `apply_immediately = true`** applies changes outside a maintenance window.
   Correct for a demo with no traffic to disrupt; wrong once there is.
