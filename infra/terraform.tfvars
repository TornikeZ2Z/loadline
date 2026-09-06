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

# The NAME of an existing Secrets Manager secret that HOLDS the HERE key --
# never the key itself. This file is committed to a public repository.
# e.g. here_secret_name = "loadline/HERE_API_KEY"
here_secret_name       = "loadline/HERE_API_KEY"
