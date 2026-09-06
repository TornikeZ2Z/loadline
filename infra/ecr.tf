resource "aws_ecr_repository" "app" {
  name = var.name_prefix

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = { Name = var.name_prefix }
}

# Untagged images — superseded pushes and failed builds — expire after 14
# days. Tagged images, anything a task definition could still reference, are
# never touched.
data "aws_ecr_lifecycle_policy_document" "expire_untagged" {
  rule {
    priority    = 1
    description = "Expire untagged images after 14 days"

    selection {
      tag_status   = "untagged"
      count_type   = "sinceImagePushed"
      count_unit   = "days"
      count_number = 14
    }

    action {
      type = "expire"
    }
  }
}

resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name
  policy     = data.aws_ecr_lifecycle_policy_document.expire_untagged.json
}
