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
