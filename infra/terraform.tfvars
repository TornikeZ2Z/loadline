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

# Set to the live secret's NAME (never the key itself — variables.tf validates
# this and the file is committed to a public repo). Empty here would produce
# GEOCODER=local and drop HERE_API_KEY from the task definition, silently
# reverting the deployed map to the offline gazetteer.
here_secret_name = "loadline/HERE_API_KEY"
