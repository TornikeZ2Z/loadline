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

# ---------------------------------------------------------------------------
# HERE_API_KEY — looked up, never created.
#
# The block above explains why this stack does not CREATE this secret: a task
# definition that references a secret with no version is a hard startup
# failure, so an empty one would take the service down rather than degrade it.
# But a key that already exists is worth wiring, because without it the live
# board silently loses the three things HERE is for: real ZIP coordinates (so
# every destination draws as an "approximate" marker), road miles and drive
# time, and the vehicle route drawn when a job is opened.
#
# Set here_secret_name in terraform.tfvars to the name of the secret that holds
# the key, then `tofu apply`. Leave it empty and everything behaves exactly as
# it did before: GEOCODER stays "local" and no HERE variable reaches the task.
data "aws_secretsmanager_secret" "here_api_key" {
  count = local.here_enabled ? 1 : 0
  name  = var.here_secret_name
}

locals {
  here_enabled = var.here_secret_name != ""
}
