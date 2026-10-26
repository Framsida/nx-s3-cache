variable "region" {
  description = "Region to deploy the cache in. Tokens are signed for this region's STS endpoint."
  type        = string
}

variable "environment" {
  description = "Instance name, such as dev or prod."
  type        = string
}

variable "domain_name" {
  description = "Custom domain of the cache, such as nx-cache.example.com."
  type        = string
}

variable "hosted_zone_name" {
  description = "Existing Route 53 public hosted zone that holds domain_name, such as example.com."
  type        = string
}

variable "allowed_role_arns" {
  description = "Exact IAM role ARNs that may use the cache."
  type        = list(string)
}

variable "alarm_emails" {
  description = "Addresses that receive alarms. Each must confirm the subscription email from AWS."
  type        = list(string)
  default     = []
}

variable "lambda_package_path" {
  description = "Path to lambda.zip built from the same release tag as the module."
  type        = string
}
