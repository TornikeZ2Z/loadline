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
