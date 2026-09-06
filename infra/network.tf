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
