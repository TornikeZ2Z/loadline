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
