provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = "loadline"
      ManagedBy = "opentofu"
    }
  }
}
