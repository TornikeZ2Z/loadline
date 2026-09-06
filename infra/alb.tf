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
