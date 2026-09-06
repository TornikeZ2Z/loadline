terraform {
  required_version = ">= 1.11"

  # A THIRD key in the shared bucket, alongside prod/ and staging/. If this
  # ever matched either of theirs, loadline would adopt that state and the
  # next plan would propose destroying a live environment to match this
  # stack's variables. Verify this line before every `tofu init` here.
  backend "s3" {
    bucket       = "ziptozip-tfstate"
    key          = "loadline/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true # native S3 locking — no DynamoDB table needed
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.70"
    }
  }
}
