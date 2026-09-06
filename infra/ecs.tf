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

  # ARM64 (Graviton). Three reasons, in order of force:
  #   1. x86 images CANNOT be built on the developer machine at all — Next 16's
  #      `next build` runs Turbopack, a native Rust binary, which segfaults
  #      under QEMU emulation on arm64 (signal 11, exit 139).
  #   2. The deploy workflow runs on `ubuntu-24.04-arm`, native arm64 and free
  #      for public repositories — so CI needs no emulation either.
  #   3. Graviton Fargate is ~20% cheaper for identical vCPU/memory.
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
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
        # "local" is the offline gazetteer. With a HERE key wired in (see
        # here_secret_name in variables.tf) the app should ask HERE for a ZIP's
        # real point instead, which is what turns the map's "approximate"
        # markers into exact ones. src/lib/geo/geocode.ts reads this variable
        # BEFORE it checks whether a key exists, so leaving it at "local" would
        # silently defeat the key.
        { name = "GEOCODER", value = local.here_enabled ? "here" : "local" },
        # NEXT_PUBLIC_BASE_PATH is deliberately unset: the app is served at
        # the root of its own subdomain. It is a BUILD-time value anyway.
        # WHATSAPP_ALLOW_UNSIGNED is deliberately unset: it must never be
        # set in production.
      ]

      secrets = concat(
        [
          { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.database_url.arn },
          { name = "SESSION_SECRET", valueFrom = aws_secretsmanager_secret.session_secret.arn },
          { name = "CRON_SECRET", valueFrom = aws_secretsmanager_secret.cron_secret.arn },
        ],
        # Only when here_secret_name names a secret that already HOLDS a value.
        # A task definition pointing at a secret with no version fails to start,
        # which is why this is opt-in rather than created empty like the others.
        local.here_enabled
        ? [{ name = "HERE_API_KEY", valueFrom = data.aws_secretsmanager_secret.here_api_key[0].arn }]
        : [],
      )

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

  # :latest + force-new-deployment has no automatic rollback on its own. The
  # default minimumHealthyPercent of 100 already prevents an outage — a
  # crash-looping image never displaces the healthy task — but without this
  # the deploy simply hangs until `wait services-stable` times out. This turns
  # that hang into an automatic revert to the last good task set.
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
}
