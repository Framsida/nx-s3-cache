# Module inputs (06 §2).

variable "environment" {
  description = "Instance name, such as dev or prod. Part of every resource name (06, TF-2)."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9-]{1,16}$", var.environment))
    error_message = "environment must be 1 to 16 lowercase letters, digits or hyphens."
  }
}

variable "name_prefix" {
  description = "Prefix of every resource name: <name_prefix>-<environment>-..."
  type        = string
  default     = "nx-cache"

  validation {
    # Keeps the default bucket name within S3's 63 characters.
    condition     = can(regex("^[a-z0-9](?:[a-z0-9-]{0,18}[a-z0-9])?$", var.name_prefix))
    error_message = "name_prefix must be 1 to 20 lowercase letters, digits or hyphens, starting and ending with a letter or digit."
  }
}

variable "domain_name" {
  description = "Custom domain of the cache, such as nx-cache.example.com. It must be in hosted_zone_name (06, TF-4)."
  type        = string

  validation {
    condition     = can(regex("^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$", var.domain_name))
    error_message = "domain_name must be a lowercase DNS name such as nx-cache.example.com."
  }
}

variable "hosted_zone_name" {
  description = "Existing Route 53 public hosted zone, such as example.com. The plan fails if it does not exist (06, TF-4)."
  type        = string

  validation {
    condition     = can(regex("^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}\\.?$", var.hosted_zone_name))
    error_message = "hosted_zone_name must be a lowercase DNS name such as example.com."
  }
}

variable "allowed_role_arns" {
  description = "Exact IAM role ARNs, from any account, that may read and write every workspace (02, AUTHZ-1; D-27)."
  type        = list(string)

  validation {
    condition     = length(var.allowed_role_arns) > 0
    error_message = "allowed_role_arns must list at least one role."
  }

  validation {
    # 02, AUTHZ-5: aws partition, roles only, no wildcards.
    condition = alltrue([
      for arn in var.allowed_role_arns :
      can(regex("^arn:aws:iam::[0-9]{12}:role/(?:[\\w+=,.@-]+/)*[\\w+=,.@-]{1,64}$", arn))
    ])
    error_message = "Each allowed_role_arns entry must be an exact IAM role ARN such as arn:aws:iam::111111111111:role/ci-runner. Wildcards, users and other partitions are not supported."
  }

  validation {
    # 02, AUTHZ-2: roles are matched on account and case-insensitive name.
    condition = length(distinct([
      for arn in var.allowed_role_arns :
      lower(try("${split(":", arn)[4]}:${element(split("/", arn), length(split("/", arn)) - 1)}", arn))
    ])) == length(var.allowed_role_arns)
    error_message = "allowed_role_arns lists the same role twice. Roles are matched on account and name (case-insensitive), whatever their path."
  }
}

variable "lambda_package_path" {
  description = "Path to lambda.zip built from this repository at the same release tag (10 §3)."
  type        = string

  validation {
    condition     = fileexists(var.lambda_package_path)
    error_message = "lambda_package_path must point to an existing file. Build it with: pnpm nx run cache-handler:package"
  }
}

variable "bucket_name" {
  description = "Artifact bucket name. Defaults to <name_prefix>-<environment>-artifacts-<account id>."
  type        = string
  default     = null

  validation {
    condition = var.bucket_name == null || (
      can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.bucket_name)) &&
      !strcontains(coalesce(var.bucket_name, "-"), "..") &&
      !startswith(coalesce(var.bucket_name, "-"), "xn--")
    )
    error_message = "bucket_name must follow S3 bucket naming rules: 3 to 63 lowercase letters, digits, dots or hyphens."
  }
}

variable "retention_days" {
  description = "Days an artifact is kept after upload (04, LC-1; D-17)."
  type        = number
  default     = 14

  validation {
    condition     = var.retention_days >= 1 && floor(var.retention_days) == var.retention_days
    error_message = "retention_days must be a whole number of at least 1."
  }
}

variable "token_audience" {
  description = "Audience bound into every token (02, TOK-1). Defaults to domain_name."
  type        = string
  default     = null

  validation {
    condition     = var.token_audience == null || can(regex("^[\\x21-\\x7e]{1,253}$", coalesce(var.token_audience, "x")))
    error_message = "token_audience must be 1 to 253 printable ASCII characters without spaces."
  }
}

variable "token_max_lifetime_seconds" {
  description = "Longest token lifetime the handler accepts (02, step 5; 05, LT-2)."
  type        = number
  default     = 3600

  validation {
    condition     = var.token_max_lifetime_seconds >= 900 && var.token_max_lifetime_seconds <= 43200 && floor(var.token_max_lifetime_seconds) == var.token_max_lifetime_seconds
    error_message = "token_max_lifetime_seconds must be a whole number from 900 to 43200."
  }
}

variable "max_artifact_bytes" {
  description = "Upload size limit (03, SIZE-1). Base64 must fit a 6 MB Lambda payload, so at most 4500000."
  type        = number
  default     = 4194304

  validation {
    condition     = var.max_artifact_bytes >= 1 && var.max_artifact_bytes <= 4500000 && floor(var.max_artifact_bytes) == var.max_artifact_bytes
    error_message = "max_artifact_bytes must be a whole number from 1 to 4500000."
  }
}

variable "lambda_memory_mb" {
  description = "Handler memory (03, FN-2)."
  type        = number
  default     = 1024

  validation {
    condition     = var.lambda_memory_mb >= 128 && var.lambda_memory_mb <= 10240
    error_message = "lambda_memory_mb must be from 128 to 10240."
  }
}

variable "lambda_timeout_seconds" {
  description = "Handler timeout. Must stay below API Gateway's 29 s integration timeout (03, FN-2)."
  type        = number
  default     = 20

  validation {
    condition     = var.lambda_timeout_seconds >= 1 && var.lambda_timeout_seconds < 29
    error_message = "lambda_timeout_seconds must be from 1 to 28."
  }
}

variable "lambda_reserved_concurrency" {
  description = "Optional cap on concurrent handler executions (03, FN-3). Not a kill switch: 0 fails every Nx command; use cache_enabled = false."
  type        = number
  default     = null

  validation {
    condition     = var.lambda_reserved_concurrency == null || coalesce(var.lambda_reserved_concurrency, 0) >= 0
    error_message = "lambda_reserved_concurrency must be 0 or more when set."
  }
}

variable "cache_enabled" {
  description = "Kill switch (D-35). false makes every request a miss or a skipped upload, without failing any Nx command."
  type        = bool
  default     = true
}

variable "api_throttle_rate_limit" {
  description = "Stage-wide steady-state requests per second (03, APIGW-6). Throttled requests fail the Nx command, so keep it generous."
  type        = number
  default     = 100

  validation {
    condition     = var.api_throttle_rate_limit > 0
    error_message = "api_throttle_rate_limit must be greater than 0."
  }
}

variable "api_throttle_burst_limit" {
  description = "Stage-wide burst limit (03, APIGW-6)."
  type        = number
  default     = 200

  validation {
    condition     = var.api_throttle_burst_limit >= 1 && floor(var.api_throttle_burst_limit) == var.api_throttle_burst_limit
    error_message = "api_throttle_burst_limit must be a whole number of at least 1."
  }
}

variable "log_retention_days" {
  description = "Retention of the handler and access logs. At least retention_days, so every stored object can be traced to its writer (04, AUD-2)."
  type        = number
  default     = 30

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.log_retention_days)
    error_message = "log_retention_days must be a value CloudWatch Logs supports, such as 14, 30, 60 or 90."
  }

  validation {
    condition     = var.log_retention_days >= var.retention_days
    error_message = "log_retention_days must be at least retention_days (04, AUD-2)."
  }
}

variable "alarms_enabled" {
  description = "Create the alarms in 07 section 4. The dashboard is always created (07, ALM-1)."
  type        = bool
  default     = true
}

variable "alarm_emails" {
  description = "Addresses subscribed to a topic the module creates. Each must confirm the subscription email from AWS."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for e in var.alarm_emails : can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", e))])
    error_message = "Each alarm_emails entry must be an email address."
  }
}

variable "alarm_sns_topic_arn" {
  description = "Existing SNS topic for alarms, instead of a topic the module creates."
  type        = string
  default     = null

  validation {
    condition     = var.alarm_sns_topic_arn == null || can(regex("^arn:aws:sns:[a-z0-9-]+:[0-9]{12}:[A-Za-z0-9_-]{1,256}$", coalesce(var.alarm_sns_topic_arn, "x")))
    error_message = "alarm_sns_topic_arn must be an SNS topic ARN."
  }

  validation {
    condition     = var.alarm_sns_topic_arn == null || length(var.alarm_emails) == 0
    error_message = "Set alarm_emails or alarm_sns_topic_arn, not both."
  }
}

variable "alarm_thresholds" {
  description = "Alarm thresholds (07 section 4)."
  type = object({
    api_5xx_rate_percent = optional(number, 5)
    api_5xx_min_requests = optional(number, 20)
    sts_failures         = optional(number, 10)
    s3_failures          = optional(number, 10)
  })
  default = {}
}

variable "admin_role_arns" {
  description = "Roles exempted from the bucket policy's denies, for purges (04, S3-POL-2 and S3-POL-3)."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for arn in var.admin_role_arns : can(regex("^arn:aws:iam::[0-9]{12}:role/(?:[\\w+=,.@-]+/)*[\\w+=,.@-]{1,64}$", arn))])
    error_message = "Each admin_role_arns entry must be an IAM role ARN."
  }
}

variable "manage_api_gateway_account" {
  description = "Create the account-wide API Gateway CloudWatch Logs role. At most one instance per account and region may set this (06, TF-10)."
  type        = bool
  default     = false
}

variable "tags" {
  description = "Tags merged into every taggable resource (06, TF-7)."
  type        = map(string)
  default     = {}
}
