# Example root module (06 §5). Copy it into your own repository and apply it
# from there; nothing in this repository applies it (D-30).

provider "aws" {
  region = var.region
}

module "nx_cache" {
  # A checkout of this repository at a release tag: the same checkout the
  # Lambda package was built from, so module and code versions match (06, EX-4).
  source = "../../terraform"

  environment         = var.environment
  domain_name         = var.domain_name
  hosted_zone_name    = var.hosted_zone_name
  allowed_role_arns   = var.allowed_role_arns
  alarm_emails        = var.alarm_emails
  lambda_package_path = var.lambda_package_path
}
