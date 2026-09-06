# loadline AWS Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy loadline as a public demo at `https://loadline.ziptozip.app`, running on ECS Fargate behind the existing shared ziptozip ALB, with its own RDS instance, managed entirely by OpenTofu in this repo.

**Architecture:** A single OpenTofu stack in `infra/` with its own state key, which creates nothing the ziptozip production stack owns. It reads that stack's VPC, subnets and ALB security group read-only through `terraform_remote_state`, and attaches to the shared ALB additively — a second SNI certificate and one host-header listener rule, leaving prod's certificate and rules untouched. The app ships as a plain `next build` / `next start` container.

**Tech Stack:** OpenTofu >= 1.11, AWS provider ~> 5.70, ECS Fargate, RDS Postgres 16, ECR, ACM, Route 53, Secrets Manager, GitHub Actions with OIDC. App is Next.js 16 / React 19 on Node 22.

**Spec:** `docs/superpowers/specs/2026-09-06-aws-deployment-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **`AWS_PROFILE=ziptozip` on every `aws` and `tofu` command, without exception.** The machine's default AWS profile points at a different account (`654654141799`). A bare command targets another client's infrastructure.
- Target AWS account is `908768512179`, region `us-east-1`.
- **Never modify `/Users/user/Desktop/ziptozip/`.** This stack reads prod's state read-only. No task in this plan applies the ziptozip stack.
- OpenTofu `required_version = ">= 1.11"`; AWS provider `~> 5.70`. Matches both existing ziptozip environments.
- Naming: `name_prefix = "loadline"`, hostname `loadline.ziptozip.app`, ALB listener rule priority `20`, secret prefix `loadline/`, state key `loadline/terraform.tfstate` in bucket `ziptozip-tfstate`.
- **Anything pushed to ECR must be `linux/amd64`.** Fargate runs the task as x86_64. A native `docker build` on Apple Silicon produces arm64, which starts and dies with `exec format error`.
- Secrets are created empty by tofu and populated by hand. **Never** use `random_password` — it writes the value into state.
- `DEMO_MODE` stays `on`. `WHATSAPP_ALLOW_UNSIGNED` must stay unset.
- All work happens on branch `feat/aws-deployment`, off `main`.

---

### Task 1: Health endpoint

The ALB target group needs something to poll. loadline has no health route — verified across all 24 files under `src/app/api/`.

Shallow by design: it returns 200 without touching Postgres. `migrate()` in `src/lib/db.ts` creates the schema on first connection and `ensureDemoData` seeds it, and a deep check can fail during that window — ECS would then replace the very task doing the seeding, which starts the seed again on a fresh task, forever.

**Files:**
- Create: `src/app/api/health/route.ts`
- Create: `docs/` (already contains the spec; commit it here)

**Interfaces:**
- Consumes: nothing.
- Produces: `GET /api/health` → `200` with body `{"status":"ok"}`. Task 6's `aws_lb_target_group.app` health check targets this exact path and matches on `200`.

- [ ] **Step 1: Create the branch**

```bash
cd /Users/user/Desktop/loadline
git checkout -b feat/aws-deployment
```

- [ ] **Step 2: Write the failing check**

There is no test runner in this repo — `package.json` has `eval` and `score` scripts, not a framework. The check is a live request against the dev server.

In one terminal:

```bash
cd /Users/user/Desktop/loadline && npm run dev
```

In another:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/api/health
```

Expected: `404` — the route does not exist yet.

- [ ] **Step 3: Write the route**

Create `src/app/api/health/route.ts`:

```ts
/**
 * Liveness probe for the ALB target group.
 *
 * DELIBERATELY SHALLOW: returns 200 without touching the database.
 *
 * A deep check (`SELECT 1`) looks more useful and is a trap here. On a cold
 * start this app creates its schema (`migrate()` in src/lib/db.ts) and then
 * seeds itself (`ensureDemoData`, reached from src/app/login/page.tsx). A deep
 * check can fail during that window, ECS replaces the task doing the seeding,
 * and the replacement starts the same slow work again — forever.
 *
 * The accepted cost: a task whose database is unreachable reports healthy and
 * serves broken pages rather than being replaced. At demo scale that is visible
 * immediately and fixable by hand.
 */
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ status: "ok" });
}
```

- [ ] **Step 4: Run the check again**

```bash
curl -s -w '\n%{http_code}\n' http://localhost:3000/api/health
```

Expected: body `{"status":"ok"}` then `200`.

- [ ] **Step 5: Typecheck**

```bash
cd /Users/user/Desktop/loadline && npm run typecheck
```

Expected: exits 0, no output.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/health/route.ts docs/
git commit -m "$(cat <<'EOF'
feat: add a shallow health endpoint for the ALB target group

Returns 200 without touching Postgres. A deep check would fail during
first-connection schema creation and seeding, and ECS would replace the
task doing that work in a loop.

Also commits the AWS deployment design spec this implements.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Y5kZFJfzFEZXFzVbfJdusD
EOF
)"
```

---

### Task 2: Container image

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`

**Interfaces:**
- Consumes: `GET /api/health` from Task 1.
- Produces: an image that listens on **port 3000** and serves `/api/health`. Task 6's container definition sets `containerPort = 3000` and Task 6's target group polls that port.

**Why not `output: "standalone"`.** Two runtime facts make it wrong here, both verified in the source:

1. `migrate()` in `src/lib/db.ts` does `fs.readFileSync(path.join(process.cwd(), "db", "schema.sql"))` at **run** time. Standalone tracing follows the JS import graph, would never see that read, and would drop `db/` — producing an image that builds clean, starts, and dies on the first request.
2. PGlite ships a wasm bundle, exactly the kind of non-JS asset tracing omits silently. `src/lib/db.ts` still imports it conditionally even when `DATABASE_URL` is set.

The image is bigger. That is the right trade for a demo.

**No `DATABASE_URL` is needed at build time.** All six pages declare `export const dynamic = "force-dynamic"`, so nothing prerenders and no page touches Postgres during `next build`. Do not add a fake connection string to fix a problem that does not exist.

**No `public/` directory exists** in this repo — do not add a `COPY public` line; it will fail the build.

- [ ] **Step 1: Write `.dockerignore` first**

Without this, `COPY . .` drags in `.pgdata` — a local embedded Postgres data directory — and bakes it into the image.

```
node_modules
.next
.pgdata
.git
.github
.env
.env.*
infra
docs
.design
.claude
*.md
```

- [ ] **Step 2: Write the Dockerfile**

```dockerfile
# syntax=docker/dockerfile:1.7
#
# Plain `next build` + `next start`. NOT output: "standalone" — see
# docs/superpowers/plans/2026-09-06-aws-deployment.md Task 2 for why.
#
# Build (for ECR, from any machine):
#   docker build --platform linux/amd64 -t loadline .

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# No DATABASE_URL: every page is force-dynamic, so nothing prerenders.
RUN npm run build

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs nextjs

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder   /app/.next        ./.next
COPY package.json next.config.ts ./
# REQUIRED AT RUNTIME: migrate() reads db/schema.sql from process.cwd().
COPY db ./db

USER nextjs
EXPOSE 3000
CMD ["npx", "next", "start", "-H", "0.0.0.0", "-p", "3000"]
```

- [ ] **Step 3: Build it**

```bash
cd /Users/user/Desktop/loadline
docker build -t loadline:smoke .
```

Expected: a successful build.

**The specific thing this step is checking:** `next.config.ts` is TypeScript, and `next start` must load it at run time. Next 16 loads TS configs with its own bundled loader, so the `typescript` devDependency being absent from the runner stage should be fine. If startup in Step 4 fails with a config-loading error, the fix is to add `typescript` to the runner stage — not to abandon the approach.

- [ ] **Step 4: Smoke-test the container**

No `DATABASE_URL`, so it falls back to PGlite and exercises schema creation and seeding end to end.

```bash
docker run --rm -d -p 3010:3000 --name loadline-smoke loadline:smoke
sleep 15
curl -s -w '\n%{http_code}\n' http://localhost:3010/api/health
curl -s -o /dev/null -w 'login page: %{http_code}\n' http://localhost:3010/login
docker logs loadline-smoke | tail -20
docker stop loadline-smoke
```

Expected: `{"status":"ok"}` / `200`, login page `200`, and no `ENOENT` for `db/schema.sql` in the logs.

An `ENOENT ... db/schema.sql` means the `COPY db ./db` line is missing or the working directory is wrong.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile .dockerignore
git commit -m "$(cat <<'EOF'
feat: containerize loadline for Fargate

Plain next build + next start rather than standalone output: migrate()
reads db/schema.sql from process.cwd() at runtime, which file tracing
would never see, and PGlite's wasm bundle is the same class of problem.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Y5kZFJfzFEZXFzVbfJdusD
EOF
)"
```

---

### Task 3: OpenTofu scaffolding

Backend, provider, variables, and the read-only handles on the ziptozip platform. Creates zero AWS resources — the deliverable is a stack that initialises and plans clean.

**Files:**
- Create: `infra/backend.tf`, `infra/providers.tf`, `infra/variables.tf`, `infra/platform.tf`, `infra/terraform.tfvars`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing.
- Produces, for every later task: `var.region`, `var.name_prefix`, `var.hostname`, `var.secret_prefix`, `var.listener_rule_priority`, `var.rds_instance_class`, `var.desired_count`, `var.image_tag`, `var.github_repo`; and locals `local.vpc_id`, `local.public_subnet_ids`, `local.private_subnet_ids`, `local.alb_security_group_id`; and data sources `data.aws_lb.shared`, `data.aws_lb_listener.https`, `data.aws_route53_zone.main`, `data.aws_caller_identity.current`, `data.aws_iam_openid_connect_provider.github`.

- [ ] **Step 1: `infra/backend.tf`**

```hcl
terraform {
  required_version = ">= 1.11"

  # A THIRD key in the shared bucket, alongside prod/ and staging/. If this
  # ever matched either of theirs, loadline would adopt that state and the
  # next plan would propose destroying a live environment to match this
  # stack's variables. Verify this line before every `tofu init` here.
  backend "s3" {
    bucket       = "ziptozip-tfstate"
    key          = "loadline/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true # native S3 locking — no DynamoDB table needed
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.70"
    }
  }
}
```

- [ ] **Step 2: `infra/providers.tf`**

```hcl
provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = "loadline"
      ManagedBy = "opentofu"
    }
  }
}
```

- [ ] **Step 3: `infra/variables.tf`**

```hcl
variable "region" {
  type    = string
  default = "us-east-1"
}

variable "name_prefix" {
  type        = string
  description = "Prefix for every named resource. Also the ECS cluster and service name."
  default     = "loadline"
}

variable "hostname" {
  type        = string
  description = "Public hostname. Served at the ROOT of its own subdomain, which is why NEXT_PUBLIC_BASE_PATH stays unset — that value is baked in by `next build`, and setting it at run time only yields an app whose pages load and whose every button 404s."
  default     = "loadline.ziptozip.app"
}

variable "zone_name" {
  type        = string
  description = "The Route 53 zone to put the record in. This zone is LOOKED UP, never created — it is delegated and shared with the ziptozip production stack."
  default     = "ziptozip.app"
}

variable "secret_prefix" {
  type    = string
  default = "loadline/"
}

# 20 sits after prod's /api/* rule at 10 and before prod's catch-all at 40,
# clear of staging's 100/130. The rule matches on host-header only, so it
# cannot collide with a ziptozip.app path rule at any priority — this choice
# is defensive, not load-bearing.
variable "listener_rule_priority" {
  type    = number
  default = 20
}

variable "rds_instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "desired_count" {
  type    = number
  default = 1
}

variable "image_tag" {
  type        = string
  description = "ECR tag the task definition points at. `latest` plus force-new-deployment is a deliberate simplification for a demo: it trades per-deploy task-definition revisions (and easy rollback) for a one-line deploy. Revisit if this stops being a demo."
  default     = "latest"
}

variable "github_repo" {
  type        = string
  description = "OIDC TRUST BOUNDARY, not a label. This string is what stops any other repository from assuming the deploy role."
  default     = "TornikeZ2Z/loadline"
}

variable "log_retention_days" {
  type    = number
  default = 14
}
```

- [ ] **Step 4: `infra/platform.tf`**

```hcl
# ============================================================================
# Read-only handles on the ziptozip platform.
#
# NOTHING in this stack creates a resource the ziptozip production stack
# owns. The VPC, subnets, ALB, Route 53 zone and GitHub OIDC provider all
# belong to prod's state; this file only reads them.
# ============================================================================

# `key = "prod/terraform.tfstate"` is a READ of prod's state, not a second
# backend for this stack. This stack's own state is the "loadline/" key in
# backend.tf. Same arrangement envs/staging uses in the ziptozip repo.
data "terraform_remote_state" "platform" {
  backend = "s3"
  config = {
    bucket = "ziptozip-tfstate"
    key    = "prod/terraform.tfstate"
    region = "us-east-1"
  }
}

# Prod's outputs.tf does not export the HTTPS listener ARN or the ALB's
# arn_suffix — only alb_dns_name / alb_zone_id / alb_security_group_id. So
# the ALB and its one HTTPS listener are looked up rather than read through
# remote state. envs/staging does exactly this, for exactly this reason.
data "aws_lb" "shared" {
  name = "ziptozip"
}

data "aws_lb_listener" "https" {
  load_balancer_arn = data.aws_lb.shared.arn
  port              = 443
}

data "aws_route53_zone" "main" {
  name         = var.zone_name
  private_zone = false
}

data "aws_caller_identity" "current" {}

# A GitHub OIDC provider is a SINGLETON per AWS account, and prod's state
# already created this one. Declaring `aws_iam_openid_connect_provider` here
# would fail with EntityAlreadyExists. Reading it means loadline's deploy
# role lives entirely in this state and prod is never applied.
data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}

locals {
  vpc_id                = data.terraform_remote_state.platform.outputs.vpc_id
  public_subnet_ids     = data.terraform_remote_state.platform.outputs.public_subnet_ids
  private_subnet_ids    = data.terraform_remote_state.platform.outputs.private_subnet_ids
  alb_security_group_id = data.terraform_remote_state.platform.outputs.alb_security_group_id
}
```

- [ ] **Step 5: `infra/terraform.tfvars`**

Committed on purpose — it holds no secrets, matching ziptozip's committed `prod.tfvars`. Every value is the variable default, written out so the stack's actual configuration is readable in one place.

```hcl
region                 = "us-east-1"
name_prefix            = "loadline"
hostname               = "loadline.ziptozip.app"
zone_name              = "ziptozip.app"
secret_prefix          = "loadline/"
listener_rule_priority = 20
rds_instance_class     = "db.t4g.micro"
desired_count          = 1
image_tag              = "latest"
github_repo            = "TornikeZ2Z/loadline"
log_retention_days     = 14
```

- [ ] **Step 6: Extend `.gitignore`**

Append:

```
# OpenTofu — state and provider caches never go in git.
# infra/*.tfvars IS committed: it holds no secrets.
infra/.terraform/
infra/*.tfstate
infra/*.tfstate.*
infra/*.tfplan
infra/.terraform.lock.hcl.bak
```

- [ ] **Step 7: Initialise and verify it plans clean**

```bash
cd /Users/user/Desktop/loadline/infra
AWS_PROFILE=ziptozip tofu init
AWS_PROFILE=ziptozip tofu fmt
AWS_PROFILE=ziptozip tofu validate
AWS_PROFILE=ziptozip tofu plan
```

Expected: `init` succeeds and writes `.terraform.lock.hcl`; `validate` reports success; `plan` reports **"No changes."**

A failure reading prod's remote state means the S3 read is denied — check `AWS_PROFILE`. An `EntityAlreadyExists` here means someone declared the OIDC provider instead of reading it.

- [ ] **Step 8: Commit**

```bash
cd /Users/user/Desktop/loadline
git add infra/backend.tf infra/providers.tf infra/variables.tf infra/platform.tf infra/terraform.tfvars infra/.terraform.lock.hcl .gitignore
git commit -m "$(cat <<'EOF'
feat(infra): OpenTofu scaffolding reading the ziptozip platform read-only

Own state key alongside prod/ and staging/. Creates nothing prod owns:
VPC, subnets, ALB and the GitHub OIDC provider (a per-account singleton)
are all read, never declared.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Y5kZFJfzFEZXFzVbfJdusD
EOF
)"
```

---

### Task 4: ECR repository, and the first image

Deliberately ahead of the ECS service. If the service were created first it would spend the intervening minutes failing to pull an image that does not exist. Creating the registry and pushing an image first means the service starts healthy the moment it exists.

**Files:**
- Create: `infra/ecr.tf`

**Interfaces:**
- Consumes: `var.name_prefix` (Task 3).
- Produces: `aws_ecr_repository.app` — Task 6's container definition builds its `image` from `aws_ecr_repository.app.repository_url`, and Task 8's deploy policy scopes its push permissions to `aws_ecr_repository.app.arn`.

- [ ] **Step 1: `infra/ecr.tf`**

```hcl
resource "aws_ecr_repository" "app" {
  name = var.name_prefix

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = { Name = var.name_prefix }
}

# Untagged images — superseded pushes and failed builds — expire after 14
# days. Tagged images, anything a task definition could still reference, are
# never touched.
data "aws_ecr_lifecycle_policy_document" "expire_untagged" {
  rule {
    priority    = 1
    description = "Expire untagged images after 14 days"

    selection {
      tag_status   = "untagged"
      count_type   = "sinceImagePushed"
      count_unit   = "days"
      count_number = 14
    }

    action {
      type = "expire"
    }
  }
}

resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name
  policy     = data.aws_ecr_lifecycle_policy_document.expire_untagged.json
}
```

- [ ] **Step 2: Plan and check the count**

```bash
cd /Users/user/Desktop/loadline/infra
AWS_PROFILE=ziptozip tofu plan
```

Expected: `Plan: 2 to add, 0 to change, 0 to destroy.`

Anything proposing a change or destroy at this point is wrong — stop and investigate before applying.

- [ ] **Step 3: Apply**

```bash
AWS_PROFILE=ziptozip tofu apply
```

- [ ] **Step 4: Verify the repository exists**

```bash
AWS_PROFILE=ziptozip aws ecr describe-repositories --repository-names loadline \
  --region us-east-1 --query 'repositories[0].repositoryUri' --output text
```

Expected: `908768512179.dkr.ecr.us-east-1.amazonaws.com/loadline`

- [ ] **Step 5: Build and push the first image**

**`--platform linux/amd64` is mandatory.** The Fargate task is x86_64; a native build on Apple Silicon produces arm64, which starts and dies with `exec format error` and no useful log line.

```bash
cd /Users/user/Desktop/loadline
export AWS_PROFILE=ziptozip AWS_REGION=us-east-1
REGISTRY=908768512179.dkr.ecr.us-east-1.amazonaws.com

aws ecr get-login-password --region us-east-1 \
  | docker login --username AWS --password-stdin "$REGISTRY"

docker build --platform linux/amd64 -t "$REGISTRY/loadline:latest" .
docker push "$REGISTRY/loadline:latest"
```

- [ ] **Step 6: Verify the pushed image's architecture**

```bash
AWS_PROFILE=ziptozip aws ecr describe-images --repository-name loadline \
  --image-ids imageTag=latest --region us-east-1 \
  --query 'imageDetails[0].{tags:imageTags,pushed:imagePushedAt,size:imageSizeInBytes}'
```

Then confirm the platform:

```bash
docker image inspect "$REGISTRY/loadline:latest" --format '{{.Os}}/{{.Architecture}}'
```

Expected: `linux/amd64`. If it says `linux/arm64`, rebuild with `--platform linux/amd64` and push again before continuing — Task 6 will otherwise produce a crash-looping service.

- [ ] **Step 7: Commit**

```bash
git add infra/ecr.tf
git commit -m "$(cat <<'EOF'
feat(infra): ECR repository with untagged-image expiry

Created and populated before the ECS service so the service has an image
to pull the moment it exists.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Y5kZFJfzFEZXFzVbfJdusD
EOF
)"
```

---

### Task 5: Security groups, RDS, and empty secrets

**Files:**
- Create: `infra/network.tf`, `infra/rds.tf`, `infra/secrets.tf`

**Interfaces:**
- Consumes: `local.vpc_id`, `local.private_subnet_ids`, `local.alb_security_group_id`, `var.name_prefix`, `var.rds_instance_class`, `var.secret_prefix` (Task 3).
- Produces: `aws_security_group.tasks` (Task 6's service `network_configuration`), `aws_db_instance.app`, and three secrets — `aws_secretsmanager_secret.database_url`, `.session_secret`, `.cron_secret` — whose ARNs Task 6's container `secrets` block and task-execution policy both reference.

**Why loadline gets its own security groups.** The existing `ziptozip-tasks` group (`sg-04a9d26402d8aa3c9`) admits **only ports 3008 and 5008**. Next.js listens on 3000. Reusing it produces a service that deploys clean and then fails its health check forever, with nothing in the application logs to explain why.

- [ ] **Step 1: `infra/network.tf`**

```hcl
# loadline's OWN security groups. Not a stylistic choice: the existing
# ziptozip-tasks group admits 3008 and 5008 only, and Next.js listens on
# 3000. Reusing it yields a service that deploys clean and then fails its
# health check forever, silently.
resource "aws_security_group" "tasks" {
  name        = "${var.name_prefix}-tasks"
  description = "loadline Fargate tasks: 3000 from the shared ziptozip ALB only"
  vpc_id      = local.vpc_id

  ingress {
    description     = "Next.js from the shared ziptozip ALB"
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [local.alb_security_group_id]
  }

  # Tasks run in PUBLIC subnets with a public IP — that is how the existing
  # ziptozip services reach ECR, Secrets Manager and CloudWatch, because the
  # private subnets have no internet route. Egress must stay open.
  egress {
    description = "ECR pull, Secrets Manager, CloudWatch Logs, SSM (ECS Exec)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.name_prefix}-tasks" }
}

# No egress rule on purpose: the database initiates nothing.
resource "aws_security_group" "rds" {
  name        = "${var.name_prefix}-rds"
  description = "loadline RDS: 5432 from loadline tasks only, no internet route"
  vpc_id      = local.vpc_id

  ingress {
    description     = "Postgres from loadline tasks"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.tasks.id]
  }

  tags = { Name = "${var.name_prefix}-rds" }
}
```

- [ ] **Step 2: `infra/rds.tf`**

```hcl
resource "aws_db_subnet_group" "main" {
  name       = var.name_prefix
  subnet_ids = local.private_subnet_ids

  tags = { Name = var.name_prefix }
}

resource "aws_db_instance" "app" {
  identifier = var.name_prefix
  engine     = "postgres"

  # Major version only. AWS resolves it to the current minor, and
  # auto_minor_version_upgrade then keeps it there without this line causing
  # perpetual drift — which pinning "16.13" would.
  engine_version = "16"

  instance_class = var.rds_instance_class

  allocated_storage     = 20
  max_allocated_storage = 50
  storage_type          = "gp3"
  storage_encrypted     = true

  db_name  = "loadline"
  username = "loadline"

  # AWS owns and rotates the master password in its own Secrets Manager
  # secret. It is never in tofu state and never in this repo. A human reads
  # it once to assemble DATABASE_URL.
  manage_master_user_password = true

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = false

  # Demo settings. All three would be wrong for production.
  backup_retention_period = 1
  deletion_protection     = false
  skip_final_snapshot     = true

  auto_minor_version_upgrade = true
  apply_immediately          = true

  tags = { Name = var.name_prefix }
}
```

- [ ] **Step 3: `infra/secrets.tf`**

```hcl
# Created EMPTY. Values are put by hand with `aws secretsmanager
# put-secret-value` (see the plan's Step 6 below).
#
# Never `random_password` here — that writes the generated value into tofu
# state, which is exactly what keeping secrets in Secrets Manager is for.
#
# recovery_window_in_days = 0 so a `tofu destroy` really deletes them. With
# the default 30-day window, re-applying this stack fails with
# "already scheduled for deletion" and cannot be worked around quickly.

resource "aws_secretsmanager_secret" "database_url" {
  name                    = "${var.secret_prefix}DATABASE_URL"
  description             = "postgres://… for loadline. Assembled by a human from the RDS endpoint plus the AWS-managed master password secret."
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret" "session_secret" {
  name                    = "${var.secret_prefix}SESSION_SECRET"
  description             = "Signs loadline session cookies. 32+ random bytes. Changing it logs everyone out."
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret" "cron_secret" {
  name                    = "${var.secret_prefix}CRON_SECRET"
  description             = "Bearer token gating /api/cron/*. No schedule calls these yet; the secret exists because the app reads the variable."
  recovery_window_in_days = 0
}

# HERE_API_KEY and the WhatsApp secrets are deliberately NOT created. The app
# falls back to the offline gazetteer and straight-line distance without a
# HERE key and every screen still works — and a task definition referencing a
# secret with no version is a hard startup failure. Add them the day they are
# actually wanted, together with their values.
```

- [ ] **Step 4: Plan**

```bash
cd /Users/user/Desktop/loadline/infra
AWS_PROFILE=ziptozip tofu fmt && AWS_PROFILE=ziptozip tofu validate
AWS_PROFILE=ziptozip tofu plan
```

Expected: `Plan: 7 to add, 0 to change, 0 to destroy.` — two security groups, the subnet group, the DB instance, and three secrets.

**Nothing may be changed or destroyed.** A destroy at this point means a name collided with an existing resource.

- [ ] **Step 5: Apply**

```bash
AWS_PROFILE=ziptozip tofu apply
```

RDS creation takes roughly 5-10 minutes.

- [ ] **Step 6: Assemble and put the secrets**

```bash
export AWS_PROFILE=ziptozip AWS_REGION=us-east-1

ENDPOINT=$(aws rds describe-db-instances --db-instance-identifier loadline \
  --query 'DBInstances[0].Endpoint.Address' --output text)
MASTER_ARN=$(aws rds describe-db-instances --db-instance-identifier loadline \
  --query 'DBInstances[0].MasterUserSecret.SecretArn' --output text)

# Read the AWS-managed master password, assemble the URL, and put it —
# without the password ever being echoed.
PGPASS=$(aws secretsmanager get-secret-value --secret-id "$MASTER_ARN" \
  --query SecretString --output text | python3 -c 'import sys,json;print(json.load(sys.stdin)["password"])')

aws secretsmanager put-secret-value --secret-id loadline/DATABASE_URL \
  --secret-string "postgres://loadline:${PGPASS}@${ENDPOINT}:5432/loadline" \
  --query 'VersionId' --output text

aws secretsmanager put-secret-value --secret-id loadline/SESSION_SECRET \
  --secret-string "$(openssl rand -hex 32)" --query 'VersionId' --output text

aws secretsmanager put-secret-value --secret-id loadline/CRON_SECRET \
  --secret-string "$(openssl rand -hex 32)" --query 'VersionId' --output text

unset PGPASS
```

- [ ] **Step 7: Verify all three have a version, without printing values**

```bash
for s in DATABASE_URL SESSION_SECRET CRON_SECRET; do
  printf '%s: ' "$s"
  AWS_PROFILE=ziptozip aws secretsmanager get-secret-value \
    --secret-id "loadline/$s" --query 'SecretString' --output text \
    | wc -c | tr -d ' '
done
```

Expected: three non-zero byte counts. A zero or an error means Task 6's tasks will die at startup, before any application log line is written.

- [ ] **Step 8: Commit**

```bash
cd /Users/user/Desktop/loadline
git add infra/network.tf infra/rds.tf infra/secrets.tf
git commit -m "$(cat <<'EOF'
feat(infra): loadline security groups, RDS instance and empty secrets

Own security groups because ziptozip-tasks admits 3008/5008 only and
Next.js listens on 3000 — reusing it fails health checks silently.
Secrets are created empty; values are put by hand, never via
random_password, which would write them into state.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Y5kZFJfzFEZXFzVbfJdusD
EOF
)"
```

---

### Task 6: Edge — target group, certificate, listener rule, DNS

**Reordered ahead of ECS deliberately.** ECS refuses to create a service whose target group is not associated with a load balancer: `InvalidParameterException: The target group with targetGroupArn ... does not have an associated load balancer`. The listener rule in this task is what creates that association, so it must exist before Task 7's service.

This is the only task that touches shared production infrastructure. Everything here is **additive**: a second certificate selected by SNI, and one host-header rule. Prod's default certificate and its rules at priorities 5/10/40 are never modified.

**Files:**
- Create: `infra/alb.tf`

**Interfaces:**
- Consumes: `data.aws_lb.shared`, `data.aws_lb_listener.https`, `data.aws_route53_zone.main`, `local.vpc_id`, `var.hostname`, `var.name_prefix`, `var.listener_rule_priority` (Task 3).
- Produces: `aws_lb_target_group.app` — Task 7's ECS service registers into it with `container_name = var.name_prefix` and `container_port = 3000`.

- [ ] **Step 1: Record the current state of prod's listener, to compare against afterwards**

```bash
export AWS_PROFILE=ziptozip AWS_REGION=us-east-1
LARN=$(aws elbv2 describe-load-balancers --names ziptozip \
  --query 'LoadBalancers[0].LoadBalancerArn' --output text)
LIS=$(aws elbv2 describe-listeners --load-balancer-arn "$LARN" \
  --query 'Listeners[?Port==`443`].ListenerArn' --output text)

echo "rules:        $(aws elbv2 describe-rules --listener-arn "$LIS" \
  --query 'Rules[].Priority' --output text)"
echo "default cert: $(aws elbv2 describe-listener-certificates --listener-arn "$LIS" \
  --query 'Certificates[?IsDefault==`true`].CertificateArn' --output text)"
```

Expected: priorities `5 10 40 100 130 default`, and one default certificate ARN.

**Copy both lines into the task notes.** Step 5 compares against them, and this is the only record of what prod's listener looked like before this stack touched it.

- [ ] **Step 2: Write `infra/alb.tf` — the target group first**

`target_type = "ip"` because awsvpc networking registers task ENIs, not instances.

```hcl
resource "aws_lb_target_group" "app" {
  name        = var.name_prefix
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = local.vpc_id
  target_type = "ip" # awsvpc networking registers task ENIs, not instances

  # Shallow probe — see src/app/api/health/route.ts for why it must not
  # touch the database.
  health_check {
    enabled             = true
    path                = "/api/health"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  deregistration_delay = 30

  tags = { Name = var.name_prefix }
}
```

Then the edge, appended to the same file:

```hcl
# --- Certificate ---
#
# A SECOND certificate on the shared listener, not a new SAN on prod's.
# ACM REPLACES a certificate when its SAN list changes, which on a live
# listener means re-validating and re-attaching mid-flight — the ziptozip
# prod stack documents this hazard on its own cert. An ALB listener can
# carry many certificates and selects by SNI, so this leaves prod's
# certificate untouched. Public ACM certificates are free.
resource "aws_acm_certificate" "app" {
  domain_name       = var.hostname
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = { Name = var.name_prefix }
}

resource "aws_route53_record" "cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.app.domain_validation_options :
    dvo.domain_name => {
      name   = dvo.resource_record_name
      type   = dvo.resource_record_type
      record = dvo.resource_record_value
    }
  }

  zone_id         = data.aws_route53_zone.main.zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "app" {
  certificate_arn         = aws_acm_certificate.app.arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}

# Additive: attaches a NON-default certificate. Does not alter which
# certificate the listener serves by default.
resource "aws_lb_listener_certificate" "app" {
  listener_arn    = data.aws_lb_listener.https.arn
  certificate_arn = aws_acm_certificate_validation.app.certificate_arn
}

# --- Listener rule ---
#
# Host-header only, so it cannot match ziptozip.app traffic at any priority.
resource "aws_lb_listener_rule" "app" {
  listener_arn = data.aws_lb_listener.https.arn
  priority     = var.listener_rule_priority

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }

  condition {
    host_header {
      values = [var.hostname]
    }
  }

  tags = { Name = var.name_prefix }
}

# --- DNS ---
resource "aws_route53_record" "app" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = var.hostname
  type    = "A"

  alias {
    name                   = data.aws_lb.shared.dns_name
    zone_id                = data.aws_lb.shared.zone_id
    evaluate_target_health = false
  }
}
```

- [ ] **Step 3: Plan — and read it carefully**

```bash
cd /Users/user/Desktop/loadline/infra
AWS_PROFILE=ziptozip tofu fmt && AWS_PROFILE=ziptozip tofu validate
AWS_PROFILE=ziptozip tofu plan
```

Expected: **add only.** If the plan proposes changing or destroying anything named `ziptozip`, stop — something is reaching into prod's resources and must be fixed before applying.

- [ ] **Step 4: Apply**

```bash
AWS_PROFILE=ziptozip tofu apply
```

`aws_acm_certificate_validation` blocks until DNS validation completes. `ziptozip.app` is already delegated to this account's zone, so this is a wait of a few minutes, not a hang.

- [ ] **Step 5: Verify prod is untouched**

Do this before anything else.

```bash
export AWS_PROFILE=ziptozip AWS_REGION=us-east-1
LARN=$(aws elbv2 describe-load-balancers --names ziptozip --query 'LoadBalancers[0].LoadBalancerArn' --output text)
LIS=$(aws elbv2 describe-listeners --load-balancer-arn "$LARN" --query 'Listeners[?Port==`443`].ListenerArn' --output text)

echo "default cert now: $(aws elbv2 describe-listener-certificates --listener-arn "$LIS" \
  --query 'Certificates[?IsDefault==`true`].CertificateArn' --output text)"
echo "rules now:        $(aws elbv2 describe-rules --listener-arn "$LIS" \
  --query 'Rules[].Priority' --output text)"

echo "--- prod still serves? ---"
curl -sI https://ziptozip.app/ | head -1
```

Expected, compared against the values recorded in Step 1:

- the default certificate ARN is **identical** — if it changed, prod's certificate was replaced, and that is a production incident, not a cosmetic difference
- the rule priorities are the Step 1 list **with `20` added and nothing else altered**
- `ziptozip.app` still returns `HTTP/2 200`

- [ ] **Step 6: Confirm loadline's hostname resolves, and returns 503**

```bash
dig +short loadline.ziptozip.app
curl -s -o /dev/null -w '%{http_code}\n' https://loadline.ziptozip.app/api/health
```

Expected: the ALB's IPs, then **`503`**.

503 is the correct answer here, not a fault: the rule and certificate exist, so TLS terminates and the ALB routes — but no ECS service exists yet, so the target group has no targets. Task 7 turns this into a 200. A `000` or a TLS error instead means the certificate did not attach.

- [ ] **Step 7: Commit**

```bash
cd /Users/user/Desktop/loadline
git add infra/alb.tf
git commit -m "$(cat <<'EOF'
feat(infra): target group, SNI certificate, listener rule and DNS

Additive on the shared ALB: a second certificate selected by SNI rather
than a new SAN on prod's, which ACM would replace on a live listener.
The rule matches host-header only.

Ordered before the ECS service because ECS refuses a target group with no
associated load balancer, and this rule is what creates that association.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Y5kZFJfzFEZXFzVbfJdusD
EOF
)"
```

---

### Task 7: ECS cluster, IAM, task definition, service

**Files:**
- Create: `infra/iam.tf`, `infra/ecs.tf`

**Interfaces:**
- Consumes: `aws_ecr_repository.app` (Task 4); `aws_security_group.tasks` and the three secrets (Task 5); `aws_lb_target_group.app` (Task 6); `local.public_subnet_ids` (Task 3).
- Produces: `aws_ecs_cluster.app` and `aws_ecs_service.app`, whose names Task 8's deploy policy and workflow reference.

- [ ] **Step 1: `infra/iam.tf`**

```hcl
data "aws_iam_policy_document" "ecs_tasks_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# --- Execution role: what ECS ITSELF assumes, before the container starts,
# --- to pull the image and resolve secrets.
resource "aws_iam_role" "task_execution" {
  name               = "${var.name_prefix}-task-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume_role.json
}

resource "aws_iam_role_policy_attachment" "task_execution_managed" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Scoped to loadline's three secrets by ARN. The managed policy above grants
# ECR and logs but NOT Secrets Manager.
data "aws_iam_policy_document" "task_execution_secrets" {
  statement {
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      aws_secretsmanager_secret.database_url.arn,
      aws_secretsmanager_secret.session_secret.arn,
      aws_secretsmanager_secret.cron_secret.arn,
    ]
  }
}

resource "aws_iam_role_policy" "task_execution_secrets" {
  name   = "${var.name_prefix}-task-execution-secrets"
  role   = aws_iam_role.task_execution.id
  policy = data.aws_iam_policy_document.task_execution_secrets.json
}

# --- Task role: what the APPLICATION assumes at run time.
resource "aws_iam_role" "task" {
  name               = "${var.name_prefix}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume_role.json
}

# ECS Exec only. The database is reachable from inside the tasks security
# group and nowhere else, so this is the ONLY way to get a shell next to it —
# for inspecting the database or re-running a seed. Without it the sole
# recourse is redeploying and reading logs.
data "aws_iam_policy_document" "task_exec_channel" {
  statement {
    actions = [
      "ssmmessages:CreateControlChannel",
      "ssmmessages:CreateDataChannel",
      "ssmmessages:OpenControlChannel",
      "ssmmessages:OpenDataChannel",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "task_exec_channel" {
  name   = "${var.name_prefix}-task-exec-channel"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task_exec_channel.json
}
```

- [ ] **Step 2: `infra/ecs.tf`**

```hcl
# loadline's own cluster. Clusters are free, and this keeps demo tasks out of
# the production cluster's Container Insights and metrics.
resource "aws_ecs_cluster" "app" {
  name = var.name_prefix

  tags = { Name = var.name_prefix }
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/${var.name_prefix}"
  retention_in_days = var.log_retention_days
}

resource "aws_ecs_task_definition" "app" {
  family                   = var.name_prefix
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.task.arn

  # x86_64, matching what the deploy workflow's ubuntu-latest runner builds
  # natively. Anything pushed from an Apple Silicon machine must therefore
  # use `docker build --platform linux/amd64`, or the task dies with
  # "exec format error".
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    {
      name      = var.name_prefix
      image     = "${aws_ecr_repository.app.repository_url}:${var.image_tag}"
      essential = true

      portMappings = [{
        containerPort = 3000
        protocol      = "tcp"
      }]

      environment = [
        { name = "NODE_ENV", value = "production" },
        # DEMO_MODE=on is an INTENTIONAL auth bypass: one-click sign-in as
        # admin, on a public URL. Correct for a showcase on sample data,
        # wrong for anything else. Flip to "off" the day real data lands,
        # and change the demo passwords at the same time.
        { name = "DEMO_MODE", value = "on" },
        { name = "LOAD_TZ", value = "America/New_York" },
        { name = "GEOCODER", value = "local" },
        # NEXT_PUBLIC_BASE_PATH is deliberately unset: the app is served at
        # the root of its own subdomain. It is a BUILD-time value anyway.
        # WHATSAPP_ALLOW_UNSIGNED is deliberately unset: it must never be
        # set in production.
      ]

      secrets = [
        { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.database_url.arn },
        { name = "SESSION_SECRET", valueFrom = aws_secretsmanager_secret.session_secret.arn },
        { name = "CRON_SECRET", valueFrom = aws_secretsmanager_secret.cron_secret.arn },
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.app.name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "ecs"
        }
      }
    }
  ])
}

resource "aws_ecs_service" "app" {
  name            = var.name_prefix
  cluster         = aws_ecs_cluster.app.id
  task_definition = aws_ecs_task_definition.app.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  enable_execute_command = true

  network_configuration {
    subnets = local.public_subnet_ids
    # PUBLIC subnets with a public IP is how the existing ziptozip services
    # reach ECR and Secrets Manager — the private subnets have no internet
    # route and there is no NAT gateway in this VPC.
    assign_public_ip = true
    security_groups  = [aws_security_group.tasks.id]
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.app.arn
    container_name   = var.name_prefix
    container_port   = 3000
  }

  # Generous, on purpose. First boot creates the schema and seeds the demo
  # corpus; a tight grace period would kill the task doing that work.
  health_check_grace_period_seconds = 120

  # The deploy workflow forces a new deployment of the SAME :latest tag, so
  # it never changes the task definition and tofu never sees drift from it.
  # desired_count is ignored so that scaling the service by hand during a
  # demo does not get reverted by the next apply.
  lifecycle {
    ignore_changes = [desired_count]
  }
}
```

- [ ] **Step 3: Plan and apply**

```bash
cd /Users/user/Desktop/loadline/infra
AWS_PROFILE=ziptozip tofu fmt && AWS_PROFILE=ziptozip tofu validate
AWS_PROFILE=ziptozip tofu plan
AWS_PROFILE=ziptozip tofu apply
```

Confirm the plan adds only — **nothing destroyed, nothing changed.**

- [ ] **Step 4: Verify the task runs and passes its health check**

```bash
export AWS_PROFILE=ziptozip AWS_REGION=us-east-1

aws ecs wait services-stable --cluster loadline --services loadline
aws ecs describe-services --cluster loadline --services loadline \
  --query 'services[0].{running:runningCount,desired:desiredCount,status:status}'

TG=$(aws elbv2 describe-target-groups --names loadline \
  --query 'TargetGroups[0].TargetGroupArn' --output text)
aws elbv2 describe-target-health --target-group-arn "$TG" \
  --query 'TargetHealthDescriptions[].TargetHealth.State'
```

Expected: `running: 1`, and target health `["healthy"]`.

If the target is `unhealthy`, read the logs before changing anything:

```bash
aws logs tail /ecs/loadline --since 10m
```

Each symptom has exactly one cause, because everything upstream was already proven:

- `exec format error` → the image is arm64. Rebuild with `--platform linux/amd64` (Task 4 Step 5).
- `ResourceInitializationError ... secrets` → a secret has no version. Re-run Task 5 Step 7.
- `ENOENT ... db/schema.sql` → the Dockerfile is missing `COPY db ./db` (Task 2).
- Task runs, health check times out → the security group is wrong; confirm ingress is 3000, not 3008 (Task 5).
- `does not have an associated load balancer` → Task 6 did not apply; the listener rule is missing.

- [ ] **Step 5: Verify the app serves publicly — which also seeds it**

```bash
curl -s -w '\n%{http_code}\n' https://loadline.ziptozip.app/api/health
curl -s -o /dev/null -w 'login: %{http_code}\n' https://loadline.ziptozip.app/login
```

Expected: `{"status":"ok"}` / `200` — the 503 from Task 6 Step 6 is now a 200 — and `login: 200`.

`src/app/login/page.tsx` calls `ensureDemoData`, so that second request **is** the seed step: the demo corpus populates itself on first visit. There is nothing to run by hand — and `npm run seed` from a laptop cannot work here, because `loadline-rds` admits 5432 from the tasks security group only.

Open `https://loadline.ziptozip.app/login` in a browser, sign in as Carrier, and confirm the board shows loads.

- [ ] **Step 6: Commit**

```bash
cd /Users/user/Desktop/loadline
git add infra/iam.tf infra/ecs.tf
git commit -m "$(cat <<'EOF'
feat(infra): ECS cluster, IAM roles, task definition and service

Own cluster to keep demo tasks out of prod's metrics. Public subnets with
a public IP because this VPC has no NAT gateway. ECS Exec enabled — the
database is reachable only from inside the tasks SG, so it is the only
shell.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Y5kZFJfzFEZXFzVbfJdusD
EOF
)"
```

---

### Task 8: GitHub Actions deploy pipeline

**Files:**
- Create: `infra/deploy-role.tf`, `.github/workflows/deploy.yml`
- Create: `infra/outputs.tf`

**Interfaces:**
- Consumes: `data.aws_iam_openid_connect_provider.github`, `var.github_repo` (Task 3); `aws_ecr_repository.app` (Task 4); `aws_ecs_cluster.app`, `aws_ecs_service.app` (Task 7).
- Produces: `output.deploy_role_arn`, which a human copies into the repo secret `AWS_DEPLOY_ROLE_ARN`.

- [ ] **Step 1: `infra/deploy-role.tf`**

```hcl
# loadline's OWN deploy role. The ziptozip prod stack's github_deploy role
# pins its `sub` to the ziptozip repository, and that condition IS the
# security boundary — widening it to admit a second repository would be the
# wrong instinct. Because the OIDC provider is merely read (platform.tf),
# this role lives entirely in loadline's state and prod is never applied.
data "aws_iam_policy_document" "deploy_assume_role" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [data.aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    # The trust boundary. Only workflows in this repository may assume it.
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repo}:*"]
    }
  }
}

resource "aws_iam_role" "deploy" {
  name               = "${var.name_prefix}-deploy"
  assume_role_policy = data.aws_iam_policy_document.deploy_assume_role.json
}

data "aws_iam_policy_document" "deploy" {
  # GetAuthorizationToken cannot be scoped to a repository — it is an
  # account-level call that returns a registry login token.
  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid = "EcrPushToLoadlineRepoOnly"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:CompleteLayerUpload",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
      "ecr:DescribeImages",
    ]
    resources = [aws_ecr_repository.app.arn]
  }

  statement {
    sid = "EcsDeployLoadlineServiceOnly"
    actions = [
      "ecs:UpdateService",
      "ecs:DescribeServices",
    ]
    resources = [aws_ecs_service.app.id]
  }
}

resource "aws_iam_role_policy" "deploy" {
  name   = "${var.name_prefix}-deploy"
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy.json
}
```

- [ ] **Step 2: `infra/outputs.tf`**

```hcl
output "deploy_role_arn" {
  description = "Copy into the GitHub repository secret AWS_DEPLOY_ROLE_ARN. Not a credential — there is no AWS access key in this pipeline."
  value       = aws_iam_role.deploy.arn
}

output "ecr_repository_url" {
  description = "Push target for the deploy workflow and for manual `docker push`."
  value       = aws_ecr_repository.app.repository_url
}

output "rds_address" {
  description = "RDS hostname, no port. A human uses it once to assemble loadline/DATABASE_URL — never logged with the password attached."
  value       = aws_db_instance.app.address
}

output "rds_master_secret_arn" {
  description = "ARN of the AWS-owned secret holding the RDS master password. Not a secret value itself."
  value       = aws_db_instance.app.master_user_secret[0].secret_arn
}

output "app_url" {
  value = "https://${var.hostname}"
}
```

- [ ] **Step 3: Apply and read the role ARN**

```bash
cd /Users/user/Desktop/loadline/infra
AWS_PROFILE=ziptozip tofu fmt && AWS_PROFILE=ziptozip tofu validate
AWS_PROFILE=ziptozip tofu apply
AWS_PROFILE=ziptozip tofu output -raw deploy_role_arn
```

Expected: `arn:aws:iam::908768512179:role/loadline-deploy`

- [ ] **Step 4: `.github/workflows/deploy.yml`**

```yaml
name: deploy

on:
  push:
    branches: [main]
  workflow_dispatch:

# id-token is what makes OIDC work. Without it the role assumption fails
# with a confusing credentials error.
permissions:
  id-token: write
  contents: read

concurrency:
  group: deploy
  cancel-in-progress: false

env:
  AWS_REGION: us-east-1
  ECR_REPOSITORY: loadline
  ECS_CLUSTER: loadline
  ECS_SERVICE: loadline

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_DEPLOY_ROLE_ARN }}
          aws-region: ${{ env.AWS_REGION }}

      - id: login-ecr
        uses: aws-actions/amazon-ecr-login@v2

      # ubuntu-latest is x86_64 and the task definition's runtime_platform is
      # X86_64, so this builds natively with no emulation.
      - name: Build and push
        env:
          REGISTRY: ${{ steps.login-ecr.outputs.registry }}
        run: |
          IMAGE="$REGISTRY/$ECR_REPOSITORY"
          docker build -t "$IMAGE:${{ github.sha }}" -t "$IMAGE:latest" .
          docker push "$IMAGE:${{ github.sha }}"
          docker push "$IMAGE:latest"

      # The task definition pins :latest, so forcing a new deployment is the
      # whole deploy. The SHA tag above exists so a bad deploy can be rolled
      # back by re-tagging a known-good image as latest and forcing again.
      - name: Deploy
        run: |
          aws ecs update-service \
            --cluster "$ECS_CLUSTER" --service "$ECS_SERVICE" \
            --force-new-deployment --no-cli-pager
          aws ecs wait services-stable \
            --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE"
```

- [ ] **Step 5: Set the repository secret**

```bash
cd /Users/user/Desktop/loadline
gh secret set AWS_DEPLOY_ROLE_ARN \
  --body "$(cd infra && AWS_PROFILE=ziptozip tofu output -raw deploy_role_arn)"
gh secret list
```

- [ ] **Step 6: Commit and verify the pipeline end to end**

```bash
git add infra/deploy-role.tf infra/outputs.tf .github/workflows/deploy.yml
git commit -m "$(cat <<'EOF'
feat(ci): OIDC deploy role and GitHub Actions pipeline

A second role trusting only repo:TornikeZ2Z/loadline:*, rather than
widening prod's github_deploy trust. Scoped to loadline's ECR repository
and ECS service. No AWS access key anywhere.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Y5kZFJfzFEZXFzVbfJdusD
EOF
)"
```

**Then, and only with the user's explicit go-ahead, push.** Nothing in this plan
pushes to a remote before this point; commits are local. Confirm before running it.

Pushing the *branch* is safe on its own — the workflow's `on.push` trigger is
scoped to `main`, so a branch push deploys nothing. `workflow_dispatch` is what
actually runs it, deliberately, so the pipeline can be proven before any merge.

```bash
git push -u origin feat/aws-deployment
gh workflow run deploy --ref feat/aws-deployment
gh run watch
```

Expected: green. A failure at `configure-aws-credentials` means the `sub` condition or the repo secret is wrong; a failure at `docker push` means the ECR statement's resource ARN is wrong.

- [ ] **Step 7: Confirm the deployed app still serves**

```bash
curl -s -w '\n%{http_code}\n' https://loadline.ziptozip.app/api/health
```

Expected: `{"status":"ok"}` / `200`.

---

### Task 9: Documentation

The README currently documents a deployment to a domain that does not exist in this account, via a proxy arrangement this deployment does not use.

**Files:**
- Modify: `README.md` — the "Deploying to ziptozip.systems/loadline" section
- Modify: `next.config.ts` — the docblock naming `ziptozip.systems`
- Create: `infra/README.md`

- [ ] **Step 1: Rewrite the README deployment section**

Replace the whole "## Deploying to ziptozip.systems/loadline" section — including the nginx / Vercel / Cloudflare sub-path guidance, which no longer applies — with:

````markdown
## Deployment

Live at **https://loadline.ziptozip.app**, on AWS ECS Fargate behind the shared
ziptozip ALB. Infrastructure is OpenTofu in [`infra/`](infra/); the design and the
reasoning behind each choice are in
[`docs/superpowers/specs/2026-09-06-aws-deployment-design.md`](docs/superpowers/specs/2026-09-06-aws-deployment-design.md).

Push to `main` and `.github/workflows/deploy.yml` builds, pushes to ECR and forces a
new ECS deployment. There are no AWS keys in the pipeline — it authenticates by OIDC.

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
````

- [ ] **Step 2: Fix the `next.config.ts` docblock**

The comment names `https://ziptozip.systems/loadline`, a domain that does not exist in this AWS account. Change that line to read:

```ts
 * `NEXT_PUBLIC_BASE_PATH` lets the app be served under a sub-path, e.g.
 * `https://example.com/loadline`. The AWS deployment does NOT use this — it
 * serves the app at the root of loadline.ziptozip.app — but the option is kept
 * for anyone proxying it under a prefix. Leave it unset for local development.
```

- [ ] **Step 3: `infra/README.md`**

```markdown
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

It owns: an ECR repository, two security groups, an RDS instance, three Secrets
Manager secrets, an ECS cluster/service/task definition, a target group, an ACM
certificate, one ALB listener rule, one Route 53 record, and two IAM roles.

It owns **none** of the platform. The VPC, subnets, the ALB itself, the Route 53
zone and the GitHub OIDC provider all belong to the ziptozip production stack and
are read only — through `terraform_remote_state` against `prod/terraform.tfstate`,
and through data sources. **No operation here applies the ziptozip stack.**

The two resources that attach to shared infrastructure —
`aws_lb_listener_certificate` and `aws_lb_listener_rule` — are additive. The
certificate is selected by SNI and does not replace prod's default; the rule matches
on host-header and cannot capture `ziptozip.app` traffic.

## Gotchas

1. **Anything pushed to ECR must be `linux/amd64`.** The task's
   `runtime_platform` is X86_64. A native `docker build` on Apple Silicon produces
   arm64, and the task dies with `exec format error` and no useful log line. The
   GitHub Actions runner is x86_64, so the pipeline is safe; manual pushes are not.

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
```

- [ ] **Step 4: Verify the docs are accurate**

```bash
cd /Users/user/Desktop/loadline
grep -rn "ziptozip.systems" README.md next.config.ts || echo "no stale domain references"
npm run typecheck
```

Expected: no stale references, typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add README.md next.config.ts infra/README.md
git commit -m "$(cat <<'EOF'
docs: replace the aspirational ziptozip.systems deployment guide

That domain does not exist in this AWS account and the sub-path proxy
arrangement is not what shipped. Documents the real deployment plus the
five traps that produce a service which deploys clean and never serves.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Y5kZFJfzFEZXFzVbfJdusD
EOF
)"
```

---

## Final verification

- [ ] `https://loadline.ziptozip.app/api/health` returns `{"status":"ok"}`
- [ ] `https://loadline.ziptozip.app/login` loads and the board shows seeded loads after signing in
- [ ] `https://ziptozip.app/` still serves, and the listener's **default** certificate ARN is unchanged from the value recorded in Task 6 Step 1
- [ ] `aws elbv2 describe-rules` shows priorities `5 10 20 40 100 130 default` — 20 added, nothing else altered
- [ ] `AWS_PROFILE=ziptozip tofu plan` in `infra/` reports **"No changes."**
- [ ] A push to `main` deploys green
- [ ] `AWS_PROFILE=ziptozip aws ce get-cost-and-usage` or the Billing console shows the expected ~$25/mo run rate after a few days
