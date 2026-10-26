terraform {
  # 1.10 adds S3-native state locking, used by the example (06, TF-6).
  required_version = ">= 1.10, < 2.0"

  required_providers {
    aws = {
      source = "hashicorp/aws"
      # 6.19.0 is the first 6.x release that accepts the nodejs24.x runtime.
      version = ">= 6.19, < 7.0"
    }
  }
}
