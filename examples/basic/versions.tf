terraform {
  required_version = ">= 1.10, < 2.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.19, < 7.0"
    }
  }

  # Filled in at `terraform init` from the deployer's own state bucket
  # (06, EX-3; D-29). See README.md.
  backend "s3" {}
}
