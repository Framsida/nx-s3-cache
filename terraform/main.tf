# Lookups and shared values. Resources are grouped by area in the other files:
# storage.tf (04), function.tf (03 §4), api.tf (03 §3), domain.tf and
# observability.tf (07).

data "aws_region" "current" {}

data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

# The zone must already exist; the plan fails if it does not (06, TF-4).
data "aws_route53_zone" "this" {
  name         = var.hosted_zone_name
  private_zone = false
}

locals {
  name       = "${var.name_prefix}-${var.environment}"
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.region
  partition  = data.aws_partition.current.partition

  bucket_name   = coalesce(var.bucket_name, "${local.name}-artifacts-${local.account_id}")
  bucket_arn    = "arn:${local.partition}:s3:::${local.bucket_name}"
  function_name = "${local.name}-handler"
  audience      = coalesce(var.token_audience, var.domain_name)
  zone_name     = trimsuffix(data.aws_route53_zone.this.name, ".")

  # 02, AUTHZ-2: STS reports an assumed role's account and name but not its
  # path, so each ARN is reduced to <account>:<last path segment>.
  allowed_roles = [
    for arn in var.allowed_role_arns :
    "${split(":", arn)[4]}:${element(split("/", arn), length(split("/", arn)) - 1)}"
  ]

  # 03, FN-5.
  lambda_environment = {
    BUCKET_NAME                = local.bucket_name
    STS_REGION                 = local.region
    TOKEN_AUDIENCE             = local.audience
    TOKEN_MAX_LIFETIME_SECONDS = tostring(var.token_max_lifetime_seconds)
    MAX_ARTIFACT_BYTES         = tostring(var.max_artifact_bytes)
    ALLOWED_ROLES              = jsonencode(local.allowed_roles)
    ENVIRONMENT                = var.environment
    CACHE_ENABLED              = tostring(var.cache_enabled)
    NODE_OPTIONS               = "--enable-source-maps"
  }
  # Lambda limits all variables together to 4 KB (03, FN-5; 06, TF-8).
  lambda_environment_bytes = sum([for k, v in local.lambda_environment : length(k) + length(v)])

  tags = merge(var.tags, {
    Project     = "nx-s3-serverless-cache"
    Environment = var.environment
  })
}
