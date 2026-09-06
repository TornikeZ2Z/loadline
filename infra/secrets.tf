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
