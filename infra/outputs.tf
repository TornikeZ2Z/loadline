output "deploy_role_arn" {
  description = "Copy into the GitHub repository secret AWS_DEPLOY_ROLE_ARN. Not a credential — there is no AWS access key in this pipeline."
  value       = aws_iam_role.deploy.arn
}

output "ecr_repository_url" {
  description = "Push target for the deploy workflow and for manual `docker push`."
  value       = aws_ecr_repository.app.repository_url
}

output "rds_address" {
  description = "RDS hostname, no port. A human uses it once to assemble loadline/DATABASE_URL — never logged with the password attached."
  value       = aws_db_instance.app.address
}

output "rds_master_secret_arn" {
  description = "ARN of the AWS-owned secret holding the RDS master password. Not a secret value itself."
  value       = aws_db_instance.app.master_user_secret[0].secret_arn
}

output "app_url" {
  value = "https://${var.hostname}"
}
